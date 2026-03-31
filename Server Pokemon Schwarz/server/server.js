
const express  = require("express");
const http     = require("http");
const https    = require("https");
const { Server } = require("socket.io");
const path = require("path");

const app    = express();
const server = http.createServer(app);

// Required for Render's reverse proxy (correct IP forwarding)
app.set("trust proxy", 1);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ["websocket"],
  allowEIO3: true
});

app.use(express.static(path.join(__dirname, "../public")));
app.use(express.json());

const ROUTES_FILE = path.join(__dirname, "../routes_by_game.json");
const fs = require("fs");

global.saveTimeout = null;

// ── GitHub persistence config ────────────────────────────────────────────────
const GH_OWNER  = "legolei";
const GH_REPO   = "nuzlocke-data";
const GH_FILE   = "db.json";
const GH_BRANCH = "main";

function ghToken() {
  return process.env.GITHUB_TOKEN || "";
}

function ghApiRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "api.github.com",
      path:     urlPath,
      method:   method,
      headers: {
        "Authorization": "token " + ghToken(),
        "User-Agent":    "nuzlocke-server",
        "Accept":        "application/vnd.github.v3+json",
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (c) => raw += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (_) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function defaultDB() {
  return {
    game: "",
    players: Array(8).fill(null).map((_, i) => ({
      name:        "Player " + (i + 1),
      color:       ["red","blue","green","purple","orange","cyan","pink","yellow"][i],
      team:        [null, null, null, null, null, null],
      badges:      [false,false,false,false,false,false,false,false],
      deaths:      0,
      mainStream:  "",
      touchStream: "",
      taken:       false,
      catches:     {},
      mainAdj:     { left: 0, top: 0, w: 100, h: 100 },
      touchAdj:    { left: 0, top: 0, w: 100, h: 100 }
    })),
    graveyard: []
  };
}

async function loadFromGitHub() {
  try {
    const rawUrl = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/${GH_FILE}`;
    const data = await new Promise((resolve, reject) => {
      https.get(rawUrl, { headers: { "User-Agent": "nuzlocke-server" } }, (res) => {
        let raw = "";
        res.on("data", (c) => raw += c);
        res.on("end", () => {
          if (res.statusCode === 200) {
            try { resolve(JSON.parse(raw)); }
            catch (e) { reject(e); }
          } else {
            reject(new Error("HTTP " + res.statusCode));
          }
        });
      }).on("error", reject);
    });

    const def = defaultDB();
    const merged = Object.assign({}, def, data);
    if (!Array.isArray(merged.players) || merged.players.length !== 8) {
      merged.players = def.players;
    } else {
      merged.players = merged.players.map((p, i) =>
        Object.assign({}, def.players[i], p)
      );
    }
    if (!Array.isArray(merged.graveyard)) merged.graveyard = [];
    if (typeof merged.game !== "string") merged.game = "";

    console.log("[db] loaded from GitHub, game:", merged.game || "(none)");
    return merged;
  } catch (err) {
    console.warn("[db] GitHub load failed:", err.message, "— using default DB");
    return defaultDB();
  }
}

let _saveSha  = null;
let _saveQueue = Promise.resolve();

async function saveToGitHub(db) {
  // Serialize saves to avoid race conditions / SHA conflicts
  _saveQueue = _saveQueue.then(async () => {
    try {
      // 1. Get current SHA
      const meta = await ghApiRequest("GET", `/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}`);
      if (meta.status !== 200) throw new Error("SHA fetch failed: " + meta.status);
      const sha = meta.body.sha;

      // 2. PUT updated content
      const content = Buffer.from(JSON.stringify(db, null, 2)).toString("base64");
      const result  = await ghApiRequest("PUT", `/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}`, {
        message: "update db",
        content,
        sha,
        branch: GH_BRANCH
      });
      if (result.status === 200 || result.status === 201) {
        console.log("[db] saved to GitHub");
      } else {
        console.error("[db] GitHub save error:", result.status, JSON.stringify(result.body).slice(0, 120));
      }
    } catch (err) {
      console.error("[db] GitHub save failed:", err.message);
    }
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────
let db = defaultDB();

loadFromGitHub().then((data) => {
  db = data;
  console.log("[server] database ready");
});

// ── Socket.IO ────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("[socket] connected:", socket.id);
  socket.emit("state", db);

  socket.on("update", (data) => {
    db = data;
    console.log("[update] state received, game:", db.game || "(none)");

    // Live Updates sofort an andere Clients senden (ohne den Sender doppelt zu triggern)
    socket.broadcast.emit("state", db);

    // GitHub speichern maximal alle 60 Sekunden (verhindert Spam)
    clearTimeout(global.saveTimeout);
    global.saveTimeout = setTimeout(() => {
      saveToGitHub(db);
    }, 60000);
  });

  socket.on("disconnect", () => {
    console.log("[socket] disconnected:", socket.id);
  });
});

// ── REST endpoints ───────────────────────────────────────────────────────────
app.get("/api/ping", (req, res) => {
  res.json({ ok: true, game: db.game || "", ts: Date.now() });
});

app.get("/api/routes", (req, res) => {
  if (!fs.existsSync(ROUTES_FILE)) return res.status(404).json({ error: "not found" });
  try {
    res.json(JSON.parse(fs.readFileSync(ROUTES_FILE)));
  } catch (err) {
    console.error("[routes] read error:", err.message);
    res.status(500).json({ error: "read error" });
  }
});

app.post("/api/updatePlayer", (req, res) => {
  const { index, player } = req.body;
  if (index == null || !player) return res.status(400).json({ error: "invalid" });

  // Neues Format: db.games[db.game].players
  if (db.games && db.game && db.games[db.game] && Array.isArray(db.games[db.game].players)) {
    if (index < 0 || index >= db.games[db.game].players.length) return res.status(400).json({ error: "invalid index" });
    db.games[db.game].players[index] = player;
  } else if (Array.isArray(db.players)) {
    // Altes Format als Fallback
    if (index < 0 || index >= db.players.length) return res.status(400).json({ error: "invalid index" });
    db.players[index] = player;
  } else {
    return res.status(400).json({ error: "no player data" });
  }

  io.emit("state", db);
  saveToGitHub(db);
  console.log(`[update] player ${index} updated and broadcast`);
  res.json({ ok: true });
});

// ── Server-side keep-alive (prevents Render free tier sleep) ─────────────────
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  const pingUrl = RENDER_URL.replace(/\/$/, "") + "/api/ping";
  setInterval(() => {
    const client = pingUrl.startsWith("https") ? https : http;
    client.get(pingUrl, (res) => {
      console.log("[keep-alive] self-ping →", res.statusCode);
    }).on("error", (e) => {
      console.warn("[keep-alive] self-ping failed:", e.message);
    });
  }, 10 * 60 * 1000);
  console.log("[keep-alive] active →", pingUrl);
} else {
  console.log("[keep-alive] RENDER_EXTERNAL_URL not set — local dev mode");
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[server] started on port ${PORT}`));
