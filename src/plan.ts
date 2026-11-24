// The sync decision, pure: a three-way comparison of the local files, the remote files and the state of the last
// sync (what both sides held when they last agreed). A side "changed" when it differs from the state.

export interface LocalFile {
  mtime: number;
  size: number;
}

export interface RemoteFile {
  name: string;
  etag: string;
  size: number;
}

/** What both sides held after the last sync of a path. */
export interface Synced {
  mtime: number;
  size: number;
  etag: string;
  name: string;
  /** The note's version on the server (`crypto.ts`: each upload is the last seen + 1). */
  version: number;
}

export type Action =
  | { kind: "upload"; path: string } // local is new or changed, remote is not
  | { kind: "download"; path: string } // remote is new or changed, local is not
  | { kind: "deleteLocal"; path: string } // gone remotely, untouched locally
  | { kind: "deleteRemote"; path: string } // gone locally, untouched remotely
  | { kind: "reconcile"; path: string } // both new or both changed: compare, keep both if they differ
  | { kind: "forget"; path: string }; // gone on both sides

export function plan(
  local: Map<string, LocalFile>,
  remote: Map<string, RemoteFile>,
  state: Map<string, Synced>,
): Action[] {
  const paths = new Set([...local.keys(), ...remote.keys(), ...state.keys()]);
  const out: Action[] = [];
  for (const path of [...paths].sort()) {
    const l = local.get(path);
    const r = remote.get(path);
    const s = state.get(path);
    if (!s) {
      if (l && r) out.push({ kind: "reconcile", path });
      else if (l) out.push({ kind: "upload", path });
      else if (r) out.push({ kind: "download", path });
      continue;
    }
    const lChanged = !!l && (l.mtime !== s.mtime || l.size !== s.size);
    const rChanged = !!r && r.etag !== s.etag;
    if (l && r) {
      if (lChanged && rChanged) out.push({ kind: "reconcile", path });
      else if (lChanged) out.push({ kind: "upload", path });
      else if (rChanged) out.push({ kind: "download", path });
    } else if (l) {
      // Deleted remotely: an edit made here since wins over the deletion.
      out.push(lChanged ? { kind: "upload", path } : { kind: "deleteLocal", path });
    } else if (r) {
      // Deleted here: an edit made on another device since wins over the deletion.
      out.push(rChanged ? { kind: "download", path } : { kind: "deleteRemote", path });
    } else {
      out.push({ kind: "forget", path });
    }
  }
  return out;
}

/** The deletions a plan would make, by side. */
export interface Deletions {
  local: string[]; // files this device would move to its trash
  remote: string[]; // files the server would move to its trash
}

export function deletions(actions: Action[]): Deletions {
  return {
    local: actions.filter((a) => a.kind === "deleteLocal").map((a) => a.path),
    remote: actions.filter((a) => a.kind === "deleteRemote").map((a) => a.path),
  };
}

/** A run may delete at most this many files on its own; past it, also over a third of what was synced, it asks. */
export const GUARD_MIN = 5;

/**
 * Whether a plan deletes too much to run unattended: more than GUARD_MIN files and more than a third of the files
 * synced so far. Guards against a wiped folder or a wrong server deleting the other side.
 */
export function needsConfirmation(d: Deletions, syncedCount: number): boolean {
  const n = d.local.length + d.remote.length;
  return n > GUARD_MIN && n > syncedCount / 3;
}

/** "folder/Note.md" → "folder/Note (conflict 2026-11-24 1012).md", numbered if taken. */
export function conflictPath(path: string, now: Date, taken: (p: string) => boolean): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const hasExt = dot > slash + 1;
  const stem = hasExt ? path.slice(0, dot) : path;
  const ext = hasExt ? path.slice(dot) : "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`;
  let candidate = `${stem} (conflict ${stamp})${ext}`;
  for (let i = 2; taken(candidate); i++) candidate = `${stem} (conflict ${stamp} ${i})${ext}`;
  return candidate;
}
