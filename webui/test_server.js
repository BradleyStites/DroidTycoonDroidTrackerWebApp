// Self-contained smoke test for the Droid Tycoon server.
// Spins the handler on an ephemeral port, exercises the API + static routes,
// then exits. No long-lived process, so it runs cleanly in a single shell call.

const http = require("http");
const { handler, db, ADMIN_KEY } = require("./server.js");

const server = handler.listen(0, async () => {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const get = (path) =>
    new Promise((resolve) => {
      http.get(base + path, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }).on("error", (e) => resolve({ status: 0, body: String(e) }));
    });

  const post = (path) =>
    new Promise((resolve) => {
      const req = http.request(base + path, { method: "POST" }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      req.on("error", (e) => resolve({ status: 0, body: String(e) }));
      req.end();
    });

  // GET with the admin key header (the admin panel requires X-Admin-Key).
  const getAuth = (path) =>
    new Promise((resolve) => {
      const req = http.request(
        base + path,
        { method: "GET", headers: { "X-Admin-Key": ADMIN_KEY } },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        }
      );
      req.on("error", (e) => resolve({ status: 0, body: String(e) }));
      req.end();
    });

  // POST JSON with the admin key header.
  const postJsonAuth = (path, obj) =>
    new Promise((resolve) => {
      const payload = JSON.stringify(obj);
      const req = http.request(
        base + path,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
            "X-Admin-Key": ADMIN_KEY,
          },
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        }
      );
      req.on("error", (e) => resolve({ status: 0, body: String(e) }));
      req.write(payload);
      req.end();
    });

  const checks = [];
  const expect = (name, cond, detail) => checks.push({ name, ok: !!cond, detail });

  // 1. filters endpoint
  const f = await get("/api/filters");
  const fj = JSON.parse(f.body);
  expect("filters HTTP 200", f.status === 200);
  expect("filters has 4 super cycles", JSON.stringify(fj.super_rebirth_cycles) === "[1,2,3,4]", JSON.stringify(fj.super_rebirth_cycles));
  expect("filters has 27 rebirth levels", fj.rebirth_levels.length === 27, "len=" + fj.rebirth_levels.length);
  expect("filters has 65 droids", fj.droids.length === 65, "len=" + fj.droids.length);
  expect("filters exposes canonical valid_colors", Array.isArray(fj.valid_colors), JSON.stringify(fj.valid_colors));
  expect(
    "valid_colors excludes erroneous Galactic + includes Base",
    Array.isArray(fj.valid_colors) &&
      !fj.valid_colors.includes("Galactic") &&
      fj.valid_colors.includes("Base") &&
      fj.valid_colors.includes("Beskar"),
    JSON.stringify(fj.valid_colors)
  );

  // 2. exact search: SR1 R1 -> 3 droids
  const d1 = await get("/api/droids?super_rebirth=1&rebirth=1");
  const d1j = JSON.parse(d1.body);
  expect("SR1 R1 -> 3 droids", d1.status === 200 && d1j.count === 3, "count=" + d1j.count);

  // 3. SR4 R27 -> 3 droids (ceiling stage)
  const d2 = await get("/api/droids?super_rebirth=4&rebirth=27");
  const d2j = JSON.parse(d2.body);
  expect("SR4 R27 -> 3 droids", d2.status === 200 && d2j.count === 3, "count=" + d2j.count);

  // 4. SR2 R15 -> 3 droids
  const d3 = await get("/api/droids?super_rebirth=2&rebirth=15");
  const d3j = JSON.parse(d3.body);
  expect("SR2 R15 -> 3 droids", d3.status === 200 && d3j.count === 3, "count=" + d3j.count);

  // 5. missing rebirth param -> 400
  const e1 = await get("/api/droids?super_rebirth=2");
  expect("missing rebirth -> 400", e1.status === 400, "status=" + e1.status);

  // 6. non-numeric input -> 400
  const e2 = await get("/api/droids?super_rebirth=abc&rebirth=1");
  expect("non-numeric super -> 400", e2.status === 400, "status=" + e2.status);

  // 7. index.html served with the ported search component
  const idx = await get("/");
  const hasSelects =
    idx.body.includes('id="superRebirth"') &&
    idx.body.includes('id="rebirth"') &&
    idx.body.includes('id="searchBtn"') &&
    idx.body.includes("Search droids by cycle");
  expect("index.html HTTP 200 + search component", idx.status === 200 && hasSelects, "status=" + idx.status);

  // 8. live DB edit reflected on next request (no caching)
  db.exec("UPDATE droid_rebirths SET droid_name = 'TEST-DROID-X' WHERE super_rebirth=1 AND rebirth=1 AND droid_name='Pit'");
  const dEdit = await get("/api/droids?super_rebirth=1&rebirth=1");
  const dEditJ = JSON.parse(dEdit.body);
  const sawEdit = dEditJ.droids.some((d) => d.name === "TEST-DROID-X");
  expect("live DB edit reflected (no cache)", sawEdit);
  db.exec("UPDATE droid_rebirths SET droid_name = 'Pit' WHERE droid_name='TEST-DROID-X'"); // restore

  // 9. /api/state returns the seeded stage (SR1, R1) with 3 droids
  const st0 = await get("/api/state");
  const st0j = JSON.parse(st0.body);
  expect("state HTTP 200 + seeded SR1/R1", st0.status === 200 && st0j.super_rebirth === 1 && st0j.rebirth === 1, JSON.stringify(st0j));
  expect("state has 3 droids at SR1/R1", st0j.droids && st0j.droids.length === 3, "count=" + (st0j.droids || []).length);

  // 10. POST /api/rebirth advances the inner cycle (SR1/R1 -> SR1/R2)
  const rb1 = await post("/api/rebirth");
  const rb1j = JSON.parse(rb1.body);
  expect("rebirth -> SR1/R2", rb1.status === 200 && rb1j.super_rebirth === 1 && rb1j.rebirth === 2, JSON.stringify(rb1j));
  const st1 = await get("/api/state");
  const st1j = JSON.parse(st1.body);
  expect("state persisted SR1/R2", st1j.super_rebirth === 1 && st1j.rebirth === 2, JSON.stringify(st1j));

  // 11. super-rebirth rollover: set to SR2/R27, rebirth -> SR3/R1
  db.exec("UPDATE player_stage SET super_rebirth = 2, rebirth = 27 WHERE id = 1");
  const rb2 = await post("/api/rebirth");
  const rb2j = JSON.parse(rb2.body);
  expect("rebirth at R27 rolls to next super: SR3/R1", rb2.status === 200 && rb2j.super_rebirth === 3 && rb2j.rebirth === 1, JSON.stringify(rb2j));

  // 12. GET (not POST) /api/rebirth is rejected (405-like) and does NOT mutate
  const before = await get("/api/state");
  const getRebirth = await get("/api/rebirth");
  const after = await get("/api/state");
  const beforeJ = JSON.parse(before.body), afterJ = JSON.parse(after.body);
  expect("GET /api/rebirth does not advance", getRebirth.status !== 200 || (beforeJ.rebirth === afterJ.rebirth && beforeJ.super_rebirth === afterJ.super_rebirth), JSON.stringify({beforeJ, afterJ, status: getRebirth.status}));

  // restore the real player state (SR1/R1) so the app opens at the start
  db.exec("UPDATE player_stage SET super_rebirth = 1, rebirth = 1 WHERE id = 1");

  // ---- task t_50383390: droid → current-cycle usage API ----
  // 13. A droid used in the current cycle (SR1) returns usage + stages + colors.
  const cyc1 = await get("/api/droid-cycle?droid=A-LT");
  const cyc1j = JSON.parse(cyc1.body);
  expect("droid-cycle A-LT HTTP 200 + in_current_cycle", cyc1.status === 200 && cyc1j.in_current_cycle === true, JSON.stringify(cyc1j));
  expect("droid-cycle A-LT has stages", Array.isArray(cyc1j.stages) && cyc1j.stages.length === 2, "stages=" + JSON.stringify(cyc1j.stages));
  expect("droid-cycle A-LT colors Base,Diamond", JSON.stringify(cyc1j.colors) === '["Base","Diamond"]', JSON.stringify(cyc1j.colors));
  expect("droid-cycle A-LT reports super_rebirth=1", cyc1j.super_rebirth === 1, "sr=" + cyc1j.super_rebirth);

  // 14. A droid NOT used in the current cycle returns in_current_cycle=false.
  const cyc2 = await get("/api/droid-cycle?droid=NOPE");
  const cyc2j = JSON.parse(cyc2.body);
  expect("droid-cycle NOPE HTTP 200 + not in cycle", cyc2.status === 200 && cyc2j.in_current_cycle === false, JSON.stringify(cyc2j));
  expect("droid-cycle NOPE has empty stages", Array.isArray(cyc2j.stages) && cyc2j.stages.length === 0, JSON.stringify(cyc2j.stages));

  // 15. Lookup is case-insensitive (a-lt == A-LT).
  const cyc3 = await get("/api/droid-cycle?droid=a-lt");
  const cyc3j = JSON.parse(cyc3.body);
  expect("droid-cycle case-insensitive a-lt", cyc3.status === 200 && cyc3j.in_current_cycle === true, JSON.stringify(cyc3j));

  // 16. Missing droid param -> 400.
  const cyc4 = await get("/api/droid-cycle");
  expect("droid-cycle missing param -> 400", cyc4.status === 400, "status=" + cyc4.status);

  // 17. index.html includes the cycle-usage panel that consumes droid:selected.
  const idx2 = await get("/");
  const hasPanel =
    idx2.body.includes('id="cyclePanel"') &&
    idx2.body.includes('id="cyclePanelBody"') &&
    idx2.body.includes("/api/droid-cycle") &&
    idx2.body.includes('"droid:selected"');
  expect("index.html has cycle-usage panel + droid-cycle wiring", idx2.status === 200 && hasPanel, "status=" + idx2.status);


  // ---- task t_b5c5e75a: droid necessity for remaining cycle (API) ----
  // 18. A droid needed later in the current cycle => needed=true + remaining stages.
  const nec1 = await get("/api/droid-necessity?droid=A-LT&super_rebirth=1&rebirth=1");
  const nec1j = JSON.parse(nec1.body);
  expect("droid-necessity A-LT (early) HTTP 200 + needed", nec1.status === 200 && nec1j.needed === true, JSON.stringify(nec1j));
  expect("droid-necessity A-LT has remaining_stages", Array.isArray(nec1j.remaining_stages) && nec1j.remaining_stages.length > 0, "remaining=" + JSON.stringify(nec1j.remaining_stages));
  expect("droid-necessity A-LT current_stage null at R1", nec1j.current_stage === null, JSON.stringify(nec1j.current_stage));

  // 19. A droid whose last stage is already cleared => needed=false.
  const necA = await get("/api/droid-necessity?droid=A-LT&super_rebirth=1&rebirth=1");
  const necAj = JSON.parse(necA.body);
  // find max rebirth for A-LT in cycle 1, then probe one past it
  const maxR = necAj.remaining_stages.map((s) => s.rebirth).concat(necAj.cleared_stages.map((s) => s.rebirth)).reduce((a, b) => Math.max(a, b), 0);
  const nec2 = await get(`/api/droid-necessity?droid=A-LT&super_rebirth=1&rebirth=${maxR + 1}`);
  const nec2j = JSON.parse(nec2.body);
  expect("droid-necessity A-LT (past last stage) needed=false", nec2.status === 200 && nec2j.needed === false, JSON.stringify(nec2j));
  expect("droid-necessity A-LT (past) empty remaining", Array.isArray(nec2j.remaining_stages) && nec2j.remaining_stages.length === 0, JSON.stringify(nec2j.remaining_stages));

  // 20. Missing droid param => 400.
  const nec3 = await get("/api/droid-necessity");
  expect("droid-necessity missing param -> 400", nec3.status === 400, "status=" + nec3.status);

  // 21. Non-existent droid => needed=false.
  const nec4 = await get("/api/droid-necessity?droid=NOPE-XYZ&super_rebirth=1&rebirth=1");
  const nec4j = JSON.parse(nec4.body);
  expect("droid-necessity NOPE needed=false", nec4.status === 200 && nec4j.needed === false, JSON.stringify(nec4j));

  // ---- task t_68b3a8b4: admin edit of upgrade chips per rebirth ----
  // 22. Filters now expose the per-(SR,RB) upgrade-chip targets.
  const fChips = await get("/api/filters");
  const fChipsJ = JSON.parse(fChips.body);
  expect("filters has upgrade_chips array", Array.isArray(fChipsJ.upgrade_chips), JSON.stringify(fChipsJ.upgrade_chips));
  expect("filters upgrade_chips seeded (>=1)", fChipsJ.upgrade_chips.length >= 1, "len=" + fChipsJ.upgrade_chips.length);

  // 23. GET /api/admin/chips (with admin key) returns a seeded value for an existing stage (SR4/R19).
  const gc1 = await getAuth("/api/admin/chips?super_rebirth=4&rebirth=19");
  const gc1j = JSON.parse(gc1.body);
  expect("GET chips SR4/R19 HTTP 200 + exists", gc1.status === 200 && gc1j.exists === true && gc1j.chips === 19940, JSON.stringify(gc1j));

  // 24. GET /api/admin/chips for a stage with no value -> exists=false, chips=null.
  const gc2 = await getAuth("/api/admin/chips?super_rebirth=1&rebirth=1");
  const gc2j = JSON.parse(gc2.body);
  expect("GET chips SR1/R1 empty (exists=false)", gc2.status === 200 && gc2j.exists === false && gc2j.chips === null, JSON.stringify(gc2j));

  // 25. GET /api/admin/chips WITHOUT the admin key -> 401 (auth enforced).
  const gc3 = await get("/api/admin/chips?super_rebirth=4&rebirth=19");
  expect("GET chips without key -> 401", gc3.status === 401, "status=" + gc3.status);

  // 26. POST /api/admin/chips sets a value for an empty stage, then GET reads it back.
  const pc1 = await postJsonAuth("/api/admin/chips", { super_rebirth: 1, rebirth: 1, chips: 9999 });
  const pc1j = JSON.parse(pc1.body);
  expect("POST chips SR1/R1 HTTP 200 + saved", pc1.status === 200 && pc1j.saved === true && pc1j.chips === 9999, JSON.stringify(pc1j));
  const gc4 = await getAuth("/api/admin/chips?super_rebirth=1&rebirth=1");
  const gc4j = JSON.parse(gc4.body);
  expect("GET chips reflects just-saved 9999", gc4.status === 200 && gc4j.exists === true && gc4j.chips === 9999, JSON.stringify(gc4j));

  // 27. POST /api/admin/chips updates (upsert) the same stage to a new value.
  const pc2 = await postJsonAuth("/api/admin/chips", { super_rebirth: 1, rebirth: 1, chips: 12345 });
  const pc2j = JSON.parse(pc2.body);
  expect("POST chips upsert SR1/R1 -> 12345", pc2.status === 200 && pc2j.chips === 12345, JSON.stringify(pc2j));

  // 28. POST /api/admin/chips rejects a negative chip count -> 400 (even with auth).
  const pc3 = await postJsonAuth("/api/admin/chips", { super_rebirth: 1, rebirth: 2, chips: -5 });
  expect("POST chips negative -> 400", pc3.status === 400, "status=" + pc3.status);

  // 29. POST /api/admin/chips rejects a non-numeric chip count -> 400.
  const pc4 = await postJsonAuth("/api/admin/chips", { super_rebirth: 1, rebirth: 2, chips: "abc" });
  expect("POST chips non-numeric -> 400", pc4.status === 400, "status=" + pc4.status);

  // 30. POST /api/admin/chips rejects a non-integer tier -> 400.
  const pc5 = await postJsonAuth("/api/admin/chips", { super_rebirth: 1, rebirth: "x", chips: 10 });
  expect("POST chips bad tier -> 400", pc5.status === 400, "status=" + pc5.status);

  // 31. POST /api/admin/chips accepts a stringified number ("coerced") -> 200.
  const pc6 = await postJsonAuth("/api/admin/chips", { super_rebirth: 2, rebirth: 3, chips: "555" });
  const pc6j = JSON.parse(pc6.body);
  expect("POST chips string number coerced -> 200", pc6.status === 200 && pc6j.chips === 555, JSON.stringify(pc6j));

  // 32. POST /api/admin/chips WITHOUT the admin key -> 401.
  const pc7 = await new Promise((resolve) => {
    const payload = JSON.stringify({ super_rebirth: 1, rebirth: 5, chips: 10 });
    const req = http.request(
      base + "/api/admin/chips",
      { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error", (e) => resolve({ status: 0, body: String(e) }));
    req.write(payload);
    req.end();
  });
  expect("POST chips without key -> 401", pc7.status === 401, "status=" + pc7.status);

  // 33. index.html includes the admin chips card + wiring.
  const idx3 = await get("/");
  const hasChipCard =
    idx3.body.includes('id="adminChipsCard"') &&
    idx3.body.includes('id="chipSuper"') &&
    idx3.body.includes('id="chipRebirth"') &&
    idx3.body.includes('id="chipValue"') &&
    idx3.body.includes("/api/admin/chips");
  expect("index.html has admin chips card + wiring", idx3.status === 200 && hasChipCard, "status=" + idx3.status);

  // Restore the test-mutated chip rows so the DB matches the seed again.
  db.exec("DELETE FROM rebirth_upgrade_chips WHERE super_rebirth=1 AND rebirth=1");
  db.exec("UPDATE rebirth_upgrade_chips SET chips=555 WHERE super_rebirth=2 AND rebirth=3");

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
