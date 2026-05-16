const http = require("http");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");

const VAULT_DIR = process.env.VAULT_DIR || "/vault";
const LOG_FILE = process.env.LOG_FILE || "/tmp/sync.log";
const READY_FLAG = process.env.READY_FLAG || "/tmp/vault-ready";
const PORT = parseInt(process.env.PORT || "8080", 10);

const MAX_BODY_BYTES = parseInt(
  process.env.MAX_BODY_BYTES || String(10 * 1024 * 1024),
  10
);
const MAX_NOTE_BYTES = parseInt(
  process.env.MAX_NOTE_BYTES || String(5 * 1024 * 1024),
  10
);
const DEFAULT_LIST_LIMIT = parseInt(process.env.DEFAULT_LIST_LIMIT || "1000", 10);
const MAX_LIST_LIMIT = parseInt(process.env.MAX_LIST_LIMIT || "10000", 10);
const DEFAULT_SEARCH_LIMIT = parseInt(process.env.DEFAULT_SEARCH_LIMIT || "20", 10);
const MAX_SEARCH_LIMIT = parseInt(process.env.MAX_SEARCH_LIMIT || "200", 10);

// ── Path helpers ───────────────────────────────────────────────

// Segments that must never be touched: Obsidian metadata (plugins execute
// code when the vault opens, so writes here are RCE on the user's desktop)
// and the trash folder.
function isReservedSegment(seg) {
  return seg === ".obsidian" || seg.startsWith(".obsidian-") || seg === ".trash";
}

function safePath(userPath) {
  if (typeof userPath !== "string" || !userPath) return null;
  if (/[\x00-\x1f]/.test(userPath)) return null;
  const resolved = path.resolve(VAULT_DIR, userPath);
  if (!resolved.startsWith(VAULT_DIR + "/") && resolved !== VAULT_DIR) return null;
  const rel = path.relative(VAULT_DIR, resolved);
  if (rel && rel.split(path.sep).some(isReservedSegment)) return null;
  return resolved;
}

function isMarkdownPath(p) {
  return typeof p === "string" && /\.md$/i.test(p);
}

function clampInt(v, def, min, max) {
  const n = typeof v === "number" ? v : parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

async function isReady() {
  try {
    await fs.access(READY_FLAG);
    return true;
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on("data", (c) => {
      if (aborted) return;
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        aborted = true;
        const err = new Error("Request body too large");
        err.statusCode = 413;
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (aborted) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve({});
      }
    });
    req.on("error", (e) => {
      if (!aborted) reject(e);
    });
  });
}

async function readBodyOrError(req, res) {
  try {
    return { body: await readBody(req) };
  } catch (e) {
    const status = e && e.statusCode === 413 ? 413 : 400;
    json(res, status, { error: e.message || "Bad request" });
    return { failed: true };
  }
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ── Search index (optional, opt-in via SEARCH_INDEX_ENABLED=true) ──────

const INDEX_ENABLED = process.env.SEARCH_INDEX_ENABLED === "true";
const INDEX_DB_PATH = process.env.INDEX_DB_PATH || "/tmp/index.sqlite";
const INDEX_SWEEP_INTERVAL_MS = parseInt(
  process.env.INDEX_SWEEP_INTERVAL_MS || "30000",
  10
);
const INDEX_DEBOUNCE_MS = parseInt(process.env.INDEX_DEBOUNCE_MS || "250", 10);
const INDEX_SCHEMA_VERSION = "1";

function indexLog(...args) {
  console.log("[index]", ...args);
}

const indexer = {
  enabled: INDEX_ENABLED,
  db: null,
  ready: false,
  bulkInProgress: false,
  pending: new Map(),
  watcher: null,
  sweepTimer: null,

  init() {
    if (!this.enabled) {
      indexLog("disabled (set SEARCH_INDEX_ENABLED=true to enable)");
      return false;
    }
    let Database;
    try {
      Database = require("better-sqlite3");
    } catch (e) {
      indexLog("better-sqlite3 not available, falling back to brute force:", e.message);
      this.enabled = false;
      return false;
    }
    try {
      this.db = new Database(INDEX_DB_PATH);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS files (
          path  TEXT PRIMARY KEY,
          size  INTEGER NOT NULL,
          mtime INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
          path UNINDEXED,
          content,
          tokenize = 'unicode61 remove_diacritics 2'
        );
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      `);
      const row = this.db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get();
      if (row && row.value !== INDEX_SCHEMA_VERSION) {
        indexLog(`schema mismatch (${row.value} != ${INDEX_SCHEMA_VERSION}), wiping`);
        this.db.exec("DELETE FROM files; DELETE FROM notes_fts;");
      }
      this.db
        .prepare(
          "INSERT INTO meta(key, value) VALUES('schema_version', ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )
        .run(INDEX_SCHEMA_VERSION);
      indexLog(`opened ${INDEX_DB_PATH}`);
      return true;
    } catch (e) {
      indexLog("init failed:", e.message);
      this.db = null;
      this.enabled = false;
      return false;
    }
  },

  // Used by the live-update paths (synchronous fs.watch and the note write
  // handlers). Reads the file from disk and replaces its index row.
  async upsert(relPath) {
    if (!this.db) return;
    const full = path.join(VAULT_DIR, relPath);
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile()) {
        this.remove(relPath);
        return;
      }
      const content = await fs.readFile(full, "utf8");
      const tx = this.db.transaction((p, s, m, c) => {
        this.db
          .prepare(
            "INSERT INTO files(path, size, mtime) VALUES(?, ?, ?) " +
              "ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime"
          )
          .run(p, s, m);
        this.db.prepare("DELETE FROM notes_fts WHERE path = ?").run(p);
        this.db
          .prepare("INSERT INTO notes_fts(path, content) VALUES(?, ?)")
          .run(p, c);
      });
      tx(relPath, stat.size, stat.mtime.getTime(), content);
    } catch {
      // File vanished or unreadable — make sure no stale row remains.
      this.remove(relPath);
    }
  },

  remove(relPath) {
    if (!this.db) return;
    try {
      const tx = this.db.transaction((p) => {
        this.db.prepare("DELETE FROM files WHERE path = ?").run(p);
        this.db.prepare("DELETE FROM notes_fts WHERE path = ?").run(p);
      });
      tx(relPath);
    } catch (e) {
      indexLog("remove failed:", relPath, e.message);
    }
  },

  // Bulk-rebuild after the readiness flag flips. Reads files in chunks and
  // yields between chunks so the event loop isn't starved.
  async bulkReindex() {
    if (!this.db || this.bulkInProgress) return;
    this.bulkInProgress = true;
    const start = Date.now();
    indexLog("bulk reindex starting");
    try {
      const files = await walkMd(VAULT_DIR, VAULT_DIR);
      this.db.exec("DELETE FROM files; DELETE FROM notes_fts;");

      const insertFile = this.db.prepare(
        "INSERT INTO files(path, size, mtime) VALUES(?, ?, ?)"
      );
      const insertFts = this.db.prepare(
        "INSERT INTO notes_fts(path, content) VALUES(?, ?)"
      );

      const CHUNK = 100;
      let inserted = 0;
      for (let i = 0; i < files.length; i += CHUNK) {
        const slice = files.slice(i, i + CHUNK);
        const reads = await Promise.all(
          slice.map(async (f) => {
            try {
              const content = await fs.readFile(
                path.join(VAULT_DIR, f.path),
                "utf8"
              );
              return { ...f, content };
            } catch {
              return null;
            }
          })
        );
        const tx = this.db.transaction((batch) => {
          for (const f of batch) {
            if (!f) continue;
            insertFile.run(f.path, f.size, new Date(f.modified).getTime());
            insertFts.run(f.path, f.content);
            inserted++;
          }
        });
        tx(reads);
        // Yield to the event loop between chunks.
        await new Promise((r) => setImmediate(r));
      }
      this.ready = true;
      indexLog(`bulk reindex done: ${inserted} files in ${Date.now() - start} ms`);
    } catch (e) {
      indexLog("bulk reindex failed:", e.message);
    } finally {
      this.bulkInProgress = false;
    }
  },

  // Debounced fs.watch handler — coalesces atomic-rename event bursts.
  scheduleWatchEvent(filename) {
    if (!this.db || !filename) return;
    const rel = filename;
    if (rel.split(path.sep).some(isReservedSegment)) return;
    if (!rel.toLowerCase().endsWith(".md")) return;
    const prev = this.pending.get(rel);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.pending.delete(rel);
      this.upsert(rel).catch((e) =>
        indexLog("watch upsert failed:", rel, e.message)
      );
    }, INDEX_DEBOUNCE_MS);
    this.pending.set(rel, t);
  },

  startWatcher() {
    if (!this.db) return;
    try {
      this.watcher = fsSync.watch(
        VAULT_DIR,
        { recursive: true },
        (_event, filename) => this.scheduleWatchEvent(filename)
      );
      indexLog(`fs.watch started on ${VAULT_DIR}`);
    } catch (e) {
      indexLog("fs.watch unavailable, relying on periodic sweep:", e.message);
    }
  },

  // Safety net: reconcile index against disk. Cheap when nothing changed —
  // only re-reads files whose mtime moved.
  async sweep() {
    if (!this.db || !this.ready) return;
    const start = Date.now();
    try {
      const files = await walkMd(VAULT_DIR, VAULT_DIR);
      const onDisk = new Map();
      for (const f of files) {
        onDisk.set(f.path, new Date(f.modified).getTime());
      }
      const indexed = new Map();
      for (const row of this.db.prepare("SELECT path, mtime FROM files").all()) {
        indexed.set(row.path, row.mtime);
      }
      let updated = 0;
      let removed = 0;
      for (const [p, mtimeMs] of onDisk) {
        const idx = indexed.get(p);
        if (idx === undefined || idx < mtimeMs) {
          await this.upsert(p);
          updated++;
        }
      }
      for (const p of indexed.keys()) {
        if (!onDisk.has(p)) {
          this.remove(p);
          removed++;
        }
      }
      if (updated || removed) {
        indexLog(
          `sweep: updated=${updated} removed=${removed} in ${Date.now() - start} ms`
        );
      }
    } catch (e) {
      indexLog("sweep failed:", e.message);
    }
  },

  startSweep() {
    if (!this.db) return;
    this.sweepTimer = setInterval(
      () => this.sweep(),
      INDEX_SWEEP_INTERVAL_MS
    );
    // Don't keep the process alive on this timer alone.
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  },

  buildFtsQuery(input) {
    // Strip every FTS5 operator so the model can't escape into query syntax.
    const cleaned = String(input).replace(/["*():\-\\^~]/g, " ").trim();
    if (!cleaned) return null;
    const tokens = cleaned.split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;
    return tokens
      .map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`))
      .join(" ");
  },

  search(query, limit) {
    if (!this.db || !this.ready) return null;
    const fts = this.buildFtsQuery(query);
    if (!fts) {
      return { results: [], total_scanned: 0, total_files: 0, truncated: false };
    }
    try {
      const rows = this.db
        .prepare(
          `SELECT path, snippet(notes_fts, 1, '', '', '...', 16) AS snippet
           FROM notes_fts
           WHERE notes_fts MATCH ?
           ORDER BY bm25(notes_fts)
           LIMIT ?`
        )
        .all(fts, limit + 1);
      const truncated = rows.length > limit;
      const sliced = rows.slice(0, limit);
      const total = this.db.prepare("SELECT COUNT(*) AS c FROM files").get().c;
      return {
        results: sliced,
        total_scanned: total,
        total_files: total,
        truncated,
      };
    } catch (e) {
      indexLog("fts query failed:", e.message);
      return null;
    }
  },
};

// ── Recursive file walk ────────────────────────────────────────

async function walkMd(dir, base, results = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (isReservedSegment(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkMd(full, base, results);
    } else if (entry.name.toLowerCase().endsWith(".md")) {
      try {
        const stat = await fs.stat(full);
        results.push({
          path: path.relative(base, full),
          size: stat.size,
          modified: stat.mtime.toISOString(),
        });
      } catch {
        // file vanished between readdir and stat — skip
      }
    }
  }
  return results;
}

// ── Note handlers ──────────────────────────────────────────────

async function handleListNotes(req, res, url) {
  const limit = clampInt(
    url.searchParams.get("limit"),
    DEFAULT_LIST_LIMIT,
    1,
    MAX_LIST_LIMIT
  );
  const cursor = clampInt(url.searchParams.get("cursor"), 0, 0, Number.MAX_SAFE_INTEGER);
  const prefixRaw = url.searchParams.get("prefix") || "";
  const prefix = prefixRaw.replace(/^\/+|\/+$/g, "");
  const updatedSince = url.searchParams.get("updated_since");
  const updatedSinceMs = updatedSince ? Date.parse(updatedSince) : NaN;

  let files = await walkMd(VAULT_DIR, VAULT_DIR);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (prefix) files = files.filter((f) => f.path.startsWith(prefix));
  if (Number.isFinite(updatedSinceMs)) {
    files = files.filter((f) => Date.parse(f.modified) >= updatedSinceMs);
  }

  const total = files.length;
  const slice = files.slice(cursor, cursor + limit);
  const next = cursor + slice.length < total ? cursor + slice.length : null;
  return json(res, 200, {
    notes: slice,
    total,
    next_cursor: next,
    truncated: next !== null,
  });
}

async function handleReadNote(res, url, full) {
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  const maxBytes = clampInt(
    url.searchParams.get("max_bytes"),
    MAX_NOTE_BYTES,
    1,
    MAX_NOTE_BYTES
  );

  let stat;
  try {
    stat = await fs.stat(full);
  } catch {
    return json(res, 404, { error: "Note not found" });
  }
  const totalSize = stat.size;
  const start = Math.min(offset, totalSize);
  const length = Math.min(maxBytes, totalSize - start);

  let content = "";
  if (length > 0) {
    const fh = await fs.open(full, "r");
    try {
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, start);
      content = buf.toString("utf8");
    } finally {
      await fh.close();
    }
  }
  const truncated = start + length < totalSize;
  return json(res, 200, {
    content,
    total_size: totalSize,
    offset: start,
    returned_bytes: length,
    truncated,
  });
}

async function handleNotes(req, res, url) {
  const notePath = url.searchParams.get("path");

  if (req.method === "GET" && !notePath) {
    return handleListNotes(req, res, url);
  }

  const full = safePath(notePath);
  if (!full) return json(res, 400, { error: "Invalid path" });
  if (!isMarkdownPath(notePath)) {
    return json(res, 400, { error: "Path must end in .md" });
  }

  if (req.method === "GET") {
    return handleReadNote(res, url, full);
  }

  if (req.method === "PUT") {
    const r = await readBodyOrError(req, res);
    if (r.failed) return;
    if (typeof r.body.content !== "string")
      return json(res, 400, { error: "Missing content" });
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, r.body.content);
    await indexer.upsert(notePath);
    return json(res, 200, { ok: true, path: notePath });
  }

  if (req.method === "PATCH") {
    const r = await readBodyOrError(req, res);
    if (r.failed) return;
    if (typeof r.body.content !== "string")
      return json(res, 400, { error: "Missing content" });
    await fs.mkdir(path.dirname(full), { recursive: true });
    let separator = "";
    try {
      const stat = await fs.stat(full);
      if (stat.size > 0) separator = "\n";
    } catch {
      // file doesn't exist — appendFile will create it, no separator needed
    }
    await fs.appendFile(full, separator + r.body.content);
    await indexer.upsert(notePath);
    return json(res, 200, { ok: true, path: notePath });
  }

  if (req.method === "DELETE") {
    try {
      await fs.unlink(full);
      indexer.remove(notePath);
      return json(res, 200, { ok: true, path: notePath });
    } catch {
      return json(res, 404, { error: "Note not found" });
    }
  }

  return json(res, 405, { error: "Method not allowed" });
}

async function bruteForceSearch(query, limit) {
  const q = query.toLowerCase();
  const files = await walkMd(VAULT_DIR, VAULT_DIR);
  files.sort((a, b) =>
    a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0
  );

  const results = [];
  let scanned = 0;
  let truncated = false;

  for (const file of files) {
    scanned++;
    const full = path.join(VAULT_DIR, file.path);
    let text;
    try {
      text = await fs.readFile(full, "utf8");
    } catch {
      continue;
    }
    const idx = text.toLowerCase().indexOf(q);
    if (idx !== -1) {
      const snippet = text.slice(Math.max(0, idx - 120), idx + 120);
      results.push({ path: file.path, snippet: snippet.trim() });
      if (results.length >= limit) {
        truncated = scanned < files.length;
        break;
      }
    }
  }

  return {
    results,
    total_scanned: scanned,
    total_files: files.length,
    truncated,
  };
}

async function handleSearch(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  const r = await readBodyOrError(req, res);
  if (r.failed) return;
  const body = r.body;
  if (typeof body.query !== "string" || !body.query) {
    return json(res, 400, { error: "Missing query" });
  }

  const limit = clampInt(body.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);

  // FTS5 path when index is opt-in, opened, and bulk-built.
  if (indexer.enabled && indexer.ready) {
    const fts = indexer.search(body.query, limit);
    if (fts) return json(res, 200, fts);
  }

  return json(res, 200, await bruteForceSearch(body.query, limit));
}

async function handleFolders(req, res, url) {
  const folderPath = url.searchParams.get("path") || "";

  if (req.method === "GET") {
    const full = folderPath ? safePath(folderPath) : VAULT_DIR;
    if (!full) return json(res, 400, { error: "Invalid path" });
    try {
      const entries = await fs.readdir(full, { withFileTypes: true });
      const folders = entries
        .filter((e) => e.isDirectory() && !isReservedSegment(e.name))
        .map((e) => e.name)
        .sort();
      return json(res, 200, { parent: folderPath || "/", folders });
    } catch {
      return json(res, 404, { error: "Folder not found" });
    }
  }

  if (!folderPath) return json(res, 400, { error: "Missing path" });
  const full = safePath(folderPath);
  if (!full) return json(res, 400, { error: "Invalid path" });

  if (req.method === "PUT") {
    await fs.mkdir(full, { recursive: true });
    return json(res, 200, { ok: true, path: folderPath });
  }

  if (req.method === "DELETE") {
    const recursive = url.searchParams.get("recursive") === "true";
    try {
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        return json(res, 404, { error: "Folder not found" });
      }
      if (!stat.isDirectory()) {
        return json(res, 404, { error: "Folder not found" });
      }
      if (!recursive) {
        const entries = await fs.readdir(full);
        if (entries.length > 0) {
          return json(res, 400, {
            error: `Folder not empty (${entries.length} items). Use recursive=true to delete.`,
          });
        }
      }
      // Capture .md descendants before rm so we can drop their index rows.
      const indexedChildren =
        indexer.enabled && indexer.db ? await walkMd(full, VAULT_DIR) : [];
      await fs.rm(full, { recursive: true });
      for (const child of indexedChildren) indexer.remove(child.path);
      return json(res, 200, { ok: true, path: folderPath });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  return json(res, 405, { error: "Method not allowed" });
}

// ── Server ─────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/status") {
      let logs = "";
      try {
        logs = await fs.readFile(LOG_FILE, "utf8");
      } catch {}
      return json(res, 200, {
        pid: process.pid,
        uptime: process.uptime(),
        ready: await isReady(),
        loginOk: logs.includes("Obsidian login OK"),
        syncRunning: logs.includes("Starting ob sync"),
        lastLines: logs.split("\n").slice(-20),
      });
    }

    if (url.pathname === "/logs") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      try {
        res.end(await fs.readFile(LOG_FILE, "utf8"));
      } catch {
        res.end("(no logs yet)");
      }
      return;
    }

    if (url.pathname === "/") {
      return json(res, 200, { ok: true, ready: await isReady() });
    }

    if (url.pathname.startsWith("/api/")) {
      if (!(await isReady())) {
        return json(res, 503, {
          error: "vault_initializing",
          message: "Vault sync is starting up, please retry in a few seconds",
        });
      }

      if (url.pathname === "/api/notes") return handleNotes(req, res, url);
      if (url.pathname === "/api/search") return handleSearch(req, res);
      if (url.pathname === "/api/folders") return handleFolders(req, res, url);

      return json(res, 404, { error: "Unknown endpoint" });
    }

    json(res, 404, { error: "Not found" });
  } catch (e) {
    if (!res.headersSent) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    } else {
      try { res.end(); } catch {}
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] API listening on :${PORT}`);
});

// ── Indexer bootstrap ──────────────────────────────────────────
// Open the DB up front so opt-in deployments fail fast on misconfig.
// Then poll for vault readiness and kick off the one-shot bulk reindex,
// followed by the fs.watch and periodic sweep loops.

(function bootstrapIndexer() {
  if (!indexer.init()) return;
  let startedBulk = false;
  const poll = setInterval(async () => {
    if (startedBulk) return;
    if (!(await isReady())) return;
    startedBulk = true;
    clearInterval(poll);
    indexer.startWatcher();
    await indexer.bulkReindex();
    indexer.startSweep();
  }, 1000);
  if (poll.unref) poll.unref();
})();

