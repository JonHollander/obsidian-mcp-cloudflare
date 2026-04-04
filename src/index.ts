import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Container, getContainer } from "@cloudflare/containers";

// ── Types ───────────────────────────────────────────────────────

interface Env {
  VAULT: R2Bucket;
  MCP_OBJECT: DurableObjectNamespace;
  OBSIDIAN_SYNC: DurableObjectNamespace;
  MCP_AUTH_TOKEN: string;
  // Container env vars (passed through to ObsidianSync)
  OBSIDIAN_EMAIL: string;
  OBSIDIAN_PASSWORD: string;
  VAULT_NAME: string;
  VAULT_PASSWORD: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
  CF_ACCOUNT_ID: string; // also used as R2_ACCOUNT_ID
}

// ── MCP Server ──────────────────────────────────────────────────

export class ObsidianMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "obsidian-vault",
    version: "1.0.0",
  });

  async init() {
    // ── List all notes ────────────────────────────────────────
    this.server.tool(
      "list_notes",
      "List all markdown notes in the vault with paths and sizes",
      {},
      async () => {
        const objects = await this.listAll();
        const files = objects
          .filter((o) => o.key.endsWith(".md"))
          .map((o) => ({
            path: o.key,
            size: o.size,
            modified: o.uploaded.toISOString(),
          }));
        return {
          content: [{ type: "text", text: JSON.stringify(files, null, 2) }],
        };
      }
    );

    // ── Read a note ───────────────────────────────────────────
    this.server.tool(
      "read_note",
      "Read the full content of a note by its path",
      { path: z.string().describe("Path to the note, e.g. 'projects/zoetrope.md'") },
      async ({ path }) => {
        const obj = await this.env.VAULT.get(path);
        if (!obj) {
          return { content: [{ type: "text", text: `Note not found: ${path}` }] };
        }
        const text = await obj.text();
        return { content: [{ type: "text", text }] };
      }
    );

    // ── Full-text search ──────────────────────────────────────
    this.server.tool(
      "search_notes",
      "Search across all notes for a text query. Returns matching file paths and snippets.",
      { query: z.string().describe("Search term (case-insensitive)") },
      async ({ query }) => {
        const objects = await this.listAll();
        const results: string[] = [];
        const q = query.toLowerCase();

        for (const obj of objects) {
          if (!obj.key.endsWith(".md")) continue;
          const file = await this.env.VAULT.get(obj.key);
          if (!file) continue;
          const text = await file.text();
          if (text.toLowerCase().includes(q)) {
            const idx = text.toLowerCase().indexOf(q);
            const snippet = text.slice(Math.max(0, idx - 120), idx + 120);
            results.push(`**${obj.key}**\n...${snippet.trim()}...`);
          }
        }

        return {
          content: [
            {
              type: "text",
              text: results.length
                ? results.join("\n\n---\n\n")
                : "No results found.",
            },
          ],
        };
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
        await this.env.VAULT.put(path, content);
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
        const existing = await this.env.VAULT.get(path);
        const prev = existing ? await existing.text() : "";
        await this.env.VAULT.put(path, prev + "\n" + content);
        return { content: [{ type: "text", text: `Appended to ${path}` }] };
      }
    );

    // ── Delete a note ─────────────────────────────────────────
    this.server.tool(
      "delete_note",
      "Delete a note from the vault",
      { path: z.string().describe("Path of the note to delete") },
      async ({ path }) => {
        await this.env.VAULT.delete(path);
        return { content: [{ type: "text", text: `Deleted ${path}` }] };
      }
    );
  }

  // ── Helper: paginated R2 list ───────────────────────────────
  private async listAll(): Promise<R2Object[]> {
    const objects: R2Object[] = [];
    let cursor: string | undefined;
    do {
      const listed = await this.env.VAULT.list({ cursor, limit: 1000 });
      objects.push(...listed.objects);
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    return objects;
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
    AWS_ACCESS_KEY_ID: (this.env as unknown as Env).R2_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: (this.env as unknown as Env).R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME: (this.env as unknown as Env).R2_BUCKET_NAME || "obsidian-vault",
    R2_ACCOUNT_ID: (this.env as unknown as Env).CF_ACCOUNT_ID,
  };

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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Optional bearer token auth
    if (env.MCP_AUTH_TOKEN) {
      const auth = request.headers.get("Authorization");
      if (auth !== `Bearer ${env.MCP_AUTH_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const url = new URL(request.url);

    // Start sync container via dedicated endpoint
    if (url.pathname === "/sync/start") {
      try {
        const stub = getContainer(
          env.OBSIDIAN_SYNC as unknown as DurableObjectNamespace<ObsidianSync>
        );
        const res = await stub.fetch(new Request("https://container/"));
        return new Response(
          JSON.stringify({ status: "started", container: res.status }),
          { headers: { "Content-Type": "application/json" } }
        );
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
