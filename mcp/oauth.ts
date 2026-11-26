// OAuth 2.1 for one person, with no state on disk: what MCP clients (Claude's connectors) need to reach the server.
//
// Clients register themselves (RFC 7591) and get a client id that is a signed copy of their redirect URIs; the
// person logs in with the server's password and the client gets a code (signed, 2 minutes, used once, PKCE S256)
// it trades for an access token (1 hour) and a refresh token (90 days, replaced on each use). Everything is signed
// with a key derived from the secret *and* the password: changing either one logs every client out.

const enc = new TextEncoder();

export interface OAuthConfig {
  /** The server's public origin, e.g. https://notes.example.com (no trailing slash). */
  publicUrl: string;
  password: string;
  secret: string;
  /** Redirect URIs a client may register; exact matches. */
  redirects: string[];
  now?: () => number; // ms, for tests
}

const ACCESS_S = 3600;
const REFRESH_S = 90 * 24 * 3600;
const CODE_S = 120;
/** Failed logins allowed in a window before logins pause for the rest of it. */
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60_000;

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

/** Equal strings, in time that doesn't depend on where they differ. */
function same(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

type Claims = Record<string, unknown> & { t: string; exp?: number };

export class OAuth {
  private key: Promise<CryptoKey>;
  private readonly usedCodes = new Map<string, number>(); // code → expiry (s)
  private fails: number[] = [];

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

  private now(): number {
    return Math.floor((this.cfg.now?.() ?? Date.now()) / 1000);
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

  /** Whether a request carries a valid access token. */
  async authorised(req: Request): Promise<boolean> {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
    return !!m && !!(await this.verify(m[1], "access"));
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
    return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?\/[\w/-]*$/.test(u);
  }

  private async register(req: Request): Promise<Response> {
    let body: { redirect_uris?: unknown; client_name?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid_client_metadata", error_description: "not JSON" }, 400);
    }
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === "string" && this.allowedRedirect(u)))
      return json({ error: "invalid_redirect_uri", error_description: "this server only accepts its known clients" }, 400);
    const clientId = await this.sign({ t: "client", r: uris, n: b64url(crypto.getRandomValues(new Uint8Array(9))) });
    return json(
      {
        client_id: clientId,
        client_id_issued_at: this.now(),
        redirect_uris: uris,
        client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 100) : undefined,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  }

  /** The request's parameters, checked; an error message when they can't be used. */
  private async authRequest(p: URLSearchParams): Promise<{ ok: Record<string, string> } | { error: string }> {
    const get = (k: string) => p.get(k) ?? "";
    const client = await this.verify(get("client_id"), "client");
    if (!client) return { error: "unknown client: add the connector again" };
    const redirect = get("redirect_uri");
    if (!(client.r as string[]).includes(redirect)) return { error: "this redirect address is not the client's" };
    if (get("response_type") !== "code") return { error: "unsupported response_type" };
    if (get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(get("code_challenge")))
      return { error: "PKCE (S256) is required" };
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
    };
  }

  private async authorizeForm(p: URLSearchParams, req: Request): Promise<Response> {
    const r = await this.authRequest(p);
    if ("error" in r) return page(req, { error: r.error });
    return page(req, { fields: r.ok });
  }

  private async authorizeLogin(req: Request): Promise<Response> {
    const form = await req.formData();
    const p = new URLSearchParams();
    for (const [k, v] of form) if (typeof v === "string") p.set(k, v);
    const r = await this.authRequest(p);
    if ("error" in r) return page(req, { error: r.error });
    const now = this.cfg.now?.() ?? Date.now();
    this.fails = this.fails.filter((t) => now - t < FAIL_WINDOW_MS);
    if (this.fails.length >= MAX_FAILS) return page(req, { fields: r.ok, wrong: "paused" }, 429);
    if (!same(p.get("password") ?? "", this.cfg.password)) {
      this.fails.push(now);
      return page(req, { fields: r.ok, wrong: "password" }, 401);
    }
    this.fails = [];
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

    if (p.get("grant_type") === "authorization_code") {
      const code = p.get("code") ?? "";
      const claims = await this.verify(code, "code");
      if (!claims || claims.c !== c) return bad("invalid_grant", "bad or expired code");
      if (claims.r !== p.get("redirect_uri")) return bad("invalid_grant", "redirect_uri differs");
      const challenge = b64url(await sha256(p.get("code_verifier") ?? ""));
      if (!same(challenge, claims.ch as string)) return bad("invalid_grant", "PKCE check failed");
      for (const [k, exp] of this.usedCodes) if (exp < this.now()) this.usedCodes.delete(k);
      if (this.usedCodes.has(code)) return bad("invalid_grant", "code already used");
      this.usedCodes.set(code, claims.exp as number);
      return this.tokens(c);
    }
    if (p.get("grant_type") === "refresh_token") {
      const claims = await this.verify(p.get("refresh_token") ?? "", "refresh");
      if (!claims || claims.c !== c) return bad("invalid_grant", "bad or expired refresh token");
      return this.tokens(c);
    }
    return bad("unsupported_grant_type", "authorization_code or refresh_token");
  }

  private async tokens(c: string): Promise<Response> {
    const now = this.now();
    const n = () => b64url(crypto.getRandomValues(new Uint8Array(12)));
    return json({
      access_token: await this.sign({ t: "access", c, n: n(), exp: now + ACCESS_S }),
      token_type: "Bearer",
      expires_in: ACCESS_S,
      refresh_token: await this.sign({ t: "refresh", c, n: n(), exp: now + REFRESH_S }),
    });
  }
}

async function digest(s: string): Promise<string> {
  return b64url((await sha256(s)).subarray(0, 12));
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const TEXTS = {
  en: {
    title: "Notes",
    ask: "An app wants to read and add to your notes. Enter the server's password to let it.",
    password: "Password",
    allow: "Allow",
    wrong: "Wrong password.",
    paused: "Too many wrong passwords: try again in a few minutes.",
    error: "This sign-in can't go on:",
  },
  es: {
    title: "Notas",
    ask: "Una aplicación quiere leer tus notas y añadir otras. Escribe la contraseña del servidor para permitírselo.",
    password: "Contraseña",
    allow: "Permitir",
    wrong: "Contraseña incorrecta.",
    paused: "Demasiados intentos fallidos: vuelve a probar dentro de unos minutos.",
    error: "No se puede seguir con este acceso:",
  },
};

function page(
  req: Request,
  o: { fields?: Record<string, string>; error?: string; wrong?: "password" | "paused" },
  status?: number,
): Response {
  const t = /^es\b/i.test(req.headers.get("accept-language") ?? "") ? TEXTS.es : TEXTS.en;
  const body = o.error
    ? `<p>${esc(t.error)} ${esc(o.error)}</p>`
    : `<p>${esc(t.ask)}</p>
${o.wrong ? `<p class="err">${esc(o.wrong === "paused" ? t.paused : t.wrong)}</p>` : ""}
<form method="post" action="/authorize">
${Object.entries(o.fields ?? {})
  .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
  .join("\n")}
<label>${esc(t.password)} <input type="password" name="password" autocomplete="current-password" autofocus required></label>
<button>${esc(t.allow)}</button>
</form>`;
  const html = `<!doctype html><html lang="${t === TEXTS.es ? "es" : "en"}"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(t.title)}</title>
<style>body{font:16px system-ui,sans-serif;max-width:26rem;margin:3rem auto;padding:0 1rem;color:#222;background:#fff}
@media(prefers-color-scheme:dark){body{color:#ddd;background:#1e1e1e}}label{display:block;margin:1rem 0}
input[type=password]{display:block;width:100%;box-sizing:border-box;padding:.6rem;font-size:1rem;margin-top:.3rem}
button{padding:.6rem 1.2rem;font-size:1rem}.err{color:#c33}</style>
<h1>${esc(t.title)}</h1>
${body}
</html>`;
  return new Response(html, {
    status: status ?? (o.error ? 400 : 200),
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });
}
