# Nextcloud Notes API — Verified Endpoint Reference

Cross-checked against the [official API docs](https://github.com/nextcloud/notes/blob/main/docs/api/v1.md), the [app source](https://github.com/nextcloud/notes), and a live Nextcloud instance.

All paths are relative to `/index.php/apps/notes/api/v1`. All requests use Basic Auth with an app-password.

This is **not** an OCS API: responses are bare JSON, there is no `ocs.meta` envelope, no `OCS-APIRequest` header is required, and failures arrive as ordinary HTTP status codes.

## Gotchas

1. **The `category` filter is an exact match, not a prefix.** `Helper::getNotesAndCategories` compares with `===`, so `?category=work` returns notes filed directly in `work` and excludes `work/clients`. Recursive listing has to be done client-side, on an unfiltered response.

2. **There is no endpoint that lists categories.** `Helper::getNotesAndCategories` computes one, but `NotesApiController::index` returns `array_values($notesData)` and throws it away. Only the app's own CSRF-protected web controller returns it. Derive the list from the notes instead.

3. **Empty categories are therefore invisible.** The app builds its category list by walking the notes folder, so every folder is a category whether or not it holds notes. A list derived from notes cannot see an empty one, and the Notes UI will show a category this API does not.

   Do not work around this by scraping the internal endpoint: `NotesService::gatherNoteFiles` merges sub-lists with PHP's `+` array operator on numerically-indexed arrays, which keeps the left operand's keys, so nested subcategories are silently dropped from that list at depth.

4. **List responses mix in id-only stubs.** On the last chunk, `NotesApiController::index` appends `{"id": N}` for every note that `pruneBefore` or the chunk cursor filtered out. A paged listing therefore ends with stubs for everything the earlier chunks already delivered in full. They are protocol noise for a stateless caller; filter for entries whose only key is `id`.

5. **An unreadable note is reported in-band, not as an HTTP error.** When `Note::getData` cannot read the file it returns HTTP 200 with a *localised error string in the `content` field*, plus `error: true`, `errorType: <PHP exception class>`, and `readonly` forced to true. Anything that does read-modify-write on content must check `error` first, or it will persist the error message over the note.

6. **The note id is the Nextcloud file id.** `Note::getId()` returns `$this->file->getId()`. That makes the id usable directly against other file-scoped APIs — system tags, comments, shares — without a path lookup.

7. **A 412 carries the note, not just a status.** `If-Match` rejections return the note's current server state in the response body specifically so the client can merge. Treat 412 as data, not as a bare failure.

8. **`title` and `category` are sanitised server-side.** Both become filesystem paths: illegal characters are stripped, and a duplicate title gets a sequential number appended. The response is authoritative — adopt the values it returns, not the ones you sent.

9. **There is no category rename, move, or delete.** A category exists only as the `category` field on each note. Renaming one means rewriting every note in it, non-atomically.

10. **Notes carry five fields the docs do not mention,** all unconditional: `internalPath`, `shareTypes`, `isShared`, `error`, `errorType`.

11. **Settings has six keys, not the two documented.** `SettingsService` defines `notesPath`, `fileSuffix`, `customSuffix`, `noteMode`, `showHidden` and `loadRecentOnStartUp`. A live server returns `noteMode`; the published docs list only the first two.

12. **`showHidden` changes what counts as a note.** It is a settings flag, but it governs the folder walk: with it set, dotfiles and dot-folders become notes and categories.

13. **Only these extensions are notes:** `txt`, `org`, `markdown`, `md`, `note`, plus the user's `customSuffix`. A file in the notes folder with any other extension is invisible to the API.

14. **Per-note attachment folders are not categories.** `gatherNoteFiles` skips folders matching `^\.attachments\.\d+$`. They move with the note when its category changes.

---

## Notes

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/notes` | Query: `category` (exact), `exclude`, `pruneBefore`, `chunkSize`, `chunkCursor`. Headers out: `ETag`, `Last-Modified`, `X-Notes-Chunk-Cursor`, `X-Notes-Chunk-Pending`. |
| `GET` | `/notes/{id}` | Query: `exclude`. Header out: `ETag`. |
| `POST` | `/notes` | Body: any read/write attributes. Creates the category folder if needed. |
| `PUT` | `/notes/{id}` | Body: the attributes to change. Header in: `If-Match`. `412` returns the current note. |
| `DELETE` | `/notes/{id}` | Moves the file to the Nextcloud trash; recoverable from Files, not from this API. |

### Note attributes

| Attribute | Access | Notes |
| --- | --- | --- |
| `id` | read-only | Also the Nextcloud file id. |
| `etag` | read-only | Changes if and only if the note changes. Since API v1.2. |
| `readonly` | read-only | True for a note shared without edit permission, or one whose body could not be read. |
| `content` | read/write | Markdown by convention; stored verbatim. Holds an error string when `error` is true. |
| `title` | read/write | Also the filename. Sanitised on write. |
| `category` | read/write | Folder path, `/`-delimited. `""` is uncategorized — never `null`. |
| `favorite` | read/write | Backed by the files favorite tag, not a Notes concept. |
| `modified` | read/write | Unix timestamp, seconds. Defaults to now. |
| `internalPath` | read-only | Undocumented. Path relative to the notes folder. |
| `shareTypes` | read-only | Undocumented. |
| `isShared` | read-only | Undocumented. `shareTypes` is non-empty. |
| `error` | read-only | Undocumented. See gotcha 5. |
| `errorType` | read-only | Undocumented. PHP exception class. |

Excludable via `exclude`: `content`, `title`, `category`, `favorite`, `modified`, `readonly`. `id` and the five undocumented fields are always sent.

### Status codes

| Code | Meaning |
| --- | --- |
| `400` | Invalid id. |
| `401` | Bad or revoked credentials. |
| `403` | The note is read-only. |
| `404` | No such note, or the Notes app is not enabled for this user. |
| `412` | `If-Match` failed; body holds the current note. |
| `507` | Out of storage. |

---

## Settings

| Method | Path |
| --- | --- |
| `GET` | `/settings` |
| `PUT` | `/settings` |

| Key | Type | Notes |
| --- | --- | --- |
| `notesPath` | string | Notes folder, relative to the user's root. |
| `fileSuffix` | string | Suffix for new notes, or `custom`. |
| `customSuffix` | string | Used when `fileSuffix` is `custom`. Undocumented. |
| `noteMode` | string | Default editor mode, e.g. `rich`. Undocumented. |
| `showHidden` | boolean | See gotcha 12. Undocumented. |
| `loadRecentOnStartUp` | boolean | Undocumented. |

---

## Attachments

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/attachment/{id}` | Not yet implemented by this server. |
| `POST` | `/attachment/{id}` | Returns the path the image was stored at. Not yet implemented by this server. |
