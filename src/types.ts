/**
 * A note as returned by the Notes API.
 *
 * Every read/write field is optional here because `GET /notes?exclude=…` omits
 * whatever the caller asked it to drop, and because the API mixes id-only stubs
 * into some list responses (see `isNoteStub` in `api.ts`).
 */
export interface Note {
  /** Server-assigned id. This is also the note file's Nextcloud file id. */
  id: number;
  /** Entity tag; changes if and only if the note changes. Since API v1.2. */
  etag?: string;
  /** True when the underlying file was shared without edit permission. */
  readonly?: boolean;
  /** Note body. Markdown by convention, but the server stores it verbatim. */
  content?: string;
  /** Also the filename, so the server sanitises it and returns the result. */
  title?: string;
  /** Folder path relative to the notes folder; `""` means uncategorized. */
  category?: string;
  favorite?: boolean;
  /** Unix timestamp, seconds. */
  modified?: number;
  /** Path of the note file relative to the notes folder. Always sent. */
  internalPath?: string;
  /** Share types on the underlying file. Always sent. */
  shareTypes?: number[];
  isShared?: boolean;
  /**
   * True when the server could not read the note body.
   *
   * The API does not fail the request in that case: it returns a localised
   * error string *in the `content` field* and sets this flag. Anything that
   * writes content back must check this first, or it will persist the error
   * message over the real note.
   */
  error?: boolean;
  /** PHP exception class behind `error`, e.g. `OCP\Files\NotPermittedException`. */
  errorType?: string;
}

/**
 * Notes app settings, as exposed by `GET /settings`.
 *
 * The published API docs cover only `notesPath` and `fileSuffix`, but
 * `SettingsService` defines four more and a live server returns them. The index
 * signature keeps any further additions intact instead of silently dropping
 * them on a round-trip.
 */
export interface NotesSettings {
  /** Folder holding the note files, relative to the user's root. */
  notesPath?: string;
  /** Suffix given to newly created note files, e.g. `.md`, or `custom`. */
  fileSuffix?: string;
  /** Suffix used when `fileSuffix` is `custom`. */
  customSuffix?: string;
  /** Default editor mode for opening notes, e.g. `rich` or `edit`. */
  noteMode?: string;
  /** Whether dotfiles and dot-folders count as notes and categories. */
  showHidden?: boolean;
  /** Whether the app loads recent notes on start-up. */
  loadRecentOnStartUp?: boolean;
  [key: string]: unknown;
}

/** One category, derived from the notes that live in it. */
export interface CategorySummary {
  /** Full `/`-delimited path; `""` is the uncategorized pseudo-category. */
  category: string;
  /** Notes filed directly in this category. */
  noteCount: number;
  /** Notes in this category and every category beneath it. */
  noteCountRecursive: number;
}
