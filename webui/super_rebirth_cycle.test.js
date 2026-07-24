// super_rebirth_cycle.test.js
//
// Self-contained Node test for super_rebirth_cycle.js. No external test
// framework — plain assert() so it runs with `node super_rebirth_cycle.test.js`.
//
// Expected values below were captured directly from webui/droid_tycoon.db
// (322 droid_rebirths rows; player_stage seeded to SR1/R1):
//   A-LT : cycle 1 only -> R3 Base, R6 Diamond
//   LO   : cycle 1 -> R8 Gold, R10 Rainbow ; cycle 2 -> R21 Beskar
//   NOPE : not present anywhere

const assert = require("assert");
const {
  DEFAULT_DB_PATH,
  openDb,
  getCurrentCycle,
  getStageDroids,
  getCycleRequirements,
  droidInCycle,
  withDb,
} = require("./super_rebirth_cycle");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const db = openDb(DEFAULT_DB_PATH);

test("current cycle resolves to SR1/R1 (seed)", () => {
  const c = getCurrentCycle(db);
  assert.strictEqual(c.superRebirth, 1);
  assert.strictEqual(c.rebirth, 1);
});

test("getStageDroids returns the 3 rows of a known stage", () => {
  // We don't know a specific stage's droids generically, but SR1/R1 must have 3.
  const droids = getStageDroids(db, 1, 1);
  assert.strictEqual(droids.length, 3);
  for (const d of droids) {
    assert.strictEqual(typeof d.name, "string");
    assert.strictEqual(typeof d.color, "string");
  }
});

test("A-LT is in current cycle (1) with stages R3,R6 and colors Base,Diamond", () => {
  const r = getCycleRequirements(db, "A-LT");
  assert.strictEqual(r.inCurrentCycle, true);
  assert.strictEqual(r.superRebirth, 1);
  assert.deepStrictEqual(r.stages, [
    { superRebirth: 1, rebirth: 3, color: "Base" },
    { superRebirth: 1, rebirth: 6, color: "Diamond" },
  ]);
  assert.deepStrictEqual(r.colors, ["Base", "Diamond"]);
  // Only appears in cycle 1, so allStages == stages
  assert.deepStrictEqual(r.allStages, r.stages);
  assert.deepStrictEqual(r.allColors, r.colors);
});

test("LO in current cycle (1): R8 Gold, R10 Rainbow", () => {
  const r = getCycleRequirements(db, "LO");
  assert.strictEqual(r.inCurrentCycle, true);
  assert.deepStrictEqual(r.stages, [
    { superRebirth: 1, rebirth: 8, color: "Gold" },
    { superRebirth: 1, rebirth: 10, color: "Rainbow" },
  ]);
  assert.deepStrictEqual(r.colors, ["Gold", "Rainbow"]);
});

test("LO across all cycles includes cycle 2 (R21 Beskar)", () => {
  const r = getCycleRequirements(db, "LO");
  const cycle2 = r.allStages.filter((s) => s.superRebirth === 2);
  assert.deepStrictEqual(cycle2, [
    { superRebirth: 2, rebirth: 21, color: "Beskar" },
  ]);
  assert.ok(r.allColors.includes("Beskar"));
});

test("LO queried against explicit cycle 2 is in that cycle", () => {
  const r = getCycleRequirements(db, "LO", 2);
  assert.strictEqual(r.inCurrentCycle, true);
  assert.strictEqual(r.superRebirth, 2);
  assert.deepStrictEqual(r.stages, [
    { superRebirth: 2, rebirth: 21, color: "Beskar" },
  ]);
  assert.deepStrictEqual(r.colors, ["Beskar"]);
});

test("non-existent droid returns empty, inCurrentCycle=false", () => {
  const r = getCycleRequirements(db, "NOPE");
  assert.strictEqual(r.inCurrentCycle, false);
  assert.deepStrictEqual(r.stages, []);
  assert.deepStrictEqual(r.colors, []);
  assert.deepStrictEqual(r.allStages, []);
  assert.deepStrictEqual(r.allColors, []);
});

test("lookup is case-insensitive on the droid id", () => {
  const r1 = getCycleRequirements(db, "a-lt");
  const r2 = getCycleRequirements(db, "A-LT");
  assert.deepStrictEqual(r1.stages, r2.stages);
});

test("droidInCycle probes membership per cycle", () => {
  assert.strictEqual(droidInCycle(db, "A-LT", 1), true);
  assert.strictEqual(droidInCycle(db, "A-LT", 2), false);
  assert.strictEqual(droidInCycle(db, "LO", 1), true);
  assert.strictEqual(droidInCycle(db, "LO", 2), true);
});

test("withDb() factory binds the database", () => {
  const api = withDb(DEFAULT_DB_PATH);
  const r = api.getCycleRequirements("A-LT");
  assert.strictEqual(r.inCurrentCycle, true);
  assert.strictEqual(typeof api.db.close, "function");
});

test("invalid cycle throws a clear error", () => {
  assert.throws(() => getCycleRequirements(db, "LO", 9), /no data/);
  assert.throws(() => getCycleRequirements(db, "LO", 0), /Invalid super rebirth cycle/);
});

test("empty droidId throws", () => {
  assert.throws(() => getCycleRequirements(db, "   "), /non-empty string/);
});

db.close();

console.log(`\nAll ${passed} tests passed.`);
