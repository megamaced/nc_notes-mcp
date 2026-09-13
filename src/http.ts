import type { Config } from './config.js';

/**
 * Path prefix for the Notes REST API.
 *
 * Unlike most Nextcloud app APIs this is not an OCS endpoint: it is a plain
 * REST API returning bare JSON with conventional HTTP status codes, so there
 * is no `ocs.meta` envelope to unwrap and no `OCS-APIRequest` header to send.
 */
export const NOTES_API = '/index.php/apps/notes/api/v1';

// -----------------------------------------------------------------------------
// Logging
// -----------------------------------------------------------------------------

const DEBUG = !!process.env.DEBUG;

function debug(msg: string): void {
  if (DEBUG) process.stderr.write(`[notes-mcp] ${msg}\n`);
}

// -----------------------------------------------------------------------------
// Retry configuration
// -----------------------------------------------------------------------------

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;
/** Upper bound on any single retry delay, including server-provided Retry-After. */
export const MAX_RETRY_DELAY_MS = 30_000;
/**
 * Methods whose response may be safely reproduced by replaying the request.
 *
 * Reads only. HTTP idempotency guarantees the server-side *state* after a
 * repeated PUT or DELETE, not that the replay returns the same *response* — and
 * the response is what this server reports back. A conditional `PUT` that
 * commits and then loses its response to a dropped connection returns 412 on
 * replay, because the first attempt already moved the etag; a committed DELETE
 * returns 404. Either would report failure for a write that succeeded, and a
 * caller retrying an append on that report would write the text twice.
 *
 * A 429 is handled separately: the server states it never processed the
 * request, so replaying it is safe for any method.
 */
const REPLAYABLE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A 5xx is ambiguous — a write may have been committed before the error, and
 * its response lost. Only replay it when the response itself is reproducible.
 * A 429 is always safe to replay: the server rejected the request outright.
 */
function isRetryable(status: number, replayable: boolean): boolean {
  if (status === 429) return true;
  return replayable && status >= 500 && status <= 599;
}

/**
 * Transient transport failures (connection reset, DNS blip, socket close).
 * Deliberately excludes AbortError: a request that hit its deadline is
 * reported to the caller rather than replayed.
 */
function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return false;
  const code = (err as { cause?: { code?: string } }).cause?.code;
  if (code) {
    return [
      'ECONNRESET',
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EPIPE',
      'ETIMEDOUT',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'UND_ERR_SOCKET',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
    ].includes(code);
  }
  // Undici surfaces network failures as a bare TypeError('fetch failed').
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff for the given zero-based attempt, capped. */
function backoffDelay(attempt: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
}

/** A request that exceeded its deadline. Never retried. */
export class TimeoutError extends Error {
  public readonly hint =
    'The Nextcloud server may be unreachable or overloaded. ' +
    'Raise NEXTCLOUD_TIMEOUT_MS if the operation is legitimately slow.';

  constructor(label: string, timeoutMs: number) {
    super(
      `Request timed out after ${timeoutMs}ms: ${label} ` +
        '[The Nextcloud server may be unreachable or overloaded. ' +
        'Raise NEXTCLOUD_TIMEOUT_MS if the operation is legitimately slow.]',
    );
    this.name = 'TimeoutError';
  }
}

/**
 * Parse a Retry-After header. Returns delay in milliseconds clamped to
 * {@link MAX_RETRY_DELAY_MS}, or null if the header is absent / unparseable.
 * The cap stops a hostile or misconfigured server from stalling the MCP
 * client indefinitely.
 */
function parseRetryAfter(res: Response): number | null {
  const header = res.headers.get('Retry-After');
  if (!header) return null;
  const clamp = (ms: number) => Math.min(Math.max(0, ms), MAX_RETRY_DELAY_MS);
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds)) return clamp(seconds * 1000);
  const date = Date.parse(header);
  if (!isNaN(date)) return clamp(date - Date.now());
  return null;
}

// -----------------------------------------------------------------------------
// Error classes
// -----------------------------------------------------------------------------

const ERROR_BODY_MAX = 200;

/** A response body that exceeded the configured size limit. */
export class ResponseTooLargeError extends Error {
  public readonly hint =
    'Narrow the request (exclude=["content"], a smaller chunkSize, or a single ' +
    'get_note) or raise NEXTCLOUD_MAX_RESPONSE_BYTES.';

  constructor(label: string, limit: number, seen: number | null) {
    super(
      `Response too large: ${label} exceeded the ${limit}-byte limit` +
        `${seen === null ? '' : ` (server declared ${seen} bytes)`} ` +
        '[Narrow the request (exclude=["content"], a smaller chunkSize, or a single ' +
        'get_note) or raise NEXTCLOUD_MAX_RESPONSE_BYTES.]',
    );
    this.name = 'ResponseTooLargeError';
  }
}

/** A failed HTTP response (non-2xx status). */
export class HttpError extends Error {
  /** Human-readable suggestion for how the caller might fix the problem. */
  public readonly hint: string;

  constructor(
    public readonly status: number,
    public readonly statusText: string,
    body: string,
  ) {
    const snippet = body.length > ERROR_BODY_MAX ? `${body.slice(0, ERROR_BODY_MAX)}…` : body;
    const hint = httpHint(status);
    super(`HTTP ${status} ${statusText}${snippet ? `: ${snippet}` : ''}${hint ? ` [${hint}]` : ''}`);
    this.name = 'HttpError';
    this.hint = hint;
  }
}

function httpHint(status: number): string {
  switch (status) {
    case 400: return 'Invalid note id — it must be the numeric id returned by list_notes.';
    case 401: return 'Check NEXTCLOUD_APP_PASSWORD — it may be expired or revoked.';
    case 403: return 'The note is read-only, or the app-password lacks permission.';
    case 404: return 'Note not found — it may have been deleted, or the Notes app is not enabled for this user.';
    case 423: return 'Locked — the note file is locked by another process or user.';
    case 429: return 'Rate-limited — too many requests. Retry later.';
    case 507: return 'Insufficient storage on the Nextcloud server.';
    default:
      if (status >= 500) return 'Server error — Nextcloud may be overloaded or misconfigured.';
      return '';
  }
}

/**
 * An `If-Match` write refused because the note changed on the server first.
 *
 * The Notes API returns the note's *current* server state in the 412 body, so
 * that state is carried on the error rather than discarded: a caller can merge
 * against it and retry without a second round-trip.
 */
export class ConflictError extends Error {
  public readonly hint =
    'The note changed on the server since the etag you passed. Merge against ' +
    '`current` and retry, or omit the etag to overwrite unconditionally.';

  constructor(public readonly current: unknown) {
    super(
      'HTTP 412 Precondition Failed: the note was modified on the server since ' +
        'the etag you supplied. [The current server state is included as `current`. ' +
        'Merge against it and retry, or omit the etag to overwrite unconditionally.]',
    );
    this.name = 'ConflictError';
  }
}

/** A Notes API response together with the headers the API uses as protocol. */
export interface NotesResponse<T> {
  data: T;
  /** Entity tag of the returned note or note list, if the server sent one. */
  etag: string | null;
  /** Opaque cursor for the next chunk, present only when the result was chunked. */
  chunkCursor: string | null;
  /** Number of notes still pending after this chunk. */
  chunkPending: number | null;
}

export class NextcloudClient {
  private readonly authHeader: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly config: Config) {
    this.maxResponseBytes = config.maxResponseBytes;
    const token = Buffer.from(`${config.user}:${config.password}`, 'utf8').toString('base64');
    this.authHeader = `Basic ${token}`;
    this.timeoutMs = config.timeoutMs;
    if (config.url.startsWith('http://')) {
      process.stderr.write(
        '[notes-mcp] WARNING: NEXTCLOUD_URL uses http:// — ' +
          'credentials will be sent in plain text. Use https:// in production.\n',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Shared retry logic
  // ---------------------------------------------------------------------------

  /**
   * Fetch with a per-request deadline and bounded retries.
   *
   * Retries exactly one delay per attempt: the server's `Retry-After` when it
   * supplies one, otherwise exponential backoff — both capped at
   * {@link MAX_RETRY_DELAY_MS}. 429 is retried for every method; 5xx and
   * transient network failures only for idempotent requests, so an ambiguous
   * write is never silently duplicated.
   *
   * A 412 is never retried and never becomes an `HttpError`: it is the Notes
   * API's concurrency signal, and its body is needed intact.
   */
  private async fetchWithRetry(url: string, init: RequestInit, label: string): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const replayable = REPLAYABLE_METHODS.has(method);
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      debug(attempt === 0 ? label : `Retry ${attempt}/${MAX_RETRIES} for ${label}`);

      let res: Response;
      try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
          throw new TimeoutError(label, this.timeoutMs);
        }
        if (isTransientNetworkError(err) && replayable && attempt < MAX_RETRIES) {
          lastError = err as Error;
          await sleep(backoffDelay(attempt));
          continue;
        }
        throw err;
      }

      if (res.ok || res.status === 412) return res;

      // Bounded: an error body can be an arbitrarily large proxy error page.
      const text = await this.readBounded(res, label).catch(() => '');
      const httpError = new HttpError(res.status, res.statusText, text);

      if (isRetryable(res.status, replayable) && attempt < MAX_RETRIES) {
        lastError = httpError;
        await sleep(parseRetryAfter(res) ?? backoffDelay(attempt));
        continue;
      }
      throw httpError;
    }
    throw lastError ?? new Error('Unexpected retry exhaustion');
  }

  /**
   * Read a response body, refusing to buffer more than the configured limit.
   *
   * `Response.text()` buffers whatever the peer sends, so the cap has to be
   * applied while reading rather than afterwards: by the time a 200-character
   * snippet is taken, the whole body is already in memory. `Content-Length` is
   * checked first when present so an oversized body is rejected before a single
   * chunk is read.
   */
  private async readBounded(res: Response, label: string): Promise<string> {
    const declared = res.headers.get('Content-Length');
    if (declared !== null) {
      const size = Number(declared);
      if (Number.isFinite(size) && size > this.maxResponseBytes) {
        throw new ResponseTooLargeError(label, this.maxResponseBytes, size);
      }
    }
    if (!res.body) return '';

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > this.maxResponseBytes) {
        await reader.cancel().catch(() => {});
        throw new ResponseTooLargeError(label, this.maxResponseBytes, null);
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }

  // ---------------------------------------------------------------------------
  // Notes REST API
  // ---------------------------------------------------------------------------

  /**
   * Call a Notes API endpoint. `path` is appended after {@link NOTES_API} and
   * must start with `/`.
   *
   * @param query Appended as a query string; undefined values are dropped.
   * @param etag Sent as `If-Match` for optimistic concurrency control. A
   *   rejected write raises {@link ConflictError} carrying the server's copy.
   */
  async notes<T = unknown>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, string | number | undefined>; etag?: string } = {},
  ): Promise<NotesResponse<T>> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) search.set(key, String(value));
    }
    const qs = search.size > 0 ? `?${search}` : '';
    const url = `${this.config.url}${NOTES_API}${path}${qs}`;

    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: 'application/json',
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.etag) headers['If-Match'] = opts.etag;

    const res = await this.fetchWithRetry(
      url,
      {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      },
      `${method} ${path}${qs}`,
    );

    const text = await this.readBounded(res, `${method} ${path}`);
    let parsed: unknown;
    if (text === '') {
      parsed = null;
    } else {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(
          `Notes API response was not valid JSON (${res.status}): ${text.slice(0, ERROR_BODY_MAX)}`,
        );
      }
    }

    if (res.status === 412) throw new ConflictError(parsed);

    const pending = res.headers.get('X-Notes-Chunk-Pending');
    return {
      data: parsed as T,
      etag: res.headers.get('ETag'),
      chunkCursor: res.headers.get('X-Notes-Chunk-Cursor'),
      chunkPending: pending === null ? null : Number(pending),
    };
  }
}
