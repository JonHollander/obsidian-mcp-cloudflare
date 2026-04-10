const http = require("http");
const fs = require("fs");
const path = require("path");

const VAULT_DIR = process.env.VAULT_DIR || "/vault";
const LOG_FILE = process.env.LOG_FILE || "/tmp/sync.log";
const READY_FLAG = process.env.READY_FLAG || "/tmp/vault-ready";
const PORT = parseInt(process.env.PORT || "8080", 10);

// ── Path helpers ───────────────────────────────────────────────

function safePath(userPath) {
  if (!userPath) return null;
  const resolved = path.resolve(VAULT_DIR, userPath);
  if (!resolved.startsWith(VAULT_DIR + "/") && resolved !== VAULT_DIR) return null;
  return resolved;
}

function isReady() {
  return fs.existsSync(READY_FLAG);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ── Recursive file walk ────────────────────────────────────────

function walkMd(dir, base) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".obsidian")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMd(full, base));
    } else if (entry.name.endsWith(".md")) {
      const stat = fs.statSync(full);
      results.push({
        path: path.relative(base, full),
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    }
  }
  return results;
}

// ── Route handlers ─────────────────────────────────────────────

async function handleNotes(req, res, url) {
  const notePath = url.searchParams.get("path");

  // GET /api/notes — list all notes
  if (req.method === "GET" && !notePath) {
    const files = walkMd(VAULT_DIR, VAULT_DIR);
    return json(res, 200, files);
  }

  const full = safePath(notePath);
  if (!full) return json(res, 400, { error: "Invalid path" });

  // GET /api/notes?path=x — read note
  if (req.method === "GET") {
    try {
      const content = fs.readFileSync(full, "utf8");
      return json(res, 200, { content });
    } catch {
      return json(res, 404, { error: "Note not found" });
    }
  }

  // PUT /api/notes?path=x — write/overwrite note
  if (req.method === "PUT") {
    const body = await readBody(req);
    if (typeof body.content !== "string")
      return json(res, 400, { error: "Missing content" });
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body.content);
    return json(res, 200, { ok: true, path: notePath });
  }

  // PATCH /api/notes?path=x — append to note
  if (req.method === "PATCH") {
    const body = await readBody(req);
    if (typeof body.content !== "string")
      return json(res, 400, { error: "Missing content" });
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const prev = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
    fs.writeFileSync(full, prev + "\n" + body.content);
    return json(res, 200, { ok: true, path: notePath });
  }

  // DELETE /api/notes?path=x — delete note
  if (req.method === "DELETE") {
    try {
      fs.unlinkSync(full);
      return json(res, 200, { ok: true, path: notePath });
    } catch {
      return json(res, 404, { error: "Note not found" });
    }
  }

  return json(res, 405, { error: "Method not allowed" });
}

async function handleSearch(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  const body = await readBody(req);
  if (!body.query) return json(res, 400, { error: "Missing query" });

  const q = body.query.toLowerCase();
  const files = walkMd(VAULT_DIR, VAULT_DIR);
  const results = [];

  for (const file of files) {
    const full = path.join(VAULT_DIR, file.path);
    let text;
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const idx = text.toLowerCase().indexOf(q);
    if (idx !== -1) {
      const snippet = text.slice(Math.max(0, idx - 120), idx + 120);
      results.push({ path: file.path, snippet: snippet.trim() });
    }
  }

  return json(res, 200, results);
}

async function handleFolders(req, res, url) {
  const folderPath = url.searchParams.get("path") || "";

  // GET /api/folders?path=x — list subfolders
  if (req.method === "GET") {
    const full = folderPath ? safePath(folderPath) : VAULT_DIR;
    if (!full) return json(res, 400, { error: "Invalid path" });
    try {
      const entries = fs.readdirSync(full, { withFileTypes: true });
      const folders = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith(".obsidian"))
        .map((e) => e.name);
      return json(res, 200, { parent: folderPath || "/", folders });
    } catch {
      return json(res, 404, { error: "Folder not found" });
    }
  }

  if (!folderPath) return json(res, 400, { error: "Missing path" });
  const full = safePath(folderPath);
  if (!full) return json(res, 400, { error: "Invalid path" });

  // PUT /api/folders?path=x — create folder
  if (req.method === "PUT") {
    fs.mkdirSync(full, { recursive: true });
    return json(res, 200, { ok: true, path: folderPath });
  }

  // DELETE /api/folders?path=x&recursive=true
  if (req.method === "DELETE") {
    const recursive = url.searchParams.get("recursive") === "true";
    try {
      if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) {
        return json(res, 404, { error: "Folder not found" });
      }
      if (!recursive) {
        const entries = fs.readdirSync(full);
        if (entries.length > 0) {
          return json(res, 400, {
            error: `Folder not empty (${entries.length} items). Use recursive=true to delete.`,
          });
        }
      }
      fs.rmSync(full, { recursive: true });
      return json(res, 200, { ok: true, path: folderPath });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  return json(res, 405, { error: "Method not allowed" });
}

// ── Server ─────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Status and logs — always available
  if (url.pathname === "/status") {
    let logs = "";
    try { logs = fs.readFileSync(LOG_FILE, "utf8"); } catch {}
    return json(res, 200, {
      pid: process.pid,
      uptime: process.uptime(),
      ready: isReady(),
      loginOk: logs.includes("Obsidian login OK"),
      syncRunning: logs.includes("Starting ob sync"),
      lastLines: logs.split("\n").slice(-20),
    });
  }

  if (url.pathname === "/logs") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    try { res.end(fs.readFileSync(LOG_FILE, "utf8")); }
    catch { res.end("(no logs yet)"); }
    return;
  }

  // Health check
  if (url.pathname === "/") {
    return json(res, 200, { ok: true, ready: isReady() });
  }

  // API endpoints — require readiness
  if (url.pathname.startsWith("/api/")) {
    if (!isReady()) {
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
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] API listening on :${PORT}`);
});
