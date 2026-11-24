import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalFile } from "../src/plan";
import { type LocalFs, LocalChanged } from "../src/sync";
import { type Http, WebDav } from "../src/webdav";

/**
 * A device's vault in memory; every write gets a later mtime, as a real disk would. `caseInsensitive` behaves like
 * Windows or Android storage: two paths differing only in case are one file. `afterList` runs once right after a
 * listing (to edit a file "while" a run is going).
 */
export class MemFs implements LocalFs {
  files = new Map<string, { data: Uint8Array; mtime: number }>();
  trashed: string[] = [];
  afterList: (() => void) | null = null;
  private static clock = 1_000;

  constructor(private readonly caseInsensitive = false) {}

  private key(path: string): string | undefined {
    if (this.files.has(path) || !this.caseInsensitive) return this.files.has(path) ? path : undefined;
    return [...this.files.keys()].find((p) => p.toLowerCase() === path.toLowerCase());
  }

  set(path: string, text: string | Uint8Array): void {
    const data = typeof text === "string" ? new TextEncoder().encode(text) : text;
    const k = this.key(path) ?? path;
    this.files.set(k, { data, mtime: MemFs.clock++ });
  }

  text(path: string): string | undefined {
    const k = this.key(path);
    const f = k && this.files.get(k);
    return f ? new TextDecoder().decode(f.data) : undefined;
  }

  private stat(path: string): LocalFile | null {
    const k = this.key(path);
    const f = k && this.files.get(k);
    return f ? { mtime: f.mtime, size: f.data.length } : null;
  }

  async list(): Promise<Map<string, LocalFile>> {
    const out = new Map([...this.files].map(([p, f]) => [p, { mtime: f.mtime, size: f.data.length }]));
    const hook = this.afterList;
    this.afterList = null;
    hook?.();
    return out;
  }

  async read(path: string): Promise<Uint8Array> {
    const k = this.key(path);
    if (!k) throw new LocalChanged("not found locally");
    return this.files.get(k)!.data;
  }

  async write(path: string, data: Uint8Array, expected: LocalFile | null): Promise<LocalFile> {
    const now = this.stat(path);
    if (JSON.stringify(now) !== JSON.stringify(expected)) throw new LocalChanged();
    this.set(path, data);
    return this.stat(path)!;
  }

  async trash(path: string, expected: LocalFile): Promise<void> {
    if (JSON.stringify(this.stat(path)) !== JSON.stringify(expected)) throw new LocalChanged();
    this.files.delete(this.key(path)!);
    this.trashed.push(path);
  }
}

export const fetchHttp: Http = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  return { status: res.status, headers, body: await res.arrayBuffer() };
};

export function rcloneBin(): string | null {
  const fromEnv = process.env.RCLONE;
  if (fromEnv) return fromEnv;
  const found = Bun.which("rclone");
  if (found) return found;
  const winget = join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Links", "rclone.exe");
  return Bun.file(winget).size > 0 ? winget : null;
}

export type Server = Awaited<ReturnType<typeof startServer>>;

/** A throwaway WebDAV server: rclone over a temp folder. `http` wraps every request (to inject failures). */
export async function startServer() {
  const bin = rcloneBin();
  if (!bin) throw new Error("rclone not found (put it on the PATH or set RCLONE)");
  const dir = mkdtempSync(join(tmpdir(), "webdav-sync-"));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const proc = Bun.spawn(
    [bin, "serve", "webdav", dir, "--addr", `127.0.0.1:${port}`, "--user", "u", "--pass", "p", "--etag-hash", "MD5", "--dir-cache-time", "0s"],
    { stdout: "ignore", stderr: "ignore" },
  );
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(url);
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
  return {
    url,
    dir,
    dav: (http: Http = fetchHttp) => new WebDav(http, url, "u", "p"),
    stop: () => {
      proc.kill();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows may hold it a moment */
      }
    },
  };
}
