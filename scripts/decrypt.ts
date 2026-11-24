// Recovers the notes from a copy of the server's folder (a backup), without Obsidian:
//   bun run decrypt <folder with sync.json and *.bin> <output folder>
// It asks for the passphrase (or reads PASSPHRASE). Files in the server's .trash/ come back under <output>/.trash/<time>/.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { type Meta, open, unlock, validPath } from "../src/crypto";

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error("usage: bun run decrypt <server copy> <output folder>");
  process.exit(2);
}
const passphrase = process.env.PASSPHRASE || prompt("Encryption passphrase:");
if (!passphrase) process.exit(2);

const meta = JSON.parse(readFileSync(join(src, "sync.json"), "utf8")) as Meta;
const keys = await unlock(passphrase, meta);
const root = resolve(out);

function* walk(dir: string): Generator<string> {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/^[0-9a-f]{32}\.bin$/.test(f)) yield p;
  }
}

let ok = 0;
let bad = 0;
for (const file of walk(src)) {
  try {
    const name = file.split(/[\\/]/).pop()!;
    const { path, data } = await open(keys, new Uint8Array(readFileSync(file)), name);
    if (!validPath(path)) throw new Error(`refused path ${JSON.stringify(path)}`);
    const sub = dirname(relative(src, file)); // "." or ".trash/<time>"
    const target = resolve(root, sub === "." ? "" : sub, ...path.split("/"));
    if (!target.startsWith(root + sep)) throw new Error(`refused path ${JSON.stringify(path)}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    ok++;
  } catch (err) {
    console.error(`${file}: ${err instanceof Error ? err.message : err}`);
    bad++;
  }
}
console.log(`${ok} recovered, ${bad} failed → ${out}`);
process.exit(bad ? 1 : 0);
