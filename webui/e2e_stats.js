// e2e_stats.js — live verification of the new stat-tracking endpoints.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_STAT = path.join(os.tmpdir(), `e2e_stats_${process.pid}.json`);
const TMP_LOG = path.join(os.tmpdir(), `e2e_log_${process.pid}.json`);
process.env.DROID_TYCOON_STAT_FILE = TMP_STAT;
process.env.DROID_TYCOON_STAT_LOG = TMP_LOG;
try {
  const { setGlobalDispatcher, Agent } = require("undici");
  setGlobalDispatcher(new Agent({ keepSocketAlive: false }));
} catch (_) {}

const { handler } = require("./server");

function getPort() {
  return new Promise((resolve) => {
    const net = require("net");
    const srv = net.createServer();
    srv.listen(0, () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
async function call(method, urlPath, body) {
  const url = `http://127.0.0.1:${PORT}${urlPath}`;
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const r = await fetch(url, opts);
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}
let PORT, server, passed = 0;
function ok(name, cond, extra) { if (!cond) { console.error("FAIL:", name, extra || ""); process.exitCode = 1; } else { passed++; console.log("  ok", name); } }

(async () => {
  try {
    PORT = await getPort();
    server = handler;
    await new Promise((r) => server.listen(PORT, r));

    // 1. Save stats including upgrade tokens.
    const s = await call("POST", "/api/stats", {
      currentSuperRebirthCycle: 2, currentRebirth: 5,
      offlineEarningsBhr: 1.25, currentCredits: 0, currentUpgradeTokens: 0,
    });
    ok("POST /api/stats persists tokens", s.status === 200 && s.data.stats.currentUpgradeTokens === 0, s.data);

    // 2. Log two snapshots for SR2/R5 (the endpoint stamps ts = now()).
    const snap1 = { currentSuperRebirthCycle: 2, currentRebirth: 5, currentCredits: 100000, currentUpgradeTokens: 10 };
    const snap2 = { currentSuperRebirthCycle: 2, currentRebirth: 5, currentCredits: 100000 + 600000, currentUpgradeTokens: 10 + 30 };
    const p1 = await call("POST", "/api/stats/snapshot", snap1);
    const p2 = await call("POST", "/api/stats/snapshot", snap2);
    ok("POST /api/stats/snapshot x2", p1.status === 200 && p2.status === 200, p1.data);

    // 3. Log snapshot validation rejects bad input.
    const bad = await call("POST", "/api/stats/snapshot", { currentSuperRebirthCycle: 0 });
    ok("snapshot rejects bad cycle", bad.status === 400, bad.data);

    // 4. GET /api/stats/log shows 2 entries.
    const log = await call("GET", "/api/stats/log");
    ok("GET /api/stats/log count=2", log.status === 200 && log.data.count === 2, log.data);

    // 5. GET /api/stats/measured — current RB (2,5): both snapshots logged,
    //    enough=true, and the deltas are correct (rate timing is real elapsed
    //    time, which we don't assert here — that's covered deterministically
    //    in stat_log.test.js).
    const m = await call("GET", "/api/stats/measured");
    ok("GET /api/stats/measured ok", m.status === 200, m.data);
    const rbCur = m.data.measured.rb.current;
    ok("measured RB current selected", rbCur && rbCur.key === "SR2-R5", rbCur);
    ok("measured enough=true with 2 snapshots", rbCur && rbCur.enough === true, rbCur);
    ok("measured creditsDelta correct", rbCur && rbCur.creditsDelta === 600000, rbCur);
    ok("measured tokensDelta correct", rbCur && rbCur.tokensDelta === 30, rbCur);

    // 6. GET /api/stats/computed includes cycle_remaining + measured.
    const c = await call("GET", "/api/stats/computed");
    ok("GET /api/stats/computed ok", c.status === 200, c.data);
    ok("computed has cycle_remaining", !!c.data.cycle_remaining, c.data.cycle_remaining);
    ok("computed has measured.rbCurrent", !!(c.data.measured && c.data.measured.rbCurrent), c.data.measured);
    ok("computed creditsRemainingFinal present", c.data.cycle_remaining.creditsRemainingFinal != null, c.data.cycle_remaining);

    // 7. DELETE /api/stats/log clears history.
    const del = await call("DELETE", "/api/stats/log");
    const log2 = await call("GET", "/api/stats/log");
    ok("DELETE clears log", del.status === 200 && log2.data.count === 0, { del: del.data, log2: log2.data });

    // 8. stats.html is served.
    const page = await fetch(`http://127.0.0.1:${PORT}/stats.html`);
    ok("GET /stats.html served", page.status === 200 && (await page.text()).includes("Stat Tracking"), page.status);

    console.log(`\nAll ${passed} e2e checks passed.`);
  } catch (e) {
    console.error("E2E error:", e.stack || e);
    process.exitCode = 1;
  } finally {
    if (server) { if (typeof server.closeAllConnections === "function") server.closeAllConnections(); await new Promise((r) => server.close(r)); }
    try { fs.unlinkSync(TMP_STAT); } catch (_) {}
    try { fs.unlinkSync(TMP_LOG); } catch (_) {}
  }
})();
