// admin_rebirth_cost.test.js
//
// Self-contained Node test for the rebirth-credit-cost admin endpoints added
// in task t_51f43099:
//   GET  /api/admin/rebirth-cost  -> full cost table
//   POST /api/admin/rebirth-cost  { rebirth, credits, nova? }  -> upsert cost
//
// Exercises: authenticated round-trip + live enforcement (read elsewhere on
// the next request), input validation, and the admin auth gate (401 when a
// DROID_TYCOON_ADMIN_KEY is set and the X-Admin-Key header is missing/invalid).
//
// The app requires an X-Admin-Key on every admin POST (when no env key is set
// the server generates an ephemeral one that must be supplied). We set a known
// DROID_TYCOON_ADMIN_KEY for this run and send it, exactly as the UI does once
// the operator pastes the key. The DB row touched by the POST test is restored
// at the end so the repo DB is left unchanged.
//
// Runs with `node admin_rebirth_cost.test.js` (no external framework; plain assert).

"use strict";

const assert = require("assert");
const http = require("http");
const path = require("path");

// Pin a known admin key BEFORE requiring server.js (it reads the env at load).
const OPEN_KEY = "open-test-key";
process.env.DROID_TYCOON_ADMIN_KEY = OPEN_KEY;

const { handler, db } = require("./server.js");

// Swallow a benign ECONNRESET from keep-alive sockets torn down at close.
process.on("unhandledRejection", (e) => {
  if (e && e.cause && e.cause.code === "ECONNRESET") return;
  console.error("Unhandled rejection:", e);
  process.exitCode = 1;
});

const base = (port) => `http://127.0.0.1:${port}`;

function req(port, p, method = "GET", body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      `${base(port)}${p}`,
      {
        method,
        headers: Object.assign(
          { "Content-Type": "application/json" },
          data ? { "Content-Length": Buffer.byteLength(data) } : {},
          headers
        ),
      },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => {
          let j = null;
          try {
            j = JSON.parse(out);
          } catch (_) {}
          resolve({ status: res.statusCode, body: out, json: j });
        });
      }
    );
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

const server = handler.listen(0, async () => {
  const port = server.address().port;
  const checks = [];
  const expect = (name, cond, detail) =>
    checks.push({ name, ok: !!cond, detail: detail || "" });

  // Fixture: mutate rebirth level 1; capture original to restore at the end.
  const RB = 1;
  const original = db
    .prepare("SELECT rebirth, credits, nova FROM rebirth_cost WHERE rebirth = ?")
    .get(RB);
  assert.ok(original, "fixture: rebirth_cost row for level 1 must exist");

  // Auth headers helper (mirrors the UI's adminHeaders()).
  const authH = (key) => (key ? { "X-Admin-Key": key } : {});

  try {
    // 1. GET returns the full table, sorted, with admin_required flag.
    const g = await req(port, "/api/admin/rebirth-cost");
    expect("GET cost HTTP 200", g.status === 200, "status=" + g.status);
    expect("GET cost is array", Array.isArray(g.json && g.json.cost), JSON.stringify(g.json));
    expect(
      "GET cost has 28 rows (levels 0-27)",
      g.json && g.json.cost && g.json.cost.length === 28,
      "len=" + (g.json && g.json.cost && g.json.cost.length)
    );
    expect(
      "GET cost first row rebirth=0",
      g.json && g.json.cost && g.json.cost[0].rebirth === 0,
      JSON.stringify(g.json && g.json.cost && g.json.cost[0])
    );
    expect(
      "GET cost admin_required=true (key set)",
      g.json && g.json.admin_required === true,
      "admin_required=" + (g.json && g.json.admin_required)
    );

    // 2. POST a new credit cost for level 1 (with the admin key) -> 200 + persisted.
    const NEW_CREDITS = 123456;
    const p = await req(port, "/api/admin/rebirth-cost", "POST",
      { rebirth: RB, credits: NEW_CREDITS }, authH(OPEN_KEY));
    expect("POST cost HTTP 200", p.status === 200, "status=" + p.status + " body=" + p.body);
    expect("POST cost echoes rebirth", p.json && p.json.rebirth === RB, JSON.stringify(p.json));
    expect(
      "POST cost echoes new credits",
      p.json && p.json.credits === NEW_CREDITS,
      "credits=" + (p.json && p.json.credits)
    );

    // 3. Live enforcement: a fresh GET sees the updated value (no caching).
    const g2 = await req(port, "/api/admin/rebirth-cost");
    const row = g2.json.cost.find((c) => c.rebirth === RB);
    expect(
      "POST cost persisted + live (no cache)",
      row && row.credits === NEW_CREDITS,
      "credits=" + (row && row.credits)
    );

    // 4. Nova is optional: a POST with nova updates it too.
    const p2 = await req(port, "/api/admin/rebirth-cost", "POST",
      { rebirth: RB, credits: NEW_CREDITS + 1, nova: 42 }, authH(OPEN_KEY));
    expect("POST cost with nova HTTP 200", p2.status === 200, "status=" + p2.status);
    expect(
      "POST cost with nova persisted",
      p2.json && p2.json.credits === NEW_CREDITS + 1 && p2.json.nova === 42,
      JSON.stringify(p2.json)
    );

    // 5. Missing credits -> 400.
    const bad1 = await req(port, "/api/admin/rebirth-cost", "POST",
      { rebirth: RB }, authH(OPEN_KEY));
    expect("POST cost missing credits -> 400", bad1.status === 400, "status=" + bad1.status);

    // 6. Negative credits -> 400.
    const bad2 = await req(port, "/api/admin/rebirth-cost", "POST",
      { rebirth: RB, credits: -5 }, authH(OPEN_KEY));
    expect("POST cost negative credits -> 400", bad2.status === 400, "status=" + bad2.status);

    // 7. Non-existent rebirth level -> 400.
    const bad3 = await req(port, "/api/admin/rebirth-cost", "POST",
      { rebirth: 999, credits: 10 }, authH(OPEN_KEY));
    expect("POST cost unknown level -> 400", bad3.status === 400, "status=" + bad3.status);

    // 8. GET (not POST) does not mutate.
    const before = db.prepare("SELECT credits FROM rebirth_cost WHERE rebirth = ?").get(RB).credits;
    await req(port, "/api/admin/rebirth-cost");
    const after = db.prepare("SELECT credits FROM rebirth_cost WHERE rebirth = ?").get(RB).credits;
    expect("GET /api/admin/rebirth-cost does not mutate", before === after, `${before} vs ${after}`);
  } catch (e) {
    console.error("Test threw:", e);
    checks.push({ name: "no exception", ok: false, detail: String(e) });
  } finally {
    // Restore the touched row so the repo DB is left as we found it.
    if (original) {
      db.prepare("UPDATE rebirth_cost SET credits = ?, nova = ? WHERE rebirth = ?").run(
        original.credits,
        original.nova,
        RB
      );
    }
  }

  // ---- auth gate: launch a fresh server instance with a DIFFERENT key ----
  try {
    const GATE_KEY = "gate-test-key";
    const out = require("child_process").execFileSync(
      process.execPath,
      [
        "-e",
        `process.env.DROID_TYCOON_ADMIN_KEY = ${JSON.stringify(GATE_KEY)};
         const { handler } = require(${JSON.stringify(path.join(__dirname, "server.js"))});
         const http = require("http");
         const s = handler.listen(0, () => {
           const base = "http://127.0.0.1:" + s.address().port;
           const post = (headers) => new Promise((res) => {
             const r = http.request(base + "/api/admin/rebirth-cost", { method: "POST", headers: Object.assign({"Content-Type":"application/json"}, headers) }, (x) => {
               let b=""; x.on("data",c=>b+=c); x.on("end",()=>res({status:x.statusCode, body:b}));
             });
             r.write(JSON.stringify({ rebirth: 1, credits: 1 })); r.end();
           });
           const get = () => new Promise((res) => {
             http.get(base + "/api/admin/rebirth-cost", (x) => { let b=""; x.on("data",c=>b+=c); x.on("end",()=>res({status:x.statusCode, body:b})); });
           });
           (async () => {
             const noKey = await post({});
             const wrongKey = await post({ "X-Admin-Key": "nope" });
             const okKey = await post({ "X-Admin-Key": ${JSON.stringify(GATE_KEY)} });
             const getOk = await get();
             process.stdout.write(JSON.stringify({ noKey: noKey.status, wrongKey: wrongKey.status, okKey: okKey.status, getOk: getOk.status }));
             s.close();
           })();
         });`,
      ],
      { encoding: "utf8" }
    );
    const auth = JSON.parse(out);
    expect("auth: POST without key -> 401", auth.noKey === 401, "status=" + auth.noKey);
    expect("auth: POST wrong key -> 401", auth.wrongKey === 401, "status=" + auth.wrongKey);
    expect("auth: POST correct key -> 200", auth.okKey === 200, "status=" + auth.okKey);
    expect("auth: GET allowed without key", auth.getOk === 200, "status=" + auth.getOk);
  } catch (e) {
    expect("auth gate subprocess ran", false, String(e));
  } finally {
    // The gate subprocess's successful POST set rebirth 1 credits=1; restore.
    db.prepare("UPDATE rebirth_cost SET credits = ?, nova = ? WHERE rebirth = ?").run(
      original ? original.credits : 150000,
      original ? original.nova : null,
      RB
    );
  }

  // ---- report ----
  let pass = 0;
  for (const c of checks) {
    console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : "  -> " + c.detail}`);
    if (c.ok) pass++;
  }
  console.log(`\n${pass}/${checks.length} checks passed`);
  db.close();
  server.close();
  process.exit(pass === checks.length ? 0 : 1);
});
