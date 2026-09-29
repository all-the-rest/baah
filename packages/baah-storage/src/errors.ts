/**
 * Typed storage errors.
 *
 * Errors must never be thrown across the worker boundary: a thrown `Error`
 * loses its class, and a `DOMException` does not survive `postMessage` at all.
 * Everything is flattened into a {@link StorageErrorPayload}, which is a plain
 * JSON-ish structure, and rebuilt on the other side.
 */

export type StorageErrorCode =
  /** An incoming worker message did not match the protocol schema. */
  | "invalid_message"
  /** Another context (tab/worker) already owns the `opfs-sahpool` VFS. */
  | "database_owned_by_another_context"
  /** `openDatabase()` was called twice in this page. */
  | "database_already_open"
  /** A statement arrived before `open` succeeded. */
  | "database_not_open"
  /** A statement arrived after `close`. */
  | "database_closed"
  /** SQLite rejected the statement (`SQLITE_*`). */
  | "sql_error"
  /** `tx` was called while a `tx` batch is still running. */
  | "nested_transaction"
  /** The backend genuinely cannot do this (e.g. SQL on the in-memory factory). */
  | "unsupported"
  | "internal";

export interface StorageErrorPayload {
  code: StorageErrorCode;
  message: string;
  /** Flat string map — structured-clone safe, no nested objects. */
  details: Record<string, string>;
}

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly details: Record<string, string>;

  constructor(
    code: StorageErrorCode,
    message: string,
    details: Record<string, string> = {},
  ) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.details = { ...details };
  }

  toPayload(): StorageErrorPayload {
    return { code: this.code, message: this.message, details: { ...this.details } };
  }

  static fromPayload(payload: StorageErrorPayload): StorageError {
    return new StorageError(payload.code, payload.message, payload.details);
  }
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" ? raw : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "number" ? raw : undefined;
}

/**
 * Normalise an unknown thrown value into a {@link StorageError}.
 *
 * SQLite-WASM throws plain objects (`{ resultCode, resultCodeName, message }`),
 * Emscripten throws `Error`, and the OPFS layer throws `DOMException` — all of
 * them are reduced to a code plus a flat detail map.
 */
export function toStorageError(
  error: unknown,
  fallbackCode: StorageErrorCode = "internal",
): StorageError {
  if (error instanceof StorageError) return error;

  const message = readString(error, "message") ?? String(error);
  const details: Record<string, string> = {};

  const name = readString(error, "name");
  if (name !== undefined) details["name"] = name;

  const code = readNumber(error, "resultCode");
  if (code !== undefined) details["sqliteCode"] = String(code);

  const codeName = readString(error, "resultCodeName");
  if (codeName !== undefined) details["sqliteCodeName"] = codeName;

  return new StorageError(fallbackCode, message, details);
}

/**
 * DOM exception names a browser throws when a `FileSystemSyncAccessHandle`
 * cannot be acquired because another context already holds it.
 */
const OWNERSHIP_ERROR_NAMES = new Set([
  "NoModificationAllowedError",
  "InvalidStateError",
  "NotAllowedError",
  "NotReadableError",
  "SecurityError",
]);

const OWNERSHIP_MESSAGE_HINTS = [
  "lock",
  "already",
  "in use",
  "another",
  "exclusive",
];

/**
 * Decide whether a failed `installOpfsSAHPoolVfs()` means "somebody else owns
 * this database" rather than "the browser is broken".
 *
 * The VFS acquires a `FileSystemSyncAccessHandle` per pool file; a second tab
 * that tries the same directory fails there, and the exact exception differs
 * per browser. So this is name- *and* message-based, deliberately.
 *
 * UNVERIFIED: the concrete exception each browser throws for the double-acquire
 * was not measured (needs two real tabs). Treat a match as a strong hint, not a
 * proof, and keep the raw `name` in `details` for the report.
 */
export function isOwnershipFailure(error: unknown): boolean {
  if (error instanceof StorageError) return error.code === "database_owned_by_another_context";

  const name = readString(error, "name");
  if (name !== undefined && OWNERSHIP_ERROR_NAMES.has(name)) return true;

  const message = (readString(error, "message") ?? String(error)).toLowerCase();
  return OWNERSHIP_MESSAGE_HINTS.some((hint) => message.includes(hint));
}

/** Build the typed "this database belongs to another context" error. */
export function ownershipError(cause: unknown): StorageError {
  const normalised = toStorageError(cause, "database_owned_by_another_context");
  return new StorageError(
    "database_owned_by_another_context",
    "The SQLite database is owned by another context. opfs-sahpool allows exactly one " +
      "connection per origin and directory, so a second tab or worker cannot open it.",
    normalised.details,
  );
}
