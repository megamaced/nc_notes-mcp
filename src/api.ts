import type { NextcloudClient, NotesResponse } from './http.js';
import type { CategorySummary, Note, NotesSettings } from './types.js';

/** Fields `GET /notes` and `GET /notes/{id}` accept in their `exclude` parameter. */
export type NoteField = 'content' | 'title' | 'category' | 'favorite' | 'modified' | 'readonly';

/**
 * True when a list entry carries nothing but an id.
 *
 * `NotesApiController::index` appends an id-only stub for every note that the
 * request's `pruneBefore` or chunk cursor filtered out of the full result, but
 * only on the last chunk. So a paged listing ends with stubs for every note the
 * earlier chunks already delivered in full, and a `pruneBefore` listing carries
 * stubs for everything unchanged since that timestamp. Both are protocol noise
 * for a stateless caller, which has no earlier response to reconcile them with.
 */
export function isNoteStub(note: Note): boolean {
  return Object.keys(note).length === 1 && 'id' in note;
}

/**
 * True when `category` is `parent` itself or nested beneath it.
 *
 * `""` is the uncategorized category, not a root that contains everything:
 * `work` is not nested inside it, it simply has no parent. Treating `""` as
 * universal would make the uncategorized row of a category summary report every
 * note on the server, and would disagree with `listNotes`, which refuses to
 * recurse from `""` for the same reason.
 */
export function isWithinCategory(category: string, parent: string): boolean {
  if (parent === '') return category === '';
  return category === parent || category.startsWith(`${parent}/`);
}

export interface ListNotesOptions {
  /**
   * Exact category to filter by. The server compares with `===`, so this does
   * not match subcategories — pass `recursive` to widen it client-side.
   */
  category?: string;
  /** Also return notes in categories nested beneath `category`. */
  recursive?: boolean;
  exclude?: NoteField[];
  /** Only return full notes changed at or after this Unix timestamp. */
  pruneBefore?: number;
  /** Cap the number of full notes per response. */
  chunkSize?: number;
  /** Cursor from a previous response's `chunkCursor`. */
  chunkCursor?: string;
}

export interface ListNotesResult {
  notes: Note[];
  /** Id-only stubs dropped from `notes`; see {@link isNoteStub}. */
  stubCount: number;
  chunkCursor: string | null;
  chunkPending: number | null;
}

/**
 * List notes, dropping the id-only stubs the API mixes in.
 *
 * A recursive category filter is applied here rather than server-side: the
 * server's filter is an exact string comparison, so `work` would miss
 * `work/clients`. Recursive listings therefore fetch the full set and filter
 * locally, which costs one unfiltered response.
 */
export async function listNotes(
  client: NextcloudClient,
  opts: ListNotesOptions = {},
): Promise<ListNotesResult> {
  const recursive = opts.recursive === true && opts.category !== undefined && opts.category !== '';

  const res: NotesResponse<Note[]> = await client.notes<Note[]>('GET', '/notes', {
    query: {
      // Let the server filter only when it can do so correctly.
      category: recursive ? undefined : opts.category,
      exclude: opts.exclude?.length ? opts.exclude.join(',') : undefined,
      pruneBefore: opts.pruneBefore,
      chunkSize: opts.chunkSize,
      chunkCursor: opts.chunkCursor,
    },
  });

  const all = Array.isArray(res.data) ? res.data : [];
  const full = all.filter((n) => !isNoteStub(n));
  const notes = recursive
    ? full.filter((n) => isWithinCategory(n.category ?? '', opts.category!))
    : full;

  return {
    notes,
    stubCount: all.length - full.length,
    chunkCursor: res.chunkCursor,
    chunkPending: res.chunkPending,
  };
}

/** Fetch one note, including its etag. */
export async function getNote(
  client: NextcloudClient,
  id: number,
  exclude?: NoteField[],
): Promise<Note> {
  const res = await client.notes<Note>('GET', `/notes/${id}`, {
    query: { exclude: exclude?.length ? exclude.join(',') : undefined },
  });
  // The note carries its own etag since API v1.2; fall back to the response
  // header on older servers so callers always have something to pass to PUT.
  return { ...res.data, etag: res.data.etag ?? res.etag ?? undefined };
}

export interface NoteInput {
  title?: string;
  content?: string;
  category?: string;
  favorite?: boolean;
  /** Unix timestamp, seconds. Defaults to now when omitted. */
  modified?: number;
}

/**
 * Create a note.
 *
 * The server sanitises `title` and `category` (they become a filename and a
 * folder path), so the returned note is authoritative — the caller should adopt
 * the values it sends back rather than the ones it requested.
 */
export async function createNote(client: NextcloudClient, input: NoteInput): Promise<Note> {
  const res = await client.notes<Note>('POST', '/notes', { body: input });
  return { ...res.data, etag: res.data.etag ?? res.etag ?? undefined };
}

/**
 * Update a note in place.
 *
 * Passing `etag` makes the write conditional: if the note changed on the server
 * first, the request is refused and a `ConflictError` carrying the server's
 * current copy is thrown instead of silently overwriting the other change.
 */
export async function updateNote(
  client: NextcloudClient,
  id: number,
  patch: NoteInput,
  etag?: string,
): Promise<Note> {
  const res = await client.notes<Note>('PUT', `/notes/${id}`, { body: patch, etag });
  return { ...res.data, etag: res.data.etag ?? res.etag ?? undefined };
}

export async function deleteNote(client: NextcloudClient, id: number): Promise<void> {
  await client.notes('DELETE', `/notes/${id}`);
}

/**
 * Append text to a note's content.
 *
 * The API has no append operation, so this is a read-modify-write. It reuses
 * the etag from its own read, which narrows the lost-update window to the gap
 * between the two calls rather than leaving it open.
 */
export async function appendToNote(
  client: NextcloudClient,
  id: number,
  text: string,
  separator = '\n\n',
): Promise<Note> {
  const current = await getNote(client, id);
  // `Note::getData` puts a localised error string in `content` when the body
  // could not be read, rather than failing the request. Appending to that and
  // writing it back would replace the note with its own error message.
  if (current.error === true) {
    throw new Error(
      `Refusing to append: the server could not read note ${id}` +
        `${current.errorType ? ` (${current.errorType})` : ''}, so its content is an error ` +
        'message rather than the note body. Appending would overwrite the note.',
    );
  }
  const body = current.content ?? '';
  const content = body === '' ? text : `${body}${separator}${text}`;
  return updateNote(client, id, { content }, current.etag);
}

/**
 * Derive the category list from the notes themselves.
 *
 * The Notes app computes a category list by walking the notes folder, but the
 * public API controller discards it — only the app's own CSRF-protected
 * endpoint returns it. Deriving from notes has one visible consequence: a
 * category holding no notes does not appear, even though the Notes UI shows it.
 */
export async function listCategories(client: NextcloudClient): Promise<CategorySummary[]> {
  const { notes } = await listNotes(client, {
    exclude: ['content', 'title', 'favorite', 'modified'],
  });

  const direct = new Map<string, number>();
  for (const note of notes) {
    const category = note.category ?? '';
    direct.set(category, (direct.get(category) ?? 0) + 1);
    // Register every ancestor so an intermediate category with no notes of its
    // own still appears, with a direct count of zero.
    const parts = category.split('/');
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/');
      if (!direct.has(ancestor)) direct.set(ancestor, 0);
    }
  }

  return [...direct.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((category) => ({
      category,
      noteCount: direct.get(category) ?? 0,
      noteCountRecursive: notes.filter((n) => isWithinCategory(n.category ?? '', category)).length,
    }));
}

/**
 * Move every note in a category to a new one.
 *
 * There is no server-side rename: a category is a folder derived from each
 * note's `category` field, so renaming means rewriting every affected note.
 * The writes are not atomic, so the per-note outcome is reported rather than
 * collapsed into one success or failure.
 */
export interface RenameCategoryResult {
  moved: {
    id: number;
    /** Title as the server reports it after the move. */
    title: string;
    from: string;
    /** Category as the server stored it. */
    to: string;
    /** Present only when the server sanitised the path into something else. */
    requested?: string;
  }[];
  failed: { id: number; title: string; error: string }[];
}

export async function renameCategory(
  client: NextcloudClient,
  from: string,
  to: string,
  recursive: boolean,
): Promise<RenameCategoryResult> {
  const { notes } = await listNotes(client, {
    category: from,
    recursive,
    exclude: ['content'],
  });

  const result: RenameCategoryResult = { moved: [], failed: [] };
  for (const note of notes) {
    const current = note.category ?? '';
    // A recursive rename re-parents the whole subtree: `work/clients` under a
    // `work` -> `archive/work` rename becomes `archive/work/clients`.
    const next = current === from ? to : `${to}${current.slice(from.length)}`;
    const title = note.title ?? `#${note.id}`;
    try {
      // Report what the server stored, not what was asked for: it sanitises
      // category segments and resolves title collisions, so the requested path
      // is not necessarily the one that now exists.
      const updated = await updateNote(client, note.id, { category: next }, note.etag);
      const actual = updated.category ?? next;
      result.moved.push({
        id: note.id,
        title: updated.title ?? title,
        from: current,
        to: actual,
        ...(actual === next ? {} : { requested: next }),
      });
    } catch (err) {
      result.failed.push({ id: note.id, title, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

export async function getSettings(client: NextcloudClient): Promise<NotesSettings> {
  const res = await client.notes<NotesSettings>('GET', '/settings');
  return res.data;
}

export async function updateSettings(
  client: NextcloudClient,
  patch: Partial<NotesSettings>,
): Promise<NotesSettings> {
  const res = await client.notes<NotesSettings>('PUT', '/settings', { body: patch });
  return res.data;
}
