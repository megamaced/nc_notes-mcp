import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { appendToNote, isNoteStub, isWithinCategory, listCategories, renameCategory } from './api.js';
import type { Note } from './types.js';
import { canonicalizeBaseUrl, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, loadConfig } from './config.js';
import { dispatchTool, TOOLS } from './tools.js';
import { NextcloudClient } from './http.js';

/**
 * Deterministic unit tests. No Nextcloud instance required — these always run,
 * including in CI.
 */

const ctx = {
  client: null as unknown as NextcloudClient,
  configSummary: 'https://cloud.example.com as tester',
};

describe('Note stub detection (pure)', () => {
  test('treats an id-only entry as a stub', () => {
    assert.equal(isNoteStub({ id: 7 }), true);
  });

  test('treats any entry carrying real fields as a note', () => {
    assert.equal(isNoteStub({ id: 7, title: 'Shopping' }), false);
    assert.equal(isNoteStub({ id: 7, category: '' }), false);
    // An excluded-everything listing still returns the etag and readonly flag,
    // so it must not be mistaken for a stub.
    assert.equal(isNoteStub({ id: 7, etag: 'abc', readonly: false }), false);
  });
});

describe('Category containment (pure)', () => {
  test('matches the category itself and anything nested beneath it', () => {
    assert.equal(isWithinCategory('work', 'work'), true);
    assert.equal(isWithinCategory('work/clients', 'work'), true);
    assert.equal(isWithinCategory('work/clients/acme', 'work'), true);
  });

  test('does not match a sibling that merely shares a prefix', () => {
    // The trap the server's own exact-match filter avoids by being exact, and
    // that a naive startsWith would fall straight into.
    assert.equal(isWithinCategory('workshop', 'work'), false);
    assert.equal(isWithinCategory('work-notes', 'work'), false);
  });

  test('treats uncategorized as a category, not as a root containing everything', () => {
    // "" is the uncategorized category. A named category is not nested inside
    // it, so a recursive count from "" must not sweep up the whole server.
    assert.equal(isWithinCategory('', ''), true);
    assert.equal(isWithinCategory('work', ''), false);
    assert.equal(isWithinCategory('work/clients', ''), false);
  });
});

describe('Base URL canonicalisation (pure)', () => {
  test('strips trailing slashes and keeps a deployment sub-path', () => {
    assert.equal(canonicalizeBaseUrl('https://cloud.example.com/'), 'https://cloud.example.com');
    assert.equal(canonicalizeBaseUrl('https://example.com/nextcloud/'), 'https://example.com/nextcloud');
  });

  test('rejects components that would corrupt the endpoint path', () => {
    assert.throws(() => canonicalizeBaseUrl('https://cloud.example/nextcloud?x=1'), /query string/);
    assert.throws(() => canonicalizeBaseUrl('https://cloud.example/#top'), /fragment/);
    assert.throws(() => canonicalizeBaseUrl('https://u:p@cloud.example'), /embedded credentials/);
    assert.throws(() => canonicalizeBaseUrl('ftp://cloud.example'), /http or https/);
  });
});

describe('Config loading (pure)', () => {
  const base = {
    NEXTCLOUD_URL: 'https://cloud.example.com',
    NEXTCLOUD_USER: 'tester',
    NEXTCLOUD_APP_PASSWORD: 'secret',
  };

  test('names every missing variable at once', () => {
    assert.throws(() => loadConfig({}), /NEXTCLOUD_URL, NEXTCLOUD_USER, NEXTCLOUD_APP_PASSWORD/);
  });

  test('falls back to the default timeout', () => {
    assert.equal(loadConfig(base).timeoutMs, DEFAULT_TIMEOUT_MS);
  });

  test('rejects a nonsense timeout rather than silently defaulting', () => {
    assert.throws(() => loadConfig({ ...base, NEXTCLOUD_TIMEOUT_MS: '-1' }), /positive number/);
    assert.throws(() => loadConfig({ ...base, NEXTCLOUD_TIMEOUT_MS: 'soon' }), /positive number/);
  });
});

describe('Tool registry', () => {
  test('every tool declares a name, description and annotations', () => {
    for (const tool of TOOLS) {
      assert.ok(tool.name, 'tool has a name');
      assert.ok(tool.description, `${tool.name} has a description`);
      assert.ok(tool.annotations, `${tool.name} has annotations`);
      assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} declares readOnlyHint`);
    }
  });

  test('no read-only tool is marked destructive', () => {
    for (const tool of TOOLS) {
      if (tool.annotations?.readOnlyHint) {
        assert.notEqual(tool.annotations.destructiveHint, true, `${tool.name}`);
      }
    }
  });
});

describe('Argument validation (no network)', () => {
  test('rejects an unknown tool', async () => {
    const result = await dispatchTool('no_such_tool', {}, ctx);
    assert.equal(result.isError, true);
  });

  test('rejects a note id that is not a positive integer', async () => {
    for (const id of [0, -1, 'abc', 1.5]) {
      const result = await dispatchTool('get_note', { id }, ctx);
      assert.equal(result.isError, true, `should reject id=${String(id)}`);
    }
  });

  test('accepts a numeric string id, as MCP clients may send one', async () => {
    // Reaches the handler and fails on the null client, not on validation.
    const result = await dispatchTool('get_note', { id: '42' }, ctx);
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.content[0]?.type === 'text' ? result.content[0].text : '', /Invalid arguments/);
  });

  test('rejects unknown properties rather than ignoring them', async () => {
    const result = await dispatchTool('get_note', { id: 1, colour: 'red' }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.type === 'text' ? result.content[0].text : '', /Invalid arguments/);
  });

  test('rejects an update that would change nothing', async () => {
    const result = await dispatchTool('update_note', { id: 1 }, ctx);
    assert.equal(result.isError, true);
    assert.match(
      result.content[0]?.type === 'text' ? result.content[0].text : '',
      /at least one of title, content, category or favorite/,
    );
  });

  test('reads the string "false" as false, not as true', async () => {
    // z.coerce.boolean() would make "false" true; the union must not.
    const result = await dispatchTool('list_notes', { category: 'work', recursive: 'false' }, ctx);
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.content[0]?.type === 'text' ? result.content[0].text : '', /Invalid arguments/);
  });

  test('rejects a boolean spelling it cannot read unambiguously', async () => {
    const result = await dispatchTool('list_notes', { recursive: 'yes' }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.type === 'text' ? result.content[0].text : '', /Invalid arguments/);
  });
});

describe('Append guard (stubbed client)', () => {
  /** Minimal stand-in that answers the single GET appendToNote makes. */
  function clientReturning(note: unknown): NextcloudClient {
    return {
      notes: async () => ({ data: note, etag: null, chunkCursor: null, chunkPending: null }),
    } as unknown as NextcloudClient;
  }

  test('refuses to append when the server could not read the note', async () => {
    // The API reports this in-band: content holds an error string, not the body.
    const unreadable = {
      id: 5,
      content: 'Error: OCP\\Files\\NotPermittedException',
      error: true,
      errorType: 'OCP\\Files\\NotPermittedException',
    };
    await assert.rejects(
      () => appendToNote(clientReturning(unreadable), 5, 'more text'),
      /Refusing to append/,
      'appending would have written the error message back over the note',
    );
  });
});

// -----------------------------------------------------------------------------
// Regressions for the issues raised in the post-release audit (#1-#9)
// -----------------------------------------------------------------------------

/** A client whose every request is answered from a scripted queue. */
function scriptedClient(responses: Note[]): NextcloudClient {
  const queue = [...responses];
  return {
    notes: async () => ({
      data: queue.shift(),
      etag: null,
      chunkCursor: null,
      chunkPending: null,
    }),
  } as unknown as NextcloudClient;
}

describe('#1 ambiguous writes are not replayed', () => {
  const config = {
    url: 'https://cloud.example.com',
    user: 'tester',
    password: 'secret',
    timeoutMs: 5_000,
    maxResponseBytes: 1024 * 1024,
  };

  /** Replaces global fetch with a scripted sequence, recording every call. */
  function withFetch(script: (() => Response)[], run: (calls: string[]) => Promise<void>) {
    const original = globalThis.fetch;
    const calls: string[] = [];
    let i = 0;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      const next = script[Math.min(i++, script.length - 1)];
      return next!();
    }) as typeof fetch;
    return run(calls).finally(() => {
      globalThis.fetch = original;
    });
  }

  const serverError = () => new Response('upstream failed', { status: 502, statusText: 'Bad Gateway' });

  test('a conditional PUT that fails ambiguously is reported, not repeated', async () => {
    // The hazard: the first PUT may have committed and lost its response. A
    // replay would come back 412 (the etag moved) and be reported as a
    // conflict, inviting the caller to repeat an append that already landed.
    await withFetch([serverError], async (calls) => {
      const client = new NextcloudClient(config);
      await assert.rejects(
        () => client.notes('PUT', '/notes/1', { body: { content: 'x' }, etag: 'old' }),
        /HTTP 502/,
      );
      assert.equal(calls.length, 1, 'the PUT must not be replayed');
    });
  });

  test('a DELETE that fails ambiguously is reported, not repeated', async () => {
    await withFetch([serverError], async (calls) => {
      const client = new NextcloudClient(config);
      await assert.rejects(() => client.notes('DELETE', '/notes/1'), /HTTP 502/);
      assert.equal(calls.length, 1, 'the DELETE must not be replayed');
    });
  });

  test('a GET is still retried, because replaying a read is safe', async () => {
    const script = [serverError, () => new Response('[]', { status: 200 })];
    await withFetch(script, async (calls) => {
      const client = new NextcloudClient(config);
      const res = await client.notes('GET', '/notes');
      assert.deepEqual(res.data, []);
      assert.equal(calls.length, 2, 'the GET should have been retried once');
    });
  });

  test('a 429 is replayed even for a write, since the server never processed it', async () => {
    const script = [
      () => new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } }),
      () => new Response('{"id":1}', { status: 200 }),
    ];
    await withFetch(script, async (calls) => {
      const client = new NextcloudClient(config);
      const res = await client.notes('PUT', '/notes/1', { body: { content: 'x' } });
      assert.deepEqual(res.data, { id: 1 });
      assert.equal(calls.length, 2);
    });
  });

  test('an oversized body is refused instead of buffered', async () => {
    const big = () =>
      new Response('x'.repeat(2048), { status: 200, headers: { 'Content-Length': '2048' } });
    await withFetch([big], async () => {
      const client = new NextcloudClient({ ...config, maxResponseBytes: 512 });
      await assert.rejects(() => client.notes('GET', '/notes'), /Response too large/);
    });
  });
});

describe('#2 note ids reject anything outside the published grammar', () => {
  test('rejects values that Number() would silently coerce to a valid id', async () => {
    // Each of these becomes a plausible id under z.coerce.number(): true -> 1,
    // ["1"] -> 1, "0x10" -> 16. On delete_note that is the wrong note.
    for (const id of [true, false, ['1'], { id: 1 }, '0x10', '1e3', ' 1 ', '+1', '01', null]) {
      const result = await dispatchTool('delete_note', { id }, ctx);
      assert.equal(result.isError, true, `should reject ${JSON.stringify(id)}`);
      assert.match(
        result.content[0]?.type === 'text' ? result.content[0].text : '',
        /Invalid arguments/,
        `should reject ${JSON.stringify(id)} at validation`,
      );
    }
  });

  test('rejects non-integers and ids beyond the safe integer range', async () => {
    for (const id of [1.5, 0, -1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      const result = await dispatchTool('delete_note', { id }, ctx);
      assert.equal(result.isError, true, `should reject ${String(id)}`);
      assert.match(
        result.content[0]?.type === 'text' ? result.content[0].text : '',
        /Invalid arguments/,
      );
    }
  });

  test('still accepts a plain integer and its decimal string spelling', async () => {
    for (const id of [42, '42']) {
      const result = await dispatchTool('get_note', { id }, ctx);
      // Reaches the handler and fails on the null client, not on validation.
      assert.doesNotMatch(
        result.content[0]?.type === 'text' ? result.content[0].text : '',
        /Invalid arguments/,
        `should accept ${JSON.stringify(id)}`,
      );
    }
  });

  test('publishes the same lower bound it enforces', () => {
    for (const tool of TOOLS) {
      const id = (tool.inputSchema.properties as Record<string, { minimum?: number }> | undefined)?.id;
      if (id) assert.equal(id.minimum, 1, `${tool.name} should publish minimum: 1`);
    }
  });
});

describe('#3 settings follow the public API contract', () => {
  test('rejects customSuffix, which the public API does not have', async () => {
    // getPublic() drops customSuffix and setPublic() derives it, so sending the
    // internal pair would store the literal string "custom" as the extension.
    const result = await dispatchTool('update_settings', { customSuffix: '.org' }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.type === 'text' ? result.content[0].text : '', /Invalid arguments/);
  });

  test('takes a custom extension as fileSuffix directly', async () => {
    const result = await dispatchTool('update_settings', { fileSuffix: '.org' }, ctx);
    assert.doesNotMatch(
      result.content[0]?.type === 'text' ? result.content[0].text : '',
      /Invalid arguments/,
    );
  });
});

describe('#4 state-changing tools declare their real impact', () => {
  /** Tools that overwrite or remove existing state rather than only adding to it. */
  const OVERWRITING = new Set([
    'update_note',
    'delete_note',
    'set_note_category',
    'rename_category',
    'update_settings',
  ]);

  test('every overwriting tool is marked destructive', () => {
    for (const tool of TOOLS) {
      if (OVERWRITING.has(tool.name)) {
        assert.equal(tool.annotations?.destructiveHint, true, `${tool.name} should be destructive`);
      }
    }
  });

  test('purely additive and read-only tools are not marked destructive', () => {
    for (const tool of TOOLS) {
      if (!OVERWRITING.has(tool.name)) {
        assert.notEqual(tool.annotations?.destructiveHint, true, `${tool.name}`);
      }
    }
  });
});

describe('#7 the uncategorized summary counts only uncategorized notes', () => {
  test('does not report every note as nested under ""', async () => {
    const notes = [
      { id: 1, category: '' },
      { id: 2, category: 'work' },
      { id: 3, category: 'work/sub' },
    ];
    const client = scriptedClient([notes as unknown as Note]);
    const categories = await listCategories(client);

    const uncategorized = categories.find((c) => c.category === '');
    assert.deepEqual(
      { direct: uncategorized?.noteCount, recursive: uncategorized?.noteCountRecursive },
      { direct: 1, recursive: 1 },
    );

    const work = categories.find((c) => c.category === 'work');
    assert.deepEqual(
      { direct: work?.noteCount, recursive: work?.noteCountRecursive },
      { direct: 1, recursive: 2 },
    );
  });
});

describe('#8 timeouts are validated at startup, not at first request', () => {
  const base = {
    NEXTCLOUD_URL: 'https://cloud.example.com',
    NEXTCLOUD_USER: 'tester',
    NEXTCLOUD_APP_PASSWORD: 'secret',
  };

  test('rejects the values AbortSignal.timeout would throw on', () => {
    assert.throws(() => loadConfig({ ...base, NEXTCLOUD_TIMEOUT_MS: '1.5' }), /whole number/);
    assert.throws(
      () => loadConfig({ ...base, NEXTCLOUD_TIMEOUT_MS: String(MAX_TIMEOUT_MS + 1) }),
      /at most/,
    );
  });

  test('accepts the boundary value, and Node uses it without clamping', async () => {
    const config = loadConfig({ ...base, NEXTCLOUD_TIMEOUT_MS: String(MAX_TIMEOUT_MS) });
    assert.equal(config.timeoutMs, MAX_TIMEOUT_MS);

    // Above 2^31-1 Node does not throw: it warns and clamps the delay to 1ms,
    // which would abort every request instantly. The bound has to sit where the
    // timer stops overflowing, not at AbortSignal's documented ceiling.
    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(w.name);
    process.on('warning', onWarning);
    try {
      AbortSignal.timeout(config.timeoutMs);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', onWarning);
    }
    assert.deepEqual(warnings, [], 'the accepted maximum must not overflow the timer');
  });

  test('rejects the value AbortSignal documents as its ceiling, which silently clamps', () => {
    assert.throws(() => loadConfig({ ...base, NEXTCLOUD_TIMEOUT_MS: '4294967295' }), /at most/);
  });
});

describe('#9 rename_category reports what the server stored', () => {
  test('reports the sanitised category and any retitled note, not the request', async () => {
    const listing = [{ id: 1, title: 'Plan', category: 'work', etag: 'e1' }];
    // The server sanitises the target path and resolves a title collision.
    const updated = { id: 1, title: 'Plan (2)', category: 'archive/work', etag: 'e2' };
    const client = scriptedClient([listing as unknown as Note, updated]);

    const result = await renameCategory(client, 'work', 'archive/work?', false);

    assert.equal(result.failed.length, 0);
    assert.deepEqual(result.moved, [
      {
        id: 1,
        title: 'Plan (2)',
        from: 'work',
        to: 'archive/work',
        requested: 'archive/work?',
      },
    ]);
  });
});
