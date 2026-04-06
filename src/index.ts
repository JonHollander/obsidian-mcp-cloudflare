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
  CLOUDFLARE_ACCOUNT_ID: string; // also used as R2_ACCOUNT_ID
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
        await this.triggerSync();
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
        await this.triggerSync();
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
        await this.triggerSync();
        return { content: [{ type: "text", text: `Deleted ${path}` }] };
      }
    );

    // ── Create a folder ───────────────────────────────────────
    const FOLDER_PLACEHOLDER = ".folder-placeholder.md";

    this.server.tool(
      "create_folder",
      "Create a folder in the vault. Creates all intermediate folders in the path (like mkdir -p). A small placeholder .md file is added so the folder syncs to Obsidian.",
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

        const parts = normalized.split("/");
        const created: string[] = [];

        for (let i = 1; i <= parts.length; i++) {
          const segment = parts.slice(0, i).join("/");
          const placeholderKey = segment + "/" + FOLDER_PLACEHOLDER;
          const existing = await this.env.VAULT.head(placeholderKey);
          if (!existing) {
            await this.env.VAULT.put(placeholderKey, "");
            created.push(segment + "/");
          }
        }

        await this.triggerSync();

        if (created.length === 0) {
          return {
            content: [{ type: "text", text: `Folder already exists: ${normalized}/` }],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Created folder${created.length > 1 ? "s" : ""}: ${created.join(", ")}`,
            },
          ],
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
        const folderPrefix = normalized + "/";

        // List all objects under this prefix
        const objects: R2Object[] = [];
        let cursor: string | undefined;
        do {
          const listed = await this.env.VAULT.list({
            prefix: folderPrefix,
            cursor,
            limit: 1000,
          });
          objects.push(...listed.objects);
          cursor = listed.truncated ? listed.cursor : undefined;
        } while (cursor);

        if (objects.length === 0) {
          return {
            content: [{ type: "text", text: `Folder not found: ${normalized}/` }],
          };
        }

        // Separate user content from folder placeholders
        const userContent = objects.filter(
          (o) => !o.key.endsWith("/" + FOLDER_PLACEHOLDER)
        );

        if (!recursive && userContent.length > 0) {
          return {
            content: [
              {
                type: "text",
                text: `Folder '${normalized}/' is not empty (${userContent.length} item(s)). Use recursive=true to delete folder and all contents.`,
              },
            ],
          };
        }

        // Batch delete all objects (R2 supports up to 1000 keys per call)
        const keysToDelete = objects.map((o) => o.key);
        for (let i = 0; i < keysToDelete.length; i += 1000) {
          await this.env.VAULT.delete(keysToDelete.slice(i, i + 1000));
        }

        await this.triggerSync();

        const msg =
          recursive && userContent.length > 0
            ? `Deleted folder '${normalized}/' and ${userContent.length} item(s)`
            : `Deleted folder: ${normalized}/`;
        return { content: [{ type: "text", text: msg }] };
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
        const prefix = normalized ? normalized + "/" : "";

        const listed = await this.env.VAULT.list({
          prefix,
          delimiter: "/",
        });

        const folders = listed.delimitedPrefixes.map((p) =>
          p.slice(prefix.length).replace(/\/$/, "")
        );

        if (folders.length === 0) {
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
              text: JSON.stringify(
                { parent: normalized || "/", folders },
                null,
                2
              ),
            },
          ],
        };
      }
    );
  }

  // ── Helper: trigger container sync after R2 writes ──────────
  private async triggerSync(): Promise<void> {
    try {
      const stub = getContainer(
        this.env.OBSIDIAN_SYNC as unknown as DurableObjectNamespace<ObsidianSync>
      );
      await stub.fetch(new Request("https://container/trigger-sync"));
    } catch {
      // Best-effort — don't fail the tool call if sync trigger fails
    }
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
    R2_ACCOUNT_ID: (this.env as unknown as Env).CLOUDFLARE_ACCOUNT_ID,
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Optional auth: Bearer header or ?token= query param
    if (env.MCP_AUTH_TOKEN) {
      const auth = request.headers.get("Authorization");
      // Extract token from raw query to avoid + being decoded as space
      const rawToken = url.search.match(/[?&]token=([^&]*)/)?.[1];
      const urlToken = rawToken ? decodeURIComponent(rawToken) : null;
      if (auth !== `Bearer ${env.MCP_AUTH_TOKEN}` && urlToken !== env.MCP_AUTH_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
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
                        url.pathname === "/sync/status" ? "/status" :
                        url.pathname === "/sync/trigger" ? "/trigger-sync" : "/";
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
