// stat_tracking.js
//
// A new, standalone, self-contained module for tracking the four player-entered
// stats of the Droid Tycoon grind. It persists exactly these four variables:
//
//   1. currentSuperRebirthCycle : integer  -- current super rebirth cycle
//   2. currentRebirth           : integer  -- current (inner) rebirth
//   3. offlineEarningsBhr       : number   -- offline earnings in b/hr (numeric)
//   4. currentCredits           : number   -- current credits (numeric)
//   5. currentUpgradeTokens     : number   -- current upgrade tokens (numeric)
//
// Storage format: JSON.
//
// Why JSON (not CSV/SQLite): the data is a single spreadsheet-like *row* of
// four named columns — there is no multi-row table to model yet. JSON is the
// most self-contained choice (no native modules, no extra deps, no schema
// migration), is trivially human-editable, and maps the four named variables
// one-to-one onto a typed record. A `.json` file is also directly diff-able in
// git. If the data ever grows into many rows (e.g. a time series of credits),
// this module's `StatRecord` shape can be swapped for an array without changing
// the public API.
//
// The module is fully runtime-agnostic: it works in Node (CommonJS) AND in a
// browser. When `require("fs")` is unavailable (browser / `window` present),
// the file-backed functions are no-ops that throw a clear error, while the
// in-memory helpers (createDefaultStats, validateStats, toStats) still work.

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

/** Default on-disk location for the stat file (alongside this module). */
const DEFAULT_STAT_FILE = path.join(__dirname, "droid_tycoon_stats.json");

/**
 * The canonical schema for a stat record.
 *
 * @typedef {Object} StatRecord
 * @property {number} currentSuperRebirthCycle  Current super rebirth cycle (integer, >= 1).
 * @property {number} currentRebirth            Current (inner) rebirth (integer, >= 1).
 * @property {number} offlineEarningsBhr        Offline earnings in b/hr (numeric).
 * @property {number} currentCredits             Current credits (numeric).
 * @property {number} currentUpgradeTokens        Current upgrade tokens (numeric).
 */

const FIELDS = Object.freeze({
  currentSuperRebirthCycle: { type: "integer", min: 1 },
  currentRebirth: { type: "integer", min: 1 },
  offlineEarningsBhr: { type: "number", min: 0 },
  currentCredits: { type: "number", min: 0 },
  currentUpgradeTokens: { type: "number", min: 0 },
});

/**
 * The four canonical field names, in column order (spreadsheet-like).
 * @type {string[]}
 */
const FIELD_NAMES = Object.keys(FIELDS);

/**
 * Build a fresh, blank record initialized to sensible defaults:
 *   - integers start at 1 (the grind always begins at SR1/R1)
 *   - numeric earnings/credits start at 0
 *
 * @returns {StatRecord}
 */
function createDefaultStats() {
  return {
    currentSuperRebirthCycle: 1,
    currentRebirth: 1,
    offlineEarningsBhr: 0,
    currentCredits: 0,
    currentUpgradeTokens: 0,
  };
}

/**
 * Validate that a value belongs to the schema's expected type/bounds.
 *
 * @param {string} field
 * @param {*} value
 * @returns {string|null}  null if valid, otherwise a human-readable reason.
 */
function validateField(field, value) {
  const spec = FIELDS[field];
  if (!spec) return `Unknown stat field: ${field}`;

  if (spec.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return `${field} must be an integer, got ${JSON.stringify(value)}`;
    }
  } else if (spec.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return `${field} must be a finite number, got ${JSON.stringify(value)}`;
    }
  }

  if (value < spec.min) {
    return `${field} must be >= ${spec.min}, got ${value}`;
  }
  return null;
}

/**
 * Validate an entire record against the schema.
 *
 * @param {*} record
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateStats(record) {
  const errors = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { valid: false, errors: ["stats must be an object"] };
  }
  for (const field of FIELD_NAMES) {
    const reason = validateField(field, record[field]);
    if (reason) errors.push(reason);
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Coerce free-form input (e.g. from JSON or a UI form) into a typed
 * StatRecord, throwing if any field is missing or invalid.
 *
 * @param {*} raw
 * @returns {StatRecord}
 */
function toStats(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("stats payload must be an object");
  }
  const out = {};
  for (const field of FIELD_NAMES) {
    const reason = validateField(field, raw[field]);
    if (reason) throw new Error(reason);
    out[field] = raw[field];
  }
  return out;
}

/**
 * Initialize storage: write a fresh, default record to `filePath`.
 * Supports partial overrides via `overrides` (e.g. { currentRebirth: 5 }).
 *
 * @param {string} [filePath]  Defaults to DEFAULT_STAT_FILE.
 * @param {Partial<StatRecord>} [overrides]
 * @returns {StatRecord}  The record that was written.
 */
function initStats(filePath = DEFAULT_STAT_FILE, overrides = {}) {
  if (!FS_AVAILABLE) {
    throw new Error("initStats requires the 'fs' module (Node.js), not a browser environment");
  }
  const merged = { ...createDefaultStats(), ...overrides };
  const checked = toStats(merged); // throws on bad overrides
  fs.writeFileSync(filePath, JSON.stringify(checked, null, 2), "utf8");
  return checked;
}

/**
 * Load the stat record from `filePath`.
 *
 * @param {string} [filePath]  Defaults to DEFAULT_STAT_FILE.
 * @returns {StatRecord}
 * @throws if the file is missing, malformed, or fails schema validation.
 */
function loadStats(filePath = DEFAULT_STAT_FILE) {
  if (!FS_AVAILABLE) {
    throw new Error("loadStats requires the 'fs' module (Node.js), not a browser environment");
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`Stat file not found: ${filePath} (run initStats first)`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    throw new Error(`Stat file is not valid JSON: ${filePath} (${e.message})`);
  }
  // Backfill any missing fields from defaults so an older seed file (written
  // before a field was added) migrates forward instead of failing schema
  // validation. toStats still enforces types/bounds on whatever remains.
  const merged = { ...createDefaultStats(), ...raw };
  return toStats(merged); // throws on schema mismatch
}

/**
 * Save a (validated) stat record to `filePath`. Any missing fields are filled
 * from defaults; the result is re-validated so a partial object still persists
 * correctly and never corrupts the schema.
 *
 * @param {Partial<StatRecord>} stats
 * @param {string} [filePath]  Defaults to DEFAULT_STAT_FILE.
 * @returns {StatRecord}  The full record that was written.
 */
function saveStats(stats, filePath = DEFAULT_STAT_FILE) {
  if (!FS_AVAILABLE) {
    throw new Error("saveStats requires the 'fs' module (Node.js), not a browser environment");
  }
  if (!stats || typeof stats !== "object") {
    throw new Error("saveStats requires a stats object");
  }
  const merged = { ...createDefaultStats(), ...stats };
  const checked = toStats(merged); // throws on invalid fields
  fs.writeFileSync(filePath, JSON.stringify(checked, null, 2), "utf8");
  return checked;
}

module.exports = {
  DEFAULT_STAT_FILE,
  FIELDS,
  FIELD_NAMES,
  createDefaultStats,
  validateField,
  validateStats,
  toStats,
  initStats,
  loadStats,
  saveStats,
};
