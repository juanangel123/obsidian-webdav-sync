// End-to-end encryption: the server only ever sees opaque names and ciphertext.
//
// Keys: PBKDF2-SHA-256 (the vault's salt and rounds, from `sync.json` on the server) gives one 256-bit master key;
// HKDF-SHA-256 splits it into an AES-256-GCM key (contents) and an HMAC-SHA-256 key (names).
// Remote name of a note: hex(HMAC(path))[0..32] + ".bin" — deterministic, so every device maps a path to the same file.
// Blob: "WDS1" | 12-byte IV | AES-GCM( u32 header length | header JSON {p: path, v: version} | content ). The path
// travels inside, so a device that meets an unknown name learns its path by opening it; `open` checks the path
// against the name. The version counts a note's uploads (each one the last seen + 1), so an older blob put back on the
// server (a restore, a replay) is told apart from a newer edit.

const enc = new TextEncoder();
const dec = new TextDecoder();
const MAGIC = "WDS1";

/** PBKDF2 rounds for a new vault; a vault's own count lives in its `sync.json`. */
export const ITERATIONS = 600_000;
/** The most rounds accepted from a server, so a tampered `sync.json` can't freeze a device. */
const MAX_ITERATIONS = 10_000_000;

export interface Keys {
  aes: CryptoKey;
  hmac: CryptoKey;
}

/** The bytes as an ArrayBuffer (what WebCrypto and fetch take); no copy when the view spans its whole buffer. */
export function buf(u: Uint8Array): ArrayBuffer {
  if (u.byteOffset === 0 && u.byteLength === u.buffer.byteLength) return u.buffer as ArrayBuffer;
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

function hex(u: Uint8Array): string {
  return Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export async function deriveKeys(passphrase: string, salt: Uint8Array, iterations = ITERATIONS): Promise<Keys> {
  const base = await crypto.subtle.importKey("raw", buf(enc.encode(passphrase)), "PBKDF2", false, ["deriveBits"]);
  const master = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: buf(salt), iterations }, base, 256);
  const hkdf = await crypto.subtle.importKey("raw", master, "HKDF", false, ["deriveKey"]);
  const sub = (info: string) => ({ name: "HKDF", hash: "SHA-256", salt: new ArrayBuffer(0), info: buf(enc.encode(info)) });
  const aes = await crypto.subtle.deriveKey(sub("webdav-vault-sync aes"), hkdf, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const hmac = await crypto.subtle.deriveKey(
    sub("webdav-vault-sync names"),
    hkdf,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  return { aes, hmac };
}

export async function remoteName(keys: Keys, path: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", keys.hmac, buf(enc.encode(path))));
  return hex(sig.subarray(0, 16)) + ".bin";
}

export interface Opened {
  path: string;
  version: number;
  data: Uint8Array;
}

export async function seal(keys: Keys, path: string, data: Uint8Array, version = 1): Promise<Uint8Array> {
  const p = enc.encode(JSON.stringify({ p: path, v: version }));
  const plain = new Uint8Array(4 + p.length + data.length);
  new DataView(plain.buffer).setUint32(0, p.length);
  plain.set(p, 4);
  plain.set(data, 4 + p.length);
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv) }, keys.aes, plain.buffer));
  const out = new Uint8Array(4 + 12 + ct.length);
  out.set(enc.encode(MAGIC), 0);
  out.set(iv, 4);
  out.set(ct, 16);
  return out;
}

export class DecryptError extends Error {}

/**
 * Opens a blob. With `name`, also checks that the sealed path is the one that name stands for, so the server can't
 * serve one note's blob under another's name.
 */
export async function open(keys: Keys, blob: Uint8Array, name?: string): Promise<Opened> {
  if (blob.length < 16 + 16 + 4 || dec.decode(blob.subarray(0, 4)) !== MAGIC) throw new DecryptError("not a sealed file");
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(blob.slice(4, 16)) }, keys.aes, buf(blob.subarray(16))),
    );
  } catch {
    throw new DecryptError("wrong passphrase or damaged file");
  }
  const len = new DataView(plain.buffer, plain.byteOffset).getUint32(0);
  if (4 + len > plain.length) throw new DecryptError("damaged file");
  let header: { p?: unknown; v?: unknown };
  try {
    header = JSON.parse(dec.decode(plain.subarray(4, 4 + len)));
  } catch {
    throw new DecryptError("damaged file");
  }
  const { p: path, v: version } = header;
  if (typeof path !== "string" || !Number.isInteger(version) || (version as number) < 1) throw new DecryptError("damaged file");
  if (name !== undefined && (await remoteName(keys, path)) !== name) throw new DecryptError("file under the wrong name");
  return { path, version: version as number, data: plain.subarray(4 + len) };
}

/** The vault's metadata on the server: the salt, and a sealed marker that proves a passphrase right. */
export interface Meta {
  version: 1;
  id: string; // hex, 16 bytes: this vault on this server (a device's sync state belongs to one)
  salt: string; // hex, 16 bytes
  iterations: number;
  check: string; // hex of seal(keys, CHECK_PATH, "ok")
}

const CHECK_PATH = "\u0000check";

export async function newMeta(passphrase: string, iterations = ITERATIONS): Promise<{ meta: Meta; keys: Keys }> {
  const salt = randomBytes(16);
  const keys = await deriveKeys(passphrase, salt, iterations);
  const check = await seal(keys, CHECK_PATH, enc.encode("ok"));
  return { meta: { version: 1, id: hex(randomBytes(16)), salt: hex(salt), iterations, check: hex(check) }, keys };
}

/** The keys for a vault's metadata, or a DecryptError when the passphrase is not the vault's. */
export async function unlock(passphrase: string, meta: Meta): Promise<Keys> {
  if (meta?.version !== 1) throw new DecryptError(`unknown vault format ${meta?.version}`);
  if (!/^[0-9a-f]{32}$/.test(meta.salt) || !/^[0-9a-f]{32}$/.test(meta.id) || !Number.isInteger(meta.iterations) || meta.iterations < 1 || meta.iterations > MAX_ITERATIONS)
    throw new DecryptError("sync.json is damaged");
  const keys = await deriveKeys(passphrase, fromHex(meta.salt), meta.iterations);
  try {
    const { path } = await open(keys, fromHex(meta.check));
    if (path !== CHECK_PATH) throw new DecryptError("bad check");
  } catch {
    throw new DecryptError("wrong encryption passphrase");
  }
  return keys;
}

/**
 * Whether a path can be synced: relative, normalised, no empty, "." or ".." segment, nothing hidden (a segment
 * starting with "."), no backslash, colon or control character (Obsidian forbids those in names too). The same rule on both sides, so a decrypted path
 * can't reach outside the vault or into `.obsidian`.
 */
export function validPath(path: string): boolean {
  if (!path || path.length > 1024) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
  if (/[\\:\u0000-\u001f]/.test(path)) return false;
  return path.split("/").every((s) => s !== "" && !s.startsWith("."));
}
