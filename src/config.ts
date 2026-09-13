export interface Config {
  /**
   * Canonical Nextcloud base URL: origin plus any deployment sub-path, with no
   * trailing slash, query, fragment, or credentials. e.g. `https://cloud.example.com`
   * or `https://example.com/nextcloud`.
   */
  url: string;
  /** Nextcloud username. */
  user: string;
  /** Nextcloud app-password (never the user's real account password). */
  password: string;
  /** Per-request deadline in milliseconds. */
  timeoutMs: number;
}

const REQUIRED = ['NEXTCLOUD_URL', 'NEXTCLOUD_USER', 'NEXTCLOUD_APP_PASSWORD'] as const;

/** Default per-request deadline; override with NEXTCLOUD_TIMEOUT_MS. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Reduce a base URL to origin + pathname, rejecting anything that would not
 * survive string concatenation with an endpoint path.
 *
 * Every request is built as `${config.url}${path}`, so a query or fragment in
 * the base would swallow the endpoint path (`…/nextcloud?x=1` + `/ocs/v2.php/…`
 * puts the whole API path inside the query string). Embedded credentials are
 * rejected separately: they are a secret that would otherwise be echoed by
 * `ping` and other diagnostics.
 */
export function canonicalizeBaseUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`NEXTCLOUD_URL is not a valid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`NEXTCLOUD_URL must use http or https, got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error(
      'NEXTCLOUD_URL must not contain embedded credentials. ' +
        'Pass NEXTCLOUD_USER and NEXTCLOUD_APP_PASSWORD instead.',
    );
  }
  if (url.search) {
    throw new Error(`NEXTCLOUD_URL must not contain a query string, got "${url.search}"`);
  }
  if (url.hash) {
    throw new Error(`NEXTCLOUD_URL must not contain a fragment, got "${url.hash}"`);
  }

  // Keep a deployment sub-path (`/nextcloud`), drop the trailing slash so the
  // appended endpoint path supplies exactly one separator.
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname}`;
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_TIMEOUT_MS;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`NEXTCLOUD_TIMEOUT_MS must be a positive number of milliseconds, got "${raw}"`);
  }
  return ms;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Generate an app-password in Nextcloud (Settings → Security → Devices & sessions) ' +
        'and pass NEXTCLOUD_URL, NEXTCLOUD_USER, NEXTCLOUD_APP_PASSWORD to the MCP server.',
    );
  }

  return {
    url: canonicalizeBaseUrl(env.NEXTCLOUD_URL!.trim()),
    user: env.NEXTCLOUD_USER!.trim(),
    password: env.NEXTCLOUD_APP_PASSWORD!,
    timeoutMs: parseTimeout(env.NEXTCLOUD_TIMEOUT_MS),
  };
}
