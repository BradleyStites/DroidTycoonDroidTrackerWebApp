// droid_necessity.test.js
//
// Tests for the t_b5c5e75a deliverable: "Compute droid necessity for remaining
// super rebirth cycle."
//
// Two layers:
//   1. PURE-logic tests (no DB): computeDroidNecessity against MOCK super
//      rebirth-cycle data. These are the "unit-testable method ... based on mock
//      super rebirth cycle data" the task acceptance calls for.
//   2. DB-backed tests: getDroidNecessity against webui/droid_tycoon.db, with
//      an explicit current-stage override so results are deterministic
//      regardless of the seed state.
//
// Run:  node droid_necessity.test.js

const assert = require("assert");
const {
  DEFAULT_DB_PATH,
  openDb,
  getCurrentCycle,
  getDroidNecessity,
  computeDroidNecessity,
} = require("./super_rebirth_cycle");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// ---------------------------------------------------------------------------
// Mock super-rebirth-cycle data (one super cycle = 27 stages × 3 droids).
// Shape expected by computeDroidNecessity:
//   { superRebirth, rebirth, droidName, droidColor }
// ---------------------------------------------------------------------------
const SR = 1;
const mockCycle = [
  // R3: A-LT (Base), Z9 (Gold), Pit (Base)
  { superRebirth: SR, rebirth: 3, droidName: "A-LT", droidColor: "Base" },
  { superRebirth: SR, rebirth: 3, droidName: "Z9", droidColor: "Gold" },
  { superRebirth: SR, rebirth: 3, droidName: "Pit", droidColor: "Base" },
  // R6: A-LT (Diamond), LO (Base), Pit (Base)
  { superRebirth: SR, rebirth: 6, droidName: "A-LT", droidColor: "Diamond" },
  { superRebirth: SR, rebirth: 6, droidName: "LO", droidColor: "Base" },
  { superRebirth: SR, rebirth: 6, droidName: "Pit", droidColor: "Base" },
  // R10: LO (Rainbow), Z9 (Base)
  { superRebirth: SR, rebirth: 10, droidName: "LO", droidColor: "Rainbow" },
  { superRebirth: SR, rebirth: 10, droidName: "Z9", droidColor: "Base" },
  // R20: Pit (Diamond)
  { superRebirth: SR, rebirth: 20, droidName: "Pit", droidColor: "Diamond" },
];

// ---- 1. PURE-logic tests with mock data --------------------------------

test("pure: droid needed ONLY at a future stage => needed=true, currentStage=null", () => {
  // Player at R1; A-LT appears at R3,R6 (both ahead).
  const r = computeDroidNecessity("A-LT", { superRebirth: SR, rebirth: 1 }, mockCycle);
  assert.strictEqual(r.needed, true);
  assert.strictEqual(r.superRebirth, SR);
  assert.strictEqual(r.currentRebirth, 1);
  assert.strictEqual(r.currentStage, null);
  assert.deepStrictEqual(r.remainingStages, [
    { superRebirth: SR, rebirth: 3, color: "Base" },
    { superRebirth: SR, rebirth: 6, color: "Diamond" },
  ]);
  assert.deepStrictEqual(r.remainingColors, ["Base", "Diamond"]);
  assert.deepStrictEqual(r.clearedStages, []);
});

test("pure: droid needed at the CURRENT stage => needed=true w/ currentStage", () => {
  // Player at R3; A-LT is required right now.
  const r = computeDroidNecessity("A-LT", { superRebirth: SR, rebirth: 3 }, mockCycle);
  assert.strictEqual(r.needed, true);
  assert.deepStrictEqual(r.currentStage, {
    superRebirth: SR,
    rebirth: 3,
    color: "Base",
  });
  // R6 still ahead => still in remainingStages
  assert.deepStrictEqual(r.remainingStages, [
    { superRebirth: SR, rebirth: 6, color: "Diamond" },
  ]);
  assert.deepStrictEqual(r.clearedStages, []);
});

test("pure: droid only at already-cleared stages => needed=false", () => {
  // Player at R7 (past R3,R6). A-LT required only at R3,R6 => all cleared.
  const r = computeDroidNecessity("A-LT", { superRebirth: SR, rebirth: 7 }, mockCycle);
  assert.strictEqual(r.needed, false);
  assert.strictEqual(r.currentStage, null);
  assert.deepStrictEqual(r.remainingStages, []);
  assert.deepStrictEqual(r.remainingColors, []);
  assert.deepStrictEqual(r.clearedStages, [
    { superRebirth: SR, rebirth: 3, color: "Base" },
    { superRebirth: SR, rebirth: 6, color: "Diamond" },
  ]);
});

test("pure: droid NOT in the cycle at all => needed=false, empty", () => {
  const r = computeDroidNecessity("NOPE", { superRebirth: SR, rebirth: 5 }, mockCycle);
  assert.strictEqual(r.needed, false);
  assert.strictEqual(r.currentStage, null);
  assert.deepStrictEqual(r.remainingStages, []);
  assert.deepStrictEqual(r.clearedStages, []);
});

test("pure: droid needed at both current AND future => currentStage + remaining", () => {
  // Player at R10; LO is required now (Rainbow) and (in a fuller cycle) maybe later.
  // In our mock LO is only at R6 (cleared) and R10 (current). So needed via current only.
  const r = computeDroidNecessity("LO", { superRebirth: SR, rebirth: 10 }, mockCycle);
  assert.strictEqual(r.needed, true);
  assert.deepStrictEqual(r.currentStage, {
    superRebirth: SR,
    rebirth: 10,
    color: "Rainbow",
  });
  assert.deepStrictEqual(r.clearedStages, [
    { superRebirth: SR, rebirth: 6, color: "Base" },
  ]);
  assert.deepStrictEqual(r.remainingStages, []);
});

test("pure: case-insensitive droid id", () => {
  const a = computeDroidNecessity("a-lt", { superRebirth: SR, rebirth: 1 }, mockCycle);
  const b = computeDroidNecessity("A-LT", { superRebirth: SR, rebirth: 1 }, mockCycle);
  assert.deepStrictEqual(a.remainingStages, b.remainingStages);
  assert.strictEqual(a.needed, b.needed);
});

test("pure: distinguishes super cycles within the same requirement set", () => {
  const twoCycle = [
    ...mockCycle,
    { superRebirth: 2, rebirth: 5, droidName: "A-LT", droidColor: "Beskar" },
  ];
  // Current stage in cycle 1; A-LT requirement exists in cycle 2 but must be ignored.
  const r = computeDroidNecessity("A-LT", { superRebirth: 1, rebirth: 1 }, twoCycle);
  assert.strictEqual(r.superRebirth, 1);
  assert.deepStrictEqual(r.remainingStages, [
    { superRebirth: 1, rebirth: 3, color: "Base" },
    { superRebirth: 1, rebirth: 6, color: "Diamond" },
  ]);
});

test("pure: empty requirement list => not needed", () => {
  const r = computeDroidNecessity("A-LT", { superRebirth: 1, rebirth: 1 }, []);
  assert.strictEqual(r.needed, false);
});

test("pure: rejects empty / non-string droidId", () => {
  assert.throws(() => computeDroidNecessity("  ", { superRebirth: 1, rebirth: 1 }, mockCycle), /non-empty string/);
  assert.throws(() => computeDroidNecessity(null, { superRebirth: 1, rebirth: 1 }, mockCycle), /non-empty string/);
});

test("pure: rejects malformed currentStage", () => {
  assert.throws(() => computeDroidNecessity("A-LT", { superRebirth: 1 }, mockCycle), /currentStage/);
  assert.throws(() => computeDroidNecessity("A-LT", null, mockCycle), /currentStage/);
});

// ---- 2. DB-backed tests (deterministic via explicit stage override) -----

const db = openDb(DEFAULT_DB_PATH);

// Capture a couple of real droid appearances from the live DB so the assertions
// are grounded in actual data rather than invented values.
const realA = db
  .prepare(
    `SELECT super_rebirth, rebirth, droid_color, droid_name
       FROM droid_rebirths
      WHERE LOWER(droid_name) = LOWER('A-LT')
      ORDER BY super_rebirth, rebirth LIMIT 1`
  )
  .get();

test("db: getDroidNecessity mirrors pure core for an early stage", () => {
  // Player at the very start (R1): A-LT is required later in cycle => needed.
  const r = getDroidNecessity(db, "A-LT", {
    currentSuperRebirth: realA.super_rebirth,
    currentRebirth: 1,
  });
  assert.strictEqual(r.superRebirth, realA.super_rebirth);
  assert.strictEqual(r.needed, true);
  // At least one remaining stage must be the one we sampled.
  const hit = r.remainingStages.some(
    (s) => s.rebirth === realA.rebirth && s.color === realA.droid_color
  );
  assert.ok(hit, "sampled A-LT requirement present in remainingStages");
});

test("db: getDroidNecessity returns needed=false once all stages cleared", () => {
  // Player one stage PAST A-LT's last appearance (max rebirth for that droid).
  const maxR = db
    .prepare(
      `SELECT MAX(rebirth) AS m FROM droid_rebirths
        WHERE LOWER(droid_name) = LOWER('A-LT') AND super_rebirth = ?`
    )
    .get(realA.super_rebirth).m;
  const r = getDroidNecessity(db, "A-LT", {
    currentSuperRebirth: realA.super_rebirth,
    currentRebirth: maxR + 1,
  });
  assert.strictEqual(r.needed, false);
  assert.strictEqual(r.currentStage, null);
  assert.deepStrictEqual(r.remainingStages, []);
});

test("db: getDroidNecessity flags currentStage when on A-LT's exact stage", () => {
  const r = getDroidNecessity(db, "A-LT", {
    currentSuperRebirth: realA.super_rebirth,
    currentRebirth: realA.rebirth,
  });
  assert.strictEqual(r.needed, true);
  assert.deepStrictEqual(r.currentStage, {
    superRebirth: realA.super_rebirth,
    rebirth: realA.rebirth,
    color: realA.droid_color,
  });
});

test("db: getDroidNecessity respects the live player_stage when no override given", () => {
  const cur = getCurrentCycle(db); // seeded SR1/R1
  const r = getDroidNecessity(db, "LO"); // LO appears in cycle 1
  assert.strictEqual(r.superRebirth, cur.superRebirth);
  assert.strictEqual(r.currentRebirth, cur.rebirth);
  assert.strictEqual(r.needed, true);
});

test("db: non-existent droid => needed=false (DB)", () => {
  const r = getDroidNecessity(db, "NOPE-XYZ", {
    currentSuperRebirth: 1,
    currentRebirth: 1,
  });
  assert.strictEqual(r.needed, false);
  assert.deepStrictEqual(r.remainingStages, []);
});

test("db: getDroidNecessity is case-insensitive against the DB", () => {
  const a = getDroidNecessity(db, "a-lt", {
    currentSuperRebirth: realA.super_rebirth,
    currentRebirth: 1,
  });
  const b = getDroidNecessity(db, "A-LT", {
    currentSuperRebirth: realA.super_rebirth,
    currentRebirth: 1,
  });
  assert.deepStrictEqual(a.remainingStages, b.remainingStages);
});

db.close();

console.log(`\nAll ${passed} droid-necessity tests passed.`);
