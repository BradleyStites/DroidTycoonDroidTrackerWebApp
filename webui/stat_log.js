// stat_log.js
//
// The "measured rate" companion to stat_tracking.js. The original tracker
// only *projected* credits-per-minute from the offline-earnings (b/hr) figure
// the user types in. This module instead *measures* the real rate by keeping a
// log of periodic snapshots (credits + upgrade tokens at a point in time) and
// computing the average change per minute between two snapshots that share the
// same Super Rebirth (SR) cycle or the same (SR, Rebirth) — exactly what the
// spreadsheet's snapshot-log does (Delta / (TimeDeltaDays * 1440)).
//
// Requirements this satisfies (from the original request):
//   - "estimate (once enough data for the current SRB and RB cycles are in;
//      at least two) to calculate average credits per minute"  -> measured
//      credits/min per SR cycle and per RB cycle, requiring >= 2 snapshots.
//   - "input current upgrade tokens to calculate how many of those i'm
//      earning per minute as well"  -> measured tokens/min, same grouping.
//
// Storage format: a JSON array of snapshot rows, one row per "log" action.
// Like stat_tracking.js this module is runtime-agnostic: the pure math helpers
// (groupByCycle, measuredRatesForGroup, computeMeasuredRates) take plain data
// and are fully unit-testable in Node; the fs-backed helpers (initLog,
// loadLog, appendSnapshot) guard themselves when `fs` is unavailable.

"use strict";

const FS_AVAILABLE = typeof require === "function" && hasFsModule();

function hasFsModule() {
  try {
    // eslint-disable-next-line global-require
    require("fs");
    return true;
  } catch (_) {
    return false;
  }
}

const fs = FS_AVAILABLE ? require("fs") : null;
const path = require("path");

/** Default on-disk location for the snapshot log (alongside this module). */
const DEFAULT_LOG_FILE = path.join(__dirname, "droid_tycoon_stat_log.json");

const MIN_SNAPSHOTS = 2; // "at least two" required before a rate is reported.

/**
 * Validate one snapshot row.
 *
 * @param {object} snap
 * @returns {string|null}  null if valid, otherwise a human-readable reason.
 */
function validateSnapshot(snap) {
  if (!snap || typeof snap !== "object" || Array.isArray(snap)) {
    return "snapshot must be an object";
  }
  if (typeof snap.ts !== "number" || !Number.isFinite(snap.ts)) {
    return "snapshot.ts must be a numeric epoch-ms timestamp";
  }
  for (const f of ["currentSuperRebirthCycle", "currentRebirth"]) {
    const v = snap[f];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      return `${f} must be an integer >= 1`;
    }
  }
  for (const f of ["currentCredits", "currentUpgradeTokens"]) {
    const v = snap[f];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return `${f} must be a finite number >= 0`;
    }
  }
  return null;
}

/**
 * Group snapshot rows by cycle.
 *
 * @param {Array<object>} log     snapshot rows
 * @param {"sr"|"rb"}     kind    "sr" -> group by super-rebirth cycle only;
 *                                "rb" -> group by (super-rebirth, rebirth) pair
 * @returns {Map<string, Array<object>>}  groups keyed by cycle identity,
 *          each group sorted ascending by timestamp.
 */
function groupByCycle(log, kind) {
  const groups = new Map();
  for (const snap of log) {
    const key = kind === "sr"
      ? `SR${snap.currentSuperRebirthCycle}`
      : `SR${snap.currentSuperRebirthCycle}-R${snap.currentRebirth}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(snap);
  }
  // Sort each group chronologically so "first" / "last" are meaningful.
  for (const arr of groups.values()) {
    arr.sort((a, b) => a.ts - b.ts);
  }
  return groups;
}

/**
 * Compute the measured rates for a single (already-sorted) group of snapshots.
 *
 * @param {Array<object>} snaps   ascending-by-ts snapshot rows (>= 1)
 * @returns {{
 *   key:string, count:number, enough:boolean,
 *   timeMinutes:number|null,
 *   creditsDelta:number|null, tokensDelta:number|null,
 *   creditsPerMin:number|null, tokensPerMin:number|null,
 *   firstTs:number, lastTs:number,
 *   firstCredits:number, lastCredits:number,
 *   firstTokens:number, lastTokens:number
 * }}
 */
function measuredRatesForGroup(snaps) {
  const first = snaps[0];
  const last = snaps[snaps.length - 1];
  const timeMinutes = (last.ts - first.ts) / 60000;
  const enough = snaps.length >= MIN_SNAPSHOTS && timeMinutes > 0;
  const creditsDelta = last.currentCredits - first.currentCredits;
  const tokensDelta = last.currentUpgradeTokens - first.currentUpgradeTokens;
  // Per-minute rate = delta / minutes. Null until we have enough data.
  const creditsPerMin = enough ? creditsDelta / timeMinutes : null;
  const tokensPerMin = enough ? tokensDelta / timeMinutes : null;
  return {
    count: snaps.length,
    enough,
    timeMinutes: enough ? timeMinutes : null,
    creditsDelta: enough ? creditsDelta : null,
    tokensDelta: enough ? tokensDelta : null,
    creditsPerMin,
    tokensPerMin,
    firstTs: first.ts,
    lastTs: last.ts,
    firstCredits: first.currentCredits,
    lastCredits: last.currentCredits,
    firstTokens: first.currentUpgradeTokens,
    lastTokens: last.currentUpgradeTokens,
  };
}

/**
 * Compute measured credits/min + tokens/min for SR and RB cycles.
 *
 * @param {Array<object>} log                  snapshot rows
 * @param {object}        opts
 * @param {number}        opts.currentSr       player's current SR cycle
 * @param {number}        opts.currentRb       player's current RB
 * @param {"sr"|"rb"|"both"} [opts.kind="both"]
 * @returns {{
 *   sr: { current:object|null, groups:Array<object> },
 *   rb: { current:object|null, groups:Array<object> }
 * }}
 *   `current` is the group matching the player's *current* cycle (the one an
 *   ETA estimate should use); `groups` lists every cycle that has data.
 */
function computeMeasuredRates(log, opts) {
  const currentSr = opts && opts.currentSr;
  const currentRb = opts && opts.currentRb;
  const kind = (opts && opts.kind) || "both";

  function forKind(k) {
    const groupsMap = groupByCycle(log, k);
    const groups = [];
    let current = null;
    for (const [key, snaps] of groupsMap.entries()) {
      const m = measuredRatesForGroup(snaps);
      m.key = key;
      groups.push(m);
      if (k === "sr") {
        if (currentSr != null && key === `SR${currentSr}`) current = m;
      } else {
        if (currentSr != null && currentRb != null &&
            key === `SR${currentSr}-R${currentRb}`) current = m;
      }
    }
    groups.sort((a, b) => b.lastTs - a.lastTs); // most recent cycle first
    return { current, groups };
  }

  const out = {};
  if (kind === "sr" || kind === "both") out.sr = forKind("sr");
  if (kind === "rb" || kind === "both") out.rb = forKind("rb");
  return out;
}

// ---------- fs-backed helpers (Node only) ----------

function initLog(filePath = DEFAULT_LOG_FILE) {
  if (!FS_AVAILABLE) {
    throw new Error("initLog requires the 'fs' module (Node.js), not a browser environment");
  }
  fs.writeFileSync(filePath, JSON.stringify([], null, 2), "utf8");
  return [];
}

function loadLog(filePath = DEFAULT_LOG_FILE) {
  if (!FS_AVAILABLE) {
    throw new Error("loadLog requires the 'fs' module (Node.js), not a browser environment");
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`Stat log not found: ${filePath} (run initLog first)`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    throw new Error(`Stat log is not valid JSON: ${filePath} (${e.message})`);
  }
  if (!Array.isArray(raw)) {
    throw new Error(`Stat log must be a JSON array: ${filePath}`);
  }
  return raw;
}

/**
 * Append a snapshot to the log and persist. The `ts` defaults to Date.now();
 * the rest of the fields are validated. Returns the full log after the append.
 *
 * @param {object} snap   { currentSuperRebirthCycle, currentRebirth,
 *                          currentCredits, currentUpgradeTokens, ts? }
 * @param {string} [filePath]
 * @returns {Array<object>}
 */
function appendSnapshot(snap, filePath = DEFAULT_LOG_FILE) {
  if (!FS_AVAILABLE) {
    throw new Error("appendSnapshot requires the 'fs' module (Node.js), not a browser environment");
  }
  const row = { ...snap };
  if (typeof row.ts !== "number") row.ts = Date.now();
  const reason = validateSnapshot(row);
  if (reason) throw new Error(reason);
  let log = [];
  if (fs.existsSync(filePath)) log = loadLog(filePath);
  log.push(row);
  fs.writeFileSync(filePath, JSON.stringify(log, null, 2), "utf8");
  return log;
}

module.exports = {
  DEFAULT_LOG_FILE,
  MIN_SNAPSHOTS,
  validateSnapshot,
  groupByCycle,
  measuredRatesForGroup,
  computeMeasuredRates,
  initLog,
  loadLog,
  appendSnapshot,
};
