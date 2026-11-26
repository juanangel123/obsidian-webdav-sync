// Small HTTP helpers shared by the server, the process and the tests.

import type { Http } from "../src/webdav";

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

export function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The WebDAV client's HTTP over fetch; `timeoutMs` aborts a request that takes longer. */
export function fetchHttp(timeoutMs?: number): Http {
  return async (req) => {
    const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    return { status: res.status, headers, body: await res.arrayBuffer() };
  };
}
