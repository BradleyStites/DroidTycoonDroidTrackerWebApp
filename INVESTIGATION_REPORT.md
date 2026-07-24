# Investigation: Local Dev Setup & Data Flow — DroidTycoon

Date: 2026-07-22
Scope: `C:/Users/bradl/gemini-cli/personal/Games/fortnite/DroidTycoon/` + the admin panel on `http://localhost:8787/`

## TL;DR (correcting one assumption)
The server on :8787 is **NOT** a wrangler/Cloudflare dev server. It is a plain
**Node.js `http` server** (`webui/server.js`) using Node's built-in `node:sqlite`
module (Node 22+). It serves `webui/index.html` and a JSON API backed by a real
**SQLite file** (`webui/droid_tycoon.db`) that is read **live on every request**
(no caching). PID 34380 = `node.exe`, listening on `0.0.0.0:8787` + `[::]:8787`.

There are also TWO different `index.html` files with different data strategies:
- `webui/index.html` — the admin/UI shell that **is a client of the API**.
- root `index.html` — a standalone "Needed Droids Tracker" that **embeds its data
  inline** and does NOT talk to the API at all. This is the file you open via `file://`.

---

## 1) What database is used, and how the admin panel writes to it

### Database
- File: `webui/droid_tycoon.db` (SQLite 3).
- Opened once at startup: `new DatabaseSync(DB_PATH)` (`server.js:59`). Statements are
  prepared per-request; reads are live (no cache), so any write is visible on the
  next request without a restart.
- Tables (verified):
  - `droid_rebirths` — master table: `(id, super_rebirth, rebirth, droid_name, droid_color)`
    with `UNIQUE(super_rebirth, rebirth, droid_name, droid_color)`. This is the
    canonical "which 3 droids are required at stage (SR,R)" data.
  - `super_rebirth_cycles` (values 1–4), `rebirth_levels` (1–27) — reference lists.
  - `droids` (name PK), `colors` (name PK) — reference lists (kept in sync by admin edits).
  - `rebirth_cost` — `(rebirth PK, credits, nova)` the cost curve.
  - `player_stage` — single row `id=1`, `(super_rebirth, rebirth)` = the ONLY mutable
    player-state (the Rebirth button advances this).
  - `rebirth_upgrade_chips` — `(super_rebirth, rebirth PK, chips)` per-stage upgrade-chip target.
- Rebuilt wholesale from the xlsx workbooks by `webui/build_db.py`
  (inputs: `Droid Tycoon Rebirth Tracking System/Driod Tycoon Rebirth.xlsx` and
  `Droid Tycoon Stat Tracking/Droid Tycoon Stats.xlsx` → writes `droid_tycoon.db`).

### How the admin panel writes
All writes go through prepared SQL in `server.js` admin handlers (gated by
`requireAdmin`, key in `X-Admin-Key` header):

- **Edit rebirth lineup**: `POST /api/admin/stage` → `DELETE` + `INSERT` into
  `droid_rebirths` inside a transaction; also `INSERT OR IGNORE` new names/colors
  into `droids`/`colors` so reference lists stay in sync. Order of the `droids`
  array is preserved (display order elsewhere).
- **Upgrade chips**: `POST /api/admin/chips` → `INSERT ... ON CONFLICT(super_rebirth,rebirth)
  DO UPDATE SET chips=...` on `rebirth_upgrade_chips`.
- **Rebirth credit cost**: `POST /api/admin/rebirth-cost` → `UPDATE rebirth_cost`
  (rebirth level must already exist; credits ≥ 0, optional nova).
- **Override current stage**: `POST /api/admin/set-stage` → `UPDATE player_stage`.
- **Rebirth button** (non-admin): `POST /api/rebirth` advances `player_stage`
  per the rule `(R<27 → R+1; else SR+1,R=1)` and persists it.

Auth: shared key `DROID_TYCOON_ADMIN_KEY` (env) or static default `"91935"`.
`GET /api/admin/rebirth-cost` is allowed without the key; all other `/api/admin/*`
require it (401 otherwise). Because the DB is read live, **the admin UI and direct
SQLite edits (e.g. DB Browser for SQLite) both take effect immediately** — the DB is
the single source of truth and the API is just a thin read/write layer over it.

---

## 2) API endpoints on localhost:8787 to read the DB

All responses are `application/json`, `Cache-Control: no-store`,
`Access-Control-Allow-Origin: *` (CORS wide open — see section 3 implications).

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/api/filters` | none | All reference lists: `super_rebirth_cycles`, `rebirth_levels`, `colors`, `valid_colors`, `droids`, `rebirth_cost` curve, `upgrade_chips`. The one-call "give me everything static" endpoint. |
| GET | `/api/droids?super_rebirth=<n>&rebirth=<n>` | none | The 3 required droids `{name,color}` for that stage. Both params required + numeric. |
| GET | `/api/state` | none | `player_stage` current `{super_rebirth, rebirth, droids[]}`. |
| GET | `/api/droid-cycle?droid=<name>` | none | Whether droid is used in the current SR cycle + which stages/colors. |
| GET | `/api/droid-necessity?droid=<name>` | none | Still-needed computation for remaining stages. |
| GET | `/api/admin/stage?super_rebirth=&rebirth=` | admin | Stage droids with row `id`s (for editing). |
| GET | `/api/admin/chips?super_rebirth=&rebirth=` | admin | Chip total for a stage (`chips`, `exists`). |
| GET | `/api/admin/rebirth-cost` | none | Full cost table `{rebirth, credits, nova}`. |
| GET | `/api/stats` | none | Persisted 4-var stat record (JSON file, not DB). |
| GET | `/api/stats/computed` | none | Derived dashboard (ETA, Nova curve) from stats + `rebirth_cost`. |
| GET | `/api/stats/log` | none | Snapshot history (measured rates). |
| GET | `/api/stats/measured` | none | Measured credits/min + tokens/min. |

Mutating endpoints (POST): `/api/rebirth`, `/api/stats`, `/api/stats/snapshot`,
`/api/admin/stage`, `/api/admin/chips`, `/api/admin/rebirth-cost`,
`/api/admin/set-stage` (admin ones need `X-Admin-Key`).

Note: the `/api/stats*` family persist to a JSON file on disk (`stat_tracking.js` /
`stat_log.js`), NOT to the SQLite DB. Only the droid/rebirth/cost/chips tables live in
`droid_tycoon.db`.

---

## 3) How index.html currently loads data when opened via file://

There are two `index.html` files with **different** loaders:

### webui/index.html (served by the :8787 server)
This one is the actual client of `node server.js`. It fetches `/api/filters`,
`/api/state`, `/api/droids`, etc. over HTTP. It only works when served by the Node
server (opening it via `file://` breaks because the relative API paths resolve to
`file://` and fetch fails). This page is already live-linked to the DB.

### root index.html (the "Needed Droids Tracker")
This is the one you open from disk. It **does not use the API at all**. Instead:

- Data is **inlined into the page** as a `<script id="data" type="application/json">{...}</script>`
  blob containing the entire data model (stages, totals, valid_colors, reference lists).
  For the current file the blob is present and valid (it rendered fine when checked).
- `loadData()` (`index.html:203`) tries `JSON.parse` of that inline blob **first**.
  Only if the blob is empty/malformed does it fall back to `fetch('data/rebirth_data.json')`.
- Under `file://`, `fetch` of a local file is blocked by the browser, so the inline
  blob is the only working source — which is why the page is designed to ship data inline.

The inline blob is generated by the build pipeline, NOT by the running server:
`build_data.py` → `data/rebirth_data.json`, then `make_panel.py` substitutes
`__DATA_JSON__` in `needed_droids_panel.html` with that JSON and writes the final
self-contained `index.html`. So the root page is effectively a **static snapshot**
of the DB at build time.

Root cause of past "empty dropdown" bugs: if `make_panel.py` was not re-run after a
data change (or the template still held the `__DATA_JSON__` placeholder), the inline
blob is invalid → `JSON.parse` fails → `loadData()` tries to `fetch` the JSON →
fails under `file://` → error banner. The fix is to regenerate via `make_panel.py`
(or serve over HTTP so the fallback fetch works).

---

## How the page could be linked to live DB updates

The DB is already read live by `server.js`, and CORS is `Access-Control-Allow-Origin: *`,
so linking a page to live data is straightforward:

**Option A — true live (recommended for the root page):**
Point `loadData()` (and the per-stage renders) at the running API instead of the
inline blob. e.g. replace the inline loader with:
```
const F = await fetch('http://localhost:8787/api/filters').then(r=>r.json());
// for a stage: await fetch(`http://localhost:8787/api/droids?super_rebirth=${s}&rebirth=${r}`)
```
Because CORS is open, this works even from a `file://` page (it calls an `http://`
origin). After any admin edit, a simple refresh (or a `setInterval` poll of the
endpoints) shows the new data with **no rebuild of index.html**. This makes the root
page behave like `webui/index.html` but pointed at localhost:8787.

**Option B — rebuild-on-change (current pipeline):**
Keep the static-snapshot design, but re-run `python build_data.py && python
make_panel.py` whenever the DB changes (can be automated by a watcher on
`droid_tycoon.db`). Simple, but requires a rebuild step and a page reload.

**Option C — already done for webui/index.html:**
That page already pulls live data from the API. If the goal is a live admin-facing
view, using/extending `webui/index.html` (served by `node server.js`) is the path of
least resistance; the root `index.html` only needs the Option A change if you want it
live too.

### Practical recommendation
- For day-to-day live editing: run `node server.js` and use `webui/index.html`
  (already live).
- If you specifically want the standalone `index.html` (opened from disk) to reflect
  DB edits without a rebuild, change its `loadData()` to fetch
  `http://localhost:8787/api/filters` + `/api/droids`. The server already supports
  exactly this and CORS won't block it.

---

## Verification performed
- Confirmed process on :8787 is `node.exe` (PID 34380) — not wrangler.
- `GET /api/filters` returned live reference data (super cycles 1–4, rebirth 1–27,
  valid_colors, droids list).
- `GET /api/state` returned live `player_stage` (currently SR1, R1, droids Pit/CB/DRK-1 Probe).
- Read `server.js` (full), `build_db.py`, `make_panel.py`, `webui/README.md`,
  root `index.html` (full), `data/rebirth_data.json` (structure).
- Enumerated SQLite tables in `droid_tycoon.db`.
