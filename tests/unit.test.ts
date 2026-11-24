import { describe, expect, test } from "bun:test";
import { DecryptError, deriveKeys, newMeta, open, remoteName, seal, unlock, validPath } from "../src/crypto";
import { type LocalFile, type RemoteFile, type Synced, conflictPath, deletions, needsConfirmation, plan } from "../src/plan";
import { parseMultistatus } from "../src/webdav";

const enc = new TextEncoder();

describe("crypto", () => {
  test("seal and open round-trip; the name is deterministic and hides the path", async () => {
    const keys = await deriveKeys("pass", new Uint8Array(16), 1000);
    const blob = await seal(keys, "Carpeta/Señal ñ.md", enc.encode("hola"), 7);
    expect(new TextDecoder().decode(blob)).not.toContain("Señal");
    const name = await remoteName(keys, "Carpeta/Señal ñ.md");
    const o = await open(keys, blob, name);
    expect(o.path).toBe("Carpeta/Señal ñ.md");
    expect(o.version).toBe(7);
    expect(new TextDecoder().decode(o.data)).toBe("hola");
    expect(await remoteName(keys, "a.md")).toBe(await remoteName(keys, "a.md"));
    expect(await remoteName(keys, "a.md")).not.toBe(await remoteName(keys, "b.md"));
    expect(await remoteName(keys, "a.md")).toMatch(/^[0-9a-f]{32}\.bin$/);
  });

  test("an empty file seals and opens", async () => {
    const keys = await deriveKeys("pass", new Uint8Array(16), 1000);
    const o = await open(keys, await seal(keys, "vacía.md", new Uint8Array()));
    expect(o.data.length).toBe(0);
  });

  test("a blob served under another note's name is refused", async () => {
    const keys = await deriveKeys("pass", new Uint8Array(16), 1000);
    const blob = await seal(keys, "a.md", enc.encode("A"));
    await expect(open(keys, blob, await remoteName(keys, "b.md"))).rejects.toThrow("wrong name");
  });

  test("two seals of the same content differ (random IV)", async () => {
    const keys = await deriveKeys("pass", new Uint8Array(16), 1000);
    expect(await seal(keys, "a.md", enc.encode("x"))).not.toEqual(await seal(keys, "a.md", enc.encode("x")));
  });

  test("a wrong passphrase fails, a tampered blob fails", async () => {
    const { meta, keys } = await newMeta("right", 1000);
    await expect(unlock("wrong", meta)).rejects.toThrow("wrong encryption passphrase");
    await unlock("right", meta);
    const blob = await seal(keys, "a.md", enc.encode("x"));
    blob[blob.length - 1] ^= 1;
    await expect(open(keys, blob)).rejects.toBeInstanceOf(DecryptError);
  });

  test("a tampered sync.json is refused before any work (huge rounds, bad salt, unknown format)", async () => {
    const { meta } = await newMeta("right", 1000);
    const t0 = Date.now();
    await expect(unlock("right", { ...meta, iterations: 2_000_000_000 })).rejects.toThrow("damaged");
    expect(Date.now() - t0).toBeLessThan(500);
    await expect(unlock("right", { ...meta, salt: "zz" })).rejects.toThrow("damaged");
    await expect(unlock("right", { ...meta, version: 2 as 1 })).rejects.toThrow("unknown vault format");
  });

  test.each([
    ["Nota.md", true],
    ["Carpeta/Sub/Señal ñ #1 (x).md", true],
    ["a b.md", true],
    ["", false],
    ["/abs.md", false],
    ["a//b.md", false],
    ["../fuera.md", false],
    ["a/./b.md", false],
    [".obsidian/plugins/x/main.js", false],
    ["notas/.oculta.md", false],
    ["a\\b.md", false],
    ["C:/x.md", false],
    ["a\u0000b.md", false],
  ])("validPath(%p) is %p", (path, ok) => {
    expect(validPath(path)).toBe(ok);
  });
});

describe("plan", () => {
  const L = (mtime: number, size = 1): LocalFile => ({ mtime, size });
  const R = (etag: string): RemoteFile => ({ name: "n", etag, size: 1 });
  const S = (mtime: number, etag: string, size = 1): Synced => ({ mtime, size, etag, name: "n", version: 1 });
  const one = (l?: LocalFile, r?: RemoteFile, s?: Synced) =>
    plan(new Map(l ? [["p", l]] : []), new Map(r ? [["p", r]] : []), new Map(s ? [["p", s]] : [])).map((a) => a.kind);

  test.each([
    ["new here", L(1), undefined, undefined, ["upload"]],
    ["new there", undefined, R("e"), undefined, ["download"]],
    ["new on both", L(1), R("e"), undefined, ["reconcile"]],
    ["unchanged", L(1), R("e"), S(1, "e"), []],
    ["changed here", L(2), R("e"), S(1, "e"), ["upload"]],
    ["size changed here", L(1, 5), R("e"), S(1, "e"), ["upload"]],
    ["changed there", L(1), R("f"), S(1, "e"), ["download"]],
    ["changed on both", L(2), R("f"), S(1, "e"), ["reconcile"]],
    ["deleted there", L(1), undefined, S(1, "e"), ["deleteLocal"]],
    ["deleted there, edited here", L(2), undefined, S(1, "e"), ["upload"]],
    ["deleted here", undefined, R("e"), S(1, "e"), ["deleteRemote"]],
    ["deleted here, edited there", undefined, R("f"), S(1, "e"), ["download"]],
    ["deleted on both", undefined, undefined, S(1, "e"), ["forget"]],
  ] as const)("%s", (_, l, r, s, expected) => {
    expect(one(l, r, s)).toEqual([...expected]);
  });

  test("the deletion guard: more than 5 and more than a third of what was synced", () => {
    const d = (n: number) => ({ local: Array.from({ length: n }, (_, i) => `${i}`), remote: [] });
    expect(needsConfirmation(d(5), 6)).toBe(false); // 5 or fewer: always fine
    expect(needsConfirmation(d(6), 18)).toBe(false); // exactly a third
    expect(needsConfirmation(d(6), 17)).toBe(true);
    expect(needsConfirmation(d(6), 100)).toBe(false);
    expect(deletions([{ kind: "deleteLocal", path: "a" }, { kind: "deleteRemote", path: "b" }, { kind: "upload", path: "c" }])).toEqual({
      local: ["a"],
      remote: ["b"],
    });
  });

  test("conflict names", () => {
    const now = new Date(2026, 10, 24, 10, 12);
    expect(conflictPath("a/Nota.md", now, () => false)).toBe("a/Nota (conflict 2026-11-24 1012).md");
    expect(conflictPath("a.b/README", now, () => false)).toBe("a.b/README (conflict 2026-11-24 1012)");
    const taken = new Set(["Nota (conflict 2026-11-24 1012).md"]);
    expect(conflictPath("Nota.md", now, (p) => taken.has(p))).toBe("Nota (conflict 2026-11-24 1012 2).md");
  });
});

describe("webdav", () => {
  test("parses a multistatus with any namespace prefix and quoted etags", () => {
    const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
      <D:response><D:href>/base/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
      <D:response><D:href>/base/a%20b.bin</D:href><D:propstat><D:prop><D:resourcetype/><D:getetag>"abc"</D:getetag><D:getcontentlength>12</D:getcontentlength></D:prop></D:propstat></D:response>
      <d:response xmlns:d="DAV:"><d:href>/base/x&amp;y.bin</d:href><d:propstat><d:prop><d:getetag>W/&quot;q&quot;</d:getetag></d:prop></d:propstat></d:response>
    </D:multistatus>`;
    expect(parseMultistatus(xml)).toEqual([
      { href: "/base/", etag: "", size: 0, dir: true },
      { href: "/base/a%20b.bin", etag: "abc", size: 12, dir: false },
      { href: "/base/x&y.bin", etag: "q", size: 0, dir: false },
    ]);
  });
});
