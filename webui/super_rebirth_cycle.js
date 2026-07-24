// super_rebirth_cycle.js
//
// Typed lookup over the LIVE Droid Tycoon rebirth database (droid_tycoon.db).
//
// The database (built by build_db.py) is the single source of truth for the
// project and is read live on every request by server.js. It holds:
//   - player_stage         : the player's current position in the grind,
//                            seeded to (super_rebirth=1, rebirth=1). This IS
//                            the "current super rebirth cycle".
//   - droid_rebirths       : master required-droids table. One row per
//                            (super_rebirth, rebirth, droid_name, droid_color).
//                            Exactly 3 rows share each (super_rebirth, rebirth)
//                            stage key. 322 rows = 324 minus the 2 quarantined
//                            "(Incorrect)" color rows.
//
// This module answers, for ANY droid identifier (name), the three things the
// task asked for:
//   1. inCurrentCycle : boolean — is this droid required anywhere in the
//                        *current* super rebirth cycle?
//   2. stages         : the list of (super_rebirth, rebirth) stages where the
//                        droid is required, within that current cycle.
//   3. colors         : the distinct list of required colors for those stages.
//
// It also exposes the full (per-cycle) requirement list so callers can see
// where else the droid is used.
//
// Schema (documented in REBIRTH_DATA_SCHEMA.md, section "Super Rebirth Cycle
// lookup module"):
//
// CycleRequirement {
//   inCurrentCycle : boolean
//   superRebirth   : number    // the resolved super-cycle (current cycle)
//   stages         : StageRef[]// stages in the current cycle needing the droid
//   colors         : string[]  // distinct colors across those stages
//   allStages      : StageRef[]// stages in ANY cycle needing the droid
//   allColors      : string[]  // distinct colors across all cycles
// }
//
// StageRef {
//   superRebirth : number
//   rebirth      : number
//   color        : string
// }

const { DatabaseSync } = require("node:sqlite");

/**
 * @typedef {Object} StageRef
 * @property {number} superRebirth  Super-rebirth (outer) cycle index, 1-based.
 * @property {number} rebirth       Rebirth (inner) stage index, 1-based.
 * @property {string} color         Required droid color for this stage/requirement.
 */

/**
 * @typedef {Object} CycleRequirement
 * @property {boolean} inCurrentCycle  True if the droid is required in the current super cycle.
 * @property {number}  superRebirth    The super cycle this result was resolved against (the current one).
 * @property {StageRef[]} stages       Stages in the CURRENT cycle that require the droid.
 * @property {string[]} colors         Distinct required colors across `stages`.
 * @property {StageRef[]} allStages    Stages in ANY cycle that require the droid.
 * @property {string[]} allColors      Distinct required colors across `allStages`.
 */

const DEFAULT_DB_PATH = require("path").join(__dirname, "droid_tycoon.db");

/**
 * Open the database, returning a node:sqlite DatabaseSync handle.
 * @param {string} [dbPath]
 * @returns {import("node:sqlite").DatabaseSync}
 */
function openDb(dbPath = DEFAULT_DB_PATH) {
  return new DatabaseSync(dbPath);
}

/**
 * Read the current super-rebirth cycle from the live player_stage table.
 * @param {import("node:sqlite").DatabaseSync} db
 * @returns {{ superRebirth: number, rebirth: number }}
 */
function getCurrentCycle(db) {
  const row = db
    .prepare("SELECT super_rebirth, rebirth FROM player_stage WHERE id = 1")
    .get();
  if (!row) {
    throw new Error("player_stage is not initialized (run build_db.py).");
  }
  return { superRebirth: row.super_rebirth, rebirth: row.rebirth };
}

/**
 * The distinct super-cycle indices that actually appear in droid_rebirths.
 * @param {import("node:sqlite").DatabaseSync} db
 * @returns {number[]}
 */
function availableCycles(db) {
  return db
    .prepare(
      "SELECT DISTINCT super_rebirth FROM droid_rebirths ORDER BY super_rebirth"
    )
    .all()
    .map((r) => r.super_rebirth);
}

/**
 * All droid requirement rows for one stage, ordered by id.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} superRebirth
 * @param {number} rebirth
 * @returns {{ name: string, color: string }[]}
 */
function getStageDroids(db, superRebirth, rebirth) {
  return db
    .prepare(
      `SELECT droid_name, droid_color
         FROM droid_rebirths
        WHERE super_rebirth = ? AND rebirth = ?
        ORDER BY id`
    )
    .all(superRebirth, rebirth)
    .map((r) => ({ name: r.droid_name, color: r.droid_color }));
}

/**
 * Resolve the super cycle to query against.
 *
 * Defaults to the current cycle from player_stage. If an explicit cycle is
 * given it is validated against the cycles that actually exist in the data.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} [cycle]
 * @returns {number}
 */
function resolveCycle(db, cycle) {
  if (cycle === undefined || cycle === null) {
    return getCurrentCycle(db).superRebirth;
  }
  const n = Number(cycle);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid super rebirth cycle: ${cycle}`);
  }
  const present = availableCycles(db);
  if (!present.includes(n)) {
    throw new Error(
      `Super rebirth cycle ${n} has no data. Available: ${present.join(", ")}`
    );
  }
  return n;
}

/**
 * Does the droid appear in the given super cycle at all?
 * (Cheap membership probe — the (super_rebirth, droid_name) index is covered
 * by the droid_rebirths UNIQUE/primary layout.)
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} droidId
 * @param {number} superRebirth
 * @returns {boolean}
 */
function droidInCycle(db, droidId, superRebirth) {
  const row = db
    .prepare(
      `SELECT 1 FROM droid_rebirths
        WHERE super_rebirth = ? AND LOWER(droid_name) = LOWER(?)
        LIMIT 1`
    )
    .get(superRebirth, droidId);
  return row !== undefined;
}

/**
 * All requirement rows for a droid across every cycle.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} droidId
 * @returns {StageRef[]}
 */
function droidAllStages(db, droidId) {
  return db
    .prepare(
      `SELECT super_rebirth, rebirth, droid_color
         FROM droid_rebirths
        WHERE LOWER(droid_name) = LOWER(?)
        ORDER BY super_rebirth, rebirth`
    )
    .all(droidId)
    .map((r) => ({
      superRebirth: r.super_rebirth,
      rebirth: r.rebirth,
      color: r.droid_color,
    }));
}

/**
 * THE PRIMARY FUNCTION.
 *
 * Given a droid identifier (its name), return whether it is used in the
 * current super rebirth cycle, plus the list of required stages and the list
 * of required colors within that cycle.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} droidId                 Droid name (case-insensitive match).
 * @param {number} [cycle]                 Optional explicit super cycle override.
 *                                         Defaults to the current cycle.
 * @returns {CycleRequirement}
 */
function getCycleRequirements(db, droidId, cycle) {
  if (typeof droidId !== "string" || !droidId.trim()) {
    throw new Error("droidId must be a non-empty string.");
  }
  const name = droidId.trim();
  const superRebirth = resolveCycle(db, cycle);

  const allStages = droidAllStages(db, name);
  const inCurrentCycle =
    allStages.length > 0 && allStages.some((s) => s.superRebirth === superRebirth);

  const stages = allStages.filter((s) => s.superRebirth === superRebirth);
  const colors = [...new Set(stages.map((s) => s.color))];
  const allColors = [...new Set(allStages.map((s) => s.color))];

  return {
    inCurrentCycle,
    superRebirth,
    stages,
    colors,
    allStages,
    allColors,
  };
}

/**
 * THE PRIMARY FUNCTION FOR THIS TASK (t_b5c5e75a):
 * "Compute droid necessity for remaining super rebirth cycle."
 *
 * Given a droid identifier AND the player's current position in the grind,
 * return whether that droid is STILL REQUIRED for any REMAINING steps in the
 * CURRENT super rebirth cycle — i.e. stages the player has not yet cleared.
 *
 * This is a PURE function: it takes the cycle's requirement rows as plain data
 * and a current-stage position, so it is trivially unit-testable with mock
 * super-rebirth-cycle data (no database needed). `getDroidNecessity` below is
 * the database-backed wrapper that feeds this pure core.
 *
 * Semantics (within the resolved current super cycle):
 *   - clearedStages  : stages with rebirth <  currentRebirth (already passed)
 *   - currentStage   : the single requirement at rebirth === currentRebirth
 *                      (the stage the player is actively on), or null if the
 *                      droid is not needed there
 *   - remainingStages: stages with rebirth >  currentRebirth (still ahead)
 *   - needed         : true if the droid is required at the current stage OR at
 *                      any remaining (future) stage. In other words, the player
 *                      still has to obtain this droid to finish the cycle.
 *
 * @typedef {Object} NecessityResult
 * @property {boolean} needed            True if still required now or later.
 * @property {number}  superRebirth      The (current) super cycle resolved against.
 * @property {number}  currentRebirth    The player's current inner progress.
 * @property {StageRef|null} currentStage  Requirement at the current stage.
 * @property {StageRef[]} remainingStages Stages ahead that still need the droid.
 * @property {string[]} remainingColors   Distinct colors across remainingStages.
 * @property {StageRef[]} clearedStages   Stages already passed that needed it.
 *
 * @param {string} droidId
 * @param {{ superRebirth: number, rebirth: number }} currentStage
 * @param {{ superRebirth: number, rebirth: number, droidName: string, droidColor: string }[]} cycleRequirements
 *        Requirement rows for the resolved super cycle (one per droid/stage).
 * @returns {NecessityResult}
 */
function computeDroidNecessity(droidId, currentStage, cycleRequirements) {
  if (typeof droidId !== "string" || !droidId.trim()) {
    throw new Error("droidId must be a non-empty string.");
  }
  if (!currentStage || typeof currentStage.superRebirth !== "number" ||
      typeof currentStage.rebirth !== "number") {
    throw new Error("currentStage must be { superRebirth, rebirth }.");
  }
  const id = droidId.trim().toLowerCase();
  const { superRebirth, rebirth: currentR } = currentStage;

  const matches = (cycleRequirements || [])
    .filter(
      (r) =>
        r.superRebirth === superRebirth &&
        (r.droidName || "").toLowerCase() === id
    )
    .map((r) => ({
      superRebirth: r.superRebirth,
      rebirth: r.rebirth,
      color: r.droidColor,
    }));

  const currentStageReq =
    matches.find((m) => m.rebirth === currentR) || null;
  const remainingStages = matches.filter((m) => m.rebirth > currentR);
  const clearedStages = matches.filter((m) => m.rebirth < currentR);
  const needed = currentStageReq !== null || remainingStages.length > 0;

  return {
    needed,
    superRebirth,
    currentRebirth: currentR,
    currentStage: currentStageReq,
    remainingStages,
    remainingColors: [...new Set(remainingStages.map((s) => s.color))],
    clearedStages,
  };
}

/**
 * All requirement rows for one super cycle (the 3 droids × 27 stages).
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} superRebirth
 * @returns {{ superRebirth: number, rebirth: number, droidName: string, droidColor: string }[]}
 */
function getCycleRequirementsForCycle(db, superRebirth) {
  return db
    .prepare(
      `SELECT super_rebirth, rebirth, droid_name, droid_color
         FROM droid_rebirths
        WHERE super_rebirth = ?
        ORDER BY rebirth`
    )
    .all(superRebirth)
    .map((r) => ({
      superRebirth: r.super_rebirth,
      rebirth: r.rebirth,
      droidName: r.droid_name,
      droidColor: r.droid_color,
    }));
}

/**
 * Database-backed wrapper around `computeDroidNecessity`.
 *
 * Resolves the current super cycle from `player_stage` (or an explicit override
 * via opts.currentSuperRebirth / opts.currentRebirth) and answers whether the
 * given droid is still required for any remaining step in that cycle.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} droidId
 * @param {{ currentSuperRebirth?: number, currentRebirth?: number }} [opts]
 * @returns {NecessityResult}
 */
function getDroidNecessity(db, droidId, opts = {}) {
  if (typeof droidId !== "string" || !droidId.trim()) {
    throw new Error("droidId must be a non-empty string.");
  }
  let currentSR, currentR;
  if (
    opts.currentSuperRebirth != null &&
    opts.currentRebirth != null
  ) {
    currentSR = opts.currentSuperRebirth;
    currentR = opts.currentRebirth;
  } else {
    const cur = getCurrentCycle(db);
    currentSR = cur.superRebirth;
    currentR = cur.rebirth;
  }
  const cycleReqs = getCycleRequirementsForCycle(db, currentSR);
  return computeDroidNecessity(
    droidId,
    { superRebirth: currentSR, rebirth: currentR },
    cycleReqs
  );
}

/**
 * Convenience factory: bind a database path and return an API object whose
 * functions take the droidId (and optional cycle) only.
 *
 * @param {string} [dbPath]
 * @returns {{
 *   db: import("node:sqlite").DatabaseSync,
 *   getCurrentCycle: () => { superRebirth: number, rebirth: number },
 *   getStageDroids: (sr: number, rb: number) => { name: string, color: string }[],
 *   getCycleRequirements: (droidId: string, cycle?: number) => CycleRequirement,
 *   getDroidNecessity: (droidId: string, opts?: object) => NecessityResult,
 * }}
 */
function withDb(dbPath = DEFAULT_DB_PATH) {
  const db = openDb(dbPath);
  return {
    db,
    getCurrentCycle: () => getCurrentCycle(db),
    getStageDroids: (sr, rb) => getStageDroids(db, sr, rb),
    getCycleRequirements: (droidId, cycle) =>
      getCycleRequirements(db, droidId, cycle),
    getDroidNecessity: (droidId, opts) => getDroidNecessity(db, droidId, opts),
  };
}

module.exports = {
  DEFAULT_DB_PATH,
  openDb,
  getCurrentCycle,
  availableCycles,
  getStageDroids,
  getCycleRequirements,
  droidInCycle,
  droidAllStages,
  computeDroidNecessity,
  getCycleRequirementsForCycle,
  getDroidNecessity,
  withDb,
};
