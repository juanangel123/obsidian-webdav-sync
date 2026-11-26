// The plugin in a real Obsidian, before a release: `bun run build && bun tests/obsidian/e2e.ts` (Windows; Obsidian
// installed per user, rclone on the PATH or from winget). Two Obsidian instances with their own profiles and throwaway
// vaults in a temp folder, driven over the DevTools protocol, sync against a local rclone WebDAV server. An Obsidian
// already open is not touched.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rcloneBin } from "../helpers";

const ROOT = mkdtempSync(join(tmpdir(), "webdav-sync-e2e-"));
const PLUGIN = join(import.meta.dir, "..", "..");
const OBS = join(process.env.LOCALAPPDATA!, "Programs", "Obsidian", "Obsidian.exe");
const RCLONE = rcloneBin() ?? "rclone";
const ID = "webdav-vault-sync";
const PORT = 28097;
const procs: { kill(): void }[] = [];
let failed = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed++;
};

mkdirSync(join(ROOT, "srv"));
mkdirSync(join(ROOT, "srv2"));
procs.push(
  Bun.spawn(
    [RCLONE, "serve", "webdav", join(ROOT, "srv2"), "--addr", `127.0.0.1:${PORT + 1}`, "--user", "u", "--pass", "p", "--etag-hash", "MD5", "--dir-cache-time", "0s"],
    { stdout: "ignore", stderr: "ignore" },
  ),
);
procs.push(
  Bun.spawn(
    [RCLONE, "serve", "webdav", join(ROOT, "srv"), "--addr", `127.0.0.1:${PORT}`, "--user", "u", "--pass", "p", "--etag-hash", "MD5", "--dir-cache-time", "0s"],
    { stdout: "ignore", stderr: "ignore" },
  ),
);

function vault(name: string, notes: Record<string, string>) {
  const v = join(ROOT, name);
  const pd = join(v, ".obsidian", "plugins", ID);
  mkdirSync(pd, { recursive: true });
  for (const f of ["main.js", "manifest.json"]) writeFileSync(join(pd, f), readFileSync(join(PLUGIN, f)));
  const settings = {
    url: `http://127.0.0.1:${PORT}`,
    username: "u",
    password: "p",
    passphrase: "frase de prueba",
    intervalMinutes: 5,
    syncOnStartup: false,
    syncAfterEdit: true,
  };
  writeFileSync(join(pd, "data.json"), JSON.stringify({ settings, state: {} }));
  writeFileSync(join(v, ".obsidian", "community-plugins.json"), JSON.stringify([ID]));
  for (const [p, t] of Object.entries(notes)) {
    mkdirSync(dirname(join(v, p)), { recursive: true });
    writeFileSync(join(v, p), t);
  }
  return v;
}

function launch(name: string, v: string, port: number) {
  const prof = join(ROOT, "prof" + name);
  mkdirSync(prof, { recursive: true });
  writeFileSync(join(prof, "obsidian.json"), JSON.stringify({ vaults: { ["t" + name]: { path: v, ts: Date.now(), open: true } } }));
  procs.push(Bun.spawn([OBS, `--user-data-dir=${prof}`, `--remote-debugging-port=${port}`], { stdout: "ignore", stderr: "ignore" }));
}

type Ev = (expr: string) => Promise<any>;

async function connect(port: number): Promise<Ev> {
  for (let i = 0; i < 120; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[];
      const page = list.find((t) => t.type === "page" && t.url.includes("index.html"));
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r) => (ws.onopen = r));
        let id = 0;
        const pending = new Map<number, (v: any) => void>();
        ws.onmessage = (m) => {
          const d = JSON.parse(String(m.data));
          pending.get(d.id)?.(d);
          pending.delete(d.id);
        };
        const ev: Ev = async (expr) => {
          const n = ++id;
          const p = new Promise<any>((r) => pending.set(n, r));
          ws.send(
            JSON.stringify({
              id: n,
              method: "Runtime.evaluate",
              params: { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true },
            }),
          );
          const d = await p;
          if (d.result?.exceptionDetails) throw new Error(JSON.stringify(d.result.exceptionDetails).slice(0, 600));
          return d.result?.result?.value;
        };
        for (let j = 0; j < 60; j++) {
          if (await ev("return !!(window.app && app.workspace && app.workspace.layoutReady)").catch(() => false)) return ev;
          await Bun.sleep(500);
        }
      }
    } catch {
      /* not up yet */
    }
    await Bun.sleep(500);
  }
  throw new Error("no obsidian on " + port);
}

const bins = () => readdirSync(join(ROOT, "srv")).filter((f) => f.endsWith(".bin"));
const P = `app.plugins.plugins["${ID}"]`;
const enable = `if (!app.plugins.isEnabled()) await app.plugins.setEnable(true); if (!${P}) await app.plugins.enablePlugin("${ID}"); return !!${P};`;
const syncNow = `await ${P}.runSync(true); return ${P}.data.lastSync;`;
const read = (p: string) => `const f = app.vault.getAbstractFileByPath(${JSON.stringify(p)}); return f ? await app.vault.read(f) : null;`;
const files = `return app.vault.getFiles().map(f => f.path).sort();`;
const notices = `return [...document.querySelectorAll(".notice")].map(n => n.textContent);`;
const modify = (p: string, t: string) =>
  `await app.vault.modify(app.vault.getAbstractFileByPath(${JSON.stringify(p)}), ${JSON.stringify(t)}); return 1;`;

try {
  const vA = vault("A", { "Nota.md": "hola desde A", "Carpeta/Señal ñ #1.md": "dos", "adj/img.png": "PNGfake" });
  const vB = vault("B", {});
  launch("A", vA, 9333);
  launch("B", vB, 9334);
  const A = await connect(9333);
  const B = await connect(9334);
  check(await A(enable), "plugin loads in A");
  check(await B(enable), "plugin loads in B");
  const dataA = readFileSync(join(vA, ".obsidian", "plugins", ID, "data.json"), "utf8");
  check(!dataA.includes("frase de prueba") && !dataA.includes('"password"'), "secrets moved out of data.json");
  check((await A(`return ${P}.getSecret("passphrase")`)) === "frase de prueba", "the passphrase is in Obsidian's secret storage");

  await A(syncNow);
  check(bins().length === 3 && existsSync(join(ROOT, "srv", "sync.json")), `A uploaded 3 encrypted files (${bins().length})`);
  check(!readdirSync(join(ROOT, "srv")).some((f) => /Nota|Señal/.test(f)), "no names on the server");
  check(bins().every((b) => !readFileSync(join(ROOT, "srv", b)).toString("latin1").includes("hola")), "no plaintext on the server");

  await B(syncNow);
  check((await B(read("Carpeta/Señal ñ #1.md"))) === "dos", "B downloaded the note with unicode and #");
  check(JSON.stringify(await B(files)) === JSON.stringify(await A(files)), "A and B hold the same files");

  // An edit in B syncs on its own (20 s after editing), then A pulls it.
  await B(modify("Nota.md", "editada en B"));
  await Bun.sleep(27_000);
  await A(syncNow);
  check((await A(read("Nota.md"))) === "editada en B", "an edit in B reaches A (B synced on its own after editing)");

  // The plugin's own download must not set off endless syncs.
  const t1 = await A(`return ${P}.data.lastSync;`);
  await Bun.sleep(25_000);
  const t2 = await A(`return ${P}.data.lastSync;`);
  check(t2 - t1 <= 25_000, `no sync loop after a download (lastSync moved ${t2 - t1} ms)`);

  // Conflict.
  await A(modify("Nota.md", "versión A"));
  await B(modify("Nota.md", "versión B"));
  await A(syncNow);
  await B(syncNow);
  await A(syncNow);
  const fa = (await A(files)) as string[];
  const copy = fa.find((f) => f.includes("conflict"));
  check(
    !!copy && (await A(read("Nota.md"))) === "versión B" && (await A(read(copy!))) === "versión A",
    `conflict kept both (${copy})`,
  );

  // A deletion goes to the trash on both sides.
  await A(`await app.vault.trash(app.vault.getAbstractFileByPath("adj/img.png"), false); return 1;`);
  await A(syncNow);
  await B(syncNow);
  check(!((await B(files)) as string[]).includes("adj/img.png"), "a deletion in A reaches B");
  check(existsSync(join(ROOT, "B", ".trash")), "B keeps it in the vault's .trash");
  check(existsSync(join(ROOT, "srv", ".trash")), "the server keeps it in its .trash");

  // A wrong passphrase.
  // In English and in Spanish: Obsidian's language (by default the system's), read when the plugin loads.
  await B(`${P}.setSecret("passphrase", "mala"); ${P}.settingsChanged(); return 1;`);
  const wrongIn = async (lang: string) => {
    await B(
      `localStorage.setItem("language", "${lang}"); await app.plugins.disablePlugin("${ID}"); await app.plugins.enablePlugin("${ID}"); await ${P}.runSync(true); return 1;`,
    );
    return ((await B(notices)) as string[]) ?? [];
  };
  const n = await wrongIn("en");
  check(n.some((t) => /wrong encryption passphrase/.test(t)), `a wrong passphrase is told: ${n.at(-1)}`);
  const ns = await wrongIn("es");
  check(ns.some((t) => /frase de cifrado no es correcta/.test(t)), `in Spanish too: ${ns.at(-1)}`);
  await B(`localStorage.removeItem("language"); return 1;`);

  // Another server (a new empty folder): the old state must not delete anything here.
  const before = (await A(files)) as string[];
  const trashBefore = readdirSync(join(ROOT, "A", ".trash"), { recursive: true }).length;
  await A(`${P}.data.settings.url = "http://127.0.0.1:${PORT + 1}"; ${P}.settingsChanged(); await ${P}.save(); await ${P}.runSync(true); return 1;`);
  check(JSON.stringify(await A(files)) === JSON.stringify(before), "pointing at a new server deletes nothing locally");
  check(readdirSync(join(ROOT, "srv2")).filter((f) => f.endsWith(".bin")).length === before.length, `everything uploaded to the new server (${before.length})`);
  check(readdirSync(join(ROOT, "A", ".trash"), { recursive: true }).length === trashBefore, "nothing new in A's trash");
} catch (e) {
  console.error(e);
  failed++;
} finally {
  for (const p of procs) {
    try {
      p.kill();
    } catch {
      /* gone */
    }
  }
}
await Bun.sleep(1_000);
try {
  rmSync(ROOT, { recursive: true, force: true });
} catch {
  /* Windows may hold it a moment */
}
console.log(failed ? `${failed} FAILED` : "ALL PASS");
process.exit(failed ? 1 : 0);
