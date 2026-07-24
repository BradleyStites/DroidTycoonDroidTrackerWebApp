const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("./droid_tycoon.db");
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log("TABLES:", tables.map(t => t.name).join(", "));
for (const t of tables.map(t => t.name)) {
  try {
    const c = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get();
    console.log(`  ${t}: ${c.n} rows`);
  } catch (e) {
    console.log(`  ${t}: ERROR ${e.message}`);
  }
}

// Inspect schema of the tables that feed the dropdowns
for (const t of ["droids", "colors", "super_rebirth_cycles", "rebirth_levels", "droid_rebirths", "player_stage", "rebirth_cost"]) {
  try {
    const cols = db.prepare(`PRAGMA table_info("${t}")`).all();
    console.log(`SCHEMA ${t}:`, cols.map(c => `${c.name}:${c.type}`).join(", "));
  } catch (e) {
    console.log(`SCHEMA ${t}: ERROR ${e.message}`);
  }
}

// Sample rows from the reference tables that feed /api/filters
console.log("\n--- droids (first 10) ---");
console.log(JSON.stringify(db.prepare("SELECT * FROM droids ORDER BY name LIMIT 10").all()));
console.log("\n--- colors ---");
console.log(JSON.stringify(db.prepare("SELECT * FROM colors ORDER BY name").all()));
console.log("\n--- super_rebirth_cycles ---");
console.log(JSON.stringify(db.prepare("SELECT * FROM super_rebirth_cycles ORDER BY value").all()));
console.log("\n--- rebirth_levels ---");
console.log(JSON.stringify(db.prepare("SELECT * FROM rebirth_levels ORDER BY value").all()));
