// Devices against a real WebDAV server (rclone serve webdav). Each test gets its own server.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DecryptError } from "../src/crypto";
import type { Deletions } from "../src/plan";
import { type Result, type State, NoVault, openVault, sync } from "../src/sync";
import type { Http } from "../src/webdav";
import { MemFs, type Server, fetchHttp, rcloneBin, startServer } from "./helpers";

const ITER = 1000; // fast keys for tests

class Device {
  state: State = {};
  constructor(
    readonly server: Server,
    readonly fs = new MemFs(),
    private readonly passphrase = "secret",
  ) {}

  /** One run; `http` wraps this run's requests. Errors are expected empty unless `allowErrors`. */
  async sync(opts: { confirmed?: Deletions; http?: Http; allowErrors?: boolean; maxBytes?: number } = {}): Promise<Result> {
    const dav = this.server.dav(opts.http);
    const { keys } = await openVault(dav, this.passphrase, { create: true, iterations: ITER });
    const r = await sync({ dav, keys, local: this.fs, state: this.state, confirmed: opts.confirmed, maxBytes: opts.maxBytes });
    if (!r.blocked) this.state = r.state;
    if (!opts.allowErrors) expect(r.errors).toEqual([]);
    return r;
  }
}

/** Runs `then` once, right after the first response that matches. */
function hookAfter(match: (method: string, depth?: string) => boolean, then: () => Promise<void>): Http {
  let fired = false;
  return async (req) => {
    const res = await fetchHttp(req);
    if (!fired && match(req.method, req.headers.Depth)) {
      fired = true;
      await then();
    }
    return res;
  };
}

const servers: Server[] = [];
async function server(): Promise<Server> {
  const s = await startServer();
  servers.push(s);
  return s;
}
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
});

const bins = (s: Server) => readdirSync(s.dir).filter((f) => f.endsWith(".bin"));
const listing = (m: string, d?: string) => m === "PROPFIND" && d === "1";

describe.skipIf(!rcloneBin())("sync", () => {
  test("the server sees no names nor contents; an empty device gets everything; nothing to do twice", async () => {
    const s = await server();
    const a = new Device(s);
    a.fs.set("Nota.md", "uno");
    a.fs.set("Carpeta/Sub/Señal ñ #1.md", "dos");
    a.fs.set("img/x.png", new Uint8Array([0, 255, 1, 2]));
    expect((await a.sync()).uploaded).toBe(3);
    expect(bins(s)).toHaveLength(3);
    expect(readdirSync(s.dir).sort()).toEqual([...bins(s), "sync.json"].sort());
    for (const f of bins(s)) {
      const raw = readFileSync(join(s.dir, f)).toString("latin1");
      expect(raw).not.toContain("uno");
      expect(raw).not.toContain("Nota");
    }
    expect((await a.sync()).uploaded).toBe(0);

    const b = new Device(s);
    expect((await b.sync()).downloaded).toBe(3);
    expect(b.fs.text("Carpeta/Sub/Señal ñ #1.md")).toBe("dos");
    expect(b.fs.files.get("img/x.png")!.data).toEqual(new Uint8Array([0, 255, 1, 2]));
    const again = await b.sync();
    expect(again.downloaded + again.uploaded).toBe(0);
  });

  test("edits, new notes and deletions travel; deletions go to a trash on both sides", async () => {
    const s = await server();
    const a = new Device(s);
    const b = new Device(s);
    a.fs.set("Nota.md", "uno");
    await a.sync();
    await b.sync();
    b.fs.set("Nota.md", "editada en b");
    b.fs.set("Nueva.md", "tres");
    await b.sync();
    await a.sync();
    expect(a.fs.text("Nota.md")).toBe("editada en b");
    expect(a.fs.text("Nueva.md")).toBe("tres");
    a.fs.files.delete("Nueva.md");
    expect((await a.sync()).deletedRemote).toBe(1);
    expect(readdirSync(join(s.dir, ".trash")).length).toBe(1);
    expect((await b.sync()).deletedLocal).toBe(1);
    expect(b.fs.trashed).toContain("Nueva.md");
  });

  test("an edit wins over a deletion made elsewhere", async () => {
    const s = await server();
    const a = new Device(s);
    const b = new Device(s);
    a.fs.set("Viva.md", "v1");
    await a.sync();
    await b.sync();
    a.fs.files.delete("Viva.md");
    await a.sync();
    b.fs.set("Viva.md", "v2 editada en b");
    await b.sync();
    await a.sync();
    expect(a.fs.text("Viva.md")).toBe("v2 editada en b");
  });

  test("the same note edited on both: nothing lost, a conflict copy on both", async () => {
    const s = await server();
    const a = new Device(s);
    const b = new Device(s);
    a.fs.set("Nota.md", "v0");
    await a.sync();
    await b.sync();
    a.fs.set("Nota.md", "versión A");
    b.fs.set("Nota.md", "versión B");
    await a.sync();
    const r = await b.sync();
    expect(r.conflicts).toHaveLength(1);
    const copy = r.conflicts[0];
    expect(copy).toMatch(/^Nota \(conflict \d{4}-\d\d-\d\d \d{4}\)\.md$/);
    expect(b.fs.text("Nota.md")).toBe("versión B");
    expect(b.fs.text(copy)).toBe("versión A");
    await a.sync();
    expect(a.fs.text("Nota.md")).toBe("versión B");
    expect(a.fs.text(copy)).toBe("versión A");
  });

  test("the same new note on both with the same content is no conflict", async () => {
    const s = await server();
    const a = new Device(s);
    const b = new Device(s);
    a.fs.set("Igual.md", "mismo");
    b.fs.set("Igual.md", "mismo");
    await a.sync();
    expect((await b.sync()).conflicts).toEqual([]);
  });
});

describe.skipIf(!rcloneBin())("races and failures", () => {
  test("two devices syncing at once: the slower one's stale upload becomes a conflict, not an overwrite", async () => {
    const s = await server();
    const a = new Device(s);
    const b = new Device(s);
    a.fs.set("Nota.md", "v0");
    await a.sync();
    await b.sync();
    a.fs.set("Nota.md", "A edit");
    b.fs.set("Nota.md", "B edit");
    // A lists the server, then B runs a whole sync, then A carries out its (now stale) plan.
    const r = await a.sync({ http: hookAfter(listing, async () => void (await b.sync())) });
    expect(r.conflicts).toHaveLength(1);
    await b.sync();
    await a.sync();
    for (const d of [a, b]) {
      expect(d.fs.text("Nota.md")).toBe("A edit");
      expect(d.fs.text(r.conflicts[0])).toBe("B edit");
    }
  });

  test("two devices creating the same note at once keep both", async () => {
    const s = await server();
    const a = new Device(s);
    const b = new Device(s);
    await a.sync(); // the vault exists; the race is over a note, not over setting it up
    a.fs.set("2026-11-24.md", "diario de A");
    b.fs.set("2026-11-24.md", "diario de B");
    await a.sync({ http: hookAfter(listing, async () => void (await b.sync())) });
    await b.sync();
    await a.sync();
    const texts = [...a.fs.files.values()].map((f) => new TextDecoder().decode(f.data)).sort();
    expect(texts).toEqual(["diario de A", "diario de B"]);
    expect([...a.fs.files.keys()].sort()).toEqual([...b.fs.files.keys()].sort());
  });

  test("a deletion racing an edit from another device keeps the edit", async () => {
    const s = await server();
    const a = new Device(s);
    const b = new Device(s);
    a.fs.set("Borrar.md", "v0");
    await a.sync();
    await b.sync();
    a.fs.files.delete("Borrar.md");
    b.fs.set("Borrar.md", "editada en B");
    await a.sync({ http: hookAfter(listing, async () => void (await b.sync())) });
    await a.sync();
    await b.sync();
    expect(a.fs.text("Borrar.md")).toBe("editada en B");
    expect(b.fs.text("Borrar.md")).toBe("editada en B");
  });

  test("a note edited here while a run downloads it is not overwritten", async () => {
    const s = await server();
    const desk = new Device(s);
    const phone = new Device(s);
    desk.fs.set("Diario.md", "v0");
    await desk.sync();
    await phone.sync();
    desk.fs.set("Diario.md", "from desktop");
    await desk.sync();
    phone.fs.afterList = () => phone.fs.set("Diario.md", "typed on phone");
    const r = await phone.sync();
    expect(phone.fs.text("Diario.md")).toBe("typed on phone");
    expect(r.conflicts).toHaveLength(1);
    expect(phone.fs.text(r.conflicts[0])).toBe("from desktop");
  });

  test("an older blob put back on the server (a restore) never rolls a note back", async () => {
    const s = await server();
    const a = new Device(s);
    const b = new Device(s);
    a.fs.set("Nota.md", "yesterday");
    await a.sync();
    await b.sync();
    const backup = mkdtempSync(join(tmpdir(), "webdav-sync-backup-"));
    cpSync(s.dir, backup, { recursive: true });
    a.fs.set("Nota.md", "today's work");
    await a.sync();
    await b.sync();
    rmSync(s.dir, { recursive: true, force: true });
    cpSync(backup, s.dir, { recursive: true });
    rmSync(backup, { recursive: true, force: true });
    const r = await b.sync();
    expect(b.fs.text("Nota.md")).toBe("today's work");
    expect(r.conflicts).toHaveLength(1);
    expect(b.fs.text(r.conflicts[0])).toBe("yesterday");
    await a.sync();
    expect(a.fs.text("Nota.md")).toBe("today's work");
  });

  test("a run cut off half way (network down, then 507s) loses nothing; the next finishes it", async () => {
    const s = await server();
    const a = new Device(s);
    const b = new Device(s);
    await a.sync();
    await b.sync();
    for (let i = 0; i < 20; i++) a.fs.set(`corte/${i}.md`, `c${i}`);
    let calls = 0;
    const flaky: Http = async (req) => {
      if (++calls > 15) throw new Error("network down");
      return fetchHttp(req);
    };
    const cut = await a.sync({ http: flaky, allowErrors: true });
    expect(cut.errors.length).toBeGreaterThan(0);
    const full: Http = async (req) => (req.method === "PUT" ? { status: 507, headers: {}, body: new ArrayBuffer(0) } : fetchHttp(req));
    expect((await a.sync({ http: full, allowErrors: true })).errors.length).toBeGreaterThan(0);
    await a.sync();
    await b.sync();
    for (let i = 0; i < 20; i++) expect(b.fs.text(`corte/${i}.md`)).toBe(`c${i}`);
  });

  test("a run whose state was never saved (app killed) re-syncs with no conflicts nor duplicates", async () => {
    const s = await server();
    const a = new Device(s);
    a.fs.set("x.md", "x");
    await a.sync();
    const b = new Device(s);
    await b.sync();
    b.state = {}; // as if the app died before saving
    const r = await b.sync();
    expect(r.conflicts).toEqual([]);
    expect(r.uploaded + r.downloaded).toBe(0);
  });

  test("a conflict whose upload failed half way does not breed a second copy", async () => {
    const s = await server();
    const a = new Device(s);
    const b = new Device(s);
    a.fs.set("Nota.md", "v0");
    await a.sync();
    await b.sync();
    a.fs.set("Nota.md", "A");
    await a.sync();
    b.fs.set("Nota.md", "B");
    let puts = 0;
    const failSecondPut: Http = async (req) => {
      if (req.method === "PUT" && ++puts === 2) return { status: 500, headers: {}, body: new ArrayBuffer(0) };
      return fetchHttp(req);
    };
    await b.sync({ http: failSecondPut, allowErrors: true });
    await b.sync();
    const copies = [...b.fs.files.keys()].filter((p) => p.includes("conflict"));
    expect(copies).toHaveLength(1);
    expect(b.fs.text("Nota.md")).toBe("B");
    expect(b.fs.text(copies[0])).toBe("A");
  });

  test("an undecryptable file is reported and left alone; the rest syncs", async () => {
    const s = await server();
    const a = new Device(s);
    a.fs.set("Buena.md", "ok");
    await a.sync();
    writeFileSync(join(s.dir, `${"ab".repeat(16)}.bin`), "garbage that is not a sealed file at all......");
    const b = new Device(s);
    const r = await b.sync({ allowErrors: true });
    expect(r.errors).toHaveLength(1);
    expect(b.fs.text("Buena.md")).toBe("ok");
    // A known note's blob replaced by garbage: the local copy stays as it is.
    writeFileSync(join(s.dir, bins(s).find((f) => !f.startsWith("abab"))!), "garbage, again, long enough to be considered...");
    const r2 = await b.sync({ allowErrors: true });
    expect(r2.errors.length).toBeGreaterThan(0);
    expect(b.fs.text("Buena.md")).toBe("ok");
  });

  test("a blob copied under another note's name is refused", async () => {
    const s = await server();
    const a = new Device(s);
    a.fs.set("a.md", "AAA");
    a.fs.set("b.md", "BBB");
    await a.sync();
    const b = new Device(s);
    await b.sync();
    const [x, y] = bins(s);
    writeFileSync(join(s.dir, y), readFileSync(join(s.dir, x)));
    await b.sync({ allowErrors: true });
    expect(b.fs.text("a.md")).toBe("AAA");
    expect(b.fs.text("b.md")).toBe("BBB");
  });
});

describe.skipIf(!rcloneBin())("vaults, guard, limits", () => {
  test("a wrong passphrase is refused before anything changes", async () => {
    const s = await server();
    const a = new Device(s);
    a.fs.set("x.md", "x");
    await a.sync();
    const c = new Device(s, new MemFs(), "wrong");
    c.fs.set("Intruso.md", "x");
    await expect(c.sync()).rejects.toBeInstanceOf(DecryptError);
    expect(bins(s)).toHaveLength(1);
  });

  test("no vault is set up automatically, nor over existing notes", async () => {
    const s = await server();
    await expect(openVault(s.dav(), "secret", { iterations: ITER })).rejects.toBeInstanceOf(NoVault);
    // Set up by hand (Check, Sync now): told so, once; opening it again is not "created".
    expect((await openVault(s.dav(), "secret", { create: true, iterations: ITER })).created).toBe(true);
    expect((await openVault(s.dav(), "secret", { create: true, iterations: ITER })).created).toBe(false);
    rmSync(join(s.dir, "sync.json"));
    const a = new Device(s);
    a.fs.set("x.md", "x");
    await a.sync();
    rmSync(join(s.dir, "sync.json"));
    await expect(openVault(s.dav(), "secret", { create: true, iterations: ITER })).rejects.toThrow("refusing");
  });

  test("a wiped vault does not wipe the server unless those exact deletions are confirmed", async () => {
    const s = await server();
    const a = new Device(s);
    const b = new Device(s);
    for (let i = 0; i < 10; i++) a.fs.set(`bulk/${i}.md`, `n${i}`);
    await a.sync();
    await b.sync();
    b.fs.files.clear();
    const r = await b.sync();
    expect(r.blocked?.remote).toHaveLength(10);
    expect(bins(s)).toHaveLength(10);
    expect((await b.sync({ confirmed: { local: [], remote: ["bulk/0.md"] } })).blocked).toBeDefined();
    const forced = await b.sync({ confirmed: r.blocked });
    expect(forced.deletedRemote).toBe(10);
    expect(bins(s)).toHaveLength(0);
    const ra = await a.sync({ confirmed: { local: [], remote: [] } });
    expect(ra.blocked?.local).toHaveLength(10); // the other side asks too
  });

  test("files over the size limit are left out, never deleted", async () => {
    const s = await server();
    const a = new Device(s);
    a.fs.set("grande.pdf", new Uint8Array(3000));
    a.fs.set("nota.md", "x");
    await a.sync();
    const r = await a.sync({ maxBytes: 1000 });
    expect(r.skipped).toEqual(["grande.pdf"]);
    expect(bins(s)).toHaveLength(2);
    const b = new Device(s);
    const rb = await b.sync({ maxBytes: 1000 });
    expect(b.fs.files.has("grande.pdf")).toBe(false);
    expect(rb.downloaded).toBe(1);
  });

  test("empty files, a 5 MB binary and 300 notes", async () => {
    const s = await server();
    const a = new Device(s);
    a.fs.set("vacía.md", "");
    const big = new Uint8Array(5 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 255;
    a.fs.set("adjuntos/grande.pdf", big);
    for (let i = 0; i < 300; i++) a.fs.set(`muchas/${i}.md`, `nota ${i}`);
    await a.sync();
    const b = new Device(s);
    expect((await b.sync()).downloaded).toBe(302);
    expect(b.fs.text("vacía.md")).toBe("");
    expect(b.fs.files.get("adjuntos/grande.pdf")!.data).toEqual(big);
  }, 60_000);
});

describe.skipIf(!rcloneBin())("case-insensitive devices", () => {
  test("a case-only rename elsewhere reaches a Windows/Android device intact", async () => {
    const s = await server();
    const a = new Device(s);
    const w = new Device(s, new MemFs(true));
    a.fs.set("note.md", "contenido");
    await a.sync();
    await w.sync();
    const f = a.fs.files.get("note.md")!;
    a.fs.files.delete("note.md");
    a.fs.set("Note.md", f.data);
    await a.sync();
    await w.sync();
    expect([...w.fs.files.keys()]).toEqual(["Note.md"]);
    expect(w.fs.text("Note.md")).toBe("contenido");
  });

  test("two notes differing only in case: one arrives, the other is reported, nothing overwritten", async () => {
    const s = await server();
    const a = new Device(s);
    a.fs.set("a.md", "minúscula");
    a.fs.set("A.md", "MAYÚSCULA");
    await a.sync();
    const w = new Device(s, new MemFs(true));
    const r = await w.sync({ allowErrors: true });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("case");
    expect(w.fs.files.size).toBe(1);
    await a.sync();
    expect(a.fs.text("a.md")).toBe("minúscula");
    expect(a.fs.text("A.md")).toBe("MAYÚSCULA");
  });
});

describe.skipIf(!rcloneBin())("recovery", () => {
  test("the recovery script decrypts a copy of the server's folder, trash included", async () => {
    const s = await server();
    const a = new Device(s);
    a.fs.set("Carpeta/Nota.md", "hola");
    a.fs.set("Borrada.md", "adiós");
    await a.sync();
    a.fs.files.delete("Borrada.md");
    await a.sync();
    const out = mkdtempSync(join(tmpdir(), "webdav-sync-out-"));
    const proc = Bun.spawnSync(["bun", "scripts/decrypt.ts", s.dir, out], { env: { ...process.env, PASSPHRASE: "secret" }, timeout: 60_000 });
    expect(proc.exitCode).toBe(0);
    expect(readFileSync(join(out, "Carpeta", "Nota.md"), "utf8")).toBe("hola");
    const t = readdirSync(join(out, ".trash"));
    expect(existsSync(join(out, ".trash", t[0], "Borrada.md"))).toBe(true);
    rmSync(out, { recursive: true, force: true });
  }, 90_000);
});
