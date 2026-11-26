// OAuth 2.1 for one person, with no state on disk: what MCP clients (Claude's connectors, Claude Code) need.
//
// Clients register themselves (RFC 7591) and get a client id that is a signed copy of their redirect URIs and name;
// the person logs in with the server's password and the client gets a code (signed, 2 minutes, PKCE S256) it trades
// for an access token (1 hour, for this server's /mcp only) and a refresh token. A refresh gives a new pair, but
// nothing is stored, so an older refresh token stays valid too: a login's session ends 90 days after it began
// however often it is refreshed. Codes are remembered as used in memory only (a restart forgets, within their 2
// minutes; the PKCE verifier is still needed). Everything is signed with an HMAC key made of the secret and the
// password: changing either one logs every client out.

import { b64url, json } from "./http";
import { page } from "./page";

const enc = new TextEncoder();

export interface OAuthConfig {
  /** The server's public origin, e.g. https://notes.example.com (no trailing slash). */
  publicUrl: string;
  password: string;
  secret: string;
  /** Redirect URIs a client may register (exact matches), besides loopback ones. */
  redirects: string[];
  now?: () => number; // ms, for tests
}

const ACCESS_S = 3600;
const SESSION_S = 90 * 24 * 3600;
const CODE_S = 120;
/** Failed logins allowed per address in a window before that address waits for the rest of it. */
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60_000;
/** Failed logins from all addresses in an hour before every login waits: the backstop. */
const MAX_FAILS_ALL = 50;
/** OAuth requests are small: a bigger body is refused before it is read. */
const MAX_BODY = 16 * 1024;
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

/** Equal strings, compared as digests: the time says nothing about where they differ nor how long they are. */
async function same(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

type Claims = Record<string, unknown> & { t: string; exp?: number };

/** Who a client is, for the sign-in page: its name as it gave it, and where the code goes. */
export interface Who {
  name: string;
  host: string; // the redirect's host, or "" for this computer
  port: string;
}

function describe(name: unknown, redirect: string): Who {
  const u = new URL(redirect);
  const local = LOOPBACK.includes(u.hostname);
  return { name: typeof name === "string" ? name : "", host: local ? "" : u.hostname, port: u.port };
}

export class OAuth {
  private key: Promise<CryptoKey>;
  private readonly usedCodes = new Map<string, number>(); // code → expiry (s)
  private readonly fails = new Map<string, number[]>(); // address → failed login times (ms)
  private failsAll: number[] = [];

  constructor(private readonly cfg: OAuthConfig) {
    if (cfg.password.length < 12) throw new Error("the login password must have at least 12 characters");
    if (cfg.secret.length < 32) throw new Error("the signing secret must have at least 32 characters");
    this.key = crypto.subtle.importKey(
      "raw",
      enc.encode(`${cfg.secret}\u0000${cfg.password}`),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }

  private ms(): number {
    return this.cfg.now?.() ?? Date.now();
  }

  private now(): number {
    return Math.floor(this.ms() / 1000);
  }

  private async sign(claims: Claims): Promise<string> {
    const body = b64url(enc.encode(JSON.stringify(claims)));
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await this.key, enc.encode(body)));
    return `${body}.${b64url(sig)}`;
  }

  private async verify(token: string, type: string): Promise<Claims | null> {
    const [body, sig, extra] = token.split(".");
    if (!body || !sig || extra !== undefined) return null;
    try {
      const ok = await crypto.subtle.verify("HMAC", await this.key, fromB64url(sig) as BufferSource, enc.encode(body));
      if (!ok) return null;
      const claims = JSON.parse(new TextDecoder().decode(fromB64url(body))) as Claims;
      if (claims.t !== type) return null;
      if (claims.exp !== undefined && claims.exp < this.now()) return null;
      return claims;
    } catch {
      return null;
    }
  }

  get resource(): string {
    return `${this.cfg.publicUrl}/mcp`;
  }

  /** Whether a request carries a valid access token for this server. */
  async authorised(req: Request): Promise<boolean> {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
    const claims = m && (await this.verify(m[1], "access"));
    return !!claims && claims.aud === this.resource;
  }

  /** The 401 that points a client to the metadata (RFC 9728). */
  challenge(): Response {
    return json({ error: "invalid_token" }, 401, {
      "WWW-Authenticate": `Bearer resource_metadata="${this.cfg.publicUrl}/.well-known/oauth-protected-resource"`,
    });
  }

  /** The OAuth routes; null when the path is not one of them. */
  async handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const base = this.cfg.publicUrl;
    if (["/register", "/authorize", "/token"].includes(url.pathname) && Number(req.headers.get("content-length") ?? 0) > MAX_BODY)
      return json({ error: "invalid_request", error_description: "body too large" }, 413);
    switch (url.pathname) {
      case "/.well-known/oauth-protected-resource":
      case "/.well-known/oauth-protected-resource/mcp":
        return json({ resource: this.resource, authorization_servers: [base], bearer_methods_supported: ["header"] });
      case "/.well-known/oauth-authorization-server":
      case "/.well-known/openid-configuration":
        return json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          authorization_response_iss_parameter_supported: true,
        });
      case "/register":
        return req.method === "POST" ? this.register(req) : json({ error: "invalid_request" }, 405);
      case "/authorize":
        if (req.method === "GET") return this.authorizeForm(url.searchParams, req);
        if (req.method === "POST") return this.authorizeLogin(req);
        return new Response(null, { status: 405 });
      case "/token":
        return req.method === "POST" ? this.token(req) : json({ error: "invalid_request" }, 405);
    }
    return null;
  }

  /**
   * A configured redirect URI, or one back to the person's own machine (RFC 8252 loopback, any port: what a local
   * client such as Claude Code listens on). A loopback code can only reach the machine that logged in.
   */
  private allowedRedirect(u: string): boolean {
    if (this.cfg.redirects.includes(u)) return true;
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      return false; // a port over 65535 too
    }
    if (url.protocol !== "http:" || !LOOPBACK.includes(url.hostname)) return false;
    if (url.username || url.password || url.search || url.hash) return false;
    return u === url.href || `${u}/` === url.href;
  }

  private async register(req: Request): Promise<Response> {
    let body: { redirect_uris?: unknown; client_name?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid_client_metadata", error_description: "not JSON" }, 400);
    }
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => typeof u === "string" && this.allowedRedirect(u)))
      return json({ error: "invalid_redirect_uri", error_description: "this server only accepts its known clients" }, 400);
    const name = typeof body.client_name === "string" ? body.client_name.slice(0, 60) : undefined;
    const clientId = await this.sign({ t: "client", r: uris, nm: name, n: b64url(crypto.getRandomValues(new Uint8Array(9))) });
    return json(
      {
        client_id: clientId,
        client_id_issued_at: this.now(),
        redirect_uris: uris,
        client_name: name,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  }

  /** The request's parameters, checked; an error message when they can't be used. */
  private async authRequest(p: URLSearchParams): Promise<{ ok: Record<string, string>; who: Who } | { error: string }> {
    const get = (k: string) => p.get(k) ?? "";
    const client = await this.verify(get("client_id"), "client");
    if (!client) return { error: "unknown client: add the connector again" };
    const redirect = get("redirect_uri");
    if (!(client.r as string[]).includes(redirect)) return { error: "this redirect address is not the client's" };
    if (get("response_type") !== "code") return { error: "unsupported response_type" };
    if (get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(get("code_challenge")))
      return { error: "PKCE (S256) is required" };
    if (get("resource") && get("resource").replace(/\/$/, "") !== this.resource) return { error: "the resource is not this server" };
    return {
      // Everything the form sends back on POST, where it is checked again.
      ok: {
        response_type: "code",
        code_challenge_method: "S256",
        client_id: get("client_id"),
        redirect_uri: redirect,
        code_challenge: get("code_challenge"),
        state: get("state"),
        resource: get("resource"),
      },
      who: describe(client.nm, redirect),
    };
  }

  private async authorizeForm(p: URLSearchParams, req: Request): Promise<Response> {
    const r = await this.authRequest(p);
    if ("error" in r) return page(req, { error: r.error });
    return page(req, { fields: r.ok, who: r.who });
  }

  /**
   * Who is trying: Cloudflare's view of the visitor's address. Trusted because the server only listens on loopback,
   * behind the Tunnel; without the header (a local client or test), one shared bucket.
   */
  private address(req: Request): string {
    return req.headers.get("cf-connecting-ip") ?? "local";
  }

  private async authorizeLogin(req: Request): Promise<Response> {
    const p = new URLSearchParams();
    try {
      for (const [k, v] of await req.formData()) if (typeof v === "string") p.set(k, v);
    } catch {
      return page(req, { error: "not a form" });
    }
    const r = await this.authRequest(p);
    if ("error" in r) return page(req, { error: r.error });
    const now = this.ms();
    const from = this.address(req);
    const mine = (this.fails.get(from) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
    this.failsAll = this.failsAll.filter((t) => now - t < 3_600_000);
    if (mine.length >= MAX_FAILS || this.failsAll.length >= MAX_FAILS_ALL)
      return page(req, { fields: r.ok, who: r.who, wrong: "paused" }, 429);
    if (!(await same(p.get("password") ?? "", this.cfg.password))) {
      this.fails.set(from, [...mine, now]);
      this.failsAll.push(now);
      for (const [k, ts] of this.fails) if (ts.every((t) => now - t >= FAIL_WINDOW_MS)) this.fails.delete(k);
      return page(req, { fields: r.ok, who: r.who, wrong: "password" }, 401);
    }
    this.fails.delete(from);
    const code = await this.sign({
      t: "code",
      c: await digest(r.ok.client_id),
      r: r.ok.redirect_uri,
      ch: r.ok.code_challenge,
      n: b64url(crypto.getRandomValues(new Uint8Array(12))),
      exp: this.now() + CODE_S,
    });
    const to = new URL(r.ok.redirect_uri);
    to.searchParams.set("code", code);
    if (r.ok.state) to.searchParams.set("state", r.ok.state);
    to.searchParams.set("iss", this.cfg.publicUrl);
    return new Response(null, { status: 302, headers: { Location: to.toString(), "Cache-Control": "no-store" } });
  }

  private async token(req: Request): Promise<Response> {
    let p: URLSearchParams;
    try {
      const type = req.headers.get("content-type") ?? "";
      p = type.includes("application/json") ? new URLSearchParams(await req.json()) : new URLSearchParams(await req.text());
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
    const bad = (error: string, description: string) => json({ error, error_description: description }, 400);
    const clientId = p.get("client_id") ?? "";
    if (!(await this.verify(clientId, "client"))) return json({ error: "invalid_client" }, 401);
    const c = await digest(clientId);
    const resource = p.get("resource");
    if (resource && resource.replace(/\/$/, "") !== this.resource) return bad("invalid_target", "the resource is not this server");

    if (p.get("grant_type") === "authorization_code") {
      const code = p.get("code") ?? "";
      const claims = await this.verify(code, "code");
      if (!claims || claims.c !== c) return bad("invalid_grant", "bad or expired code");
      // OAuth 2.1 lets a client leave redirect_uri out (PKCE binds the code); when given, it must be the same.
      if (p.has("redirect_uri") && claims.r !== p.get("redirect_uri")) return bad("invalid_grant", "redirect_uri differs");
      if (!(await same(b64url(await sha256(p.get("code_verifier") ?? "")), claims.ch as string)))
        return bad("invalid_grant", "PKCE check failed");
      for (const [k, exp] of this.usedCodes) if (exp < this.now()) this.usedCodes.delete(k);
      if (this.usedCodes.has(code)) return bad("invalid_grant", "code already used");
      this.usedCodes.set(code, claims.exp as number);
      return this.tokens(c, this.now() + SESSION_S);
    }
    if (p.get("grant_type") === "refresh_token") {
      const claims = await this.verify(p.get("refresh_token") ?? "", "refresh");
      if (!claims || claims.c !== c) return bad("invalid_grant", "bad or expired refresh token");
      return this.tokens(c, claims.exp as number); // the same session end: refreshing never extends it
    }
    return bad("unsupported_grant_type", "authorization_code or refresh_token");
  }

  private async tokens(c: string, sessionEnd: number): Promise<Response> {
    const now = this.now();
    const n = () => b64url(crypto.getRandomValues(new Uint8Array(12)));
    const expiresIn = Math.max(1, Math.min(ACCESS_S, sessionEnd - now));
    return json({
      access_token: await this.sign({ t: "access", c, aud: this.resource, n: n(), exp: now + expiresIn }),
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: await this.sign({ t: "refresh", c, n: n(), exp: sessionEnd }),
    });
  }
}

async function digest(s: string): Promise<string> {
  return b64url((await sha256(s)).subarray(0, 12));
}
