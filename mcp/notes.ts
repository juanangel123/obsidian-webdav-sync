// The vault as one more device that never keeps a copy on disk: it reads the server's blobs, keeps what it learned
// in memory (a name → path map, and the text of the notes for searching), and writes the way the plugin does — a
// new blob only where none is, a changed one only if the server still holds what was read (else it reads again).
// A device that syncs later sees these writes as another device's edits: new versions it downloads, or a conflict
// copy if it changed the same note meanwhile. Never deletes, moves nor renames.

import { type Keys, DecryptError, buf, open, remoteName, seal, validPath } from "../src/crypto";
import { openVault } from "../src/sync";
import { type WebDav, WebDavError } from "../src/webdav";

const dec = new TextDecoder();
const enc = new TextEncoder();
/** Files whose text is kept for searching and can be read or written here; the rest are only listed. */
const TEXT = /\.(md|txt|canvas|base)$/i;
/** Text kept per note at most (a huge note is listed and searchable by name only). */
const MAX_TEXT = 2 * 1024 * 1024;
const BLOB = /^[0-9a-f]{32}\.bin$/;

interface Entry {
  name: string; // remote name
  etag: string;
  size: number; // blob size
  path: string;
  version: number;
  text: string | null; // null: not a text file, or too big
}

export interface Hit {
  path: string;
  snippet: string;
}

export class NoteError extends Error {}

/** Lower case, accents gone: "Canción" and "cancion" match. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export class Notes {
  private keys: Keys | null = null;
  private readonly byName = new Map<string, Entry>();
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly dav: WebDav,
    private readonly passphrase: string,
  ) {}

  private async unlock(): Promise<Keys> {
    this.keys ??= (await openVault(this.dav, this.passphrase)).keys;
    return this.keys;
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
      if (had && had.etag === e.etag) continue;
      const blob = await this.dav.get(e.name);
      if (!blob) continue;
      let o: Awaited<ReturnType<typeof open>>;
      try {
        o = await open(keys, blob, e.name);
      } catch (err) {
        if (err instanceof DecryptError) continue; // not ours, or damaged: the devices report it
        throw err;
      }
      if (!validPath(o.path)) continue;
      const text = TEXT.test(o.path) && o.data.length <= MAX_TEXT ? dec.decode(o.data) : null;
      this.byName.set(e.name, { name: e.name, etag: e.etag, size: e.size, path: o.path, version: o.version, text });
    }
    for (const n of [...this.byName.keys()]) if (!seen.has(n)) this.byName.delete(n);
  }

  private entries(): Entry[] {
    return [...this.byName.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  private find(path: string): Entry | undefined {
    const all = this.entries();
    return all.find((e) => e.path === path) ?? all.find((e) => e.path.toLowerCase() === path.toLowerCase());
  }

  /** Paths under a folder ("" for all), with their sizes. */
  async list(folder = ""): Promise<{ path: string; size: number }[]> {
    await this.refresh();
    const prefix = folder.replace(/^\/+|\/+$/g, "");
    const p = prefix ? fold(prefix) + "/" : "";
    return this.entries()
      .filter((e) => fold(e.path).startsWith(p))
      .map((e) => ({ path: e.path, size: e.text?.length ?? e.size }));
  }

  /** Notes whose path or text holds every word of the query (case and accents ignored), best first. */
  async search(query: string, limit = 20): Promise<Hit[]> {
    await this.refresh();
    const words = fold(query).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const scored: { e: Entry; score: number; at: number }[] = [];
    for (const e of this.entries()) {
      const path = fold(e.path);
      const text = e.text === null ? "" : fold(e.text);
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

  /** A new note; refuses a path that exists (in any case: Windows and Android disks can't hold both). */
  async create(path: string, text: string): Promise<string> {
    const p = normalise(path);
    await this.refresh();
    const clash = this.find(p);
    if (clash) throw new NoteError(`"${clash.path}" already exists: append to it, or pick another name`);
    const keys = await this.unlock();
    const name = await remoteName(keys, p);
    if (await this.dav.stat(name)) throw new NoteError(`"${p}" already exists`);
    try {
      await this.dav.put(name, buf(await seal(keys, p, enc.encode(text), 1)), true);
    } catch (err) {
      if (err instanceof WebDavError && err.status === 412) throw new NoteError(`"${p}" already exists`);
      throw err;
    }
    await this.refresh();
    return p;
  }

  /** Adds text at the end of a note, on a new line. Retries when a device changes the note in between. */
  async append(path: string, text: string): Promise<string> {
    await this.refresh();
    const e = this.find(path);
    if (!e) throw new NoteError(`no note at "${path}"`);
    if (e.text === null) throw new NoteError(`"${e.path}" is not a text note`);
    const keys = await this.unlock();
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = await this.dav.stat(e.name);
      if (!before) throw new NoteError(`"${e.path}" was just deleted on another device`);
      const blob = await this.dav.get(e.name);
      if (!blob) continue;
      const o = await open(keys, blob, e.name);
      const old = dec.decode(o.data);
      const joined = old === "" || old.endsWith("\n") ? old + text : `${old}\n${text}`;
      const sealed = await seal(keys, o.path, enc.encode(joined.endsWith("\n") ? joined : joined + "\n"), o.version + 1);
      const now = await this.dav.stat(e.name);
      if (now?.etag !== before.etag) continue; // changed between the read and now: read again
      await this.dav.put(e.name, buf(sealed));
      await this.refresh();
      return o.path;
    }
    throw new NoteError(`"${e.path}" keeps changing on another device: try again in a moment`);
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

/** A path as the vault would hold it: no leading or trailing slash, ".md" when it has no extension. */
export function normalise(path: string): string {
  let p = path.trim().replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
  if (!/\.[A-Za-z0-9]{1,8}$/.test(p.split("/").pop() ?? "")) p += ".md";
  if (!validPath(p)) throw new NoteError(`"${path}" is not a valid note path (no "..", hidden folders, "\\" or ":")`);
  if (!TEXT.test(p)) throw new NoteError(`only text notes can be written here (.md, .txt): "${p}"`);
  return p;
}
