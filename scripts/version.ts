// Sets a new version everywhere it lives: `bun run version 0.2.0` → package.json, manifest.json, versions.json.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("usage: bun run version <x.y.z>");
  process.exit(2);
}
const json = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const write = (f: string, v: unknown) => writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`);
const pkg = json("package.json");
const manifest = json("manifest.json");
const versions = json("versions.json");
pkg.version = version;
manifest.version = version;
versions[version] = manifest.minAppVersion;
write("package.json", pkg);
write("manifest.json", manifest);
write("versions.json", versions);
console.log(`${version} (min app ${manifest.minAppVersion})`);
