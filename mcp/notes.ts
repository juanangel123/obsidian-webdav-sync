// The vault as one more device that never keeps a copy on disk: it reads the server's blobs, keeps what it learned
// in memory (a name → path map, and the text of the notes for searching), and writes the way a device does. A device
// that syncs later sees these writes as another device's edits: new versions it downloads, or a conflict copy if it
// changed the same note meanwhile. Deletes only to the server's trash, as a device does; never moves nor renames.
//
// rclone (the server this runs next to) ignores If-Match and If-None-Match on PUT, so no write here is atomic:
// writes run one at a time in this process, each is checked right before (the ETag) and right after (the server
// still holds what was put, else it is read again and retried), which leaves only a window of milliseconds against a
// device uploading the same note — the same one the devices have between themselves.

import { type Keys, DecryptError, buf, open, remoteName, seal, validPath } from "../src/crypto";
import { META, TRASH, openVault } from "../src/sync";
import { type WebDav, WebDavError } from "../src/webdav";

const dec = new TextDecoder();
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const enc = new TextEncoder();
/** Files whose text is kept for searching and reading. */
const READABLE = /\.(md|txt|canvas|base)$/i;
/** Files written here (canvas and base are JSON or YAML: text appended to them would break them). */
const WRITABLE = /\.(md|txt)$/i;
/** Text kept per note at most; bigger blobs (attachments) are never downloaded, so they can't exhaust the memory. */
const MAX_TEXT = 2 * 1024 * 1024;
/** Blob overhead over the content: magic, IV, tag, header with the path. */
const BLOB_OVERHEAD = 64 + 1024;
const BLOB = /^[0-9a-f]{32}\.bin$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

interface Entry {
  name: string; // remote name
  etag: string;
  size: number; // blob size
  /** null: not opened (too big) or can't be opened (damaged, another key); kept so it isn't fetched again. */
  path: string | null;
  version: number;
  bytes: number; // content size
  text: string | null; // null: not a readable note, too big, or not UTF-8
  folded: string; // fold(text), for searching
}

interface Hit {
  path: string;
  snippet: string;
}

export class NoteError extends Error {}

/** Lower case, accents gone: "Canción" and "cancion" match. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The key two paths clash on: the same file on a case-insensitive disk, NFC or NFD alike. */
function same(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Notes {
  private keys: Keys | null = null;
  private metaEtag: string | null = null; // sync.json's ETag the keys belong to
  private unlockError: { etag: string; error: Error } | null = null;
  private readonly byName = new Map<string, Entry>();
  private refreshing: Promise<void> | null = null;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dav: WebDav,
    private readonly passphrase: string,
  ) {}

  /**
   * The keys for the vault on the server now. A new `sync.json` (a vault set up again, a restore) drops the keys and
   * everything learned with them; a wrong passphrase is remembered for that `sync.json`, so it isn't derived again
   * on every call.
   */
  private async unlock(): Promise<Keys> {
    const st = await this.dav.stat(META);
    const etag = st?.etag ?? "";
    if (this.keys && etag && etag === this.metaEtag) return this.keys;
    if (this.unlockError && etag && etag === this.unlockError.etag) throw this.unlockError.error;
    this.keys = null;
    this.byName.clear();
    try {
      this.keys = (await openVault(this.dav, this.passphrase)).keys;
      this.metaEtag = etag;
      this.unlockError = null;
      return this.keys;
    } catch (err) {
      if (err instanceof Error) this.unlockError = { etag, error: err };
      throw err;
    }
  }

  /** Brings the in-memory view up to date with the server: only blobs whose ETag changed are fetched again. */
  async refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const keys = await this.unlock();
    const entries = (await this.dav.list()).filter((e) => !e.dir && BLOB.test(e.name));
    const seen = new Set<string>();
    for (const e of entries) {
      seen.add(e.name);
      const had = this.byName.get(e.name);
      if (had && had.etag && had.etag === e.etag && had.size === e.size) continue;
      const unknown = { name: e.name, etag: e.etag, size: e.size, path: null, version: 0, bytes: 0, text: null, folded: "" };
      if (e.size > MAX_TEXT + BLOB_OVERHEAD) {
        this.byName.set(e.name, unknown); // an attachment: never downloaded here
        continue;
      }
      const blob = await this.dav.get(e.name);
      if (!blob) continue;
      try {
        this.byName.set(e.name, { ...this.entry(await open(keys, blob, e.name), e.name), etag: e.etag, size: e.size });
      } catch (err) {
        if (!(err instanceof DecryptError)) throw err;
        this.byName.set(e.name, unknown); // damaged or another key: the devices report it
      }
    }
    for (const n of [...this.byName.keys()]) if (!seen.has(n)) this.byName.delete(n);
  }

  private entry(o: { path: string; version: number; data: Uint8Array }, name: string): Entry {
    if (!validPath(o.path)) throw new DecryptError("invalid path");
    let text: string | null = null;
    if (READABLE.test(o.path) && o.data.length <= MAX_TEXT) {
      try {
        text = strict.decode(o.data);
      } catch {
        text = dec.decode(o.data); // not UTF-8: searchable, but never written back
      }
    }
    return {
      name,
      etag: "",
      size: 0,
      path: o.path,
      version: o.version,
      bytes: o.data.length,
      text,
      folded: text === null ? "" : fold(text),
    };
  }

  private entries(): (Entry & { path: string })[] {
    return [...this.byName.values()]
      .filter((e): e is Entry & { path: string } => e.path !== null)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  private find(path: string): (Entry & { path: string }) | undefined {
    const all = this.entries();
    const p = path.normalize("NFC");
    return all.find((e) => e.path === p) ?? all.find((e) => same(e.path) === same(p));
  }

  /** Files under a folder ("" for all), with their sizes in bytes; and how many big files couldn't be named. */
  async list(folder = ""): Promise<{ files: { path: string; size: number }[]; unnamed: number }> {
    await this.refresh();
    const prefix = folder.replace(/^\/+|\/+$/g, "");
    const p = prefix ? fold(prefix) + "/" : "";
    const files = this.entries()
      .filter((e) => fold(e.path).startsWith(p))
      .map((e) => ({ path: e.path, size: e.bytes }));
    const unnamed = [...this.byName.values()].filter((e) => e.path === null && e.size > MAX_TEXT + BLOB_OVERHEAD).length;
    return { files, unnamed };
  }

  /** Notes whose path or text holds every word of the query (case and accents ignored), best first. */
  async search(query: string, limit = 20): Promise<Hit[]> {
    await this.refresh();
    const words = fold(query).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const scored: { e: Entry & { path: string }; score: number; at: number }[] = [];
    for (const e of this.entries()) {
      const path = fold(e.path);
      const text = e.folded;
      if (!words.every((w) => path.includes(w) || text.includes(w))) continue;
      const score = words.filter((w) => path.includes(w)).length * 10 + words.reduce((n, w) => n + count(text, w), 0);
      const at = Math.min(...words.map((w) => text.indexOf(w)).filter((i) => i >= 0), Number.POSITIVE_INFINITY);
      scored.push({ e, score, at });
    }
    scored.sort((a, b) => b.score - a.score || a.e.path.localeCompare(b.e.path));
    return scored.slice(0, limit).map(({ e, at }) => ({ path: e.path, snippet: snippet(e.text ?? "", at) }));
  }

  async read(path: string): Promise<{ path: string; text: string }> {
    await this.refresh();
    const e = this.find(path);
    if (!e) throw new NoteError(`no note at "${path}"`);
    if (e.text === null) throw new NoteError(`"${e.path}" is not a text note (or is too big to read here)`);
    return { path: e.path, text: e.text };
  }

  /** One write at a time in this process: rclone can't refuse a PUT that lost a race. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writing.then(fn, fn);
    this.writing = run.catch(() => {});
    return run;
  }

  /** PUTs a blob and checks the server kept it: its ETag and size there, or null when another write replaced it at once. */
  private async put(name: string, sealed: Uint8Array): Promise<{ etag: string; size: number } | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        const etag = await this.dav.put(name, buf(sealed));
        const after = await this.dav.stat(name);
        if (!after) return null;
        return !etag || after.etag === etag ? { etag: after.etag, size: after.size } : null;
      } catch (err) {
        // 423: rclone locks a file while another PUT to it is in flight (a device's upload).
        if (!(err instanceof WebDavError && err.status === 423) || attempt >= 4) throw err;
        await sleep(200 * (attempt + 1));
      }
    }
  }

  /** Writes what was just put into the in-memory view, so the next call sees it without waiting for a listing. */
  private remember(name: string, at: { etag: string; size: number }, path: string, version: number, data: Uint8Array): void {
    this.byName.set(name, { ...this.entry({ path, version, data }, name), ...at });
  }

  /**
   * A new note; refuses a path that exists (in any case or Unicode form: Windows and Android disks can't hold both).
   * Its folders take the spelling of existing ones. Its version is the time, so it is newer than any version a device
   * still remembers for that path (a note deleted there, its blob gone to the server's trash).
   */
  create(path: string, text: string): Promise<string> {
    return this.exclusive(async () => {
      await this.refresh();
      const p = this.spelled(normalise(path));
      const clash = this.find(p);
      if (clash) throw new NoteError(`"${clash.path}" already exists: append to it, or pick another name`);
      const keys = await this.unlock();
      const name = await remoteName(keys, p);
      if (await this.dav.stat(name)) throw new NoteError(`"${p}" already exists`);
      const data = enc.encode(text);
      const version = Math.floor(Date.now() / 1000);
      const at = await this.put(name, await seal(keys, p, data, version));
      if (!at) throw new NoteError(`another device wrote "${p}" at the same moment: nothing was saved, try again`);
      this.remember(name, at, p, version, data);
      return p;
    });
  }

  /** The path with the folders spelled as the vault already has them ("inbox/x.md" → "Inbox/x.md"). */
  private spelled(p: string): string {
    const parts = p.split("/");
    const all = this.entries().map((e) => e.path.split("/"));
    for (let i = 0; i < parts.length - 1; i++) {
      const known = all.find((q) => q.length > i + 1 && q.slice(0, i + 1).every((s, j) => same(s) === same(parts[j])));
      if (known) parts[i] = known[i];
    }
    return parts.join("/");
  }

  /** Adds text at the end of a note, on a new line. Retries when a device changes the note in between. */
  append(path: string, text: string): Promise<string> {
    return this.exclusive(async () => {
      await this.refresh();
      const e = this.find(path);
      if (!e) throw new NoteError(`no note at "${path}"`);
      if (e.text === null || !WRITABLE.test(e.path)) throw new NoteError(`"${e.path}" is not a Markdown or text note`);
      const keys = await this.unlock();
      const add = enc.encode(text.endsWith("\n") ? text : `${text}\n`);
      for (let attempt = 0; attempt < 5; attempt++) {
        const before = await this.dav.stat(e.name);
        if (!before) throw new NoteError(`"${e.path}" was just deleted on another device`);
        const blob = await this.dav.get(e.name);
        if (!blob) continue;
        const o = await open(keys, blob, e.name);
        try {
          strict.decode(o.data);
        } catch {
          throw new NoteError(`"${o.path}" is not UTF-8 text: not changed, so its bytes stay as they are`);
        }
        const nl = o.data.length && o.data[o.data.length - 1] !== 0x0a ? enc.encode("\n") : new Uint8Array(0);
        const data = concat(o.data, nl, add);
        const sealed = await seal(keys, o.path, data, o.version + 1);
        if ((await this.dav.stat(e.name))?.etag !== before.etag) continue; // changed while reading: read again
        const at = await this.put(e.name, sealed);
        if (!at) continue; // a device's upload replaced it at once: add to theirs
        this.remember(e.name, at, o.path, o.version + 1, data);
        return o.path;
      }
      throw new NoteError(`"${e.path}" keeps changing on another device: try again in a moment`);
    });
  }

  /**
   * Deletes a file the way a device does: its blob moves to the server's trash (`.trash/<time>/`, recoverable there),
   * and each device moves its copy to the vault's trash on its next sync — or uploads it again if it edited it since,
   * so an edit is never lost. Refused when the file changed on the server after this process last read it.
   */
  delete(path: string): Promise<string> {
    return this.exclusive(async () => {
      await this.refresh();
      const e = this.find(path);
      if (!e) throw new NoteError(`no file at "${path}"`);
      const st = await this.dav.stat(e.name);
      if (!st) {
        this.byName.delete(e.name);
        throw new NoteError(`"${e.path}" was just deleted on another device`);
      }
      if (st.etag !== e.etag) throw new NoteError(`"${e.path}" just changed on another device: nothing was deleted, read it again first`);
      const dir = `${TRASH}/${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await this.dav.mkcol(TRASH);
      await this.dav.mkcol(dir);
      for (let attempt = 0; ; attempt++) {
        try {
          await this.dav.move(e.name, `${dir}/${e.name}`);
          break;
        } catch (err) {
          // 404: gone meanwhile; 423: a device's upload of this file is in flight.
          if (err instanceof WebDavError && err.status === 404) {
            this.byName.delete(e.name);
            throw new NoteError(`"${e.path}" was just deleted on another device`);
          }
          if (!(err instanceof WebDavError && err.status === 423) || attempt >= 4) throw err;
          await sleep(200 * (attempt + 1));
        }
      }
      this.byName.delete(e.name);
      return e.path;
    });
  }
}

function count(text: string, word: string): number {
  let n = 0;
  for (let i = text.indexOf(word); i >= 0 && n < 50; i = text.indexOf(word, i + word.length)) n++;
  return n;
}

function snippet(text: string, at: number): string {
  if (!text) return "";
  const start = Number.isFinite(at) ? Math.max(0, at - 80) : 0;
  const s = text.slice(start, start + 240).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + s + (start + 240 < text.length ? "…" : "");
}

/**
 * A path as the vault would hold it: NFC (as Obsidian keeps names), no leading or trailing slash, ".md" unless it
 * ends in .md or .txt ("Meeting 26.11" → "Meeting 26.11.md"). Refuses what a device's disk can't hold.
 */
function normalise(path: string): string {
  let p = path.normalize("NFC").trim().replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
  if (!WRITABLE.test(p)) p += ".md";
  const bad = !validPath(p) || p.split("/").some((s) => /[<>"|?*]/.test(s) || /[. ]$/.test(s) || RESERVED.test(s));
  if (bad) throw new NoteError(`"${path}" can't be a note's path (no "..", hidden folders, < > : " | ? * \\, or names Windows reserves)`);
  return p;
}
