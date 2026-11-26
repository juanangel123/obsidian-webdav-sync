// The sign-in page a person sees once when connecting a client.

import type { Who } from "./oauth";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

type Texts = (typeof TEXTS)["en"];

const TEXTS = {
  en: {
    title: "Notes",
    ask: "An app wants to read and add to your notes. Enter the server's password to let it.",
    app: "App",
    unnamed: "(no name given)",
    goes: "Access goes to",
    local: (port: string) => `this computer${port ? ` (port ${port})` : ""}`,
    check: "Only go on if you just asked for this.",
    password: "Password",
    allow: "Allow",
    wrong: "Wrong password.",
    paused: "Too many wrong passwords: try again in a few minutes.",
    error: "This sign-in can't go on:",
  },
  es: {
    title: "Notas",
    ask: "Una aplicación quiere leer tus notas y añadir otras. Escribe la contraseña del servidor para permitírselo.",
    app: "Aplicación",
    unnamed: "(sin nombre)",
    goes: "El acceso irá a",
    local: (port: string) => `este ordenador${port ? ` (puerto ${port})` : ""}`,
    check: "Sigue solo si acabas de pedirlo tú.",
    password: "Contraseña",
    allow: "Permitir",
    wrong: "Contraseña incorrecta.",
    paused: "Demasiados intentos fallidos: vuelve a probar dentro de unos minutos.",
    error: "No se puede seguir con este acceso:",
  },
};

// The sign-in page: Obsidian-like (its violet accent, dark and light greys, Inter when installed), without its name
// or logo: a password page dressed as a known brand is what phishing looks like. A gem of its own instead.
const CSS = `:root{--bg:#f6f6f6;--card:#fff;--text:#222;--muted:#5c5c5c;--line:#e0e0e0;--accent:#7c3aed;--accent-hover:#6d28d9;
--field:#fff;--err:#d43c3c;--shadow:0 1px 2px rgba(0,0,0,.04),0 8px 28px rgba(0,0,0,.08)}
@media(prefers-color-scheme:dark){:root{--bg:#1e1e1e;--card:#262626;--text:#dadada;--muted:#a3a3a3;--line:#363636;
--accent:#8a5cf5;--accent-hover:#9d76f7;--field:#1e1e1e;--err:#fb6464;--shadow:0 1px 2px rgba(0,0,0,.3),0 12px 32px rgba(0,0,0,.35)}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{display:grid;place-items:center;min-height:100vh;padding:16px;background:var(--bg);color:var(--text);
font:15px/1.55 Inter,"Segoe UI",system-ui,-apple-system,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.card{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:32px 28px;box-shadow:var(--shadow)}
.gem{display:block;width:44px;height:44px;margin:0 0 18px}
h1{font-size:22px;font-weight:700;letter-spacing:-.01em;margin:0 0 6px}
.lead{color:var(--muted);margin:0 0 18px}
.who{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0 0 8px;padding:12px 14px;border:1px solid var(--line);border-radius:8px;font-size:14px}
.who dt{color:var(--muted)}.who dd{margin:0;overflow-wrap:anywhere}.muted{color:var(--muted)}
.check{color:var(--muted);font-size:13px;margin:0 0 20px}
label{display:block;font-size:13px;font-weight:600;margin:0 0 6px}
input[type=password]{display:block;width:100%;padding:10px 12px;font:inherit;color:var(--text);background:var(--field);
border:1px solid var(--line);border-radius:8px;outline:none;transition:border-color .15s,box-shadow .15s}
input[type=password]:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 25%,transparent)}
input[aria-invalid=true]{border-color:var(--err)}
.err{color:var(--err);font-size:13px;margin:8px 0 0}
button{display:block;width:100%;margin-top:20px;padding:10px 14px;font:inherit;font-weight:600;color:#fff;background:var(--accent);
border:0;border-radius:8px;cursor:pointer;transition:background .15s}
button:hover{background:var(--accent-hover)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}`;

const GEM = `<svg class="gem" viewBox="0 0 48 48" aria-hidden="true"><defs>
<linearGradient id="g1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#b79cff"/><stop offset="1" stop-color="#6d28d9"/></linearGradient>
<linearGradient id="g2" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8a5cf5"/><stop offset="1" stop-color="#4c1d95"/></linearGradient></defs>
<path d="M24 3 40 15 35 43 13 43 8 15Z" fill="url(#g1)"/><path d="M24 3 29 22 35 43 24 31Z" fill="url(#g2)" opacity=".9"/>
<path d="M8 15 24 31 13 43Z" fill="#3b1a78" opacity=".35"/><path d="M24 3 19 22 24 31 29 22Z" fill="#fff" opacity=".18"/></svg>`;

export function page(
  req: Request,
  o: { fields?: Record<string, string>; who?: Who; error?: string; wrong?: "password" | "paused" },
  status?: number,
): Response {
  const t = /^es\b/i.test(req.headers.get("accept-language") ?? "") ? TEXTS.es : TEXTS.en;
  const body = o.error
    ? `<p class="err">${esc(t.error)} ${esc(o.error)}</p>`
    : `<p class="lead">${esc(t.ask)}</p>
${o.who ? whoBlock(t, o.who) : ""}
<form method="post" action="/authorize">
${Object.entries(o.fields ?? {})
  .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
  .join("\n")}
<label for="pw">${esc(t.password)}</label>
<input id="pw" type="password" name="password" autocomplete="current-password" autofocus required${o.wrong ? ' aria-invalid="true" aria-describedby="err"' : ""}>
${o.wrong ? `<p class="err" id="err" role="alert">${esc(o.wrong === "paused" ? t.paused : t.wrong)}</p>` : ""}
<button type="submit">${esc(t.allow)}</button>
</form>`;
  const html = `<!doctype html><html lang="${t === TEXTS.es ? "es" : "en"}"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
<title>${esc(t.title)}</title>
<style>${CSS}</style>
<main class="card">
${GEM}
<h1>${esc(t.title)}</h1>
${body}
</main>
</html>`;
  return new Response(html, {
    status: status ?? (o.error ? 400 : 200),
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action ${formAction(o.fields?.redirect_uri)}`,
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });
}

/** Who asks and where the access goes: a link someone else sent can't pass for the person's own client. */
function whoBlock(t: Texts, who: Who): string {
  const to = who.host ? who.host : t.local(who.port);
  return `<dl class="who"><dt>${esc(t.app)}</dt><dd>${who.name ? esc(who.name) : `<span class="muted">${esc(t.unnamed)}</span>`}</dd>
<dt>${esc(t.goes)}</dt><dd><strong>${esc(to)}</strong></dd></dl>
<p class="check">${esc(t.check)}</p>`;
}

/** The form posts here, then the server redirects to the client: browsers check form-action on both. */
function formAction(redirect: string | undefined): string {
  try {
    return redirect ? `'self' ${new URL(redirect).origin}` : "'self'";
  } catch {
    return "'self'";
  }
}
