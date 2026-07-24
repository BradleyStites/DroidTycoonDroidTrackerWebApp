// server_stats.test.js
//
// Self-contained Node test for the /api/stats endpoint added in task
// t_6e1e7411. Spins up server.js on an ephemeral port with the stat file
// redirected to a temp location (DROID_TYCOON_STAT_FILE), so it never writes
// into the repo and never depends on prior state. Exercises the GET + POST
// round-trip for the four tracked variables and verifies type validation
// rejects bad input.
//
// Runs with `node server_stats.test.js` (no external framework; plain assert).

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Redirect the stat file to an isolated temp path BEFORE requiring server.js,
// so every load/save in this test goes to a scratch file, not the repo.
const TMP_STAT = path.join(os.tmpdir(), `droid_tycoon_stats_test_${process.pid}.json`);
process.env.DROID_TYCOON_STAT_FILE = TMP_STAT;

// Disable undici keep-alive for the test so pooled sockets don't emit a
// benign ECONNRESET when the server closes at the end of the run.
try {
  const { setGlobalDispatcher, Agent } = require("undici");
  setGlobalDispatcher(new Agent({ keepSocketAlive: false }));
} catch (_) {
  /* undici not directly requireable in this Node build; ECONNRESET is benign */
}

// Swallow the single benign ECONNRESET that can still surface from an undici
// keep-alive socket being torn down when the server closes. All real
// assertions have already completed by then; this keeps the test exit clean.
process.on("unhandledRejection", (e) => {
  if (e && e.cause && e.cause.code === "ECONNRESET") return;
  console.error("Unhandled rejection:", e);
  process.exitCode = 1;
});

const { handler } = require("./server");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

function cleanup() {
  try { fs.unlinkSync(TMP_STAT); } catch (_) {}
}

function getPort() {
  return new Promise((resolve) => {
    const net = require("net");
    const srv = net.createServer();
    srv.listen(0, () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function api(method, body) {
  const url = `http://127.0.0.1:${PORT}/api/stats`;
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

let server, PORT;

(async () => {
  try {
    PORT = await getPort();
    server = handler;
    await new Promise((resolve) => server.listen(PORT, resolve));

    // --- GET on a fresh/no-file state seeds defaults --------------------
    test("GET /api/stats seeds defaults on first read", async () => {
      const { status, data } = await api("GET");
      assert.strictEqual(status, 200);
      assert.strictEqual(data.stats.currentSuperRebirthCycle, 1);
      assert.strictEqual(data.stats.currentRebirth, 1);
      assert.strictEqual(data.stats.offlineEarningsBhr, 0);
      assert.strictEqual(data.stats.currentCredits, 0);
    });
    await new Promise((r) => setTimeout(r, 50));

    // --- POST then GET round-trips all four variables ------------------
    test("POST then GET persists all four tracked variables", async () => {
      const payload = {
        currentSuperRebirthCycle: 3,
        currentRebirth: 14,
        offlineEarningsBhr: 2.5,
        currentCredits: 987654.32,
      };
      const post = await api("POST", payload);
      assert.strictEqual(post.status, 200, JSON.stringify(post.data));
      const get = await api("GET");
      assert.strictEqual(get.status, 200);
      // Saved values are echoed back with the exact types.
      assert.strictEqual(get.data.stats.currentSuperRebirthCycle, 3);
      assert.strictEqual(get.data.stats.currentRebirth, 14);
      assert.strictEqual(get.data.stats.offlineEarningsBhr, 2.5);
      assert.strictEqual(get.data.stats.currentCredits, 987654.32);
      // Integerness preserved (not coerced to float).
      assert.ok(Number.isInteger(get.data.stats.currentSuperRebirthCycle));
      assert.ok(Number.isInteger(get.data.stats.currentRebirth));
      // And the persisted file on disk holds the same values.
      const onDisk = JSON.parse(fs.readFileSync(TMP_STAT, "utf8"));
      assert.strictEqual(onDisk.currentSuperRebirthCycle, 3);
      assert.strictEqual(onDisk.offlineEarningsBhr, 2.5);
    });
    await new Promise((r) => setTimeout(r, 50));

    // --- Partial POST keeps other fields --------------------------------
    test("partial POST updates only provided fields", async () => {
      const post = await api("POST", { currentCredits: 100 });
      assert.strictEqual(post.status, 200);
      assert.strictEqual(post.data.stats.currentCredits, 100);
      // The earlier integer values survive a partial update.
      assert.strictEqual(post.data.stats.currentSuperRebirthCycle, 3);
      assert.strictEqual(post.data.stats.currentRebirth, 14);
    });
    await new Promise((r) => setTimeout(r, 50));

    // --- Validation: rejects non-integer cycles/rebirths ---------------
    test("POST rejects non-integer cycle/rebirth", async () => {
      const bad = await api("POST", { currentSuperRebirthCycle: 1.5 });
      assert.strictEqual(bad.status, 400);
      assert.ok(/integer/.test(bad.data.error));
    });
    await new Promise((r) => setTimeout(r, 50));

    test("POST rejects out-of-bounds (zero / negative)", async () => {
      const zero = await api("POST", { currentRebirth: 0 });
      assert.strictEqual(zero.status, 400);
      const neg = await api("POST", { offlineEarningsBhr: -5 });
      assert.strictEqual(neg.status, 400);
    });
    await new Promise((r) => setTimeout(r, 50));

    // --- Validation: accepts numeric strings from HTML inputs ----------
    test("POST accepts numeric strings (as the UI sends them)", async () => {
      const post = await api("POST", {
        currentSuperRebirthCycle: "4",
        currentRebirth: "9",
        offlineEarningsBhr: "1.25",
        currentCredits: "5000",
      });
      assert.strictEqual(post.status, 200, JSON.stringify(post.data));
      assert.strictEqual(post.data.stats.currentSuperRebirthCycle, 4);
      assert.strictEqual(post.data.stats.currentRebirth, 9);
      assert.strictEqual(post.data.stats.offlineEarningsBhr, 1.25);
      assert.strictEqual(post.data.stats.currentCredits, 5000);
    });
    await new Promise((r) => setTimeout(r, 50));

    // --- Unknown route still 404s --------------------------------------
    test("unknown /api route still returns 404", async () => {
      // Connection: close so undici doesn't pool an idle keep-alive socket
      // that would otherwise emit an ECONNRESET when the server closes.
      const res = await fetch(`http://127.0.0.1:${PORT}/api/does-not-exist`, {
        headers: { Connection: "close" },
      });
      assert.strictEqual(res.status, 404);
    });

    console.log(`\nAll ${passed} /api/stats server tests passed.`);
  } catch (e) {
    console.error(`\nTest failed: ${e.stack || e}`);
    process.exitCode = 1;
  } finally {
    // Destroy any pooled keep-alive sockets before closing so undici's
    // connection pool doesn't surface a benign ECONNRESET as an
    // unhandledRejection after the server is gone.
    if (server) {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    cleanup();
  }
})();
