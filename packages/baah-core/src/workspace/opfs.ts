/**
 * The OPFS workspace: a private sandbox directory of the browser's own.
 *
 * This is the mode every browser can do (Chrome 108+, Firefox 111+, Safari
 * 16.4+ — Plan.md §14.1) and the only one that works from a Web Worker without
 * a user gesture, because OPFS handles carry no permission prompt: the agent
 * works on a *copy* of the user's project, never in place. The UI must say so.
 *
 * Two eviction facts drive the code (Plan.md §5.3, §14.1):
 *
 * 1. OPFS is best-effort storage. Safari deletes script-created data after
 *    **7 days without interaction** and Chromium does the same under storage
 *    pressure. We therefore ask for `navigator.storage.persist()` on open and
 *    report whether it was granted — the UI shows a warning and keeps
 *    export/import a first-class feature, not a side feature.
 * 2. There is one directory per workspace so two sessions cannot collide.
 *
 * Import path: `@all-the.rest/baah-core/workspace/opfs.ts`
 */

import {
  createDirectoryWorkspace,
  type DirectoryWorkspace,
  type WorkspaceDescription,
  type WorkspaceKind,
} from "./directory-workspace.ts";
import { isDirectoryHandle } from "./paths.ts";
import { guardHandle } from "./errors.ts";

/** Storage usage against the quota, for the eviction warning in the UI. */
export interface StorageEstimate {
  /** Bytes in use. */
  readonly usage: number;
  /** Bytes available. */
  readonly quota: number;
}

export interface OpfsWorkspaceDescription extends WorkspaceDescription {
  readonly kind: "opfs";
  /**
   * `true` when `navigator.storage.persist()` is active: the browser will not
   * evict this workspace silently. `false` means best-effort only, and the UI
   * has to say so.
   */
  readonly persisted: boolean;
}

export interface OpfsWorkspace extends DirectoryWorkspace {
  describe(): OpfsWorkspaceDescription;
  /** Ask the browser to keep the sandbox around. Safe to call repeatedly. */
  requestPersistence(): Promise<boolean>;
  /** Current usage/quota, or `null` when the browser refuses to report it. */
  estimate(): Promise<StorageEstimate | null>;
}

export interface OpfsWorkspaceOptions {
  /**
   * Sub-directory of the OPFS root, one per workspace. Created on open.
   * Default `"workspace"`.
   */
  readonly directoryName?: string;
  /** Label shown in the UI. Defaults to the directory name. */
  readonly label?: string;
  /** Stable id. Defaults to `opfs:<directoryName>`. */
  readonly id?: string;
  /**
   * Call `navigator.storage.persist()` while opening (default `true`).
   * The request is best-effort: browsers may answer `false` without asking.
   */
  readonly requestPersistence?: boolean;
  /** See `DirectoryWorkspaceOptions.maxOpenFileHandles`. */
  readonly maxOpenFileHandles?: number;
}

/** `navigator.storage` is the only part of the API we depend on. */
interface StorageManagerLike {
  getDirectory(): Promise<FileSystemDirectoryHandle>;
  persisted?(): Promise<boolean>;
  persist?(): Promise<boolean>;
  estimate?(): Promise<StorageEstimate>;
}

function storageManager(): StorageManagerLike {
  const storage = (navigator as { storage?: StorageManagerLike }).storage;
  if (storage === undefined || typeof storage.getDirectory !== "function") {
    throw new Error(
      "The Origin Private File System is not available in this browser " +
        "(needs Chrome 108+, Firefox 111+ or Safari 16.4+, in a secure context).",
    );
  }
  return storage;
}

const DEFAULT_DIRECTORY_NAME = "workspace";

export async function createOpfsWorkspace(
  options: OpfsWorkspaceOptions = {},
): Promise<OpfsWorkspace> {
  const directoryName = options.directoryName ?? DEFAULT_DIRECTORY_NAME;
  const label = options.label ?? directoryName;
  const id = options.id ?? `opfs:${directoryName}`;
  const storage = storageManager();

  const opfsRoot = await guardHandle(directoryName, "directory", () => storage.getDirectory());
  // Defensive: the platform already guarantees this, but a workspace with the
  // wrong root kind would fail much later and much more confusingly.
  if (!isDirectoryHandle(opfsRoot)) {
    throw new Error(`The OPFS root is not a directory handle (got "${opfsRoot.kind}").`);
  }

  // `create: true` — the sandbox directory is ours, there is nothing to pick.
  const root = await guardHandle(directoryName, "directory", () =>
    opfsRoot.getDirectoryHandle(directoryName, { create: true }),
  );

  let persisted = (await storage.persisted?.()) ?? false;
  if ((options.requestPersistence ?? true) && !persisted) {
    persisted = (await storage.persist?.()) ?? false;
  }

  const kind: WorkspaceKind = "opfs";
  const base = createDirectoryWorkspace(root, {
    id,
    label,
    kind,
    ...(options.maxOpenFileHandles === undefined
      ? {}
      : { maxOpenFileHandles: options.maxOpenFileHandles }),
  });

  return {
    ...base,
    id: base.id,
    label: base.label,
    root: base.root,

    describe: (): OpfsWorkspaceDescription => ({
      label,
      kind,
      writable: true,
      persisted,
    }),

    async requestPersistence() {
      persisted = (await storage.persist?.()) ?? false;
      return persisted;
    },

    async estimate() {
      // Not every browser reports an estimate; that is not an error worth
      // failing a workspace open for.
      return (await storage.estimate?.()) ?? null;
    },
  };
}
