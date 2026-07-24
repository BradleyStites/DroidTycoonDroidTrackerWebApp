// stat_view.test.js
// Self-contained Node test for stat_view.js (no framework, plain assert).
// Run: node stat_view.test.js
"use strict";

const assert = require("assert");
const {
  MINUTES_PER_DAY,
  NOVA_BASE,
  decomposeHMS,
  etaToTarget,
  bhrToCreditsPerMin,
  cumulativeNovaCurve,
  buildDashboard,
  fmtNum,
  renderStatsView,
} = require("./stat_view");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// --- rate conversion (b/hr -> cr/min) ---------------------------------------
test("bhrToCreditsPerMin converts billions-per-hour to credits-per-minute", () => {
  // 1 b/hr = 1e9 / 60 cr/min
  assert.strictEqual(bhrToCreditsPerMin(1), 1e9 / 60);
  // spec anchor: 0.00985 b/hr from the spreadsheet's rate table
  assert.ok(Math.abs(bhrToCreditsPerMin(0.00985) - 164166.6667) < 0.01);
});

// --- H/M/S decomposition (INT + ROUNDDOWN, spec §4) -------------------------
test("decomposeHMS splits minutes into H:M:S", () => {
  const d = decomposeHMS(3673); // 61h 13m
  assert.strictEqual(d.hours, 61);
  assert.strictEqual(d.minutes, 13);
  assert.strictEqual(d.seconds, 0);
  assert.strictEqual(d.hms, "61:13:00");
});
test("decomposeHMS handles fractional seconds", () => {
  const d = decomposeHMS(61.5); // 1h 1m 30s
  assert.strictEqual(d.hours, 1);
  assert.strictEqual(d.minutes, 1);
  assert.strictEqual(d.seconds, 30);
});
test("decomposeHMS guards invalid/negative input", () => {
  assert.strictEqual(decomposeHMS(-1).hms, "—");
  assert.strictEqual(decomposeHMS(NaN).hms, "—");
});

// --- ETA to target (spec §4) ------------------------------------------------
test("etaToTarget computes minutes and H/M/S from current/target/rate", () => {
  // 810 target, 0 current, 0.00985 cr/min -> 82233.5 min expected
  const e = etaToTarget(0, 810, 0.00985);
  assert.ok(Math.abs(e.minutes - 82233.5) < 1);
  assert.strictEqual(e.hms, "1370:33:30");
});
test("etaToTarget returns zero H/M/S when already at/above target", () => {
  const e = etaToTarget(1000, 810, 0.00985);
  assert.strictEqual(e.minutes, 0);
  assert.strictEqual(e.hms, "00:00:00");
});
test("etaToTarget is undefined when rate <= 0", () => {
  const e = etaToTarget(0, 810, 0);
  assert.strictEqual(e.minutes, Infinity);
  assert.strictEqual(e.hms, "—");
});

// --- cumulative Nova curve (spec §5 / §6) -----------------------------------
test("cumulativeNovaCurve seeds 11/16 at rebirths 12/13", () => {
  const c = cumulativeNovaCurve(13);
  assert.deepStrictEqual(c[0], { rebirth: 12, nova: 11, increment: 0 });
  assert.deepStrictEqual(c[1], { rebirth: 13, nova: 16, increment: 5 });
});
test("cumulativeNovaCurve increments by +1 each step (matches DB)", () => {
  const c = cumulativeNovaCurve(20);
  // cross-check against the real cost table values in rebirth_cost
  const last = c[c.length - 1];
  assert.strictEqual(last.rebirth, 20);
  assert.strictEqual(last.nova, 79); // 67 + 11 + 1 ... matches spreadsheet curve
  // monotonic, increment grows by exactly 1 each row
  for (let i = 2; i < c.length; i++) {
    assert.strictEqual(c[i].increment, c[i - 1].increment + 1);
    assert.strictEqual(c[i].nova, c[i - 1].nova + c[i].increment);
  }
});
test("cumulativeNovaCurve returns [] below rebirth 12", () => {
  assert.deepStrictEqual(cumulativeNovaCurve(11), []);
});

// --- dashboard (spec §5, Main sheet rows) -----------------------------------
const SAMPLE_COST = [
  { rebirth: 0, credits: 10000, nova: null },
  { rebirth: 1, credits: 150000, nova: null },
  { rebirth: 12, credits: 3400000000, nova: 11 },
  { rebirth: 19, credits: 810000000000, nova: 67 },
];
test("buildDashboard only includes rebirths >= currentRebirth", () => {
  const stats = { currentSuperRebirthCycle: 3, currentRebirth: 12, offlineEarningsBhr: 0.00985, currentCredits: 0 };
  const rows = buildDashboard(stats, SAMPLE_COST);
  assert.deepStrictEqual(rows.map((r) => r.rebirth), [12, 19]);
});
test("buildDashboard ETC uses credits/rate/1440 (days) and /60 (hours)", () => {
  const stats = { currentSuperRebirthCycle: 3, currentRebirth: 12, offlineEarningsBhr: 0.00985, currentCredits: 0 };
  const rows = buildDashboard(stats, SAMPLE_COST);
  const r12 = rows[0];
  const rate = bhrToCreditsPerMin(0.00985);
  const expMin = (3400000000 - 0) / rate;
  assert.ok(Math.abs(r12.etcDays - expMin / MINUTES_PER_DAY) < 1e-6);
  assert.ok(Math.abs(r12.etcHours - expMin / 60) < 1e-6);
});
test("buildDashboard returns null ETC when rate is zero", () => {
  const stats = { currentSuperRebirthCycle: 3, currentRebirth: 12, offlineEarningsBhr: 0, currentCredits: 0 };
  const rows = buildDashboard(stats, SAMPLE_COST);
  assert.strictEqual(rows[0].etcDays, null);
  assert.strictEqual(rows[0].etcHours, null);
});
test("buildDashboard carries the cumulative Nova reward per row", () => {
  const stats = { currentSuperRebirthCycle: 3, currentRebirth: 12, offlineEarningsBhr: 0.00985, currentCredits: 0 };
  const rows = buildDashboard(stats, SAMPLE_COST);
  assert.strictEqual(rows[0].nova, 11);
  assert.strictEqual(rows[1].nova, 67);
});

// --- render (spec: readable view of current values + computed stats) -------
function sampleStats() {
  return { currentSuperRebirthCycle: 3, currentRebirth: 12, offlineEarningsBhr: 0.00985, currentCredits: 500000 };
}
test("renderStatsView emits current values and the dashboard table", () => {
  const html = renderStatsView(sampleStats(), SAMPLE_COST);
  assert.ok(html.includes("Super Rebirth Cycle"));
  assert.ok(html.includes(">3<")); // current SR value
  assert.ok(html.includes("stats-table"));
  assert.ok(html.includes("Credits Req."));
  assert.ok(html.includes("ETC (days)"));
  assert.ok(html.includes("Nova"));
});
test("renderStatsView shows the derived cr/min rate", () => {
  const html = renderStatsView(sampleStats(), SAMPLE_COST);
  assert.ok(html.includes("cr/min"));
  assert.ok(html.includes("164,166.67")); // 0.00985 b/hr formatted
});
test("renderStatsView handles a missing cost table gracefully", () => {
  const html = renderStatsView(sampleStats(), []);
  assert.ok(html.includes("No upcoming rebirths"));
});

console.log(`\nAll ${passed} stat-view tests passed.`);
