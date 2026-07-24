# Droid Tycoon — Rebirth Tracker (Web UI)

A modern web UI shell porting the original spreadsheet dashboard's **droid search**
exactly: filter droids by **Super Rebirth Cycle** (1–4) × **Rebirth Cycle** (1–27)
and see the 3 required droids (name + color) for that stage.

Data is read **live** from a real SQLite database (`droid_tycoon.db`), so you can
edit it with any DB editor (DB Browser for SQLite, etc.) and the next page load
reflects your changes — no GUI needed for quick edits.

## Files
- `index.html` — the web UI shell + the search/filter component (no build step).
- `server.js` — tiny Node HTTP server (uses the built-in `node:sqlite`, Node 22+).
  Serves `index.html` and a JSON API backed by the database, read fresh per request.
- `build_db.py` — regenerates `droid_tycoon.db` from the source xlsx workbooks.
- `droid_tycoon.db` — generated SQLite DB (the data model; safe to edit directly).
- `test_server.js` — self-contained smoke test (run `node test_server.js`).

## Run
```bash
# 1. (first time, or after editing the xlsx) build the database
python build_db.py

# 2. start the UI
node server.js
# open http://localhost:8787
```
Set `PORT` to change the port (default 8787).

## API
- `GET /api/filters` → reference lists (super cycles, rebirth levels, colors, droids, cost curve).
- `GET /api/droids?super_rebirth=<n>&rebirth=<n>` → the 3 required droids for that stage.
  Both params required and numeric; otherwise `400`.
- `GET /api/state` → the player's current stage `{super_rebirth, rebirth, droids[]}` (the droids
  required at the current stage). This is the only mutable state; it is persisted in the DB.
- `POST /api/rebirth` → advances the player's current stage per the transition rule
  (Rebirth +1, wrapping to 1 at 27; Super Rebirth +1 when Rebirth wraps), persists it, and
  returns the new stage + the droids required there. Only `POST` mutates — `GET` is ignored.

### Admin API (edit rebirth cycles)
- `GET  /api/admin/stage?super_rebirth=<n>&rebirth=<n>` → the required droids for that stage
  (with row ids), for editing.
- `POST /api/admin/stage` → body `{ super_rebirth, rebirth, droids:[{name,color},...] }`.
  Replaces the required-droid rows for that stage in a transaction, and syncs any new
  names/colors into the reference lists. Validates each droid has a non-empty name+color.
  **The order of `droids` in the array is preserved** (it is the order other views render),
  so the admin UI's ▲/▼ reorder controls change the displayed sequence.
- `POST /api/admin/set-stage` → body `{ super_rebirth, rebirth }`. Manually overrides the
  player's current stage (both must be positive integers).
- `GET/POST /api/admin/chips` → read/set the upgrade-chip count for a stage.
  - `GET  /api/admin/chips?super_rebirth=<n>&rebirth=<n>` → `{ exists, chips }` (null if that stage isn't seeded yet).
  - `POST /api/admin/chips` → body `{ super_rebirth, rebirth, chips }`. `chips` must be a number ≥ 0
    (string-numbers are coerced). Upserts in a transaction; negative/non-numeric/bad tiers → 400.
- `GET/POST /api/admin/rebirth-cost` → read/set the credits (and optional Nova) required for a rebirth level.
  - `GET  /api/admin/rebirth-cost` → the full cost table (rebirth, credits, nova). Allowed without a key.
  - `POST /api/admin/rebirth-cost` → body `{ rebirth, credits, nova? }`. `credits` must be a number ≥ 0;
    `nova` is optional (omit to leave unchanged). Unknown rebirth level → 400. The new cost is read live everywhere
    (stage-detail panel, stat ETA), so the change takes effect immediately.
|
**All `/api/admin/*` routes require admin access.** Send the key in the
`X-Admin-Key` request header. The key is `DROID_TYCOON_ADMIN_KEY` (set in the
server's environment). If that env var is not set, the server generates an
ephemeral key on startup and prints it to the console — set the env var for any
non-local/shared deployment so the key stays stable across restarts. Requests
without a valid key get `401 Unauthorized`.

## Admin section
The admin panel has three cards (bottom of the page); all share the single admin-key field
(top of the first card), which is remembered in the browser's localStorage and sent as the
`X-Admin-Key` header:

1. **Admin — edit rebirth cycles** lets you:
   - Load any stage, then add / edit / remove / **reorder** its required droids
     (name + color) and save straight to the database. Use the ▲/▼ buttons on each
     row to change display order. Color field autocompletes from known colors.
   - Override the current player stage directly (super rebirth + rebirth).
2. **Admin — edit upgrade chips per rebirth** lets you load a (Super Rebirth, Rebirth)
   tier, view its current upgrade-chip total, edit it, and save. The change is reflected
   live in the stage-detail panel.
3. **Admin — edit rebirth credit cost** lets you pick a rebirth level, change how many
   credits (and optional Nova) are required to perform that rebirth, and save. The new
   cost is read live everywhere (stage-detail panel, stat ETA), so the change takes
   effect immediately.

Without the admin key, saves are rejected with a 401.

All admin edits write to `droid_tycoon.db` and are reflected live in every view. You can
still edit the DB directly with any SQLite editor for bulk/rapid changes — the admin UI is
just a convenience layer over the same tables.

## Rebirth transition rule
The Rebirth button in the **Current progress** card advances both cycles from the current
stage using the rule verified against `REBIRTH_DATA_SCHEMA.md`:
- if `rebirth < 27` → `(super_rebirth, rebirth + 1)`
- else → `(super_rebirth + 1, 1)`  (a super rebirth rolls the inner cycle back to 1)

The new stage is written to the `player_stage` table (single row, id=1) and read back live,
so it survives page reloads and edits made directly in the DB.

## Rebuilding from source
If you change the xlsx, re-run `python build_db.py` to regenerate the DB. The running
server picks up DB edits automatically (no restart needed).
