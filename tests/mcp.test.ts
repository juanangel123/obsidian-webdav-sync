// The notes MCP server: its view of the vault and its writes, against a real WebDAV server and a plugin device;
// the OAuth flow a connector goes through; the MCP endpoint.
import { afterEach, describe, expect, test } from "bun:test";
import { Notes, NoteError } from "../mcp/notes";
import { OAuth } from "../mcp/oauth";
import { createHandler } from "../mcp/server";
import { openVault, sync, type State } from "../src/sync";
import { MemFs, type Server, rcloneBin, startServer } from "./helpers";

const ITER = 1000;
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
});

class Device {
  state: State = {};
  fs = new MemFs();
  constructor(readonly server: Server) {}
  async sync() {
    const dav = this.server.dav();
    const { keys } = await openVault(dav, "secret", { create: true, iterations: ITER });
    const r = await sync({ dav, keys, local: this.fs, state: this.state });
    expect(r.errors).toEqual([]);
    this.state = r.state;
    return r;
  }
}

async function setup() {
  const server = await startServer();
  servers.push(server);
  const phone = new Device(server);
  phone.fs.set("Recetas/Canción del pan.md", "Harina, agua y sal.\nHorno a 220.");
  phone.fs.set("Trabajo/Ideas.md", "Una idea sobre el radar.");
  phone.fs.set("foto.png", new Uint8Array([1, 2, 3]));
  await phone.sync();
  return { server, phone, notes: new Notes(server.dav(), "secret") };
}

describe.skipIf(!rcloneBin())("notes", () => {
  test("lists, searches (case and accents ignored) and reads what the devices synced", async () => {
    const { notes } = await setup();
    expect((await notes.list()).map((f) => f.path)).toEqual(["foto.png", "Recetas/Canción del pan.md", "Trabajo/Ideas.md"]);
    expect((await notes.list("trabajo")).map((f) => f.path)).toEqual(["Trabajo/Ideas.md"]);
    const hits = await notes.search("CANCION horno");
    expect(hits.map((h) => h.path)).toEqual(["Recetas/Canción del pan.md"]);
    expect(hits[0].snippet).toContain("Horno a 220");
    expect(await notes.search("nothing like this")).toEqual([]);
    expect((await notes.read("trabajo/ideas.md")).text).toBe("Una idea sobre el radar.");
    await expect(notes.read("foto.png")).rejects.toThrow(NoteError);
    await expect(notes.read("nope.md")).rejects.toThrow(NoteError);
  });

  test("a wrong passphrase is refused", async () => {
    const { server } = await setup();
    await expect(new Notes(server.dav(), "wrong").list()).rejects.toThrow("wrong encryption passphrase");
  });

  test("sees the devices' later edits", async () => {
    const { phone, notes } = await setup();
    expect((await notes.read("Trabajo/Ideas.md")).text).toBe("Una idea sobre el radar.");
    phone.fs.set("Trabajo/Ideas.md", "Otra idea.");
    phone.fs.set("Nueva.md", "nueva");
    await phone.sync();
    expect((await notes.read("Trabajo/Ideas.md")).text).toBe("Otra idea.");
    expect((await notes.list()).map((f) => f.path)).toContain("Nueva.md");
  });

  test("a created note reaches the devices; an existing path (in any case) is refused", async () => {
    const { server, phone, notes } = await setup();
    expect(await notes.create("Inbox/Compra", "- leche")).toBe("Inbox/Compra.md");
    await expect(notes.create("inbox/compra.md", "x")).rejects.toThrow("already exists");
    await expect(notes.create("trabajo/IDEAS.md", "x")).rejects.toThrow("already exists");
    await expect(notes.create("../fuera.md", "x")).rejects.toThrow("not a valid note path");
    await expect(notes.create(".obsidian/app.md", "x")).rejects.toThrow("not a valid note path");
    await expect(notes.create("foto2.png", "x")).rejects.toThrow("only text notes");
    await phone.sync();
    expect(phone.fs.text("Inbox/Compra.md")).toBe("- leche");
    const laptop = new Device(server);
    await laptop.sync();
    expect(laptop.fs.text("Inbox/Compra.md")).toBe("- leche");
  });

  test("an append reaches the devices, and a device's edit since its last sync is never lost", async () => {
    const { phone, notes } = await setup();
    await notes.append("Trabajo/Ideas.md", "- y otra más");
    await phone.sync();
    expect(phone.fs.text("Trabajo/Ideas.md")).toBe("Una idea sobre el radar.\n- y otra más\n");
    await notes.append("Trabajo/Ideas.md", "- tercera");
    phone.fs.set("Trabajo/Ideas.md", "Editada en el móvil sin sincronizar.");
    const r = await phone.sync();
    expect(r.conflicts.length).toBe(1);
    expect(phone.fs.text("Trabajo/Ideas.md")).toBe("Editada en el móvil sin sincronizar.");
    expect(phone.fs.text(r.conflicts[0])).toBe("Una idea sobre el radar.\n- y otra más\n- tercera\n");
    // And the server's view follows: the device's version won the path.
    expect((await notes.read("Trabajo/Ideas.md")).text).toBe("Editada en el móvil sin sincronizar.");
  });

  test("an append re-reads when a device writes the note at the same moment", async () => {
    const server = await startServer();
    servers.push(server);
    const phone = new Device(server);
    phone.fs.set("a.md", "uno\n");
    await phone.sync();
    let fired = false;
    const dav = server.dav(async (req) => {
      const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));
      const out = { status: res.status, headers, body: await res.arrayBuffer() };
      if (!fired && req.method === "GET" && req.url.endsWith(".bin")) {
        fired = true;
        phone.fs.set("a.md", "uno\ndos (móvil)\n");
        await phone.sync();
      }
      return out;
    });
    const notes = new Notes(dav, "secret");
    await notes.list(); // the refresh's GET fires the phone's edit...
    fired = false; // ...and again during the append's read
    await notes.append("a.md", "tres (Claude)");
    await phone.sync();
    expect(phone.fs.text("a.md")).toBe("uno\ndos (móvil)\ntres (Claude)\n");
  });
});

// ── OAuth and the endpoint ──────────────────────────────────────────────────────────────────────────────────────

const BASE = "https://notes.test";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const PASSWORD = "correct horse battery";

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeAuth(now = () => Date.now()) {
  return new OAuth({ publicUrl: BASE, password: PASSWORD, secret: "s".repeat(40), redirects: [REDIRECT], now });
}

const fakeNotes = {
  search: async () => [{ path: "a.md", snippet: "hola" }],
  list: async () => [],
  read: async (p: string) => ({ path: p, text: "texto" }),
  create: async (p: string) => p,
  append: async (p: string) => p,
} as unknown as Notes;

async function connect(auth: OAuth, handle = createHandler({ notes: fakeNotes, oauth: auth, inbox: "Inbox" })) {
  const reg = await handle(new Request(`${BASE}/register`, { method: "POST", body: JSON.stringify({ redirect_uris: [REDIRECT] }) }));
  expect(reg.status).toBe(201);
  const { client_id } = (await reg.json()) as { client_id: string };
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const params = { response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "xyz" };
  const login = (password: string) =>
    handle(new Request(`${BASE}/authorize`, { method: "POST", body: new URLSearchParams({ ...params, password }) }));
  return { handle, client_id, verifier, params, login };
}

async function exchange(handle: (r: Request) => Promise<Response>, body: Record<string, string>) {
  return handle(new Request(`${BASE}/token`, { method: "POST", body: new URLSearchParams(body) }));
}

describe("oauth", () => {
  test("metadata, and a 401 that points to it", async () => {
    const handle = createHandler({ notes: fakeNotes, oauth: makeAuth(), inbox: "" });
    const prm = (await (await handle(new Request(`${BASE}/.well-known/oauth-protected-resource`))).json()) as Record<string, unknown>;
    expect(prm).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE] });
    const as = (await (await handle(new Request(`${BASE}/.well-known/oauth-authorization-server`))).json()) as Record<string, unknown>;
    expect(as).toMatchObject({ issuer: BASE, token_endpoint: `${BASE}/token`, code_challenge_methods_supported: ["S256"] });
    const res = await handle(new Request(`${BASE}/mcp`, { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`${BASE}/.well-known/oauth-protected-resource`);
    const forged = await handle(new Request(`${BASE}/mcp`, { method: "POST", body: "{}", headers: { Authorization: "Bearer abc.def" } }));
    expect(forged.status).toBe(401);
  });

  test("only known redirect URIs register", async () => {
    const handle = createHandler({ notes: fakeNotes, oauth: makeAuth(), inbox: "" });
    const res = await handle(
      new Request(`${BASE}/register`, { method: "POST", body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }) }),
    );
    expect(res.status).toBe(400);
    const reg = (uris: string[]) =>
      handle(new Request(`${BASE}/register`, { method: "POST", body: JSON.stringify({ redirect_uris: uris }) }));
    expect((await reg(["http://localhost:53682/callback"])).status).toBe(201); // a local client (Claude Code)
    expect((await reg(["http://127.0.0.1/callback"])).status).toBe(201);
    expect((await reg(["http://localhost.evil.example/callback"])).status).toBe(400);
    expect((await reg(["https://localhost:3000/callback?x=https://evil"])).status).toBe(400);
  });

  test("the form, a wrong password, then the code, the tokens and the endpoint", async () => {
    const auth = makeAuth();
    const { handle, client_id, verifier, params, login } = await connect(auth);
    const form = await handle(new Request(`${BASE}/authorize?${new URLSearchParams(params)}`, { headers: { "Accept-Language": "es-ES" } }));
    expect(form.status).toBe(200);
    const html = await form.text();
    expect(html).toContain("Contraseña");
    // What a browser posts: the form's own fields plus the password.
    const posted = new URLSearchParams([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))]));
    posted.set("password", PASSWORD);
    const viaForm = await handle(new Request(`${BASE}/authorize`, { method: "POST", body: posted }));
    expect(viaForm.status).toBe(302);
    expect((await login("wrong password!")).status).toBe(401);
    const ok = await login(PASSWORD);
    expect(ok.status).toBe(302);
    const to = new URL(ok.headers.get("location")!);
    expect(to.origin + to.pathname).toBe(REDIRECT);
    expect(to.searchParams.get("state")).toBe("xyz");
    const code = to.searchParams.get("code")!;

    const base = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id };
    expect((await exchange(handle, { ...base, code_verifier: "x".repeat(43) })).status).toBe(400);
    const tok = await exchange(handle, { ...base, code_verifier: verifier });
    expect(tok.status).toBe(200);
    const t = (await tok.json()) as { access_token: string; refresh_token: string };
    expect((await exchange(handle, { ...base, code_verifier: verifier })).status).toBe(400); // used once

    const mcp = (body: unknown, token = t.access_token) =>
      handle(new Request(`${BASE}/mcp`, { method: "POST", body: JSON.stringify(body), headers: { Authorization: `Bearer ${token}` } }));
    const init = (await (await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json()) as {
      result: { protocolVersion: string };
    };
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect((await mcp({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const tools = (await (await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as { result: { tools: { name: string }[] } };
    expect(tools.result.tools.map((x) => x.name)).toEqual(["search_notes", "list_notes", "read_note", "create_note", "append_to_note"]);
    const call = (await (
      await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_note", arguments: { path: "Compra", content: "x" } } })
    ).json()) as { result: { content: { text: string }[]; isError: boolean } };
    expect(call.result.isError).toBe(false);
    expect(call.result.content[0].text).toContain('"Inbox/Compra"');
    // A refresh token is not an access token.
    expect((await mcp({ jsonrpc: "2.0", id: 4, method: "ping" }, t.refresh_token)).status).toBe(401);

    const again = await exchange(handle, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id });
    expect(again.status).toBe(200);
    const other = await connect(auth);
    expect((await exchange(handle, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: other.client_id })).status).toBe(400);
  });

  test("tokens expire; a new password logs every client out", async () => {
    let now = Date.now();
    const auth = makeAuth(() => now);
    const { handle, client_id, verifier, login } = await connect(auth);
    const code = new URL((await login(PASSWORD)).headers.get("location")!).searchParams.get("code")!;
    const t = (await (await exchange(handle, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id, code_verifier: verifier })).json()) as {
      access_token: string;
      refresh_token: string;
    };
    const ping = (h: (r: Request) => Promise<Response>) =>
      h(new Request(`${BASE}/mcp`, { method: "POST", body: '{"jsonrpc":"2.0","id":1,"method":"ping"}', headers: { Authorization: `Bearer ${t.access_token}` } }));
    expect((await ping(handle)).status).toBe(200);
    const other = createHandler({
      notes: fakeNotes,
      oauth: new OAuth({ publicUrl: BASE, password: "another password", secret: "s".repeat(40), redirects: [REDIRECT] }),
      inbox: "",
    });
    expect((await ping(other)).status).toBe(401);
    now += 3601_000;
    expect((await ping(handle)).status).toBe(401);
  });

  test("logins pause after five wrong passwords", async () => {
    const { login } = await connect(makeAuth());
    for (let i = 0; i < 5; i++) expect((await login("wrong password!")).status).toBe(401);
    expect((await login(PASSWORD)).status).toBe(429);
  });
});
