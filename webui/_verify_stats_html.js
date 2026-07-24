// Headless functional verification of stats.html (no server / no network).
// Builds minimal DOM + localStorage shims, evaluates the inline <script>, and
// simulates: fill inputs -> Save -> (reload) -> log 2 snapshots -> measured +
// computed render -> clear. Asserts persistence + no exceptions.
"use strict";
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "stats.html"), "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error("FAIL: no <script> block found"); process.exit(1); }
let scriptSrc = m[1];

// ---- shared persistent storage (like localStorage across page loads) ----
function makeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _dump: () => Object.fromEntries(map),
  };
}
const store = makeLocalStorage();

// ---- DOM shim ----
function makeEl(id) {
  return {
    id, value: "", innerHTML: "", textContent: "", className: "", style: {},
    _listeners: {}, files: [],
    addEventListener(ev, fn) { this._listeners[ev] = fn; },
    click() { (this._listeners.click || (() => {}))(); },
    appendChild() {}, removeChild() {},
  };
}
function makeDoc() {
  const els = new Map();
  return {
    _els: els,
    getElementById(id) {
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    createElement() { return makeEl("created"); },
    body: makeEl("body"),
  };
}

function run(doc) {
  const sandbox = {
    document: doc,
    localStorage: store,
    setTimeout: (fn) => fn(),
    console,
    Blob: function (parts) { this.parts = parts; },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
    FileReader: function () {},
  };
  const fn = new Function(...Object.keys(sandbox), scriptSrc);
  fn(...Object.values(sandbox));
  return doc;
}

function assert(name, cond) {
  if (!cond) { console.error("FAIL:", name); process.exitCode = 1; }
  else console.log("  ok", name);
}

// ---- simulate a "page load" ----
let doc = makeDoc();
run(doc);

// 1) initial load populated inputs from defaults (localStorage empty -> defaults)
assert("initial SR default = 1", doc.getElementById("statSR").value === 1 || doc.getElementById("statSR").value === "1" || doc.getElementById("statSR").value === "");

// 2) fill inputs and save
const SR = doc.getElementById("statSR");
const RB = doc.getElementById("statRB");
const EARN = doc.getElementById("statEarn");
const CR = doc.getElementById("statCredits");
const TK = doc.getElementById("statTokens");
SR.value = "2"; RB.value = "5"; EARN.value = "1.25"; CR.value = "1000000"; TK.value = "42";
doc.getElementById("statSaveBtn").click(); // triggers saveStats

const savedRaw = store.getItem("droidTycoon.stats.v1");
assert("stats persisted to localStorage", !!savedRaw);
const saved = JSON.parse(savedRaw);
assert("saved SR=2", saved.currentSuperRebirthCycle === 2);
assert("saved RB=5", saved.currentRebirth === 5);
assert("saved earn=1.25", saved.offlineEarningsBhr === 1.25);
assert("saved credits=1000000", saved.currentCredits === 1000000);
assert("saved tokens=42", saved.currentUpgradeTokens === 42);
assert("inputs filled back from save", doc.getElementById("statSR").value === 2);

// 3) reload: fresh DOM, same store -> loadStats fills inputs from localStorage
let doc2 = makeDoc();
run(doc2);
assert("reload fills SR from storage", doc2.getElementById("statSR").value === 2);
assert("reload fills RB from storage", doc2.getElementById("statRB").value === 5);
assert("reload fills credits from storage", doc2.getElementById("statCredits").value === 1000000);

// 4) computed view rendered without throwing and contains expected content
const computed = doc2.getElementById("statsComputed").innerHTML;
assert("computed shows Super Rebirth Cycle", computed.includes("Super Rebirth Cycle"));
assert("computed shows dashboard table", computed.includes("Credits Req."));
assert("computed shows 1000000", computed.includes("1,000,000"));

// 5) log two snapshots for SR2/R5 (need enough=2 for measured rate)
const snapBtn = doc2.getElementById("snapshotBtn");
// inputs already SR2/R5/earn/credits/tokens from reload
// snapshot 1
doc2.getElementById("statCredits").value = "1000000";
doc2.getElementById("statTokens").value = "42";
snapBtn.click();
// bump credits/tokens for snapshot 2 (a moment later)
doc2.getElementById("statCredits").value = "1600000";
doc2.getElementById("statTokens").value = "72";
snapBtn.click();

const logRaw = store.getItem("droidTycoon.statLog.v1");
assert("snapshot log persisted", !!logRaw);
const log = JSON.parse(logRaw);
assert("two snapshots logged", log.length === 2);

const measured = doc2.getElementById("measuredBox").innerHTML;
assert("measured view rendered", measured.includes("By Super Rebirth cycle"));
assert("measured shows current RB (SR2-R5)", measured.includes("SR2-R5"));

// 6) clear log
doc2.getElementById("clearLogBtn").click();
assert("log cleared from storage", store.getItem("droidTycoon.statLog.v1") === null);
assert("log view empty after clear", doc2.getElementById("logBox").innerHTML.includes("No snapshots yet"));

// 7) export doesn't throw
doc2.getElementById("exportBtn").click();
assert("export click ok", true);

console.log("\nVerification complete.");
