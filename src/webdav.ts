// A small WebDAV client over an injected HTTP function (Obsidian's requestUrl in the app, fetch in tests).

export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: ArrayBuffer | string;
}

export interface HttpResponse {
  status: number;
  /** Header names in lower case. */
  headers: Record<string, string>;
  body: ArrayBuffer;
}

export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export interface RemoteEntry {
  name: string; // relative to the base, no leading slash
  etag: string;
  size: number;
  dir: boolean;
}

interface PropEntry {
  href: string;
  etag: string;
  size: number;
  dir: boolean;
}

export class WebDavError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A request that got no answer in time (thrown by the app's Http). */
export class TimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly seconds: number,
  ) {
    super(`${method}: no answer in ${seconds} s`);
  }
}

function base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function cleanEtag(raw: string): string {
  return decodeEntities(raw.trim()).replace(/^W\//, "").replace(/^"|"$/g, "");
}

/** Parses a PROPFIND multistatus body (namespace prefixes dropped; no DOMParser, so it runs in tests too). */
export function parseMultistatus(xml: string): PropEntry[] {
  const plain = xml.replace(/<(\/?)[A-Za-z][\w.-]*:/g, "<$1");
  const out: PropEntry[] = [];
  for (const m of plain.matchAll(/<response\b[^>]*>([\s\S]*?)<\/response>/g)) {
    const body = m[1];
    const href = /<href\b[^>]*>([\s\S]*?)<\/href>/.exec(body)?.[1];
    if (!href) continue;
    const etag = cleanEtag(/<getetag\b[^>]*>([\s\S]*?)<\/getetag>/.exec(body)?.[1] ?? "");
    const size = Number(/<getcontentlength\b[^>]*>\s*(\d+)\s*<\/getcontentlength>/.exec(body)?.[1] ?? 0);
    const dir = /<resourcetype\b[^>]*>[\s\S]*?<collection\b/.test(body);
    out.push({ href: decodeEntities(href.trim()), etag, size, dir });
  }
  return out;
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop>' +
  "<d:resourcetype/><d:getetag/><d:getcontentlength/></d:prop></d:propfind>";

export class WebDav {
  private readonly base: string;
  private readonly basePath: string;
  private readonly auth: string;

  constructor(
    private readonly http: Http,
    url: string,
    user: string,
    password: string,
  ) {
    this.base = url.replace(/\/+$/, "");
    this.basePath = decodeURIComponent(new URL(this.base + "/").pathname);
    this.auth = "Basic " + base64(`${user}:${password}`);
  }

  url(name: string): string {
    return this.base + "/" + name.split("/").map(encodeURIComponent).join("/");
  }

  private async req(
    method: string,
    name: string,
    ok: number[],
    headers: Record<string, string> = {},
    body?: ArrayBuffer | string,
  ): Promise<HttpResponse> {
    const res = await this.http({ url: this.url(name), method, headers: { Authorization: this.auth, ...headers }, body });
    if (!ok.includes(res.status)) {
      const hint = res.status === 401 ? " (wrong user or password)" : "";
      throw new WebDavError(`${method} /${name}: HTTP ${res.status}${hint}`, res.status);
    }
    return res;
  }

  private entry(e: PropEntry): RemoteEntry {
    let path = e.href;
    try {
      path = decodeURIComponent(new URL(e.href, this.base + "/").pathname);
    } catch {
      /* keep as is */
    }
    if (path.startsWith(this.basePath)) path = path.slice(this.basePath.length);
    return { name: path.replace(/^\/+|\/+$/g, ""), etag: e.etag, size: e.size, dir: e.dir };
  }

  private async propfind(name: string, depth: "0" | "1"): Promise<RemoteEntry[] | null> {
    const res = await this.req("PROPFIND", name, [207, 404], { Depth: depth, "Content-Type": "application/xml" }, PROPFIND_BODY);
    if (res.status === 404) return null;
    return parseMultistatus(new TextDecoder().decode(res.body)).map((e) => this.entry(e));
  }

  /** The entries directly inside a folder ("" for the base), without the folder itself. */
  async list(dir = ""): Promise<RemoteEntry[]> {
    const self = dir.replace(/^\/+|\/+$/g, "");
    const all = await this.propfind(dir, "1");
    if (!all) throw new WebDavError(`PROPFIND /${dir}: HTTP 404 (no such folder)`, 404);
    return all.filter((e) => e.name !== self);
  }

  async stat(name: string): Promise<RemoteEntry | null> {
    return (await this.propfind(name, "0"))?.[0] ?? null;
  }

  async get(name: string): Promise<Uint8Array | null> {
    const res = await this.req("GET", name, [200, 404]);
    return res.status === 404 ? null : new Uint8Array(res.body);
  }

  /**
   * Writes a file; returns its new ETag when the server tells it on the PUT (else ""). `onlyIfAbsent` sends
   * `If-None-Match: *` and throws a 412 WebDavError when the file exists — on servers that honour it: rclone doesn't
   * (nor If-Match), so callers check before and after.
   */
  async put(name: string, data: ArrayBuffer | string, onlyIfAbsent = false): Promise<string> {
    const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
    if (onlyIfAbsent) headers["If-None-Match"] = "*";
    const res = await this.req("PUT", name, [200, 201, 204], headers, data);
    return cleanEtag(res.headers.etag ?? "");
  }

  /** Creates a folder; an existing one is fine. */
  async mkcol(name: string): Promise<void> {
    await this.req("MKCOL", name, [201, 405]);
  }

  async move(from: string, to: string): Promise<void> {
    await this.req("MOVE", from, [201, 204], { Destination: this.url(to), Overwrite: "F" });
  }
}
