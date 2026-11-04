# Changelog

## v0.1.1 — Security dependency updates

Dependency and CI updates only — no tool changes, no config changes required.

The minimum versions in `package.json` now exclude releases with published advisories: `@modelcontextprotocol/sdk` `^1.32.2` (was `^1.30.0`) and `zod` `^4.6.7` (was `^4.5.4`). The release tarball carries only `dist/`, so `npm install -g` resolves dependencies within those ranges; the old floors allowed the affected versions. The lockfile, used when building from source, moves the same way.

- **zod → 4.6.7** clears [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5): zod through 4.6.5 records an issue for every failing element of an array, without limit, so a client sending a very large invalid array argument could exhaust the server's memory. This is the advisory that reaches a stdio server.
- **`@modelcontextprotocol/sdk` → 1.32.2** clears GHSA-f897-62hf-6gxq, GHSA-6qxp-vccf-f47h, GHSA-22jm-h49p-29qw, GHSA-46jr-4wx8-v453, GHSA-rvq5-wwqv-78pq and GHSA-6prh-2h8m-c8cw. They concern the SDK's HTTP transports, bearer auth, experimental tasks and OAuth client, none of which this server uses.
- **Transitive updates through the SDK:** proxy-addr 2.0.8 (critical, GHSA-jqcg-44mw-7w3h), body-parser 2.4.0, express 5.3.0, hono 4.13.16, @hono/node-server 2.1.5, qs 6.17.1, ip-address 10.7.5, fast-uri 3.1.9. Only fast-uri is loaded at runtime, by ajv when resolving the server's own JSON Schemas; the rest belong to the HTTP transport and auth modules.
- **CI:** action refs pinned to commit SHAs and the workflow token limited to `contents: read` (#12, from emirhan-karaca). Dependabot minor and patch updates merge themselves once CI passes, after a 7-day cooldown on new upstream releases.
- **Dev tooling:** ESLint 10.13, typescript-eslint 8.72, tsx 4.23.15, `@types/node` 26.6.5.

`pnpm audit --prod` is clean. One development-scope advisory remains — minimatch GHSA-g3hv-75wg-m249, via ESLint, fixed only in minimatch 11 — and is not part of the installed package.

## v0.1.0 — Initial release

A Model Context Protocol server for Nextcloud Notes: twelve tools covering notes, categories and app settings over the Notes REST API.

### Tools

- **Notes:** `list_notes`, `get_note`, `create_note`, `update_note`, `append_to_note`, `delete_note`
- **Categories:** `list_categories`, `set_note_category`, `rename_category`
- **Settings:** `get_settings`, `update_settings`
- **Other:** `ping`

Every tool declares the full MCP annotation set, so a client can tell a read from an overwrite without parsing descriptions.

### Notable behaviour

- **Optimistic concurrency.** `get_note` returns the note's etag; passing it to `update_note` makes the write conditional, and a rejected write carries the server's current copy so a caller can merge without a second round-trip. `append_to_note` does this internally.
- **Categories are derived.** The Notes API has no endpoint that lists categories and no server-side rename, so `list_categories` derives the list from the notes — a category holding no notes is invisible — and `rename_category` rewrites each note individually, reporting the per-note outcome because the operation is not atomic.
- **Recursive category filtering is client-side.** The server's `category` filter is an exact string comparison, so `work` does not match `work/clients`.
- **Unreadable notes are refused, not appended to.** When the server cannot read a note body it returns HTTP 200 with a localised error string *in the content field*; `append_to_note` checks for that rather than writing the error message back over the note.

`ENDPOINTS.md` documents these and ten more behaviours that are not in the published API docs.

### Hardening before release

Nine issues raised against the pre-release tree (#1–#9) are fixed in this release:

- **Writes are never replayed after an ambiguous failure** (#1). A conditional `PUT` that commits and loses its response returns 412 on replay, and a committed `DELETE` returns 404 — both would report failure for a write that succeeded. Only reads are replayable; 429 still replays for any method.
- **Note ids reject anything outside the published grammar** (#2). Under `z.coerce.number()`, `true` and `["1"]` became `1` and `"0x10"` became `16`, so a client ignoring the JSON Schema could aim `delete_note` at an unrelated note.
- **Settings follow the public API contract** (#3), which differs from `SettingsService`'s internal one: `fileSuffix` is the extension itself and `customSuffix` is not part of it.
- **`set_note_category` is marked destructive** (#4) — it overwrites a category and moves the file.
- **Response and result sizes are bounded** (#5), configurable via `NEXTCLOUD_MAX_RESPONSE_BYTES`.
- **The documented install path works** (#6).
- **The uncategorized summary counts only uncategorized notes** (#7) rather than every note on the server.
- **Timeouts are validated at startup** (#8), capped at 2147483647 — above that Node's timer silently clamps the delay to 1ms instead of throwing.
- **`rename_category` reports what the server stored** (#9), not what was requested, since categories are sanitised and titles can be collision-resolved.
