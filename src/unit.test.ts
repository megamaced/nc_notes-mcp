import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { appendToNote, isNoteStub, isWithinCategory } from './api.js';
import { canonicalizeBaseUrl, DEFAULT_TIMEOUT_MS, loadConfig } from './config.js';
import { dispatchTool, TOOLS } from './tools.js';
import type { NextcloudClient } from './http.js';

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

  test('treats the uncategorized root as containing everything', () => {
    assert.equal(isWithinCategory('', ''), true);
    assert.equal(isWithinCategory('work/clients', ''), true);
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
