// The MCP endpoint (Streamable HTTP, stateless: one JSON answer per POST, no event stream) and its tools.

import pkg from "../package.json";
import { json } from "./http";
import { NoteError, type Notes } from "./notes";
import type { OAuth } from "./oauth";

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"];

const str = (description: string) => ({ type: "string", description });

const TOOLS = [
  {
    name: "search_notes",
    description:
      "Search the notes by words (all must appear, in the path or the text; case and accents ignored). Returns paths and a snippet around the first match.",
    inputSchema: { type: "object", properties: { query: str("Words to look for") }, required: ["query"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_notes",
    description: "List the files of the vault, or of one folder, with their sizes.",
    inputSchema: { type: "object", properties: { folder: str('A folder path, e.g. "Work/Projects"; empty for all') } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "read_note",
    description: "Read one note's full text (Markdown).",
    inputSchema: { type: "object", properties: { path: str('The note\'s path, e.g. "Work/Ideas.md"') }, required: ["path"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_note",
    description:
      "Create a new Markdown note. Fails if the path exists (then use append_to_note). A path without a folder goes to the inbox folder; without an extension gets .md.",
    inputSchema: {
      type: "object",
      properties: { path: str('e.g. "Shopping list" or "Work/Meeting 2026-11-26.md"'), content: str("Markdown text") },
      required: ["path", "content"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "append_to_note",
    description: "Add text at the end of an existing note, on a new line.",
    inputSchema: {
      type: "object",
      properties: { path: str("The note's path"), text: str("Markdown text to add") },
      required: ["path", "text"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
];

export interface ServerConfig {
  notes: Notes;
  oauth: OAuth;
  /** Folder for new notes given without one ("" for the vault's root). */
  inbox: string;
  log?: (event: Record<string, unknown>) => void;
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

export function createHandler(cfg: ServerConfig): (req: Request) => Promise<Response> {
  const log = cfg.log ?? (() => {});
  const inbox = cfg.inbox.replace(/^\/+|\/+$/g, "");

  async function call(name: string, args: Record<string, unknown>): Promise<string> {
    const s = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
    switch (name) {
      case "search_notes": {
        const hits = await cfg.notes.search(s("query"));
        if (!hits.length) return "No notes match.";
        return hits.map((h) => `- ${h.path}${h.snippet ? `\n  ${h.snippet}` : ""}`).join("\n");
      }
      case "list_notes": {
        const { files, unnamed } = await cfg.notes.list(s("folder"));
        const big = unnamed ? `\n(${unnamed} large attachments not listed: they are never downloaded here)` : "";
        if (!files.length) return `No files there.${big}`;
        return files.map((f) => `- ${f.path} (${f.size} bytes)`).join("\n") + big;
      }
      case "read_note": {
        const n = await cfg.notes.read(s("path"));
        return `# ${n.path}\n\n${n.text}`;
      }
      case "create_note": {
        let path = s("path").trim();
        if (!path) throw new NoteError("a path is required");
        if (inbox && !path.replace(/^\/+/, "").includes("/")) path = `${inbox}/${path.replace(/^\/+/, "")}`;
        const p = await cfg.notes.create(path, s("content"));
        return `Created "${p}". It reaches the devices on their next sync.`;
      }
      case "append_to_note": {
        if (!s("text")) throw new NoteError("no text to add");
        const p = await cfg.notes.append(s("path"), s("text"));
        return `Added to "${p}". It reaches the devices on their next sync.`;
      }
    }
    throw new RpcError(-32602, `unknown tool ${name}`);
  }

  async function rpc(m: Rpc): Promise<unknown | null> {
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id ?? null, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: m.id ?? null, error: { code, message } });
    if (m.id === undefined || m.id === null) return null; // a notification: nothing to answer
    switch (m.method) {
      case "initialize": {
        const asked = String(m.params?.protocolVersion ?? "");
        return ok({
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "webdav-vault-notes", version: pkg.version },
          instructions:
            "The owner's Obsidian vault (Markdown notes). Search before reading; never invent paths: list or search first. " +
            "To jot something down, create a note (or append to the one the owner names). Writes reach the owner's devices on their next sync.",
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: TOOLS });
      case "tools/call": {
        const name = String(m.params?.name ?? "");
        const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
        const started = Date.now();
        try {
          const text = await call(name, args);
          log({ event: "tool", tool: name, ok: true, ms: Date.now() - started });
          return ok({ content: [{ type: "text", text }], isError: false });
        } catch (err) {
          if (err instanceof RpcError) return fail(err.code, err.message);
          const msg = err instanceof NoteError ? err.message : `server error: ${err instanceof Error ? err.message : err}`;
          log({ event: "tool", tool: name, ok: false, ms: Date.now() - started, error: err instanceof NoteError ? "note" : msg });
          return ok({ content: [{ type: "text", text: msg }], isError: true });
        }
      }
    }
    return fail(-32601, `method not found: ${m.method}`);
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const auth = await cfg.oauth.handle(req);
    if (auth) return auth;
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname !== "/mcp") return json({ error: "not found" }, 404);
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    if (!(await cfg.oauth.authorised(req))) return cfg.oauth.challenge();
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
    }
    const batch = Array.isArray(body);
    const messages: unknown[] = batch ? (body as unknown[]) : [body];
    const answers = (await Promise.all(messages.map((m) => rpc((m ?? {}) as Rpc)))).filter((a) => a !== null);
    if (!answers.length) return new Response(null, { status: 202 });
    return json(batch ? answers : answers[0]);
  };
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
