// One sync run: list both sides, plan, carry the plan out file by file. Independent of Obsidian (LocalFs is the
// vault in the app, a Map in tests).
//
// Every action re-checks its side right before it changes anything — the server's ETag before a PUT or a MOVE, the
// local file before a write or a trash — so another device's run, or the user typing, between the listing and the
// action turns it into a comparison (a conflict copy if they differ) instead of an overwrite.

import { type Keys, type Meta, type Opened, DecryptError, buf, newMeta, open, remoteName, seal, unlock, validPath } from "./crypto";
import {
  type Action,
  type Deletions,
  type LocalFile,
  type RemoteFile,
  type Synced,
  conflictPath,
  deletions,
  needsConfirmation,
  plan,
} from "./plan";
import { type WebDav, WebDavError } from "./webdav";

/** Thrown by LocalFs when a file is not as the listing saw it (edited, created or deleted since). */
export class LocalChanged extends Error {}

export interface LocalFs {
  list(): Promise<Map<string, LocalFile>>;
  read(path: string): Promise<Uint8Array>;
  /**
   * Writes a file (creating its folders) only if it is still as `expected` (null: still absent), else throws
   * LocalChanged; returns its stat after the write.
   */
  write(path: string, data: Uint8Array, expected: LocalFile | null): Promise<LocalFile>;
  /** Moves a file to the vault's trash only if it is still as `expected`, else throws LocalChanged. */
  trash(path: string, expected: LocalFile): Promise<void>;
}

export type State = Record<string, Synced>;

export interface Result {
  state: State;
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: string[];
  /** "path: message", in English (logs). */
  errors: string[];
  /** The same failures with their error, for a message in the user's language. */
  failures: { path: string; error: unknown }[];
  /** Paths left out of this run (too big, or a name this device can't hold). */
  skipped: string[];
  /** Set when the run stopped before changing anything: the deletions it would make, waiting for a confirmation. */
  blocked?: Deletions;
}

export const META = "sync.json";
const TRASH = ".trash";
/** Decrypted contents kept between resolving unknown names and writing them, at most (a phone's memory). */
const CACHE_BYTES = 32 * 1024 * 1024;
/** Blob overhead over the content: magic, IV, tag, header. */
const BLOB_OVERHEAD = 64 + 1024;

export class NoVault extends Error {
  constructor(
    message: string,
    readonly kind: "none" | "notEmpty" | "vanished",
  ) {
    super(message);
  }
}

/** A file's action that failed for a reason the user may need to act on. */
export class FileError extends Error {
  constructor(
    message: string,
    readonly kind: "gone" | "caseClash" | "badName",
    /** For "caseClash": the path it clashes with. */
    readonly other = "",
  ) {
    super(message);
  }
}

/**
 * Reads the vault's metadata and returns the keys for the passphrase, the vault's id, and whether this call set the
 * vault up. A server with no `sync.json` gets a new vault only when `create` (a manual action) and only if it holds
 * no notes yet.
 */
export async function openVault(
  dav: WebDav,
  passphrase: string,
  opts: { create?: boolean; iterations?: number } = {},
): Promise<{ keys: Keys; id: string; created: boolean }> {
  const read = async () => {
    const raw = await dav.get(META);
    return raw ? (JSON.parse(new TextDecoder().decode(raw)) as Meta) : null;
  };
  let meta = await read();
  let created = false;
  if (!meta) {
    if (!opts.create) throw new NoVault("no vault on this server yet: press Sync now on the first device to set it up", "none");
    if ((await dav.list()).some((e) => e.name.endsWith(".bin")))
      throw new NoVault("this server folder holds notes but no sync.json: refusing to start a new vault over them", "notEmpty");
    const fresh = await newMeta(passphrase, opts.iterations);
    try {
      await dav.put(META, JSON.stringify(fresh.meta, null, 2), true);
    } catch (err) {
      if (!(err instanceof WebDavError && err.status === 412)) throw err; // another device set it up first
    }
    meta = await read(); // whoever won, everyone uses what is on the server
    if (!meta) throw new NoVault("sync.json vanished right after it was written", "vanished");
    created = meta.id === fresh.meta.id;
  }
  return { keys: await unlock(passphrase, meta), id: meta.id, created };
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface SyncOptions {
  dav: WebDav;
  keys: Keys;
  local: LocalFs;
  state: State;
  now?: Date;
  /** Deletions the user confirmed: the run goes ahead only if its plan deletes these exact files. */
  confirmed?: Deletions;
  /** Files larger than this are left out (default 50 MB). */
  maxBytes?: number;
  /** Called with the state so far every few actions, so a run killed half way keeps what it did. */
  onProgress?: (state: State) => Promise<void> | void;
  log?: (msg: string) => void;
}

export async function sync(opts: SyncOptions): Promise<Result> {
  return new Run(opts).go();
}

class Run {
  private readonly dav: WebDav;
  private readonly keys: Keys;
  private readonly local: LocalFs;
  private readonly now: Date;
  private readonly maxBytes: number;
  private readonly state: State;
  private readonly result: Result;
  private localFiles = new Map<string, LocalFile>();
  private readonly remote = new Map<string, RemoteFile>();
  private readonly names = new Map<string, string>(); // path → remote name
  private readonly cache = new Map<string, Opened>(); // remote name → opened blob (bounded by CACHE_BYTES)
  private cached = 0;
  private trashDir: string | null = null;

  constructor(private readonly opts: SyncOptions) {
    this.dav = opts.dav;
    this.keys = opts.keys;
    this.local = opts.local;
    this.now = opts.now ?? new Date();
    this.maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
    this.state = { ...opts.state };
    this.result = {
      state: this.state,
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      conflicts: [],
      errors: [],
      failures: [],
      skipped: [],
    };
  }

  private error(path: string, err: unknown): void {
    const msg = err instanceof DecryptError ? `cannot decrypt (${err.message})` : err instanceof Error ? err.message : String(err);
    this.result.errors.push(`${path}: ${msg}`);
    this.result.failures.push({ path, error: err });
    this.opts.log?.(`${path}: ${msg}`);
  }

  private async nameOf(path: string): Promise<string> {
    let n = this.names.get(path) ?? this.state[path]?.name;
    if (!n) n = await remoteName(this.keys, path);
    this.names.set(path, n);
    return n;
  }

  async go(): Promise<Result> {
    const { state, result } = this;
    const skip = new Set<string>();

    // This device: only paths both sides can hold (validPath), within the size limit.
    for (const [path, f] of await this.local.list()) {
      if (!validPath(path) || f.size > this.maxBytes) skip.add(path);
      else this.localFiles.set(path, f);
    }

    // The server: names of synced or local paths are known; an unknown one is opened to learn its path.
    const byName = new Map<string, string>();
    for (const path of [...Object.keys(state), ...this.localFiles.keys()]) byName.set(await this.nameOf(path), path);
    const entries = (await this.dav.list()).filter((e) => !e.dir && /^[0-9a-f]{32}\.bin$/.test(e.name));
    for (const e of entries) {
      let path = byName.get(e.name);
      if (path === undefined) {
        if (e.size > this.maxBytes + BLOB_OVERHEAD) continue; // too big for this device: left alone
        try {
          const o = await this.fetch(e.name, true);
          if (!o) continue;
          path = o.path;
          if (!validPath(path)) {
            skip.add(path);
            continue;
          }
          this.names.set(path, e.name);
        } catch (err) {
          this.error(e.name, err);
          continue;
        }
      }
      if (e.size > this.maxBytes + BLOB_OVERHEAD) skip.add(path);
      this.remote.set(path, { name: e.name, etag: e.etag, size: e.size });
    }
    for (const p of skip) {
      this.localFiles.delete(p);
      this.remote.delete(p);
    }
    result.skipped = [...skip].sort();

    // The plan, minus skipped paths (kept in the state as they were: a skipped path is neither deleted nor forgotten).
    const synced = new Map(Object.entries(state).filter(([p]) => !skip.has(p)));
    const actions = plan(this.localFiles, this.remote, synced);
    const del = deletions(actions);
    if (needsConfirmation(del, synced.size) && !sameDeletions(del, this.opts.confirmed)) {
      result.blocked = del;
      return result;
    }

    // Local deletions first, so a case-only rename on a case-insensitive disk frees the name before the download.
    const ordered = [...actions.filter((a) => a.kind === "deleteLocal"), ...actions.filter((a) => a.kind !== "deleteLocal")];
    let done = 0;
    let saved = Date.now();
    for (const a of ordered) {
      try {
        await this.run(a);
      } catch (err) {
        this.error(a.path, err);
      }
      if (this.opts.onProgress && (++done % 25 === 0 || Date.now() - saved > 5_000)) {
        await this.opts.onProgress({ ...state });
        saved = Date.now();
      }
    }
    return result;
  }

  /** GETs and opens a remote file (checking the name); `keep` holds it for a later action while the cache allows. */
  private async fetch(name: string, keep = false): Promise<Opened | null> {
    const hit = this.cache.get(name);
    if (hit) {
      this.cache.delete(name);
      this.cached -= hit.data.length;
      return hit;
    }
    const blob = await this.dav.get(name);
    if (!blob) return null;
    const o = await open(this.keys, blob, name);
    if (keep && this.cached + o.data.length <= CACHE_BYTES) {
      this.cache.set(name, o);
      this.cached += o.data.length;
    }
    return o;
  }

  /** The remote file as it is now (fresh stat and GET), for a comparison. */
  private async current(path: string): Promise<{ etag: string; size: number; opened: Opened } | null> {
    const name = await this.nameOf(path);
    const st = await this.dav.stat(name);
    if (!st) return null;
    this.cache.delete(name);
    const opened = await this.fetch(name);
    if (!opened) return null;
    if (opened.path !== path) throw new DecryptError("file under the wrong name", "wrongName");
    return { etag: st.etag, size: st.size, opened };
  }

  /**
   * PUTs a path's content as version `version`, only if the server still holds `expectedEtag` (undefined: nothing),
   * else throws RemoteChanged. Records the state.
   */
  private async put(path: string, data: Uint8Array, local: LocalFile, version: number, expectedEtag: string | undefined): Promise<void> {
    const name = await this.nameOf(path);
    const st = await this.dav.stat(name);
    if ((st?.etag ?? undefined) !== expectedEtag) throw new RemoteChanged();
    let etag = await this.dav.put(name, buf(await seal(this.keys, path, data, version)));
    if (!etag) etag = (await this.dav.stat(name))?.etag ?? "";
    this.state[path] = { mtime: local.mtime, size: local.size, etag, name, version };
  }

  private async run(a: Action): Promise<void> {
    const path = a.path;
    switch (a.kind) {
      case "upload": {
        const l = this.localFiles.get(path)!;
        const r = this.remote.get(path);
        const version = Math.max(this.state[path]?.version ?? 0, 0) + 1;
        try {
          await this.put(path, await this.local.read(path), l, version, r?.etag);
        } catch (err) {
          if (!(err instanceof RemoteChanged)) throw err;
          return this.reconcile(path); // another device wrote it since the listing
        }
        this.result.uploaded++;
        return;
      }
      case "download": {
        const r = this.remote.get(path)!;
        const o = await this.fetch(r.name);
        if (!o) throw new FileError("gone from the server since the listing", "gone");
        if (o.path !== path) throw new DecryptError("file under the wrong name", "wrongName");
        const s = this.state[path];
        if (s && o.version <= s.version) return this.reconcile(path); // an older blob put back: keep both
        const clash = this.caseClash(path);
        if (clash) throw new FileError(`differs only in case from "${clash}": rename one of them`, "caseClash", clash);
        let l: LocalFile;
        try {
          l = await this.local.write(path, o.data, this.localFiles.get(path) ?? null);
        } catch (err) {
          if (!(err instanceof LocalChanged)) throw err;
          return this.reconcile(path, true); // edited here since the listing
        }
        this.localFiles.set(path, l);
        this.state[path] = { mtime: l.mtime, size: l.size, etag: r.etag, name: r.name, version: o.version };
        this.result.downloaded++;
        return;
      }
      case "deleteLocal": {
        try {
          await this.local.trash(path, this.localFiles.get(path)!);
        } catch (err) {
          if (err instanceof LocalChanged) return; // edited here since: the next run uploads it
          throw err;
        }
        this.localFiles.delete(path);
        delete this.state[path];
        this.result.deletedLocal++;
        return;
      }
      case "deleteRemote": {
        const r = this.remote.get(path)!;
        const st = await this.dav.stat(r.name);
        if (st && st.etag !== r.etag) return; // edited elsewhere since: the next run downloads it
        if (st) {
          if (!this.trashDir) {
            this.trashDir = `${TRASH}/${this.now.toISOString().replace(/[:.]/g, "-")}`;
            await this.dav.mkcol(TRASH);
            await this.dav.mkcol(this.trashDir);
          }
          await this.dav.move(r.name, `${this.trashDir}/${r.name}`);
        }
        delete this.state[path];
        this.result.deletedRemote++;
        return;
      }
      case "reconcile":
        return this.reconcile(path);
      case "forget":
        delete this.state[path];
        return;
    }
  }

  /** A local path whose name differs only in case, if any (case-insensitive disks can't hold both). */
  private caseClash(path: string): string | undefined {
    const lower = path.toLowerCase();
    for (const p of this.localFiles.keys()) if (p !== path && p.toLowerCase() === lower) return p;
    return undefined;
  }

  /**
   * Both sides changed (or the listing went stale): compare what each holds now. Equal → recorded as synced.
   * Different → the server's version is kept beside it as a conflict copy (on both sides), this device's stays at the path.
   */
  private async reconcile(path: string, relist = false): Promise<void> {
    if (relist) this.localFiles = await this.local.list();
    const l = this.localFiles.get(path);
    const cur = await this.current(path);
    if (!l) {
      // Gone here meanwhile: nothing to compare; the next run sees the remote as new or changed.
      return;
    }
    const mine = await this.local.read(path);
    if (!cur) {
      await this.put(path, mine, l, (this.state[path]?.version ?? 0) + 1, undefined);
      this.result.uploaded++;
      return;
    }
    const theirs = cur.opened;
    const version = Math.max(theirs.version, this.state[path]?.version ?? 0) + 1;
    if (equal(theirs.data, mine)) {
      const name = await this.nameOf(path);
      this.state[path] = { mtime: l.mtime, size: l.size, etag: cur.etag, name, version: theirs.version };
      return;
    }
    // A copy with this same content may exist already (a run cut off half way): reuse it.
    let copy = await this.existingCopy(path, theirs.data);
    if (!copy) {
      copy = conflictPath(path, this.now, (p) => this.localFiles.has(p) || this.remote.has(p));
      const cl = await this.local.write(copy, theirs.data, null);
      this.localFiles.set(copy, cl);
    }
    const cl = this.localFiles.get(copy)!;
    if (!this.state[copy]) {
      await this.put(copy, theirs.data, cl, 1, this.remote.get(copy)?.etag);
    }
    await this.put(path, mine, l, version, cur.etag);
    this.result.conflicts.push(copy);
  }

  private async existingCopy(path: string, data: Uint8Array): Promise<string | undefined> {
    const dot = path.lastIndexOf(".");
    const stem = dot > path.lastIndexOf("/") + 1 ? path.slice(0, dot) : path;
    for (const p of this.localFiles.keys()) {
      if (!p.startsWith(`${stem} (conflict `)) continue;
      if (equal(await this.local.read(p), data)) return p;
    }
    return undefined;
  }
}

class RemoteChanged extends Error {}

function sameDeletions(a: Deletions, b: Deletions | undefined): boolean {
  if (!b) return false;
  const eq = (x: string[], y: string[]) => x.length === y.length && [...x].sort().every((v, i) => v === [...y].sort()[i]);
  return eq(a.local, b.local) && eq(a.remote, b.remote);
}
