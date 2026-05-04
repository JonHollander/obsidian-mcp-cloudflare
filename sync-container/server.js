const http = require("http");
const fs = require("fs/promises");
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
    return json(res, 200, { ok: true, path: notePath });
  }

  if (req.method === "DELETE") {
    try {
      await fs.unlink(full);
      return json(res, 200, { ok: true, path: notePath });
    } catch {
      return json(res, 404, { error: "Note not found" });
    }
  }

  return json(res, 405, { error: "Method not allowed" });
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
  const q = body.query.toLowerCase();
  const files = await walkMd(VAULT_DIR, VAULT_DIR);
  files.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));

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

  return json(res, 200, {
    results,
    total_scanned: scanned,
    total_files: files.length,
    truncated,
  });
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
      await fs.rm(full, { recursive: true });
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
