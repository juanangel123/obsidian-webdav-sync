// The notes MCP server: `bun mcp/main.ts`, or the binary from `bun run mcp:build`. Settings from the environment:
//   PUBLIC_URL        the server's public origin (https://…), as clients reach it
//   WEBDAV_URL        the vault's WebDAV folder (default http://127.0.0.1:8097)
//   WEBDAV_USER, WEBDAV_PASS   its login (RCLONE_USER / RCLONE_PASS also read, as `rclone serve` takes them)
//   NOTES_PASSPHRASE  the vault's encryption passphrase
//   MCP_PASSWORD      the password asked when a client connects (12+ characters)
//   MCP_SECRET        a random string (32+ characters) that signs the tokens; changing it logs every client out
//   MCP_REDIRECTS     comma-separated redirect URIs clients may use (default: Claude's connectors)
//   NOTES_INBOX       folder for new notes given without one (default "Inbox"; "" for the root)
//   HOST, PORT        where to listen (default 127.0.0.1:8098)

import { WebDav, type Http } from "../src/webdav";
import { Notes } from "./notes";
import { OAuth } from "./oauth";
import { createHandler } from "./server";

const env = (k: string, fallback?: string): string => {
  const v = process.env[k] ?? fallback;
  if (v === undefined || v === "") {
    console.error(`missing ${k}`);
    process.exit(2);
  }
  return v;
};

const http: Http = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(30_000) });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  return { status: res.status, headers, body: await res.arrayBuffer() };
};

const log = (e: Record<string, unknown>) => console.log(JSON.stringify({ time: new Date().toISOString(), ...e }));

const dav = new WebDav(
  http,
  env("WEBDAV_URL", "http://127.0.0.1:8097"),
  env("WEBDAV_USER", process.env.RCLONE_USER),
  env("WEBDAV_PASS", process.env.RCLONE_PASS),
);
const notes = new Notes(dav, env("NOTES_PASSPHRASE"));
const oauth = new OAuth({
  publicUrl: env("PUBLIC_URL").replace(/\/+$/, ""),
  password: env("MCP_PASSWORD"),
  secret: env("MCP_SECRET"),
  redirects: (process.env.MCP_REDIRECTS ?? "https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
});
const handler = createHandler({ notes, oauth, inbox: process.env.NOTES_INBOX ?? "Inbox", log });

const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8098),
  async fetch(req) {
    try {
      return await handler(req);
    } catch (err) {
      log({ event: "error", error: err instanceof Error ? err.message : String(err) });
      return new Response("server error", { status: 500 });
    }
  },
});
log({ event: "start", url: `http://${server.hostname}:${server.port}` });

// Unlock the vault now, so the first request doesn't wait for the key derivation (and a wrong passphrase shows at once).
notes.refresh().then(
  () => log({ event: "ready" }),
  (err) => log({ event: "error", error: `vault: ${err instanceof Error ? err.message : err}` }),
);
