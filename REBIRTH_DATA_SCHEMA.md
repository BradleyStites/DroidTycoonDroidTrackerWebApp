# Droid Tycoon — Rebirth Data Model Schema

Extracted from the two project spreadsheets. Source of truth for the UI build.

## Source files

1. `Droid Tycoon Rebirth Tracking System/Driod Tycoon Rebirth.xlsx`
   (note the typo "Driod" in the filename — matches the actual file on disk)
   - The *content* workbook: which droids are required at each rebirth stage, plus the
     lookup calculator. This is the primary "droid rebirth data model".

2. `Droid Tycoon Stat Tracking/Droid Tycoon Stats.xlsx`
   - The *cost / progression* workbook: credits + Nova costs per rebirth, and the
     Super Rebirth (SR) x Rebirth (R) grind-rate logging. Supplements the content
     workbook with the numeric cost curves.

---

## 1. Core content workbook — `Driod Tycoon Rebirth.xlsx`

### 1.1 Sheet `DroidRebirthDB`  (THE master table — 324 data rows)

Columns (header row 1):
| Col | Header          | Type   | Meaning / rules |
|-----|-----------------|--------|-----------------|
| A   | `Super Rebirth` | int ≥1 | Super-cycle index (tier above a normal rebirth). Values seen: 1–4. |
| B   | `Rebirth`       | int ≥1 | Rebirth-cycle number within that super cycle. Values seen: 1–27. |
| C   | `Droid Name`    | string | The droid required to unlock/advance this stage. 63 distinct names. |
| D   | `Droid Color`   | enum   | Cosmetic/rank color of the required droid (see palette below). |
| E   | (unused)        | —      | Empty in all rows. Ignore. |

**Structure rule (verified against all 324 rows):**
- The combination `(Super Rebirth, Rebirth)` is a *stage key*.
- Every stage key has **exactly 3 rows** — i.e. each (SR, R) stage requires **3 droids**.
- There are **108 distinct stages** in the data (4 SR tiers × 27 R levels = 108, fully populated).
- `Rebirth` is NOT globally unique — it repeats per super cycle (R 1–27 exists under SR 1, 2, 3, and 4).

**Color palette (`Droid Color` enum values observed):**
`Base`, `Default`, `Gold`, `Diamond`, `Rainbow`, `Beskar`
Plus two clearly-flagged data errors that should be excluded/quarantined by the UI:
`Base (Incorrect)`, `Default (Incorrect)`  (1 occurrence each).
> Implication: colors appear to escalate Base → Gold → Diamond → Rainbow → Beskar as a
> stage "quality" tier, but a single stage mixes colors (e.g. R3 under SR1 = Base, Base, Gold),
> so color is a property of the *individual droid requirement*, not the stage.

### 1.2 Sheet `Do I Need It`  (lookup calculator)

A single-row input form. Layout (row = label/value):
- `A1` `Super Rebirth`  ← input (number)
- `A2` `Rebirth`        ← input (number)
- `A3` `Droid`          ← input (droid name string)
- `A4`  (merged A4:D4)  ← a 4th input, currently `40.0` (purpose ambiguous; likely a level/count threshold)
- `A5` `Result`         → computed via a Google-Sheets `QUERY` over `DroidRebirthDB!A2:E998`:
  `select B,C,D where C = '<droid>' and A = <super> and B >= <rebirth>`
  - Returns the matching `Rebirth`, `Droid Name`, `Droid Color` (fallback: `21`, `LO`, `Beskar`).
- `C1:D3` merged (title/branding area, no data).

> This sheet confirms the lookup semantics: given (Super Rebirth, Rebirth, Droid) you
> resolve to the droid's color/requirement. The UI can replicate this with a simple filter
> over `DroidRebirthDB` rather than porting the QUERY formula.

### 1.3 Reference / validation sheets (single-column lists)

- `Droids` (65 rows): master list of droid names. Used to validate `Droid Name` entries.
  (63 of these appear in `DroidRebirthDB`; 2 are list-only.)
- `Ranks` (5 rows): `Common`, `Rare`, `Epic`, `Legend`, `Mythic` — droid rarity tiers.
- `Colors` (6 rows): `Default`, `Gold`, `Diamond`, `Rainbow`, `Beskar`, `Galactic` —
  the *canonical* color enum (note `Galactic` is listed here but not yet used in `DroidRebirthDB`;
  `Base` is used in data but absent from this list → the two color lists disagree; treat
  `DroidRebirthDB`'s observed values as ground truth and reconcile later).
- `Rebirths` (27 rows): values 1–27 — the valid `Rebirth` domain.
- `SuperRebirthCycles` (4 rows): values 1–4 — the valid `Super Rebirth` domain.
- `Rebirth Cost` (empty): placeholder sheet, no data. Reserved for cost display.

---

## 2. Cost / progression workbook — `Droid Tycoon Stats.xlsx`

### 2.1 Sheet `RebirthRequirementsRewards`  (cost curve — 27 data rows)

| Col | Header   | Type   | Rule |
|-----|----------|--------|------|
| A   | `Rebirth`| int    | `=A(prev)+1`, starting at 0. Domain: 0–27. |
| B   | `Credits`| number | Credits cost to reach that rebirth. Grows ~2.4–3.6× per step (e.g. 10k → 150k → 975k → 2.95M … 32T at R27). |
| C   | `Nova`   | number | Nova reward, starts at R12 (11, 16, 22, 29, … 191). Empty for R0–R11. |

Formula observed for column A: `=A{n-1}+1` (monotonic +1). Credits/Nova are hardcoded
lookup values, not derived by a simple formula — store as a table.

### 2.2 Sheet `Main`  (derived per-rebirth metrics — 26 data rows, R18–R26 populated)

| Col | Header | Derivation |
|-----|--------|------------|
| A | `Rebirth` | `=A(prev)+1` |
| B | `B/Min (calc)` | pulls from `TimeToCompletionCalculations` / `Credits Calculations` sheets |
| C | `Credits Required` | hardcoded (810, 2000, 3000, 4500, 6000, 9000, 13500, 21000, …) |
| D | `Rewards (Nova)` | `=(prev)+1+prev` cumulative-style; R18=67 … grows |
| E | `Time To Completion (est)` | `=C / B / 1440` (credits ÷ credits-per-min ÷ mins-per-day) |
| F | `ETC (Hour)` | `=(C/B)/60` |
| G | `Nova / Hour` | `(D - Dprev) / (E*1440)` |

### 2.3 Logging sheets ( grind-rate telemetry )

- `Form Responses 1`: Google-Form export. Cols: `Timestamp, Super Rebirth Cycle, Rebirth, Credits, Upgrade Chips`. 5 real submissions (all SR 3, R20–21). This is *player log data*, not a static model.
- `Credits Calculations`: `SR, R, Credits(B), Time, Delta, Time Delta, B/Min`. Tracks credits/min grind rate per (SR,R). Observed range SR 1–15, R up to 22.
- `Upgrade Chips Calculations`: same shape for Upgrade Chips. Observed range SR 1–6, R up to 21.
- `TimeToCompletionCalculations`: tuning constants (`Est Cred/Min`, `Current Credits`, `Credit Finish`, `Round(C)`, `Round(D)`) used by `Main`.

---

## 3. Increment / transition logic (the part the task asked to pin down)

### Rebirth Cycle (`Rebirth`, column B of `DroidRebirthDB`)
- A **1-based integer counter** that increments by **+1** at each stage.
- Resets to **1** whenever `Super Rebirth` increments (i.e. Rebirth cycles *within* a super cycle; it does not run forever). In the data it spans **1–27** per super cycle.
- It is the "inner" loop: 27 rebirth stages per super cycle.

### Super Rebirth Cycle (`Super Rebirth`, column A of `DroidRebirthDB`)
- A **1-based integer counter** for the "tier above" a normal rebirth. Increments by **+1**
  when a full Rebirth cycle (1→27) is completed.
- In the data it spans **1–4** (4 super cycles fully populated, 27 rebirths each).
- It is the "outer" loop: completing R27 of SR{n} transitions you to SR{n+1}, R1.

### Transition rule (composed)
```
given current state (SR, R):
  next stage = if R < 27: (SR, R+1)
               else:       (SR+1, 1)     # super rebirth "rolls over" the inner cycle
max observed: SR=4, R=27  (no data beyond — treat as current ceiling, not hard cap)
```

### Which droids are needed (the "needed droids" model)
- For any target stage `(SR, R)`, the required droids = the **3 rows** in `DroidRebirthDB`
  sharing that `(SR, R)` key: each row gives `{ Droid Name, Droid Color }`.
- The `Do I Need It` sheet resolves the reverse direction: given a droid name + your
  current `(SR, R)`, it returns the earliest stage ≥ your current R where that droid is required.

---

## 4. Recommended UI data shape (one normalized table)

```
RebirthStage {
  super_rebirth : int        # 1..4  (outer cycle)
  rebirth       : int        # 1..27 (inner cycle)
  droid_name    : str        # FK -> Droids list
  droid_color   : enum       # Base|Default|Gold|Diamond|Rainbow|Beskar
  # (3 rows share one (super_rebirth, rebirth) key)
}
```
Plus reference tables: `droids[]`, `ranks[]`, `colors[]`, `rebirth_cost[rebirth] -> {credits, nova}`.

### Field dictionary for the UI
| Field | Type | Domain | Notes |
|-------|------|--------|-------|
| `super_rebirth` | integer | 1–4 | Outer cycle; +1 when R wraps 27→1 |
| `rebirth` | integer | 1–27 | Inner cycle; +1 each stage; wraps to 1 on super rebirth |
| `droid_name` | string | 63 distinct | Must exist in `Droids` list |
| `droid_color` | enum | Base, Default, Gold, Diamond, Rainbow, Beskar | Exclude `* (Incorrect)` rows |
| `credits_cost` | number | from `RebirthRequirementsRewards` | Keyed by `rebirth` |
| `nova_reward` | number | null for R0–11, else 11..191 | Keyed by `rebirth` |

---

## 5. Open items / data-quality flags (need a human or richer source to resolve)
1. **Filename typo**: `Driod Tycoon Rebirth.xlsx` ("Driod"). Code should reference the exact on-disk name.
2. **Color enum mismatch**: `Colors` sheet lists `Galactic` (unused) and omits `Base` (used).
   `DroidRebirthDB` is authoritative; reconcile the canonical palette.
3. **`Base (Incorrect)` / `Default (Incorrect)`** rows (2 total) — data errors; quarantine.
4. **`Do I Need It!A4`** input (`40.0`) purpose is undocumented — likely a level/threshold;
   confirm before wiring into UI logic.
5. **`Rebirth Cost` sheet is empty** — reserved slot; cost data actually lives in the
   *Stats* workbook (`RebirthRequirementsRewards`). UI should read cost from there.
6. **Ceiling**: data stops at SR4/R27. Whether higher exists is unknown — don't hard-cap the UI.
7. The **Stats workbook costs are per-rebirth only** (not per (SR,R)); if Super Rebirth
   changes cost, that multiplier is not present in the data.

---

## 6. Super Rebirth Cycle lookup module (`webui/super_rebirth_cycle.js`)

A typed module that answers, for **any droid identifier**, the three requirements the
tracker needs:

1. `inCurrentCycle` — boolean: is this droid required *anywhere* in the current super
   rebirth cycle?
2. `stages` — the list of required stages `(superRebirth, rebirth)` within that cycle.
3. `colors` — the list of required droid colors for those stages.

### Where the data lives (source of truth)

The **live** source is `webui/droid_tycoon.db` (SQLite, built by `webui/build_db.py`, read
live on every request by `webui/server.js`). Two tables drive the module:

| Table            | Role                                                                 |
|------------------|----------------------------------------------------------------------|
| `player_stage`   | The player's current position: `super_rebirth`, `rebirth`, `id=1`.  |
|                  | **This single row IS the "current super rebirth cycle."** Seeded to SR1/R1. |
| `droid_rebirths` | Master required-droids table. Columns `(super_rebirth, rebirth,    |
|                  | droid_name, droid_color)`, 3 rows per `(super_rebirth, rebirth)`   |
|                  | stage key. 322 rows = 324 − 2 quarantined `(Incorrect)` rows.       |

The current cycle is read from `player_stage` by default; an explicit cycle can be passed
to the lookup. Cycle validity is checked against the cycles actually present in
`droid_rebirths` (currently 1–4).

### Function signature

```js
const { getCycleRequirements, withDb } = require("./super_rebirth_cycle");

// Bind once, then query many droids:
const api = withDb();                       // opens droid_tycoon.db
const r = api.getCycleRequirements("LO");   // droid id = name (case-insensitive)

// OR pass a DatabaseSync handle directly:
const r = getCycleRequirements(db, "LO");
// OR query a specific (non-current) cycle:
const r = getCycleRequirements(db, "LO", 2);
```

### Returned schema (`CycleRequirement`)

```ts
type StageRef = {
  superRebirth: number;   // super cycle, 1-based (outer loop)
  rebirth:      number;   // rebirth stage, 1-based (inner loop, 1..27)
  color:        string;   // required droid color for this requirement
};

type CycleRequirement = {
  inCurrentCycle: boolean;     // (1) droid required in the current cycle
  superRebirth:   number;      // the cycle this result was resolved against
  stages:         StageRef[];  // (2) stages in the current cycle needing it
  colors:         string[];    // (3) distinct colors across `stages`
  allStages:      StageRef[];  // stages in ANY cycle needing it
  allColors:      string[];    // distinct colors across all cycles
};
```

### Examples (from the live DB, seeded to SR1/R1)

| Droid | `inCurrentCycle` | `stages` (current cycle)            | `colors`            |
|-------|------------------|-------------------------------------|---------------------|
| `A-LT` | true           | SR1/R3 Base, SR1/R6 Diamond         | Base, Diamond       |
| `LO`   | true           | SR1/R8 Gold, SR1/R10 Rainbow        | Gold, Rainbow       |
| `LO` (cycle 2) | true  | SR2/R21 Beskar                      | Beskar              |
| `NOPE` | false          | `[]`                                | `[]`                |

`A-LT` appears only in cycle 1, so `stages == allStages`. `LO` also appears in cycle 2
(R21 Beskar) — visible via `allStages` — but `getCycleRequirements(db,"LO",2)` resolves it
against cycle 2 directly.

### Other exports

- `getCurrentCycle(db)` → `{ superRebirth, rebirth }` from `player_stage`.
- `getStageDroids(db, sr, rb)` → the 3 `{name,color}` required droids for one stage.
- `availableCycles(db)` → distinct super-cycle indices present in the data.
- `droidInCycle(db, name, sr)` → boolean membership probe for one cycle.
- `droidAllStages(db, name)` → all `StageRef`s for a droid across every cycle.
- `openDb(path?)` → a `DatabaseSync` handle (defaults to `droid_tycoon.db` next to the module).

### Tests

`webui/super_rebirth_cycle.test.js` — plain `assert`, run with `node super_rebirth_cycle.test.js`.
12 cases covering the seed cycle, known stages, per-cycle resolution, case-insensitive ids,
non-existent droids, and error paths. All pass against the built DB.
