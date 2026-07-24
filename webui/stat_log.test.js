// stat_log.test.js
//
// Self-contained Node test for stat_log.js (no framework, plain assert).
// Run: node stat_log.test.js
//
// Covers the measured-rate engine: snapshot validation, cycle grouping, the
// "at least two snapshots" gate, and the measured credits/min + tokens/min
// math for both SR-cycle and (SR,RB)-cycle groupings.

"use strict";

const assert = require("assert");

const {
  MIN_SNAPSHOTS,
  validateSnapshot,
  groupByCycle,
  measuredRatesForGroup,
  computeMeasuredRates,
} = require("./stat_log");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// Helper: build a snapshot with a timestamp `minutesAgo` minutes before now.
let NOW = 1_700_000_000_000; // fixed epoch so math is deterministic
function snap(sr, rb, credits, tokens, minutesAgo) {
  return {
    ts: NOW - minutesAgo * 60000,
    currentSuperRebirthCycle: sr,
    currentRebirth: rb,
    currentCredits: credits,
    currentUpgradeTokens: tokens,
  };
}

// --- snapshot validation --------------------------------------------
test("validateSnapshot accepts a well-formed snapshot", () => {
  assert.strictEqual(validateSnapshot(snap(2, 5, 100, 3, 0)), null);
});
test("validateSnapshot rejects bad timestamps, cycles, and negatives", () => {
  assert.notStrictEqual(validateSnapshot({ ...snap(2, 5, 100, 3, 0), ts: "x" }), null);
  assert.notStrictEqual(validateSnapshot({ ...snap(0, 5, 100, 3, 0) }), null); // sr < 1
  assert.notStrictEqual(validateSnapshot({ ...snap(2, 1.5, 100, 3, 0) }), null); // rb not int
  assert.notStrictEqual(validateSnapshot({ ...snap(2, 5, -1, 3, 0) }), null); // credits < 0
  assert.notStrictEqual(validateSnapshot({ ...snap(2, 5, 100, -1, 0) }), null); // tokens < 0
});

// --- cycle grouping --------------------------------------------------
test("groupByCycle groups by SR and by (SR,RB)", () => {
  const log = [
    snap(2, 5, 100, 0, 50),
    snap(2, 5, 200, 1, 40),
    snap(2, 6, 300, 2, 30),
    snap(3, 1, 10, 0, 20),
  ];
  const sr = groupByCycle(log, "sr");
  assert.strictEqual(sr.size, 2); // SR2, SR3
  assert.deepStrictEqual([...sr.keys()].sort(), ["SR2", "SR3"]);
  const rb = groupByCycle(log, "rb");
  assert.strictEqual(rb.size, 3); // (2,5),(2,6),(3,1)
  assert.deepStrictEqual([...rb.keys()].sort(), ["SR2-R5", "SR2-R6", "SR3-R1"]);
  // groups are sorted ascending by timestamp
  assert.ok(rb.get("SR2-R5")[0].ts < rb.get("SR2-R5")[1].ts);
});

// --- measured rate: the >= 2 snapshot gate ---------------------------
test("measuredRatesForGroup reports null rate with only one snapshot", () => {
  const m = measuredRatesForGroup([snap(2, 5, 100, 1, 0)]);
  assert.strictEqual(m.count, 1);
  assert.strictEqual(m.enough, false);
  assert.strictEqual(m.creditsPerMin, null);
  assert.strictEqual(m.tokensPerMin, null);
});

test("measuredRatesForGroup computes credits/min and tokens/min from delta over minutes", () => {
  // 2 snapshots, 100 minutes apart: credits 0 -> 1000 (=> 10 cr/min),
  // tokens 5 -> 15 (=> 0.1 token/min).
  const m = measuredRatesForGroup([snap(2, 5, 0, 5, 100), snap(2, 5, 1000, 15, 0)]);
  assert.strictEqual(m.enough, true);
  assert.strictEqual(m.timeMinutes, 100);
  assert.strictEqual(m.creditsDelta, 1000);
  assert.strictEqual(m.tokensDelta, 10);
  assert.ok(Math.abs(m.creditsPerMin - 10) < 1e-9);
  assert.ok(Math.abs(m.tokensPerMin - 0.1) < 1e-9);
});

test("measuredRatesForGroup requires positive time between snapshots", () => {
  // same timestamp -> zero minutes -> not enough
  const m = measuredRatesForGroup([snap(2, 5, 0, 0, 0), snap(2, 5, 100, 0, 0)]);
  assert.strictEqual(m.enough, false);
  assert.strictEqual(m.creditsPerMin, null);
});

// --- computeMeasuredRates: current-cycle selection -------------------
test("computeMeasuredRates picks the current SR and RB cycle", () => {
  const log = [
    snap(2, 5, 0, 0, 100),
    snap(2, 5, 1000, 10, 0), // current RB cycle (2,5)
    snap(2, 6, 0, 0, 100),
    snap(2, 6, 500, 5, 0),   // other RB cycle (2,6)
    snap(3, 1, 0, 0, 50),
    snap(3, 1, 200, 2, 0),   // other SR cycle (3,1)
  ];
  const out = computeMeasuredRates(log, { currentSr: 2, currentRb: 5, kind: "both" });
  assert.ok(out.sr.current);
  assert.strictEqual(out.sr.current.key, "SR2");
  assert.ok(out.rb.current);
  assert.strictEqual(out.rb.current.key, "SR2-R5");
  // credits/min for current RB = 1000 / 100 = 10
  assert.ok(Math.abs(out.rb.current.creditsPerMin - 10) < 1e-9);
  assert.ok(Math.abs(out.rb.current.tokensPerMin - 0.1) < 1e-9);
});

test("computeMeasuredRates returns null current when no data for that cycle", () => {
  const log = [snap(2, 5, 0, 0, 100), snap(2, 5, 1000, 10, 0)];
  const out = computeMeasuredRates(log, { currentSr: 9, currentRb: 9, kind: "both" });
  assert.strictEqual(out.sr.current, null);
  assert.strictEqual(out.rb.current, null);
  // but the history still contains the SR2 group
  assert.strictEqual(out.sr.groups.length, 1);
});

test("computeMeasuredRates respects kind filter (sr only)", () => {
  const log = [snap(2, 5, 0, 0, 100), snap(2, 5, 1000, 10, 0)];
  const out = computeMeasuredRates(log, { currentSr: 2, currentRb: 5, kind: "sr" });
  assert.ok(out.sr);
  assert.strictEqual(out.rb, undefined);
});

test("MIN_SNAPSHOTS is 2 (matches the request's 'at least two')", () => {
  assert.strictEqual(MIN_SNAPSHOTS, 2);
});

console.log(`\nAll ${passed} stat-log tests passed.`);
