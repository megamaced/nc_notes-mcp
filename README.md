# notes-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Nextcloud Notes](https://github.com/nextcloud/notes) — exposes notes, categories and app settings to Claude and any MCP-compatible client.

## How it works

The server speaks one API: the Notes REST API at `/index.php/apps/notes/api/v1`.

Unlike most Nextcloud apps this is not an OCS endpoint — it returns bare JSON with conventional HTTP status codes, and note bodies travel inline in the `content` field. There is no WebDAV leg, so no path arithmetic and no file locking to contend with.

Details and the behaviours that are not in the published API docs are in [ENDPOINTS.md](ENDPOINTS.md).

## Tools exposed (12)

- **Notes:** `list_notes`, `get_note`, `create_note`, `update_note`, `append_to_note`, `delete_note`
- **Categories:** `list_categories`, `set_note_category`, `rename_category`
- **Settings:** `get_settings`, `update_settings`
- **Other:** `ping`

Every tool declares MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), so clients can distinguish a read from an irreversible delete without parsing descriptions.

### Concurrency

`get_note` returns the note's `etag`. Passing it back to `update_note` makes the write conditional: if the note changed on the server in the meantime, the write is refused and the error carries the server's current copy of the note, so a caller can merge and retry without a second round-trip. `append_to_note` does this internally.

### Categories

A category is a folder under the notes folder, named by each note's `category` field and nested with `/`. Two consequences shape the tools:

- The server's `category` filter is an exact string comparison, so `list_notes` takes `recursive` to include subcategories such as `work/clients` under `work`.
- There is no category endpoint and no server-side rename. `list_categories` derives the list from the notes themselves, so a category holding no notes does not appear. `rename_category` rewrites every affected note individually and reports the per-note outcome, because the operation is not atomic.

## Install

```bash
corepack pnpm install
corepack pnpm build
```

## Configuration

Add to your MCP client config (Claude Code shown):

```json
{
  "mcpServers": {
    "notes": {
      "command": "notes-mcp",
      "args": [],
      "env": {
        "NEXTCLOUD_URL": "https://your-nextcloud.example.com",
        "NEXTCLOUD_USER": "your-username",
        "NEXTCLOUD_APP_PASSWORD": "xxxx-xxxx-xxxx-xxxx-xxxx"
      }
    }
  }
}
```

**Generate the app-password** in Nextcloud under Settings > Security > Devices & sessions > "Create new app password". The MCP server only needs an app-password, never your real account password — and you can revoke it without affecting your main login.

## Development

```bash
corepack pnpm install
corepack pnpm dev        # stdio MCP server, point mcp inspector at it
corepack pnpm test       # deterministic unit tests, no Nextcloud required
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build      # tsc -> dist/
```

Required env vars: `NEXTCLOUD_URL`, `NEXTCLOUD_USER`, `NEXTCLOUD_APP_PASSWORD`. Optional: `NEXTCLOUD_TIMEOUT_MS` (per-request deadline, default 60000), `DEBUG` (log each request to stderr).

## Disclosure

This project was 100% written by AI (Claude), including all source code, tests, CI configuration, and documentation.

## License

MIT — see [LICENSE](LICENSE).

## Related

- [Nextcloud Notes](https://github.com/nextcloud/notes) and its [API reference](https://github.com/nextcloud/notes/blob/main/docs/api/v1.md)
- [nc_collectives-mcp](https://github.com/megamaced/nc_collectives-mcp) — the same approach for Nextcloud Collectives
- [Model Context Protocol](https://modelcontextprotocol.io)
