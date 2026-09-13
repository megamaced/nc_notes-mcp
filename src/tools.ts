import { z, type ZodTypeAny } from 'zod';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import {
  appendToNote,
  createNote,
  deleteNote,
  getNote,
  getSettings,
  listCategories,
  listNotes,
  renameCategory,
  updateNote,
  updateSettings,
  type NoteField,
} from './api.js';
import { ConflictError, HttpError, type NextcloudClient } from './http.js';

interface Context {
  client: NextcloudClient;
  configSummary: string;
}

interface ToolDef<S extends ZodTypeAny> {
  tool: Tool;
  argsSchema: S;
  handler: (args: z.infer<S>, ctx: Context) => Promise<CallToolResult>;
}

const Empty = z.object({}).strict();

/**
 * A boolean argument that tolerates MCP clients which serialise scalars as
 * strings, without the footgun `z.coerce.boolean()` carries: that is just
 * `Boolean(value)`, so every non-empty string — including "false" — becomes
 * `true`. Accept real booleans and the two unambiguous string spellings, and
 * reject anything else so a caller gets an error rather than the inverse of
 * what they asked for.
 */
const Bool = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);

/**
 * A note id: a positive safe integer, or the decimal string spelling of one.
 *
 * Not `z.coerce.number()`, which is `Number(value)` and therefore accepts far
 * more than the advertised `integer` schema: `true` and `["1"]` both become
 * `1`, and `"0x10"` becomes `16`. A client that ignores the published schema
 * could aim a destructive tool at an unrelated note that way, so the grammar is
 * enforced here rather than assumed. The JSON Schema is the documentation; this
 * is the trust boundary.
 */
const NoteId = z
  .union([z.number(), z.string().regex(/^[1-9]\d*$/, 'must be a positive decimal integer')])
  .transform((v) => (typeof v === 'number' ? v : Number(v)))
  .refine((n) => Number.isSafeInteger(n) && n > 0, {
    message: 'must be a positive integer within the safe integer range',
  });

const ExcludableFields = z.array(
  z.enum(['content', 'title', 'category', 'favorite', 'modified', 'readonly']),
);

/**
 * Largest JSON result handed back to the client.
 *
 * A result far past this is unusable anyway: it displaces the caller's context
 * rather than informing it. Refusing with guidance beats truncating, which
 * would produce invalid JSON the caller cannot parse.
 */
const MAX_RESULT_BYTES = 1024 * 1024;

function jsonResult(data: unknown, guidance?: string): CallToolResult {
  const text = JSON.stringify(data, null, 2);
  const size = Buffer.byteLength(text, 'utf8');
  if (size > MAX_RESULT_BYTES) {
    return errorResult(
      `Result too large: ${size} bytes exceeds the ${MAX_RESULT_BYTES}-byte limit.` +
        (guidance ? ` ${guidance}` : ''),
    );
  }
  return { content: [{ type: 'text', text }] };
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

// -----------------------------------------------------------------------------
// ping
// -----------------------------------------------------------------------------

const pingTool: ToolDef<typeof Empty> = {
  argsSchema: Empty,
  tool: {
    name: 'ping',
    description:
      'Verify connectivity and credentials against the Nextcloud Notes API. ' +
      'Returns the configured server, user and the notes folder settings.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: {
      title: 'Check connection',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (_args, ctx) => {
    const settings = await getSettings(ctx.client);
    return jsonResult({ ok: true, target: ctx.configSummary, settings });
  },
};

// -----------------------------------------------------------------------------
// Notes
// -----------------------------------------------------------------------------

const ListNotesArgs = z
  .object({
    category: z.string().optional(),
    recursive: Bool.optional(),
    exclude: ExcludableFields.optional(),
    pruneBefore: z.coerce.number().int().nonnegative().optional(),
    chunkSize: z.coerce.number().int().positive().optional(),
    chunkCursor: z.string().optional(),
  })
  .strict();

const listNotesTool: ToolDef<typeof ListNotesArgs> = {
  argsSchema: ListNotesArgs,
  tool: {
    name: 'list_notes',
    description:
      'List notes, optionally filtered by category. The server matches categories exactly, ' +
      'so pass recursive=true to include subcategories such as "work/clients" under "work". ' +
      'Use exclude=["content"] to keep the response small when only metadata is needed.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Category path; "" means uncategorized.' },
        recursive: { type: 'boolean', description: 'Include notes in nested subcategories.' },
        exclude: {
          type: 'array',
          items: { type: 'string', enum: ['content', 'title', 'category', 'favorite', 'modified', 'readonly'] },
          description: 'Fields to omit from each note, to reduce response size.',
        },
        pruneBefore: { type: 'integer', description: 'Only return notes modified at or after this Unix timestamp.' },
        chunkSize: { type: 'integer', description: 'Maximum notes per response.' },
        chunkCursor: { type: 'string', description: 'Cursor from a previous response.' },
      },
      additionalProperties: false,
    },
    annotations: {
      title: 'List notes',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    const result = await listNotes(ctx.client, {
      category: args.category,
      recursive: args.recursive,
      exclude: args.exclude as NoteField[] | undefined,
      pruneBefore: args.pruneBefore,
      chunkSize: args.chunkSize,
      chunkCursor: args.chunkCursor,
    });
    return jsonResult(
      {
        count: result.notes.length,
        notes: result.notes,
        ...(result.chunkCursor
          ? { chunkCursor: result.chunkCursor, chunkPending: result.chunkPending }
          : {}),
      },
      'Retry with exclude=["content"] for metadata only, or a chunkSize to page through them.',
    );
  },
};

const GetNoteArgs = z
  .object({ id: NoteId, exclude: ExcludableFields.optional() })
  .strict();

const getNoteTool: ToolDef<typeof GetNoteArgs> = {
  argsSchema: GetNoteArgs,
  tool: {
    name: 'get_note',
    description:
      'Fetch one note including its content and etag. Pass the etag to update_note to make ' +
      'the write conditional on nothing else having changed the note first.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        exclude: {
          type: 'array',
          items: { type: 'string', enum: ['content', 'title', 'category', 'favorite', 'modified', 'readonly'] },
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Read note',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await getNote(ctx.client, args.id, args.exclude as NoteField[] | undefined)),
};

const CreateNoteArgs = z
  .object({
    title: z.string().optional(),
    content: z.string().optional(),
    category: z.string().optional(),
    favorite: Bool.optional(),
  })
  .strict();

const createNoteTool: ToolDef<typeof CreateNoteArgs> = {
  argsSchema: CreateNoteArgs,
  tool: {
    name: 'create_note',
    description:
      'Create a note. The category is a "/"-delimited folder path and is created automatically ' +
      'if missing. The server sanitises the title and category, so use the values in the ' +
      'response rather than the ones supplied.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string' },
        category: { type: 'string', description: 'e.g. "work/clients"; omit for uncategorized.' },
        favorite: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    annotations: {
      title: 'Create note',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => jsonResult(await createNote(ctx.client, args)),
};

const UpdateNoteArgs = z
  .object({
    id: NoteId,
    title: z.string().optional(),
    content: z.string().optional(),
    category: z.string().optional(),
    favorite: Bool.optional(),
    etag: z.string().optional(),
  })
  .strict()
  .refine(
    (a) =>
      a.title !== undefined ||
      a.content !== undefined ||
      a.category !== undefined ||
      a.favorite !== undefined,
    { message: 'Supply at least one of title, content, category or favorite.' },
  );

const updateNoteTool: ToolDef<typeof UpdateNoteArgs> = {
  argsSchema: UpdateNoteArgs,
  tool: {
    name: 'update_note',
    description:
      'Update a note. Only the supplied fields change. Passing content replaces the whole body — ' +
      'use append_to_note to add to it. Pass the etag from get_note to refuse the write if ' +
      'someone else changed the note first.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        title: { type: 'string' },
        content: { type: 'string', description: 'Replaces the entire note body.' },
        category: { type: 'string' },
        favorite: { type: 'boolean' },
        etag: { type: 'string', description: 'Last known etag, for conflict detection.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Update note',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    const { id, etag, ...patch } = args;
    return jsonResult(await updateNote(ctx.client, id, patch, etag));
  },
};

const AppendArgs = z
  .object({ id: NoteId, text: z.string().min(1), separator: z.string().optional() })
  .strict();

const appendToNoteTool: ToolDef<typeof AppendArgs> = {
  argsSchema: AppendArgs,
  tool: {
    name: 'append_to_note',
    description:
      'Append text to the end of a note without resending its whole body. Reads the note and ' +
      'writes it back conditionally, so a concurrent edit is reported rather than overwritten.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        text: { type: 'string' },
        separator: { type: 'string', description: 'Inserted between the existing body and the new text. Default: a blank line.' },
      },
      required: ['id', 'text'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Append to note',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await appendToNote(ctx.client, args.id, args.text, args.separator)),
};

const DeleteNoteArgs = z.object({ id: NoteId }).strict();

const deleteNoteTool: ToolDef<typeof DeleteNoteArgs> = {
  argsSchema: DeleteNoteArgs,
  tool: {
    name: 'delete_note',
    description:
      "Delete a note. The note file goes to the Nextcloud trash, so it is recoverable from the " +
      'Files app until the trash is emptied, but this server cannot restore it.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Delete note',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    await deleteNote(ctx.client, args.id);
    return textResult(`Deleted note ${args.id}.`);
  },
};

// -----------------------------------------------------------------------------
// Categories
// -----------------------------------------------------------------------------

const listCategoriesTool: ToolDef<typeof Empty> = {
  argsSchema: Empty,
  tool: {
    name: 'list_categories',
    description:
      'List every category that contains at least one note, with direct and recursive note ' +
      'counts. Categories are derived from the notes themselves because the Notes API has no ' +
      'endpoint for them, so a category holding no notes will not appear here even though the ' +
      'Notes app shows it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: {
      title: 'List categories',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (_args, ctx) => jsonResult(await listCategories(ctx.client)),
};

const SetCategoryArgs = z
  .object({ id: NoteId, category: z.string(), etag: z.string().optional() })
  .strict();

const setNoteCategoryTool: ToolDef<typeof SetCategoryArgs> = {
  argsSchema: SetCategoryArgs,
  tool: {
    name: 'set_note_category',
    description:
      'Move a note to a category, creating the category if it does not exist. Pass "" to make ' +
      'the note uncategorized. Any attachments move with the note.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        category: { type: 'string', description: '"/"-delimited path; "" for uncategorized.' },
        etag: { type: 'string' },
      },
      required: ['id', 'category'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Set note category',
      readOnlyHint: false,
      // Overwrites the note's existing category and moves the file: a move, not
      // an additive update, so clients should treat it as they treat any other
      // overwrite.
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) =>
    jsonResult(await updateNote(ctx.client, args.id, { category: args.category }, args.etag)),
};

const RenameCategoryArgs = z
  .object({ from: z.string().min(1), to: z.string(), recursive: Bool.optional() })
  .strict();

const renameCategoryTool: ToolDef<typeof RenameCategoryArgs> = {
  argsSchema: RenameCategoryArgs,
  tool: {
    name: 'rename_category',
    description:
      'Rename a category by moving every note in it. The Notes API has no category rename, so ' +
      'this rewrites each note individually and is not atomic: a partial failure leaves some ' +
      'notes moved. The per-note outcome is reported. Pass recursive=true to re-parent nested ' +
      'subcategories too.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string', description: '"" moves the notes to uncategorized.' },
        recursive: { type: 'boolean', description: 'Also re-parent nested subcategories.' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Rename category',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    const result = await renameCategory(ctx.client, args.from, args.to, args.recursive === true);
    return jsonResult({
      movedCount: result.moved.length,
      failedCount: result.failed.length,
      ...result,
    });
  },
};

// -----------------------------------------------------------------------------
// Settings
// -----------------------------------------------------------------------------

const getSettingsTool: ToolDef<typeof Empty> = {
  argsSchema: Empty,
  tool: {
    name: 'get_settings',
    description:
      'Read the Notes app settings: notes folder, file suffix, editor mode, and whether hidden ' +
      'files count as notes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: {
      title: 'Read settings',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (_args, ctx) => jsonResult(await getSettings(ctx.client)),
};

const SETTINGS_KEYS = ['notesPath', 'fileSuffix', 'noteMode', 'showHidden', 'loadRecentOnStartUp'] as const;

const UpdateSettingsArgs = z
  .object({
    notesPath: z.string().optional(),
    fileSuffix: z.string().optional(),
    noteMode: z.string().optional(),
    showHidden: Bool.optional(),
    loadRecentOnStartUp: Bool.optional(),
  })
  .strict()
  .refine((a) => SETTINGS_KEYS.some((k) => a[k] !== undefined), {
    message: `Supply at least one of ${SETTINGS_KEYS.join(', ')}.`,
  });

const updateSettingsTool: ToolDef<typeof UpdateSettingsArgs> = {
  argsSchema: UpdateSettingsArgs,
  tool: {
    name: 'update_settings',
    description:
      'Change the Notes app settings. Set fileSuffix to the extension itself, including the ' +
      'dot — ".md", ".org", or any custom extension; the server stores a non-standard one as ' +
      'the custom suffix. Changing notesPath re-points the app at a different folder: notes in ' +
      'the old folder stop appearing in Notes until it is pointed back.',
    inputSchema: {
      type: 'object',
      properties: {
        notesPath: { type: 'string', description: "Folder for note files, relative to the user's root." },
        fileSuffix: { type: 'string', description: 'Suffix for new note files, e.g. ".md" or ".org". Any extension is accepted.' },
        noteMode: { type: 'string', description: 'Default editor mode, e.g. "rich" or "edit".' },
        showHidden: { type: 'boolean', description: 'Count dotfiles and dot-folders as notes and categories.' },
        loadRecentOnStartUp: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    annotations: {
      title: 'Update settings',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => jsonResult(await updateSettings(ctx.client, args)),
};

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------

const REGISTRY = {
  ping: pingTool,
  list_notes: listNotesTool,
  get_note: getNoteTool,
  create_note: createNoteTool,
  update_note: updateNoteTool,
  append_to_note: appendToNoteTool,
  delete_note: deleteNoteTool,
  list_categories: listCategoriesTool,
  set_note_category: setNoteCategoryTool,
  rename_category: renameCategoryTool,
  get_settings: getSettingsTool,
  update_settings: updateSettingsTool,
} as const;

export const TOOLS: Tool[] = Object.values(REGISTRY).map((d) => d.tool);

export async function dispatchTool(
  name: string,
  rawArgs: unknown,
  ctx: Context,
): Promise<CallToolResult> {
  const def = (REGISTRY as unknown as Record<string, ToolDef<ZodTypeAny>>)[name];
  if (!def) {
    return errorResult(`Unknown tool: ${name}`);
  }

  const parseResult = def.argsSchema.safeParse(rawArgs ?? {});
  if (!parseResult.success) {
    return errorResult(
      `Invalid arguments for ${name}: ${parseResult.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`,
    );
  }

  try {
    return await def.handler(parseResult.data, ctx);
  } catch (err) {
    // A conflict carries the server's current copy of the note. Hand it back so
    // the caller can merge and retry without another round-trip.
    if (err instanceof ConflictError) {
      return errorResult(`${err.message}\n\ncurrent:\n${JSON.stringify(err.current, null, 2)}`);
    }
    if (err instanceof HttpError) {
      return errorResult(err.message);
    }
    if (err instanceof Error) {
      return errorResult(err.message);
    }
    return errorResult(String(err));
  }
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}
