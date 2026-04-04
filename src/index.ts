import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Container } from "@cloudflare/containers";

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
  CF_ACCOUNT_ID: string;
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
  sleepAfter = "0s"; // always running

  onStart() {
    const env = this.env as unknown as Env;
    this.envVars = {
      OBSIDIAN_EMAIL: env.OBSIDIAN_EMAIL,
      OBSIDIAN_PASSWORD: env.OBSIDIAN_PASSWORD,
      VAULT_NAME: env.VAULT_NAME,
      VAULT_PASSWORD: env.VAULT_PASSWORD,
      AWS_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
      R2_BUCKET_NAME: env.R2_BUCKET_NAME || "obsidian-vault",
      CF_ACCOUNT_ID: env.CF_ACCOUNT_ID,
    };
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

    return (ObsidianMCP as any).serve("/mcp").fetch(request, env, ctx);
  },
};
