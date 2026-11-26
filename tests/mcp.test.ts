// The notes MCP server: its view of the vault and its writes, against a real WebDAV server and a plugin device;
// the OAuth flow a connector goes through; the MCP endpoint.
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Notes, NoteError } from "../mcp/notes";
import { OAuth } from "../mcp/oauth";
import { createHandler } from "../mcp/server";
import { openVault, sync, type State } from "../src/sync";
import { b64url, fetchHttp } from "../mcp/http";
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
    expect((await notes.list()).files.map((f) => f.path)).toEqual(["foto.png", "Recetas/Canción del pan.md", "Trabajo/Ideas.md"]);
    expect((await notes.list("trabajo")).files.map((f) => f.path)).toEqual(["Trabajo/Ideas.md"]);
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
    expect((await notes.list()).files.map((f) => f.path)).toContain("Nueva.md");
  });

  test("a created note reaches the devices; an existing path (in any case) is refused", async () => {
    const { server, phone, notes } = await setup();
    expect(await notes.create("Inbox/Compra", "- leche")).toBe("Inbox/Compra.md");
    await expect(notes.create("inbox/compra.md", "x")).rejects.toThrow("already exists");
    await expect(notes.create("trabajo/IDEAS.md", "x")).rejects.toThrow("already exists");
    await expect(notes.create("../fuera.md", "x")).rejects.toThrow("can't be a note's path");
    await expect(notes.create(".obsidian/app.md", "x")).rejects.toThrow("can't be a note's path");
    expect(await notes.create("foto2.png", "x")).toBe("foto2.png.md");
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

  test("an append re-reads when a device writes the note between its read and its write", async () => {
    const server = await startServer();
    servers.push(server);
    const phone = new Device(server);
    phone.fs.set("a.md", "uno\n");
    await phone.sync();
    let armed = false;
    let gets = 0;
    const http = fetchHttp();
    const notes = new Notes(
      server.dav(async (req) => {
        const res = await http(req);
        if (req.method === "GET" && req.url.endsWith(".bin")) gets++;
        // The append's own GET of the note (after its first stat): the phone writes right then.
        if (armed && req.method === "GET" && req.url.endsWith(".bin")) {
          armed = false;
          phone.fs.set("a.md", "uno\ndos (móvil)\n");
          await phone.sync();
        }
        return res;
      }),
      "secret",
    );
    await notes.list();
    armed = true;
    gets = 0;
    await notes.append("a.md", "tres (Claude)");
    expect(gets).toBe(2); // read, changed underneath, read again
    await phone.sync();
    expect(phone.fs.text("a.md")).toBe("uno\ndos (móvil)\ntres (Claude)\n");
  });

  test("appends at the same moment all land, one after the other", async () => {
    const { phone, notes } = await setup();
    await Promise.all(["- a", "- b", "- c", "- d"].map((t) => notes.append("Trabajo/Ideas.md", t)));
    await phone.sync();
    const lines = phone.fs.text("Trabajo/Ideas.md")!.split("\n");
    for (const t of ["- a", "- b", "- c", "- d"]) expect(lines).toContain(t);
  });

  test("an append keeps the note's bytes, and refuses notes that aren't UTF-8 text or are JSON", async () => {
    const server = await startServer();
    servers.push(server);
    const phone = new Device(server);
    phone.fs.set("latin.txt", new Uint8Array([0x63, 0x61, 0x6e, 0x63, 0x69, 0xf3, 0x6e, 0x0a])); // "canción" in Latin-1
    phone.fs.set("bom.md", new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])); // BOM + "hi", no final newline
    phone.fs.set("Board.canvas", '{"nodes":[]}');
    await phone.sync();
    const notes = new Notes(server.dav(), "secret");
    await expect(notes.append("latin.txt", "x")).rejects.toThrow("not UTF-8");
    await expect(notes.append("Board.canvas", "x")).rejects.toThrow("not a Markdown or text note");
    await notes.append("bom.md", "x");
    await phone.sync();
    expect([...phone.fs.files.get("bom.md")!.data]).toEqual([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0a, 0x78, 0x0a]);
    expect([...phone.fs.files.get("latin.txt")!.data]).toEqual([0x63, 0x61, 0x6e, 0x63, 0x69, 0xf3, 0x6e, 0x0a]);
  });

  test("create: names with dots get .md, folders keep the vault's spelling, NFC and NFD are one name", async () => {
    const { phone, notes } = await setup();
    expect(await notes.create("Reunión 26.11.2026", "x")).toBe("Reunión 26.11.2026.md");
    expect(await notes.create("trabajo/Plan v2.0", "x")).toBe("Trabajo/Plan v2.0.md");
    await expect(notes.create("Recetas/Canción del pan.md", "x")).rejects.toThrow("already exists");
    await expect(notes.create("¿Qué?.md", "x")).rejects.toThrow("can't be a note's path");
    await expect(notes.create("CON", "x")).rejects.toThrow("can't be a note's path");
    await expect(notes.create("Board.canvas", "x")).resolves.toBe("Board.canvas.md");
    await phone.sync();
    expect(phone.fs.text("Trabajo/Plan v2.0.md")).toBe("x");
  });

  test("a delete goes to the server's trash and to the devices' trash; a device's edit since is kept", async () => {
    const { server, phone, notes } = await setup();
    const laptop = new Device(server);
    await laptop.sync();
    laptop.fs.set("Trabajo/Ideas.md", "Editada en el portátil sin sincronizar.");
    expect(await notes.delete("recetas/canción del pan.md")).toBe("Recetas/Canción del pan.md");
    expect(await notes.delete("Trabajo/Ideas.md")).toBe("Trabajo/Ideas.md");
    expect(await notes.delete("foto.png")).toBe("foto.png");
    await expect(notes.delete("Trabajo/Ideas.md")).rejects.toThrow("no file at");
    await expect(notes.read("Trabajo/Ideas.md")).rejects.toThrow(NoteError);
    const trash = readdirSync(join(server.dir, ".trash")).flatMap((d) => readdirSync(join(server.dir, ".trash", d)));
    expect(trash.length).toBe(3);
    await phone.sync();
    expect(phone.fs.trashed.sort()).toEqual(["Recetas/Canción del pan.md", "Trabajo/Ideas.md", "foto.png"]);
    await laptop.sync(); // its edit wins: uploaded again
    expect(laptop.fs.text("Trabajo/Ideas.md")).toBe("Editada en el portátil sin sincronizar.");
    expect((await notes.read("Trabajo/Ideas.md")).text).toBe("Editada en el portátil sin sincronizar.");
  });

  test("a note created where one was deleted reaches a device that still remembers the old one", async () => {
    const server = await startServer();
    servers.push(server);
    const a = new Device(server);
    const b = new Device(server);
    a.fs.set("Inbox/X.md", "v1");
    await a.sync();
    for (let i = 2; i <= 4; i++) {
      a.fs.set("Inbox/X.md", `v${i}`);
      await a.sync();
    }
    await b.sync();
    expect(b.state["Inbox/X.md"].version).toBe(4);
    await a.fs.trash("Inbox/X.md", (await a.fs.list()).get("Inbox/X.md")!);
    await a.sync(); // the blob goes to the server's trash
    await b.fs.trash("Inbox/X.md", (await b.fs.list()).get("Inbox/X.md")!); // B deleted it too, not synced yet
    const notes = new Notes(server.dav(), "secret");
    await notes.create("Inbox/X.md", "de Claude");
    await b.sync();
    await b.sync();
    expect(b.fs.text("Inbox/X.md")).toBe("de Claude");
  });

  test("attachments are never downloaded, and a damaged blob isn't fetched again", async () => {
    const { server } = await setup();
    const big = new Device(server);
    big.fs.set("video.mp4", new Uint8Array(3 * 1024 * 1024));
    await big.sync();
    writeFileSync(join(server.dir, `${"f".repeat(32)}.bin`), "not a sealed file at all, just junk bytes here");
    const gets: string[] = [];
    const http = fetchHttp();
    const notes = new Notes(
      server.dav(async (req) => {
        if (req.method === "GET") gets.push(req.url.split("/").pop()!);
        return http(req);
      }),
      "secret",
    );
    const first = await notes.list();
    expect(first.unnamed).toBe(1);
    expect(first.files.map((f) => f.path)).not.toContain("video.mp4");
    gets.length = 0;
    await notes.list();
    expect(gets).toEqual([]); // nothing changed: nothing downloaded, the junk included
  });

  test("a vault set up again on the server: the old keys are dropped, nothing is written under them", async () => {
    const { server, notes } = await setup();
    await notes.list();
    for (const f of readdirSync(server.dir)) rmSync(join(server.dir, f), { recursive: true, force: true });
    const fresh = new Device(server);
    fresh.fs.set("nueva.md", "nueva bóveda");
    await fresh.sync();
    expect((await notes.list()).files.map((f) => f.path)).toEqual(["nueva.md"]);
    await notes.create("c.md", "x");
    await fresh.sync();
    expect(fresh.fs.text("c.md")).toBe("x");
  });

  test("a wrong passphrase is derived once per sync.json, not on every call", async () => {
    const { server } = await setup();
    const wrong = new Notes(server.dav(), "wrong");
    await expect(wrong.list()).rejects.toThrow("wrong encryption passphrase");
    const t = performance.now();
    await expect(wrong.list()).rejects.toThrow("wrong encryption passphrase");
    expect(performance.now() - t).toBeLessThan(200);
  });
});

// ── OAuth and the endpoint ──────────────────────────────────────────────────────────────────────────────────────

const BASE = "https://notes.test";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const PASSWORD = "correct horse battery";


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
  const reg = await handle(
    new Request(`${BASE}/register`, { method: "POST", body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Claude <b>" }) }),
  );
  expect(reg.status).toBe(201);
  const { client_id } = (await reg.json()) as { client_id: string };
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const params = { response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "xyz" };
  const login = (password: string, ip?: string) =>
    handle(
      new Request(`${BASE}/authorize`, {
        method: "POST",
        body: new URLSearchParams({ ...params, password }),
        headers: ip ? { "CF-Connecting-IP": ip } : {},
      }),
    );
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
    expect(tools.result.tools.map((x) => x.name)).toEqual(["search_notes", "list_notes", "read_note", "create_note", "append_to_note", "delete_note"]);
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
    const paused = await login(PASSWORD);
    expect(paused.status).toBe(429);
    const html = await paused.text();
    expect(html).toContain("15 minutes");
    expect(html).toContain('<button type="submit" disabled>');
  });

  test("a sign-in that can't go on says what to do, in the person's language", async () => {
    const handle = createHandler({ notes: fakeNotes, oauth: makeAuth(), inbox: "" });
    const res = await handle(new Request(`${BASE}/authorize?client_id=forged`, { headers: { "Accept-Language": "es-ES,es;q=0.9" } }));
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("No se puede iniciar sesión");
    expect(html).toContain("Quita el conector");
  });

  test("logins pause per address; someone else's wrong passwords don't lock the owner out", async () => {
    const { login } = await connect(makeAuth());
    for (let i = 0; i < 5; i++) expect((await login("wrong password!", "203.0.113.9")).status).toBe(401);
    expect((await login(PASSWORD, "203.0.113.9")).status).toBe(429);
    expect((await login(PASSWORD, "198.51.100.7")).status).toBe(302);
  });

  test("the page says who asks and where the access goes; the form posts only there", async () => {
    const { handle, params } = await connect(makeAuth());
    const res = await handle(new Request(`${BASE}/authorize?${new URLSearchParams(params)}`));
    const html = await res.text();
    expect(html).toContain("Claude &#60;b&#62;");
    expect(html).toContain("claude.ai");
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self' https://claude.ai");
  });

  test("redirects: loopback on any valid port only; resource must be this server", async () => {
    const auth = makeAuth();
    const handle = createHandler({ notes: fakeNotes, oauth: auth, inbox: "" });
    const reg = (uris: string[]) =>
      handle(new Request(`${BASE}/register`, { method: "POST", body: JSON.stringify({ redirect_uris: uris }) }));
    expect((await reg(["http://localhost:99999/callback"])).status).toBe(400);
    expect((await reg(["http://localhost:8080/cb?next=https://evil.example"])).status).toBe(400);
    expect((await reg(["http://user@localhost:8080/cb"])).status).toBe(400);
    const { params, client_id, verifier, login } = await connect(auth, handle);
    const other = await handle(new Request(`${BASE}/authorize?${new URLSearchParams({ ...params, resource: "https://evil.example/mcp" })}`));
    expect(other.status).toBe(400);
    const code = new URL((await login(PASSWORD)).headers.get("location")!).searchParams.get("code")!;
    // OAuth 2.1: redirect_uri may be left out of the token request.
    const tok = await exchange(handle, { grant_type: "authorization_code", code, client_id, code_verifier: verifier, resource: `${BASE}/mcp` });
    expect(tok.status).toBe(200);
  });

  test("a session ends 90 days after the login, however often it is refreshed", async () => {
    let now = Date.now();
    const auth = makeAuth(() => now);
    const { handle, client_id, verifier, login } = await connect(auth);
    const code = new URL((await login(PASSWORD)).headers.get("location")!).searchParams.get("code")!;
    let t = (await (await exchange(handle, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id, code_verifier: verifier })).json()) as {
      refresh_token: string;
    };
    for (let day = 10; day <= 80; day += 10) {
      now += 10 * 86_400_000;
      const r = await exchange(handle, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id });
      expect(r.status).toBe(200);
      t = (await r.json()) as { refresh_token: string };
    }
    now += 11 * 86_400_000; // day 91
    expect((await exchange(handle, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id })).status).toBe(400);
  });

  test("bodies too large and non-form logins are refused cleanly", async () => {
    const handle = createHandler({ notes: fakeNotes, oauth: makeAuth(), inbox: "" });
    const big = await handle(new Request(`${BASE}/register`, { method: "POST", body: "x".repeat(20_000), headers: { "Content-Length": "20000" } }));
    expect(big.status).toBe(413);
    const notForm = await handle(new Request(`${BASE}/authorize`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }));
    expect(notForm.status).toBe(400);
  });
});
