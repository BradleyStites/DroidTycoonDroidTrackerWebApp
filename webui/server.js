// Droid Tycoon — web UI shell server.
// Serves the static UI (index.html) and a small JSON API backed by the SQLite
// database (droid_tycoon.db). The DB is read LIVE on every request (no caching),
// so edits made with an external DB editor are reflected on the next request.
//
// Run:  node server.js
//       (optionally set PORT, default 8787)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = process.env.PORT || 8787;
const DIR = __dirname;
const DB_PATH = path.join(DIR, "droid_tycoon.db");

// Cycle requirement lookup (task 0): given a droid id, reports whether it is
// used in the current super rebirth cycle plus the stages/colors needed.
const { getCycleRequirements, getDroidNecessity } = require("./super_rebirth_cycle");

// Statistics view (task t_4b627966): compute/render layer that mirrors the
// spreadsheet's Main sheet from the four persisted variables.
const statView = require("./stat_view");

// Player stat tracking (task 1 / t_783c3a3b): the four manually-entered grind
// variables — current super rebirth cycle, current rebirth, offline earnings
// (b/hr), and current credits — persisted to a JSON record on disk.
const {
  DEFAULT_STAT_FILE,
  FIELD_NAMES,
  FIELDS,
  createDefaultStats,
  validateStats,
  toStats,
  initStats,
  loadStats,
  saveStats,
} = require("./stat_tracking");

// Snapshot log (this task): the *measured* credits/tokens-per-minute engine.
// Keeps a history of periodic snapshots and derives the real average rate per
// Super Rebirth (SR) cycle and per (SR, Rebirth) cycle once >= 2 snapshots
// exist for a cycle — complementing the *projected* rate in stat_view.js.
const statLog = require("./stat_log");

// Allow overriding the stat file location (tests point this at a temp file so
// they never write into the repo). Falls back to the module default.
const STAT_FILE = process.env.DROID_TYCOON_STAT_FILE || DEFAULT_STAT_FILE;
const LOG_FILE = process.env.DROID_TYCOON_STAT_LOG || statLog.DEFAULT_LOG_FILE;

if (!fs.existsSync(DB_PATH)) {
  console.error(`Missing database: ${DB_PATH}\nRun: python build_db.py`);
  process.exit(1);
}

// One connection, opened at startup. node:sqlite statements are prepared per-request.
const db = new DatabaseSync(DB_PATH);

// ---------- canonical data ----------\n// The system's authoritative color palette lives in data/rebirth_data.json as
// `valid_colors` (the canonical list, curated to exclude erroneous workbook
// entries such as "Galactic"). The `colors` table in the DB is only a reference
// list derived from the workbook and is NOT authoritative (it can contain
// bad entries and miss valid ones like "Base"). The admin color dropdown is
// populated from this canonical list so users can only pick valid colors.
const REBIRTH_DATA_PATH = path.join(DIR, "..", "data", "rebirth_data.json");
function loadValidColors() {
  try {
    const raw = fs.readFileSync(REBIRTH_DATA_PATH, "utf-8");
    const model = JSON.parse(raw);
    const list = Array.isArray(model.valid_colors) ? model.valid_colors : [];
    // Strip any trailing descriptive annotations in parentheses (e.g.
    // "Blue (legacy)" -> "Blue") so only clean names reach the UI.
    return list
      .map((c) => String(c).split("(")[0].trim())
      .filter((c, i, arr) => c && arr.indexOf(c) === i);
  } catch (e) {
    console.warn(`[filters] could not load valid_colors from ${REBIRTH_DATA_PATH}: ${e.message}`);
    return [];
  }
}
const VALID_COLORS = loadValidColors();

// ---------- admin auth ----------
// The admin endpoints mutate the rebirth lineups, so they are gated behind a
// shared key. The key is read from DROID_TYCOON_ADMIN_KEY (set once per
// deployment). If unset, the server generates an ephemeral one on startup and
// prints it — fine for local single-user use, but you SHOULD set the env var
// before exposing the server to anyone else. The key is sent by the UI as the
// `X-Admin-Key` request header.
// Static default is "91935"; an explicit DROID_TYCOON_ADMIN_KEY env var takes
// precedence (so the key can be changed without editing source). Only if
// neither is set do we fall back to an ephemeral auto-generated key.
let ADMIN_KEY = process.env.DROID_TYCOON_ADMIN_KEY || "91935";
if (!ADMIN_KEY) {
  ADMIN_KEY = crypto.randomBytes(16).toString("hex");
  console.warn(
    `\n[ADMIN] DROID_TYCOON_ADMIN_KEY not set — generated an ephemeral admin key for this session:\n        ${ADMIN_KEY}\n        Set DROID_TYCOON_ADMIN_KEY to keep a stable key across restarts.\n`
  );
}
// Expose the active key so tests can read it and the UI can autofill it locally.
module.exports.ADMIN_KEY = ADMIN_KEY;

// Returns true when the request carries a valid admin key.
function isAdmin(req) {
  const headerKey = req.headers["x-admin-key"];
  if (typeof headerKey !== "string" || headerKey.length === 0) return false;
  const a = Buffer.from(headerKey);
  const b = Buffer.from(ADMIN_KEY);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Guard for admin routes. Sends 401 when the key is missing/invalid and
// returns false so the caller can bail out of the handler.
function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  sendJson(res, 401, {
    error: "Admin access required. Provide a valid 'X-Admin-Key' header.",
  });
  return false;
}

// The player's current position in the rebirth grind. This is the only mutable
// state in the app; everything else is reference/lookup data. We create the
// table lazily here so the server works even against a DB built before this
// feature existed (build_db.py also creates it on fresh builds).
db.exec(`
  CREATE TABLE IF NOT EXISTS player_stage (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    super_rebirth INTEGER NOT NULL,
    rebirth       INTEGER NOT NULL
  )
`);
// Seed to the starting stage (SR1, R1) if the row doesn't exist yet.
db.exec(`
  INSERT OR IGNORE INTO player_stage (id, super_rebirth, rebirth)
  VALUES (1, 1, 1)
`);

// Per-rebirth upgrade-chip targets (task t_68b3a8b4). This table stores the
// upgrade-chip count awarded/required at each (super_rebirth, rebirth) stage.
// It is keyed identically to droid_rebirths so the admin panel can edit chips
// for the exact same stage coordinate. We create it lazily here (matching the
// player_stage pattern) so the server works against a DB built before this
// feature existed; build_db.py (and seed_upgrade_chips.py) create/seed it on
// fresh builds, so this block only guarantees the schema is present.
db.exec(`
  CREATE TABLE IF NOT EXISTS rebirth_upgrade_chips (
    super_rebirth INTEGER NOT NULL,
    rebirth       INTEGER NOT NULL,
    chips         REAL    NOT NULL,
    PRIMARY KEY (super_rebirth, rebirth)
  )
`);

// Rebirth transition rule (verified against REBIRTH_DATA_SCHEMA.md):
//   if R < 27 : (SR, R+1)
//   else      : (SR+1, 1)   -- super rebirth rolls the inner cycle over to 1
const REBIRTH_MAX = 27;
function nextStage(sr, rb) {
  if (rb < REBIRTH_MAX) return { super_rebirth: sr, rebirth: rb + 1 };
  return { super_rebirth: sr + 1, rebirth: 1 };
}

function getDbRows(sql, params = []) {
  const stmt = db.prepare(sql);
  // node:sqlite `?` placeholders take positional arguments, not an array.
  const args = Array.isArray(params) ? params : [params];
  return stmt.all(...args);
}

// ---------- API ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function apiDroids(query, res) {
  const sr = query.get("super_rebirth");
  const rb = query.get("rebirth");

  if (sr === null && rb === null) {
    // reference list only
    const rows = getDbRows("SELECT name FROM droids ORDER BY name");
    return sendJson(res, 200, { droids: rows.map((r) => r.name) });
  }

  // Validate both filters are present and integers (port the exact search fields).
  if (sr === null || rb === null || !/^\d+$/.test(sr) || !/^\d+$/.test(rb)) {
    return sendJson(res, 400, {
      error: "Both 'super_rebirth' and 'rebirth' are required numeric filters.",
    });
  }
  const superRebirth = parseInt(sr, 10);
  const rebirth = parseInt(rb, 10);

  const rows = getDbRows(
    `SELECT droid_name, droid_color
       FROM droid_rebirths
      WHERE super_rebirth = ? AND rebirth = ?
      ORDER BY id`,
    [superRebirth, rebirth]
  );

  sendJson(res, 200, {
    super_rebirth: superRebirth,
    rebirth: rebirth,
    count: rows.length,
    droids: rows.map((r) => ({ name: r.droid_name, color: r.droid_color })),
  });
}

function apiFilters(res) {
  const superCycles = getDbRows("SELECT value FROM super_rebirth_cycles ORDER BY value").map(
    (r) => r.value
  );
  const rebirthLevels = getDbRows("SELECT value FROM rebirth_levels ORDER BY value").map(
    (r) => r.value
  );
  const colors = getDbRows("SELECT name FROM colors ORDER BY name").map((r) => r.name);
  const droids = getDbRows("SELECT name FROM droids ORDER BY name").map((r) => r.name);
  // Canonical, curated color palette (excludes erroneous workbook entries and
  // strips annotations). This is what the admin color dropdown is built from.
  const valid_colors = VALID_COLORS;
  const cost = getDbRows(
    "SELECT rebirth, credits, nova FROM rebirth_cost ORDER BY rebirth"
  ).map((r) => ({ rebirth: r.rebirth, credits: r.credits, nova: r.nova }));
  // Per-rebirth upgrade-chip targets (task t_68b3a8b4). Returned as a list of
  // {super_rebirth, rebirth, chips} so the admin panel can populate a chip
  // editor and the stage-detail view can show live chip values.
  const chips = getDbRows(
    "SELECT super_rebirth, rebirth, chips FROM rebirth_upgrade_chips ORDER BY super_rebirth, rebirth"
  ).map((r) => ({ super_rebirth: r.super_rebirth, rebirth: r.rebirth, chips: r.chips }));
  sendJson(res, 200, {
    super_rebirth_cycles: superCycles,
    rebirth_levels: rebirthLevels,
    colors,
    valid_colors,
    droids,
    rebirth_cost: cost,
    upgrade_chips: chips,
  });
}

// ---------- static ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  // prevent path traversal
  const filePath = path.join(DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not found");
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

// ---------- DroidTycoon project root (task t_d2d5eb61) ----------
// Serves the project-root static page (DroidTycoon/index.html, the "Needed
// Droids Tracker" snapshot) under the /droidtycoon/* route so it can be opened
// over http://localhost:8787 instead of via file://. Mounting the project root
// (parent of webui) keeps the page SAME-ORIGIN with the admin panel and the
// live /api/* endpoints, so any fetch the page makes to /api/... is a
// same-origin request (no CORS). Assets under DroidTycoon/ (e.g. data/) are
// reachable at /droidtycoon/data/... as well.
const ROOT_DIR = path.join(DIR, "..");
// The webui/ folder holds the server source and the live SQLite DB. The
// project-root route is for serving the public page (index.html) and its
// static assets (data/), so we explicitly keep webui/ internals out of reach
// to avoid disclosing server source / the database via path traversal.
const WEBUI_DIR = path.join(ROOT_DIR, "webui");
function serveFromProject(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  // Strip the /droidtycoon prefix; an empty remainder maps to index.html.
  const rel = urlPath.replace(/^\/droidtycoon/, "") || "/";
  if (rel === "/") return serveProjectFile(path.join(ROOT_DIR, "index.html"), res);
  // path.resolve canonicalizes ".." so traversal attempts (e.g.
  // /droidtycoon/../webui/server.js) resolve to an absolute path we can
  // containment-check. Strip the leading slash so it's treated as relative.
  const filePath = path.resolve(ROOT_DIR, rel.replace(/^\/+/, ""));
  return serveProjectFile(filePath, res);
}

function serveProjectFile(filePath, res) {
  // Containment: must be the root dir itself or strictly inside it...
  const insideRoot =
    filePath === ROOT_DIR || filePath.startsWith(ROOT_DIR + path.sep);
  // ...but never inside webui/ (server source + DB stay private).
  const insideWebui =
    filePath === WEBUI_DIR || filePath.startsWith(WEBUI_DIR + path.sep);
  if (!insideRoot || insideWebui || !fs.existsSync(filePath) ||
      fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not found");
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

// ---------- droid → current-cycle usage (task t_50383390) ----------
// GET /api/droid-cycle?droid=<name>
//   Reports whether the droid is used in the CURRENT super rebirth cycle
//   (resolved from player_stage) and, if so, which stages + colors are needed.
//   Uses the cycle module from task 0 so the data source stays unified.
function apiDroidCycle(query, res) {
  const raw = query.get("droid");
  if (raw === null || !raw.trim()) {
    return sendJson(res, 400, { error: "Missing 'droid' query parameter." });
  }
  const droidId = raw.trim();
  try {
    const req = getCycleRequirements(db, droidId);
    sendJson(res, 200, {
      droid: droidId,
      in_current_cycle: req.inCurrentCycle,
      super_rebirth: req.superRebirth,
      stages: req.stages.map((s) => ({
        super_rebirth: s.superRebirth,
        rebirth: s.rebirth,
        color: s.color,
      })),
      colors: req.colors,
      // Also surface where-else the droid is used (across all cycles) so the
      // UI can note "used in other cycles too" without a second call.
      used_in_other_cycles: req.allStages.some(
        (s) => s.superRebirth !== req.superRebirth
      ),
    });
  } catch (e) {
    return sendJson(res, 404, { error: e.message });
  }
}

// ---------- droid necessity for remaining cycle (task t_b5c5e75a) ----------
// GET /api/droid-necessity?droid=<name>[&super_rebirth=<n>&rebirth=<m>]
//   Answers: is this droid STILL REQUIRED for any REMAINING step in the
//   current super rebirth cycle? Returns needed (bool), the current stage
//   requirement (if the droid is needed right now), and the specific remaining
//   stages + colors needing it. Defaults the "current" position to player_stage;
//   overrides let callers probe from an arbitrary stage without mutating state.
function apiDroidNecessity(query, res) {
  const raw = query.get("droid");
  if (raw === null || !raw.trim()) {
    return sendJson(res, 400, { error: "Missing 'droid' query parameter." });
  }
  const opts = {};
  const sr = query.get("super_rebirth");
  const rb = query.get("rebirth");
  if (sr !== null || rb !== null) {
    if (!/^\d+$/.test(sr || "") || !/^\d+$/.test(rb || "")) {
      return sendJson(res, 400, {
        error: "'super_rebirth' and 'rebirth' must be positive integers when provided.",
      });
    }
    opts.currentSuperRebirth = parseInt(sr, 10);
    opts.currentRebirth = parseInt(rb, 10);
  }
  try {
    const r = getDroidNecessity(db, raw.trim(), opts);
    sendJson(res, 200, {
      droid: raw.trim(),
      needed: r.needed,
      super_rebirth: r.superRebirth,
      current_rebirth: r.currentRebirth,
      current_stage: r.currentStage,
      remaining_stages: r.remainingStages,
      remaining_colors: r.remainingColors,
      cleared_stages: r.clearedStages,
    });
  } catch (e) {
    return sendJson(res, 404, { error: e.message });
  }
}

// ---------- player progress (Rebirth button) ----------
function apiState(res) {
  const row = getDbRows(
    "SELECT super_rebirth, rebirth FROM player_stage WHERE id = 1"
  )[0];
  if (!row) {
    return sendJson(res, 500, { error: "Player stage not initialized." });
  }
  // Also return the 3 required droids for the current stage so the front end
  // can render the "next droids needed" list without a second request.
  const droids = getDbRows(
    `SELECT droid_name, droid_color
       FROM droid_rebirths
      WHERE super_rebirth = ? AND rebirth = ?
      ORDER BY id`,
    [row.super_rebirth, row.rebirth]
  ).map((r) => ({ name: r.droid_name, color: r.droid_color }));

  sendJson(res, 200, {
    super_rebirth: row.super_rebirth,
    rebirth: row.rebirth,
    droids,
  });
}

// ---------- bulk stages snapshot (task t_b8b899c3) ----------
// GET /api/stages -> the full page data model the "Needed Droids Tracker"
// (DroidTycoon/index.html) renders, read LIVE from the DB on every request.
// Returns one JSON object whose shape exactly matches the page's inlined DATA
// blob (stages, totals, reference, cost_curve, quarantined) so the page can
// swap its static snapshot for a live fetch with no other changes. Read-only,
// same data the public admin panel already exposes (no auth required).
function apiStages(res) {
  const rows = getDbRows(
    `SELECT super_rebirth, rebirth, droid_name, droid_color
       FROM droid_rebirths ORDER BY super_rebirth, rebirth, id`
  );
  const costByRebirth = {};
  for (const r of getDbRows("SELECT rebirth, credits, nova FROM rebirth_cost ORDER BY rebirth")) {
    costByRebirth[r.rebirth] = { credits: r.credits, nova: r.nova == null ? null : r.nova };
  }
  const stages = {};
  for (const r of rows) {
    const key = r.super_rebirth + "-" + r.rebirth;
    if (!stages[key]) stages[key] = { super_rebirth: r.super_rebirth, rebirth: r.rebirth, droids: [] };
    stages[key].droids.push({ droid_name: r.droid_name, droid_color: r.droid_color });
  }
  for (const key in stages) {
    const st = stages[key];
    st.cost = costByRebirth[st.rebirth] || { credits: null, nova: null };
  }

  const superCycles = getDbRows("SELECT value FROM super_rebirth_cycles ORDER BY value").map((r) => r.value);
  const rebirthLevels = getDbRows("SELECT value FROM rebirth_levels ORDER BY value").map((r) => r.value);
  const distinctDroids = new Set(rows.map((r) => r.droid_name));

  const costCurve = {};
  for (const r of getDbRows("SELECT rebirth, credits, nova FROM rebirth_cost ORDER BY rebirth")) {
    costCurve[String(r.rebirth)] = { credits: r.credits, nova: r.nova == null ? null : r.nova };
  }

  sendJson(res, 200, {
    source: {
      db: DB_PATH,
      note: "Live data read from droid_tycoon.db on every request.",
    },
    valid_colors: VALID_COLORS,
    droids_per_stage: 3,
    super_cycle_range: [superCycles[0], superCycles[superCycles.length - 1]],
    rebirth_range: [rebirthLevels[0], rebirthLevels[rebirthLevels.length - 1]],
    totals: {
      super_cycles: superCycles.length,
      rebirths_per_cycle: rebirthLevels.length,
      stages: Object.keys(stages).length,
      droids_total: rows.length,
      distinct_droid_names: distinctDroids.size,
      quarantined_rows: 0,
    },
    stages,
    reference: {
      droids: getDbRows("SELECT name FROM droids ORDER BY name").map((r) => r.name),
      colors: getDbRows("SELECT name FROM colors ORDER BY name").map((r) => r.name),
      ranks: ["Common", "Rare", "Epic", "Legend", "Mythic"],
      super_cycles: superCycles,
      rebirths: rebirthLevels,
    },
    cost_curve: costCurve,
    quarantined: [],
  });
}

function apiRebirth(res) {
  const row = getDbRows(
    "SELECT super_rebirth, rebirth FROM player_stage WHERE id = 1"
  )[0];
  if (!row) {
    return sendJson(res, 500, { error: "Player stage not initialized." });
  }
  // Advance both cycles per the transition rule, persist, and read back the
  // new stage + the droids required there.
  const next = nextStage(row.super_rebirth, row.rebirth);
  db.exec(
    `UPDATE player_stage SET super_rebirth = ${next.super_rebirth}, rebirth = ${next.rebirth} WHERE id = 1`
  );
  const droids = getDbRows(
    `SELECT droid_name, droid_color
       FROM droid_rebirths
      WHERE super_rebirth = ? AND rebirth = ?
      ORDER BY id`,
    [next.super_rebirth, next.rebirth]
  ).map((r) => ({ name: r.droid_name, color: r.droid_color }));

  sendJson(res, 200, {
    super_rebirth: next.super_rebirth,
    rebirth: next.rebirth,
    droids,
  });
}

// ---------- player stats tracker (task t_6e1e7411) ----------
// GET /api/stats  -> the persisted four-variable stat record (seeding a
//   default file on first read so the UI always has something to display).
// POST /api/stats { <field>: <value>, ... }  -> validate + persist the four
//   tracked variables (currentSuperRebirthCycle, currentRebirth,
//   offlineEarningsBhr, currentCredits) and echo the saved record back.
function apiGetStats(res) {
  let stats;
  try {
    stats = loadStats(STAT_FILE);
  } catch (e) {
    // First run (no file yet) or a corrupt/empty file: seed defaults so the
    // UI can populate the inputs, then re-read the persisted defaults.
    if (/not found/.test(e.message) || /valid JSON/.test(e.message)) {
      try {
        initStats(STAT_FILE);
        stats = loadStats(STAT_FILE);
      } catch (e2) {
        return sendJson(res, 500, { error: "Failed to initialize stats: " + e2.message });
      }
    } else {
      return sendJson(res, 500, { error: e.message });
    }
  }
  return sendJson(res, 200, { stats });
}

// ---------- computed statistics view (task t_4b627966) ----------
// GET /api/stats/computed -> the four persisted variables PLUS the derived
// metrics that mirror the spreadsheet's `Main` sheet: the live earning rate
// (b/hr -> cr/min), the per-rebirth dashboard (credits required, ETC in days
// and hours, cumulative Nova), and the cumulative-Nova curve. The cost table
// comes from the live `rebirth_cost` lookup so it always matches the DB.
function apiStatsComputed(res) {
  let stats;
  try {
    stats = loadStats(STAT_FILE);
  } catch (e) {
    if (/not found/.test(e.message) || /valid JSON/.test(e.message)) {
      stats = createDefaultStats();
    } else {
      return sendJson(res, 500, { error: e.message });
    }
  }
  let costRows;
  try {
    costRows = getDbRows(
      "SELECT rebirth, credits, nova FROM rebirth_cost ORDER BY rebirth"
    );
  } catch (e) {
    return sendJson(res, 500, { error: "Failed to read rebirth_cost: " + e.message });
  }
  const costTable = costRows.map((r) => ({
    rebirth: r.rebirth,
    credits: r.credits,
    nova: r.nova == null ? null : r.nova,
  }));
  const ratePerMin = statView.bhrToCreditsPerMin(stats.offlineEarningsBhr);
  const dashboard = statView.buildDashboard(stats, costTable);
  const novaCurve = statView.cumulativeNovaCurve(
    Math.max(stats.currentRebirth, costTable.length ? costTable[costTable.length - 1].rebirth : 28)
  );

  // Credits remaining to finish the *current* rebirth cycle: use the cost for
  // the player's current rebirth as the in-cycle target (credits required minus
  // current credits), plus the running total to the final rebirth (27).
  const currentCostRow = costTable.find((r) => r.rebirth === stats.currentRebirth);
  const finalCostRow = costTable.length ? costTable[costTable.length - 1] : null;
  const creditsRemainingCycle = currentCostRow
    ? Math.max(0, currentCostRow.credits - stats.currentCredits)
    : null;
  const creditsRemainingAll = finalCostRow
    ? Math.max(0, finalCostRow.credits - stats.currentCredits)
    : null;

  // Measured credits/min (from the snapshot log) for the player's current RB
  // cycle, used as a more accurate ETA basis once enough snapshots exist.
  let measured = null;
  let measuredLogCount = 0;
  try {
    const log = statLog.loadLog(LOG_FILE);
    measuredLogCount = log.length;
    measured = statLog.computeMeasuredRates(log, {
      currentSr: stats.currentSuperRebirthCycle,
      currentRb: stats.currentRebirth,
      kind: "rb",
    }).rb.current;
  } catch (e) {
    if (!( /not found/.test(e.message) || /valid JSON/.test(e.message))) {
      // Non-recoverable; surface it rather than silently returning partial data.
      return sendJson(res, 500, { error: "Failed to read stat log: " + e.message });
    }
  }

  return sendJson(res, 200, {
    stats,
    ratePerMin,
    dashboard,
    nova_curve: novaCurve,
    cycle_remaining: {
      currentRebirth: stats.currentRebirth,
      creditsRequiredForCurrentRebirth: currentCostRow ? currentCostRow.credits : null,
      creditsRemainingForCurrentRebirth: creditsRemainingCycle,
      creditsRequiredFinal: finalCostRow ? finalCostRow.credits : null,
      creditsRemainingFinal: creditsRemainingAll,
      etMinCycleProjected:
        ratePerMin > 0 && creditsRemainingCycle != null
          ? creditsRemainingCycle / ratePerMin
          : null,
      etMinCycleMeasured:
        measured && measured.creditsPerMin && measured.creditsPerMin > 0 && creditsRemainingCycle != null
          ? creditsRemainingCycle / measured.creditsPerMin
          : null,
    },
    measured: {
      logCount: measuredLogCount,
      minSnapshots: statLog.MIN_SNAPSHOTS,
      rbCurrent: measured,
    },
  });
}

async function apiSaveStats(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  if (!body || typeof body !== "object") {
    return sendJson(res, 400, { error: "Request body must be a JSON object." });
  }
  // Only accept known fields; ignore anything else to avoid schema drift.
  const candidate = {};
  for (const f of FIELD_NAMES) {
    if (Object.prototype.hasOwnProperty.call(body, f)) candidate[f] = body[f];
  }
  // Validate types/bounds BEFORE touching disk, coercing numeric strings
  // into real numbers (HTML <input> values arrive as strings) so the saved
  // record is always fully typed. Per-field errors are collected so the UI
  // can surface exactly what the user got wrong.
  const errors = [];
  for (const f of Object.keys(candidate)) {
    const spec = FIELDS[f];
    let v = candidate[f];
    if (spec.type === "integer") {
      if (typeof v === "string" && /^-?\d+$/.test(v)) v = parseInt(v, 10);
      if (typeof v !== "number" || !Number.isInteger(v)) {
        errors.push(`${f} must be an integer, got ${JSON.stringify(candidate[f])}`);
        continue;
      }
      if (v < spec.min) { errors.push(`${f} must be >= ${spec.min}, got ${v}`); continue; }
      candidate[f] = v; // persist the coerced integer
    } else {
      if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) v = Number(v);
      if (typeof v !== "number" || !Number.isFinite(v)) {
        errors.push(`${f} must be a finite number, got ${JSON.stringify(candidate[f])}`);
        continue;
      }
      if (v < spec.min) { errors.push(`${f} must be >= ${spec.min}, got ${v}`); continue; }
      candidate[f] = v; // persist the coerced number
    }
  }
  if (errors.length) {
    return sendJson(res, 400, { error: errors.join("; "), errors });
  }
  try {
    // Merge onto the currently persisted record (falling back to defaults
    // on first run) so a partial update never wipes the other three fields.
    // stat_tracking.saveStats merges over defaults, not disk — so we load
    // first and merge the validated candidate on top ourselves.
    let current;
    try {
      current = loadStats(STAT_FILE);
    } catch (e) {
      if (/not found/.test(e.message) || /valid JSON/.test(e.message)) {
        current = createDefaultStats();
      } else {
        throw e;
      }
    }
    const merged = { ...current, ...candidate };
    const saved = saveStats(merged, STAT_FILE);
    return sendJson(res, 200, { stats: saved });
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
}

// ---------- snapshot log + measured rates (this task) ----------
// POST /api/stats/snapshot  { currentSuperRebirthCycle, currentRebirth,
//   currentCredits, currentUpgradeTokens }  -> append a timestamped snapshot
//   to the log (seeding an empty log on first write) and return the saved row.
async function apiSaveSnapshot(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  if (!body || typeof body !== "object") {
    return sendJson(res, 400, { error: "Request body must be a JSON object." });
  }
  // Reuse stat_tracking validation for the shared four cycle/credit fields.
  const candidate = {};
  for (const f of ["currentSuperRebirthCycle", "currentRebirth", "currentCredits", "currentUpgradeTokens"]) {
    if (Object.prototype.hasOwnProperty.call(body, f)) candidate[f] = body[f];
  }
  const errors = [];
  for (const f of Object.keys(candidate)) {
    const spec = FIELDS[f];
    let v = candidate[f];
    if (spec.type === "integer") {
      if (typeof v === "string" && /^-?\d+$/.test(v)) v = parseInt(v, 10);
      if (typeof v !== "number" || !Number.isInteger(v) || v < spec.min) {
        errors.push(`${f} must be an integer >= ${spec.min}, got ${JSON.stringify(candidate[f])}`);
        continue;
      }
      candidate[f] = v;
    } else {
      if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) v = Number(v);
      if (typeof v !== "number" || !Number.isFinite(v) || v < spec.min) {
        errors.push(`${f} must be a number >= ${spec.min}, got ${JSON.stringify(candidate[f])}`);
        continue;
      }
      candidate[f] = v;
    }
  }
  if (errors.length) {
    return sendJson(res, 400, { error: errors.join("; "), errors });
  }
  try {
    const log = statLog.appendSnapshot(candidate, LOG_FILE);
    const saved = log[log.length - 1];
    return sendJson(res, 200, { snapshot: saved, count: log.length });
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
}

// GET /api/stats/log  -> the full (newest-last) snapshot history.
function apiGetLog(res) {
  let log;
  try {
    log = statLog.loadLog(LOG_FILE);
  } catch (e) {
    if (/not found/.test(e.message) || /valid JSON/.test(e.message)) log = [];
    else return sendJson(res, 500, { error: e.message });
  }
  return sendJson(res, 200, { log, count: log.length, minSnapshots: statLog.MIN_SNAPSHOTS });
}

// DELETE /api/stats/log  -> wipe the snapshot history (and the on-disk file).
function apiClearLog(res) {
  try {
    if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE);
    return sendJson(res, 200, { cleared: true });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
}

// GET /api/stats/measured  -> the *measured* average credits/min and tokens/min
// for the player's current SR cycle and (SR, RB) cycle, computed from the
// snapshot log. Returns `null` rates until >= 2 snapshots exist for a cycle
// (mirrors the request: "once enough data ... at least two").
function apiGetMeasured(res) {
  let stats;
  try {
    stats = loadStats(STAT_FILE);
  } catch (e) {
    if (/not found/.test(e.message) || /valid JSON/.test(e.message)) stats = createDefaultStats();
    else return sendJson(res, 500, { error: e.message });
  }
  let log;
  try {
    log = statLog.loadLog(LOG_FILE);
  } catch (e) {
    if (/not found/.test(e.message) || /valid JSON/.test(e.message)) log = [];
    else return sendJson(res, 500, { error: e.message });
  }
  const measured = statLog.computeMeasuredRates(log, {
    currentSr: stats.currentSuperRebirthCycle,
    currentRb: stats.currentRebirth,
    kind: "both",
  });
  return sendJson(res, 200, {
    stats,
    logCount: log.length,
    minSnapshots: statLog.MIN_SNAPSHOTS,
    measured,
  });
}

// ---------- admin (edit rebirth cycles) ----------
// Read a JSON request body (small payloads only).
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// GET /api/admin/stage?super_rebirth=&rebirth=  -> the 3 droids for that stage.
function apiAdminGetStage(query, res) {
  const sr = query.get("super_rebirth");
  const rb = query.get("rebirth");
  if (sr === null || rb === null || !/^\d+$/.test(sr) || !/^\d+$/.test(rb)) {
    return sendJson(res, 400, {
      error: "Both 'super_rebirth' and 'rebirth' are required numeric filters.",
    });
  }
  const superRebirth = parseInt(sr, 10);
  const rebirth = parseInt(rb, 10);
  const rows = getDbRows(
    `SELECT id, droid_name, droid_color
       FROM droid_rebirths
      WHERE super_rebirth = ? AND rebirth = ?
      ORDER BY id`,
    [superRebirth, rebirth]
  );
  sendJson(res, 200, {
    super_rebirth: superRebirth,
    rebirth: rebirth,
    droids: rows.map((r) => ({ id: r.id, name: r.droid_name, color: r.droid_color })),
  });
}

// POST /api/admin/stage  { super_rebirth, rebirth, droids:[{name,color},...] }
// Replaces the required-droid rows for one stage. This is the "edit rebirth
// cycles" admin capability. Runs in a transaction so a stage is never left
// half-updated.
async function apiAdminSaveStage(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  const sr = body.super_rebirth;
  const rb = body.rebirth;
  const droids = body.droids;
  if (!Number.isInteger(sr) || !Number.isInteger(rb)) {
    return sendJson(res, 400, {
      error: "'super_rebirth' and 'rebirth' must be integers.",
    });
  }
  if (!Array.isArray(droids)) {
    return sendJson(res, 400, { error: "'droids' must be an array." });
  }
  for (const d of droids) {
    if (!d || typeof d.name !== "string" || typeof d.color !== "string" ||
        !d.name.trim() || !d.color.trim()) {
      return sendJson(res, 400, {
        error: "Each droid needs a non-empty 'name' and 'color'.",
      });
    }
  }
  try {
    db.exec("BEGIN");
    db.prepare("DELETE FROM droid_rebirths WHERE super_rebirth = ? AND rebirth = ?").run(sr, rb);
    const ins = db.prepare(
      `INSERT INTO droid_rebirths (super_rebirth, rebirth, droid_name, droid_color)
       VALUES (?, ?, ?, ?)`
    );
    for (const d of droids) {
      ins.run(sr, rb, d.name.trim(), d.color.trim());
      // Keep the reference lists in sync so new names/colors show up everywhere.
      db.prepare("INSERT OR IGNORE INTO droids (name) VALUES (?)").run(d.name.trim());
      db.prepare("INSERT OR IGNORE INTO colors (name) VALUES (?)").run(d.color.trim());
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch (_) {}
    return sendJson(res, 500, { error: "Save failed: " + e.message });
  }
  const rows = getDbRows(
    `SELECT id, droid_name, droid_color FROM droid_rebirths
      WHERE super_rebirth = ? AND rebirth = ? ORDER BY id`,
    [sr, rb]
  );
  sendJson(res, 200, {
    super_rebirth: sr,
    rebirth: rb,
    saved: rows.length,
    droids: rows.map((r) => ({ id: r.id, name: r.droid_name, color: r.droid_color })),
  });
}

// ---------- admin (edit rebirth credit cost) ----------
// Per-rebirth credit cost lives in the `rebirth_cost` table (rebirth PK,
// credits, nova). These endpoints let an admin read and update the credits
// (and nova) required for any rebirth *level*; the new values are read LIVE
// on the next request everywhere else (stage detail, stat ETA, etc.) so the
// change is immediately enforced in-game.

// Auth is enforced via the shared requireAdmin()/ADMIN_KEY defined earlier
// (env DROID_TYCOON_ADMIN_KEY). PUT/POST write to the config store behind it.

// GET /api/admin/rebirth-cost  -> the full cost table (rebirth, credits, nova),
// sorted by rebirth, so the admin editor can populate its level dropdown.
function apiAdminGetCost(res) {
  const rows = getDbRows(
    "SELECT rebirth, credits, nova FROM rebirth_cost ORDER BY rebirth"
  );
  sendJson(res, 200, {
    admin_required: !!ADMIN_KEY,
    cost: rows.map((r) => ({
      rebirth: r.rebirth,
      credits: r.credits,
      nova: r.nova == null ? null : r.nova,
    })),
  });
}

// POST /api/admin/rebirth-cost  { rebirth, credits, nova? }
// Upserts the credit (and optional nova) cost for one rebirth level. Runs in
// a transaction so the config store is never left half-updated. credits is
// required (>= 0); nova is optional (omit/null to leave it unchanged or clear
// it). The rebirth level must already exist in the table.
async function apiAdminSaveCost(req, res) {
  if (!requireAdmin(req, res)) return;
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  const rb = body.rebirth;
  const credits = body.credits;
  if (!Number.isInteger(rb) || rb < 0) {
    return sendJson(res, 400, { error: "'rebirth' must be an integer >= 0." });
  }
  // Coerce numeric strings (HTML <input> values arrive as strings).
  let creditsVal = credits;
  if (typeof creditsVal === "string" && /^-?\d+(\.\d+)?$/.test(creditsVal)) {
    creditsVal = Number(creditsVal);
  }
  if (typeof creditsVal !== "number" || !Number.isFinite(creditsVal) || creditsVal < 0) {
    return sendJson(res, 400, { error: "'credits' must be a number >= 0." });
  }
  let novaVal = body.nova;
  if (novaVal !== undefined && novaVal !== null) {
    if (typeof novaVal === "string" && /^-?\d+(\.\d+)?$/.test(novaVal)) {
      novaVal = Number(novaVal);
    }
    if (typeof novaVal !== "number" || !Number.isFinite(novaVal) || novaVal < 0) {
      return sendJson(res, 400, { error: "'nova' must be a number >= 0 (or omitted)." });
    }
  }
  // The level must already exist; we edit config, we don't create levels.
  const exists = getDbRows("SELECT 1 FROM rebirth_cost WHERE rebirth = ?", [rb]);
  if (!exists.length) {
    return sendJson(res, 400, { error: `No rebirth_cost row for level ${rb}.` });
  }
  try {
    db.exec("BEGIN");
    if (novaVal === undefined) {
      // Leave nova untouched.
      db.prepare(
        "UPDATE rebirth_cost SET credits = ? WHERE rebirth = ?"
      ).run(creditsVal, rb);
    } else {
      db.prepare(
        "UPDATE rebirth_cost SET credits = ?, nova = ? WHERE rebirth = ?"
      ).run(creditsVal, novaVal, rb);
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch (_) {}
    return sendJson(res, 500, { error: "Save failed: " + e.message });
  }
  const row = getDbRows(
    "SELECT rebirth, credits, nova FROM rebirth_cost WHERE rebirth = ?",
    [rb]
  )[0];
  sendJson(res, 200, {
    super_rebirth: null,
    rebirth: row.rebirth,
    credits: row.credits,
    nova: row.nova == null ? null : row.nova,
    saved: true,
  });
}

// POST /api/admin/set-stage  { super_rebirth, rebirth }
// Manually set the player's current stage (admin override of the counter).
async function apiAdminSetPlayerStage(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  const sr = body.super_rebirth;
  const rb = body.rebirth;
  if (!Number.isInteger(sr) || !Number.isInteger(rb) || sr < 1 || rb < 1) {
    return sendJson(res, 400, {
      error: "'super_rebirth' and 'rebirth' must be positive integers.",
    });
  }
  db.prepare("UPDATE player_stage SET super_rebirth = ?, rebirth = ? WHERE id = 1").run(sr, rb);
  return apiState(res);
}

// ---------- admin: upgrade chips per rebirth tier (task t_68b3a8b4) ----------
// GET /api/admin/chips?super_rebirth=&rebirth=
//   Returns the upgrade-chip total for one (SR, RB) stage. A 404 with a
//   `chips: null` hint is returned when no value has been set yet, so the UI
//   can show an empty editor instead of failing.
function apiAdminGetChips(query, res) {
  const sr = query.get("super_rebirth");
  const rb = query.get("rebirth");
  if (sr === null || rb === null || !/^\d+$/.test(sr) || !/^\d+$/.test(rb)) {
    return sendJson(res, 400, {
      error: "Both 'super_rebirth' and 'rebirth' are required numeric filters.",
    });
  }
  const superRebirth = parseInt(sr, 10);
  const rebirth = parseInt(rb, 10);
  const row = getDbRows(
    `SELECT chips FROM rebirth_upgrade_chips
      WHERE super_rebirth = ? AND rebirth = ?`,
    [superRebirth, rebirth]
  )[0];
  return sendJson(res, 200, {
    super_rebirth: superRebirth,
    rebirth: rebirth,
    chips: row ? row.chips : null,
    exists: !!row,
  });
}

// POST /api/admin/chips  { super_rebirth, rebirth, chips }
//   Validate and persist the upgrade-chip total for one (SR, RB) stage. The
//   chip count is a non-negative number (the in-game resource is a running
//   total, so negatives are rejected). Runs in a transaction for atomicity.
async function apiAdminSaveChips(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  const sr = body.super_rebirth;
  const rb = body.rebirth;
  let chips = body.chips;
  if (!Number.isInteger(sr) || !Number.isInteger(rb) || sr < 1 || rb < 1) {
    return sendJson(res, 400, {
      error: "'super_rebirth' and 'rebirth' must be positive integers.",
    });
  }
  // Coerce numeric-string payloads (HTML <input> values arrive as strings).
  if (typeof chips === "string" && /^-?\d*\.?\d+$/.test(chips)) chips = Number(chips);
  if (typeof chips !== "number" || !Number.isFinite(chips)) {
    return sendJson(res, 400, {
      error: "'chips' must be a finite number, got " + JSON.stringify(body.chips),
    });
  }
  if (chips < 0) {
    return sendJson(res, 400, { error: "'chips' must be >= 0." });
  }
  try {
    db.prepare(
      `INSERT INTO rebirth_upgrade_chips (super_rebirth, rebirth, chips)
       VALUES (?, ?, ?)
       ON CONFLICT(super_rebirth, rebirth) DO UPDATE SET chips = excluded.chips`
    ).run(sr, rb, chips);
  } catch (e) {
    return sendJson(res, 500, { error: "Save failed: " + e.message });
  }
  const row = getDbRows(
    `SELECT chips FROM rebirth_upgrade_chips
      WHERE super_rebirth = ? AND rebirth = ?`,
    [sr, rb]
  )[0];
  return sendJson(res, 200, {
    super_rebirth: sr,
    rebirth: rb,
    chips: row ? row.chips : chips,
    saved: true,
  });
}

// ---------- router ----------
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (u.pathname === "/api/filters") return apiFilters(res);
  if (u.pathname === "/api/droids") return apiDroids(u.searchParams, res);
  if (u.pathname === "/api/state") return apiState(res);
  if (u.pathname === "/api/stages") return apiStages(res);
  if (u.pathname === "/api/rebirth" && req.method === "POST") return apiRebirth(res);
  if (u.pathname === "/api/admin/stage" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    return apiAdminGetStage(u.searchParams, res);
  }
  if (u.pathname === "/api/admin/stage" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    return apiAdminSaveStage(req, res);
  }
  if (u.pathname === "/api/admin/set-stage" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    return apiAdminSetPlayerStage(req, res);
  }
  if (u.pathname === "/api/admin/chips" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    return apiAdminGetChips(u.searchParams, res);
  }
  if (u.pathname === "/api/admin/chips" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    return apiAdminSaveChips(req, res);
  }
  if (u.pathname === "/api/admin/rebirth-cost" && req.method === "GET") {
    return apiAdminGetCost(res);
  }
  if (u.pathname === "/api/admin/rebirth-cost" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    return apiAdminSaveCost(req, res);
  }
  if (u.pathname === "/api/droid-cycle") return apiDroidCycle(u.searchParams, res);
  if (u.pathname === "/api/droid-necessity") return apiDroidNecessity(u.searchParams, res);
  if (u.pathname === "/api/stats" && req.method === "GET") return apiGetStats(res);
  if (u.pathname === "/api/stats" && req.method === "POST") return apiSaveStats(req, res);
  if (u.pathname === "/api/stats/computed" && req.method === "GET") return apiStatsComputed(res);
  if (u.pathname === "/api/stats/snapshot" && req.method === "POST") return apiSaveSnapshot(req, res);
  if (u.pathname === "/api/stats/log" && req.method === "GET") return apiGetLog(res);
  if (u.pathname === "/api/stats/log" && req.method === "DELETE") return apiClearLog(res);
  if (u.pathname === "/api/stats/measured" && req.method === "GET") return apiGetMeasured(res);
  if (u.pathname.startsWith("/api/")) {
    return sendJson(res, 404, { error: "Unknown API route" });
  }
  // Serve the DroidTycoon project-root page (task t_d2d5eb61) so the Needed
  // Droids Tracker is reachable same-origin at /droidtycoon instead of file://.
  if (u.pathname === "/droidtycoon" || u.pathname.startsWith("/droidtycoon/")) {
    return serveFromProject(req, res);
  }
  return serveStatic(req, res);
});

// Export the request handler so tests can mount it without binding PORT.
// (Spread the object so the earlier `module.exports.ADMIN_KEY` assignment is
// preserved — a bare `module.exports = {...}` would otherwise drop it.)
module.exports = { handler: server, db, DB_PATH, ADMIN_KEY };

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Droid Tycoon UI running at http://localhost:${PORT}`);
    console.log(`Database: ${DB_PATH}  (read live on every request)`);
  });
}
