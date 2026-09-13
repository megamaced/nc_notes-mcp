# Changelog

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
