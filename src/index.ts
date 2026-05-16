import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Container, getContainer } from "@cloudflare/containers";

// ── Types ───────────────────────────────────────────────────────

interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  OBSIDIAN_SYNC: DurableObjectNamespace;
  MCP_AUTH_TOKEN: string;
  // Container env vars (passed through to ObsidianSync)
  OBSIDIAN_EMAIL: string;
  OBSIDIAN_PASSWORD: string;
  VAULT_NAME: string;
  VAULT_PASSWORD: string;
  SEARCH_INDEX_ENABLED: string;
}

// ── MCP Server ──────────────────────────────────────────────────

export class ObsidianMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "obsidian-vault",
    version: "1.0.0",
  });

  // ── Helper: proxy requests to the container API ────────────
  private async containerFetch(
    method: string,
    path: string,
    body?: unknown
  ): Promise<Response> {
    const stub = getContainer(
      this.env.OBSIDIAN_SYNC as unknown as DurableObjectNamespace<ObsidianSync>
    );
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    return stub.fetch(new Request(`https://container${path}`, init));
  }

  private async containerJson(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; data: any }> {
    try {
      const res = await this.containerFetch(method, path, body);
      const data = await res.json().catch(() => ({}));
      return { status: res.status, data };
    } catch (e) {
      return {
        status: 0,
        data: { error: e instanceof Error ? e.message : String(e) },
      };
    }
  }

  private errorText(data: any, fallback: string): string {
    if (data?.error === "vault_initializing") {
      return "The vault is initializing. Please try again in a moment.";
    }
    return data?.error || data?.message || fallback;
  }

  async init() {
    // ── List all notes ────────────────────────────────────────
    this.server.tool(
      "list_notes",
      "List markdown notes in the vault. Supports pagination, prefix filtering, and incremental listing via updated_since.",
      {
        limit: z
          .number()
          .int()
          .positive()
          .max(10000)
          .default(1000)
          .describe("Max notes to return (default 1000, max 10000)."),
        cursor: z
          .number()
          .int()
          .nonnegative()
          .default(0)
          .describe("Offset cursor from a previous response's next_cursor."),
        prefix: z
          .string()
          .default("")
          .describe("Only return notes whose path starts with this prefix, e.g. 'projects/'."),
        updated_since: z
          .string()
          .optional()
          .describe("ISO timestamp; only return notes modified at or after this time."),
      },
      async ({ limit, cursor, prefix, updated_since }) => {
        const qs = new URLSearchParams();
        qs.set("limit", String(limit));
        qs.set("cursor", String(cursor));
        if (prefix) qs.set("prefix", prefix);
        if (updated_since) qs.set("updated_since", updated_since);
        const { status, data } = await this.containerJson(
          "GET",
          `/api/notes?${qs.toString()}`
        );
        if (status !== 200) {
          return {
            content: [{ type: "text", text: this.errorText(data, "Failed to list notes") }],
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }
    );

    // ── Read a note ───────────────────────────────────────────
    this.server.tool(
      "read_note",
      "Read a note by path. For very large notes, use offset/max_bytes to page through content (response includes truncated/total_size).",
      {
        path: z.string().describe("Path to the note, e.g. 'projects/zoetrope.md'"),
        offset: z
          .number()
          .int()
          .nonnegative()
          .default(0)
          .describe("Byte offset to start reading from (default 0)."),
        max_bytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max bytes to return. Defaults to the server's configured cap."),
      },
      async ({ path, offset, max_bytes }) => {
        const qs = new URLSearchParams();
        qs.set("path", path);
        if (offset) qs.set("offset", String(offset));
        if (max_bytes) qs.set("max_bytes", String(max_bytes));
        const { status, data } = await this.containerJson(
          "GET",
          `/api/notes?${qs.toString()}`
        );
        if (status === 404) {
          return { content: [{ type: "text", text: `Note not found: ${path}` }] };
        }
        if (status !== 200) {
          return {
            content: [{ type: "text", text: this.errorText(data, "Failed to read note") }],
          };
        }
        if (data.truncated) {
          const header =
            `[truncated: returned ${data.returned_bytes} of ${data.total_size} bytes ` +
            `from offset ${data.offset}. Call read_note again with offset=${data.offset + data.returned_bytes} for more.]\n\n`;
          return { content: [{ type: "text", text: header + data.content }] };
        }
        return { content: [{ type: "text", text: data.content }] };
      }
    );

    // ── Full-text search ──────────────────────────────────────
    this.server.tool(
      "search_notes",
      "Search across all notes for a text query. Returns matching paths and snippets, sorted by recency.",
      {
        query: z.string().describe("Search term (case-insensitive)"),
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .default(20)
          .describe("Max results to return (default 20, max 200)."),
      },
      async ({ query, limit }) => {
        const { status, data } = await this.containerJson(
          "POST",
          "/api/search",
          { query, limit }
        );
        if (status !== 200) {
          return {
            content: [{ type: "text", text: this.errorText(data, "Search failed") }],
          };
        }
        const results: Array<{ path: string; snippet: string }> = data.results || [];
        if (!results.length) {
          return { content: [{ type: "text", text: "No results found." }] };
        }
        const formatted = results
          .map((r) => `**${r.path}**\n...${r.snippet}...`)
          .join("\n\n---\n\n");
        const footer = data.truncated
          ? `\n\n---\n\n_Showing ${results.length} of more matches. Increase \`limit\` (max 200) or refine the query._`
          : "";
        return { content: [{ type: "text", text: formatted + footer }] };
      }
    );

    // ── Write / create a note ─────────────────────────────────
    this.server.tool(
      "write_note",
      "Create a new note or overwrite an existing one",
      {
        path: z.string().describe("Path for the note, e.g. 'inbox/idea.md'"),
        content: z.string().describe("Full markdown content"),
      },
      async ({ path, content }) => {
        const { status, data } = await this.containerJson(
          "PUT",
          `/api/notes?path=${encodeURIComponent(path)}`,
          { content }
        );
        if (status !== 200) {
          return {
            content: [{ type: "text", text: this.errorText(data, "Failed to write note") }],
          };
        }
        return { content: [{ type: "text", text: `Wrote ${path}` }] };
      }
    );

    // ── Append to a note ──────────────────────────────────────
    this.server.tool(
      "append_to_note",
      "Append content to the end of an existing note, or create it if it doesn't exist",
      {
        path: z.string().describe("Path to the note"),
        content: z.string().describe("Content to append"),
      },
      async ({ path, content }) => {
        const { status, data } = await this.containerJson(
          "PATCH",
          `/api/notes?path=${encodeURIComponent(path)}`,
          { content }
        );
        if (status !== 200) {
          return {
            content: [{ type: "text", text: this.errorText(data, "Failed to append to note") }],
          };
        }
        return { content: [{ type: "text", text: `Appended to ${path}` }] };
      }
    );

    // ── Delete a note ─────────────────────────────────────────
    this.server.tool(
      "delete_note",
      "Delete a note from the vault",
      { path: z.string().describe("Path of the note to delete") },
      async ({ path }) => {
        const { status, data } = await this.containerJson(
          "DELETE",
          `/api/notes?path=${encodeURIComponent(path)}`
        );
        if (status === 404) {
          return { content: [{ type: "text", text: `Note not found: ${path}` }] };
        }
        if (status !== 200) {
          return {
            content: [{ type: "text", text: this.errorText(data, "Failed to delete note") }],
          };
        }
        return { content: [{ type: "text", text: `Deleted ${path}` }] };
      }
    );

    // ── Create a folder ───────────────────────────────────────
    this.server.tool(
      "create_folder",
      "Create a folder in the vault. Creates all intermediate folders in the path (like mkdir -p).",
      {
        path: z.string().describe(
          "Folder path, e.g. 'projects/2026/research'. No trailing slash needed."
        ),
      },
      async ({ path }) => {
        const normalized = path.replace(/^\/+|\/+$/g, "");
        if (!normalized) {
          return {
            content: [{ type: "text", text: "Error: folder path cannot be empty" }],
          };
        }
        const { status, data } = await this.containerJson(
          "PUT",
          `/api/folders?path=${encodeURIComponent(normalized)}`
        );
        if (status !== 200) {
          return {
            content: [{ type: "text", text: this.errorText(data, "Failed to create folder") }],
          };
        }
        return {
          content: [{ type: "text", text: `Created folder: ${normalized}/` }],
        };
      }
    );

    // ── Delete a folder ───────────────────────────────────────
    this.server.tool(
      "delete_folder",
      "Delete a folder from the vault. By default only deletes empty folders. Set recursive=true to delete the folder and all its contents.",
      {
        path: z.string().describe(
          "Folder path to delete, e.g. 'projects/old'. No trailing slash needed."
        ),
        recursive: z
          .boolean()
          .default(false)
          .describe(
            "If true, delete the folder and all its contents. If false (default), only delete if the folder is empty."
          ),
      },
      async ({ path, recursive }) => {
        const normalized = path.replace(/^\/+|\/+$/g, "");
        if (!normalized) {
          return {
            content: [{ type: "text", text: "Error: folder path cannot be empty" }],
          };
        }
        const qs = `path=${encodeURIComponent(normalized)}&recursive=${recursive}`;
        const { status, data } = await this.containerJson("DELETE", `/api/folders?${qs}`);
        if (status === 404) {
          return {
            content: [{ type: "text", text: `Folder not found: ${normalized}/` }],
          };
        }
        if (status === 400) {
          return {
            content: [{ type: "text", text: data.error }],
          };
        }
        if (status !== 200) {
          return {
            content: [{ type: "text", text: this.errorText(data, "Failed to delete folder") }],
          };
        }
        return {
          content: [{ type: "text", text: `Deleted folder: ${normalized}/` }],
        };
      }
    );

    // ── List folders ──────────────────────────────────────────
    this.server.tool(
      "list_folders",
      "List subfolders at a given path in the vault. Returns immediate child folders only.",
      {
        path: z
          .string()
          .default("")
          .describe(
            "Parent folder path, e.g. 'projects'. Empty string for vault root. No trailing slash needed."
          ),
      },
      async ({ path }) => {
        const normalized = path.replace(/^\/+|\/+$/g, "");
        const { status, data } = await this.containerJson(
          "GET",
          `/api/folders?path=${encodeURIComponent(normalized)}`
        );
        if (status !== 200) {
          return {
            content: [{ type: "text", text: this.errorText(data, "Failed to list folders") }],
          };
        }
        if (!data.folders || data.folders.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: normalized
                  ? `No subfolders found in: ${normalized}/`
                  : "No folders found in vault root.",
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }
    );
  }
}

// ── Sync Container ──────────────────────────────────────────────

export class ObsidianSync extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "24h";
  enableInternet = true;

  envVars = {
    OBSIDIAN_EMAIL: (this.env as unknown as Env).OBSIDIAN_EMAIL,
    OBSIDIAN_PASSWORD: (this.env as unknown as Env).OBSIDIAN_PASSWORD,
    VAULT_NAME: (this.env as unknown as Env).VAULT_NAME,
    VAULT_PASSWORD: (this.env as unknown as Env).VAULT_PASSWORD,
    SEARCH_INDEX_ENABLED:
      (this.env as unknown as Env).SEARCH_INDEX_ENABLED || "",
  };

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/__destroy__") {
      await this.destroy();
      return new Response("destroyed");
    }
    return super.fetch(request);
  }

  override onStart() {
    console.log("[sync] container started");
  }

  override onStop(opts: { exitCode: number; reason: string }) {
    console.log("[sync] container stopped:", JSON.stringify(opts));
  }

  override onError(error: unknown) {
    console.error("[sync] container error:", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

// ── Fetch handler ───────────────────────────────────────────────

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Fail closed: refuse to serve if no auth token is configured.
    const expected = env.MCP_AUTH_TOKEN;
    if (!expected || expected.length < 16) {
      return new Response(
        "Server misconfigured: MCP_AUTH_TOKEN secret is missing or too short " +
          "(min 16 chars). Refusing to serve. See README for setup.",
        { status: 503 }
      );
    }

    // Auth: Bearer header (preferred) or ?token= query param.
    // Query-string tokens are convenient for clients that can't set headers,
    // but they end up in access logs and browser history — prefer headers.
    const authHeader = request.headers.get("Authorization") || "";
    const headerToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : "";
    // Extract from raw query so '+' is not decoded as space.
    const rawToken = url.search.match(/[?&]token=([^&]*)/)?.[1];
    const urlToken = rawToken ? decodeURIComponent(rawToken) : "";

    if (
      !timingSafeEqual(headerToken, expected) &&
      !timingSafeEqual(urlToken, expected)
    ) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Sync container endpoints
    if (url.pathname.startsWith("/sync/")) {
      try {
        const stub = getContainer(
          env.OBSIDIAN_SYNC as unknown as DurableObjectNamespace<ObsidianSync>
        );

        if (url.pathname === "/sync/restart") {
          try { await stub.fetch(new Request("https://container/__destroy__")); } catch {}
          await new Promise((r) => setTimeout(r, 2000));
          const res = await stub.fetch(new Request("https://container/"));
          return new Response(
            JSON.stringify({ status: "restarted", container: res.status }),
            { headers: { "Content-Type": "application/json" } }
          );
        }

        const subpath = url.pathname === "/sync/start" ? "/" :
                        url.pathname === "/sync/logs" ? "/logs" :
                        url.pathname === "/sync/status" ? "/status" : "/";
        const res = await stub.fetch(new Request(`https://container${subpath}`));
        if (url.pathname === "/sync/start") {
          return new Response(
            JSON.stringify({ status: "started", container: res.status }),
            { headers: { "Content-Type": "application/json" } }
          );
        }
        return res;
      } catch (err) {
        return new Response(
          JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    return (ObsidianMCP as any).serve("/mcp").fetch(request, env, ctx);
  },
};
