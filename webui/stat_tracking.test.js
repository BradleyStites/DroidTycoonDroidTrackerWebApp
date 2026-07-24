// stat_tracking.test.js
//
// Self-contained Node test for stat_tracking.js. No external test framework —
// plain assert() so it runs with `node stat_tracking.test.js`.
//
// Covers the task acceptance criteria:
//   1. schema is defined (FIELD_NAMES / FIELDS / createDefaultStats)
//   2. storage can be initialized (initStats writes a default file)
//   3. the four variables can be saved and loaded (round-trip via a temp file)

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  DEFAULT_STAT_FILE,
  FIELD_NAMES,
  FIELDS,
  createDefaultStats,
  validateField,
  validateStats,
  toStats,
  initStats,
  loadStats,
  saveStats,
} = require("./stat_tracking");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// Use a temp file so we never touch the real DEFAULT_STAT_FILE / repo state.
const tmpFile = path.join(os.tmpdir(), `droid_tycoon_stats_test_${process.pid}.json`);
function cleanup() {
  try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
}

try {
  // --- Schema is defined -------------------------------------------------
  test("schema defines exactly the five required fields in column order", () => {
    assert.deepStrictEqual(FIELD_NAMES, [
      "currentSuperRebirthCycle",
      "currentRebirth",
      "offlineEarningsBhr",
      "currentCredits",
      "currentUpgradeTokens",
    ]);
    assert.strictEqual(Object.keys(FIELDS).length, 5);
    assert.strictEqual(FIELDS.currentSuperRebirthCycle.type, "integer");
    assert.strictEqual(FIELDS.currentRebirth.type, "integer");
    assert.strictEqual(FIELDS.offlineEarningsBhr.type, "number");
    assert.strictEqual(FIELDS.currentCredits.type, "number");
    assert.strictEqual(FIELDS.currentUpgradeTokens.type, "number");
  });

  test("createDefaultStats returns a valid default record (SR1/R1, 0/0/0)", () => {
    const d = createDefaultStats();
    assert.deepStrictEqual(d, {
      currentSuperRebirthCycle: 1,
      currentRebirth: 1,
      offlineEarningsBhr: 0,
      currentCredits: 0,
      currentUpgradeTokens: 0,
    });
    assert.strictEqual(validateStats(d).valid, true);
  });

  // --- Storage can be initialized ---------------------------------------
  test("initStats writes a default file that loadStats can read back", () => {
    const written = initStats(tmpFile);
    assert.strictEqual(fs.existsSync(tmpFile), true);
    const loaded = loadStats(tmpFile);
    assert.deepStrictEqual(loaded, written);
    assert.deepStrictEqual(loaded, createDefaultStats());
  });

  test("initStats honors integer + numeric overrides", () => {
    const written = initStats(tmpFile, {
      currentSuperRebirthCycle: 3,
      currentRebirth: 12,
      offlineEarningsBhr: 4.5,
      currentCredits: 999.5,
      currentUpgradeTokens: 7,
    });
    const loaded = loadStats(tmpFile);
    assert.deepStrictEqual(loaded, written);
    assert.strictEqual(loaded.currentSuperRebirthCycle, 3);
    assert.strictEqual(loaded.currentRebirth, 12);
    assert.strictEqual(loaded.offlineEarningsBhr, 4.5);
    assert.strictEqual(loaded.currentCredits, 999.5);
    assert.strictEqual(loaded.currentUpgradeTokens, 7);
  });

  // --- The four variables can be saved and loaded (round-trip) ----------
  test("saveStats then loadStats round-trips all five variables", () => {
    const saved = saveStats(
      {
        currentSuperRebirthCycle: 2,
        currentRebirth: 27,
        offlineEarningsBhr: 1.25,
        currentCredits: 123456.78,
        currentUpgradeTokens: 42,
      },
      tmpFile
    );
    const loaded = loadStats(tmpFile);
    assert.deepStrictEqual(loaded, saved);
    assert.strictEqual(loaded.currentSuperRebirthCycle, 2);
    assert.strictEqual(loaded.currentRebirth, 27);
    assert.strictEqual(loaded.offlineEarningsBhr, 1.25);
    assert.strictEqual(loaded.currentCredits, 123456.78);
    assert.strictEqual(loaded.currentUpgradeTokens, 42);
  });

  test("saveStats accepts a partial record and fills defaults from schema", () => {
    // Only update credits + tokens; everything else should keep its default.
    const saved = saveStats({ currentCredits: 50, currentUpgradeTokens: 3 }, tmpFile);
    const loaded = loadStats(tmpFile);
    assert.deepStrictEqual(loaded, {
      currentSuperRebirthCycle: 1,
      currentRebirth: 1,
      offlineEarningsBhr: 0,
      currentCredits: 50,
      currentUpgradeTokens: 3,
    });
    assert.strictEqual(saved.currentCredits, 50);
    assert.strictEqual(saved.currentUpgradeTokens, 3);
  });

  // --- Validation guards the schema -------------------------------------
  test("validateField rejects non-integers and out-of-bounds values", () => {
    assert.notStrictEqual(validateField("currentSuperRebirthCycle", 1.5), null);
    assert.notStrictEqual(validateField("currentSuperRebirthCycle", 0), null);
    assert.notStrictEqual(validateField("currentRebirth", "5"), null);
    assert.notStrictEqual(validateField("offlineEarningsBhr", -1), null);
    assert.strictEqual(validateField("currentCredits", 0), null);
    assert.strictEqual(validateField("currentRebirth", 27), null);
  });

  test("toStats throws on a missing or wrong-typed field", () => {
    assert.throws(() => toStats({ currentRebirth: 1, offlineEarningsBhr: 0, currentCredits: 0 }),
      /currentSuperRebirthCycle/);
    assert.throws(() => toStats({
      currentSuperRebirthCycle: 1, currentRebirth: 1,
      offlineEarningsBhr: 0, currentCredits: "lots",
    }), /currentCredits/);
  });

  test("loadStats throws a clear error when the file is missing", () => {
    const missing = path.join(os.tmpdir(), `droid_tycoon_stats_missing_${process.pid}.json`);
    assert.throws(() => loadStats(missing), /not found/);
  });

  test("loadStats throws when the file violates the schema", () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ currentSuperRebirthCycle: 0 }), "utf8");
    assert.throws(() => loadStats(tmpFile), /currentSuperRebirthCycle/);
  });

  test("DEFAULT_STAT_FILE points next to the module", () => {
    assert.ok(DEFAULT_STAT_FILE.endsWith("droid_tycoon_stats.json"));
    assert.ok(DEFAULT_STAT_FILE.includes("webui"));
  });
} finally {
  cleanup();
}

console.log(`\nAll ${passed} stat-tracking tests passed.`);
