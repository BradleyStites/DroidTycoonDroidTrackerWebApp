# Droid Tycoon Stats Spreadsheet — Structure & Behavior Spec

Source file: `Droid Tycoon Stat Tracking/Droid Tycoon Stats.xlsx`
Inspected: 2026-07-22 — 6 sheets, no embedded charts, no conditional
formatting, no data validation, no external links, no named ranges.

The workbook is a manual stat-tracking/forecasting tool for the Droid Tycoon
game. Its job is to turn a log of in-game resource snapshots (Credits,
Upgrade Chips, Nova) into **rates** (per-minute), **time-to-completion
estimates**, and **reward curves**. A new web module should replicate these
behaviors.

--------------------------------------------------------------------------------
## 1. Sheet inventory and purpose
--------------------------------------------------------------------------------

| Sheet | Role | Size |
|-------|------|------|
| `Form Responses 1` | Raw data entry (likely a Google Form dump). | A1:F6 (5 rows of data) |
| `Credits Calculations` | Manual per-snapshot Credit log + rate calc. | A1:G1004 (31 rows used) |
| `Upgrade Chips Calculations` | Manual per-snapshot Chip log + rate calc. | A1:G1000 (15 rows used) |
| `TimeToCompletionCalculations` | Completion-time decomposition (H/M/S) per target. | A1:M23 (23 rows) |
| `Main` | Dashboard: one row per upcoming rebirth w/ est. time & Nova/hr. | A1:G1000 (10 rows used) |
| `RebirthRequirementsRewards` | Static lookup: Credits required & Nova reward per rebirth. | A1:C1001 (29 rows used) |

--------------------------------------------------------------------------------
## 2. `Form Responses 1` — raw input
--------------------------------------------------------------------------------
Columns (header row 1):
- A `Timestamp` (datetime)
- B `Super Rebirth Cycle` (number)
- C `Rebirth` (number)
- D `Credits` (number)
- E `Upgrade Chips` (number)
- F `Column 5` — **unused/empty placeholder**

5 data rows present (all Super Rebirth Cycle = 3, rebirths 20–21). This is the
player's hand-recorded progress. It does NOT feed the calculation sheets via
formula (the Calculations sheets are logged independently) — so treat it as a
reference/raw log, not a live source for computed columns.

--------------------------------------------------------------------------------
## 3. `Credits Calculations` & `Upgrade Chips Calculations` — rate engine
--------------------------------------------------------------------------------
Identical structure; one for Credits, one for Chips. Header fill = `4DD0E1`
(teal). Columns:

- A `SR` — Super Rebirth cycle number (manual tag)
- B `R` — Rebirth number within the cycle (manual tag)
- C `Credits(B)` / `Upgrade Chips` — resource balance at the logged time
- D `Time` — timestamp of the snapshot
- E `Delta` — `=C{n}-C{n-1}` (gain since previous logged row)
- F `Time Delta` — `=D{n}-D{n-1}` (elapsed time, Excel date fraction)
- G `B/Min` / `Chips/Min` — `=E{n}/(F{n}*1440)`

**Key behavior — rate per minute:**
`rate_per_min = Delta / (TimeDelta_in_days * 1440)`
Because a datetime subtraction in Excel yields days, multiplying by 1440
converts to minutes. Row 2 has no previous row, so E/F/G are blank there.

This is the core "how fast am I earning" metric. The web module must replicate:
given an ordered list of (timestamp, balance) snapshots, compute the delta of
balance and the delta of time between consecutive snapshots, then
`rate/min = balance_delta / (time_delta_days * 1440)`.

--------------------------------------------------------------------------------
## 4. `TimeToCompletionCalculations` — time-to-finish decomposition
--------------------------------------------------------------------------------
Two regions:

**Rates table (rows 1–14, columns A–C only):** a static lookup of
`Est Cred / Min` rates (A2..A14 = 0.00985 … 325) used as fallback/reference
rates for each target. B and the rest of these rows are empty.

**Per-target completion block (rows 15–23, columns A–M):**
For each rebirth target it computes estimated time to finish earning the
required Credits:

- A `Est Cred / Min` — pulled from `Credits Calculations!G{row}`
- B `Current Credits` — pulled from `Credits Calculations!C{row}`
- C `Credit Finish` — the target total (manual constant, e.g. 810, 2000 … 32000)
- D `Remaining` — `=C-B` (target minus current)
- E `Est Min to Completion` — `=D/A` (remaining / rate → minutes)
- F `Est Hrs To Completion` — `=E/60`
- G `Act Est Hrs` — `=INT(F)`
- H `Est Min` — `=(F - L)*60` (fractional hours → minutes)
- I `Act Est Min` — `=INT(H)`
- J `Est Sec` — `=(H - M)*60`
- K `Act Est Sec` — `=INT(J)`
- L `Round(C)` — `=ROUNDDOWN(F,0)` (whole hours)
- M `Round(D)` — `=ROUNDDOWN(H,0)` (whole minutes)

**Key behavior — H/M/S decomposition:** given a rate and a current balance vs
a target, estimate minutes = remaining/rate, then break the hours figure into
integer hours + integer minutes + integer seconds via INT/ROUNDDOWN. This is
the "ETA" logic the dashboard reuses.

--------------------------------------------------------------------------------
## 5. `Main` — dashboard (primary view to mimic)
--------------------------------------------------------------------------------
Header columns:
- A `Rebirth` (number; `=A{prev}+1`)
- B `B/Min (calc)` — pulls the rate from `TimeToCompletionCalculations!A{...}`
  for rows 2–4 and from `Credits Calculations!G{...}` for rows 5–10
- C `Credits Required` — manual target constant
  (810, 2000, 3000, 4500, 6000, 9000, 13500, 21000, 32000)
- D `Rewards (Nova)` — **cumulative**:
  - D2 `=67` (base)
  - D3 `=(D2-56)+1+D2` → i.e. prev + (prev - 56) + 1; for later rows
    `=(D{prev}-D{prev-1})+1+D{prev}` (increment = previous gain + 1)
- E `Time To Completion (estimated)` — `=C/B/1440` → **days**
- F `ETC (Hour)` — `=(C/B)/60` → **hours**
- G `Nova / Hour` — nova earned over the rebirth ÷ minutes:
  - G2 `=(D2-56)/(E2*1440)` (56 = fixed Nova base)
  - G3 `=(D3-D2)/(E3*1440)` … (gain ÷ minutes)

Number formats on row 2: B `#,##0.000`; E `[h]:mm:ss`; F `#,##0.00`;
G `#,##0.000`.

**Key behaviors:**
1. One row per upcoming rebirth in sequence (A auto-increments).
2. Per-row credits-needed target and the live earning rate are shown together.
3. Estimated completion time is shown both in **days** (E) and **hours** (F)
   via `credits / rate / 1440` and `/60`.
4. Nova reward is a **running cumulative** total, incremented by the prior
   step's gain + 1 (with a fixed base of 56).
5. `Nova / Hour` = nova gained in that rebirth ÷ estimated minutes — a
   efficiency/throughput metric.

--------------------------------------------------------------------------------
## 6. `RebirthRequirementsRewards` — static lookup table
--------------------------------------------------------------------------------
- A `Rebirth` — `=A{prev}+1` starting at 0
- B `Credits` — credits required at that rebirth (10,000 → 32,000,000,000,000)
- C `Nova` — reward; rows 1–13 blank, then:
  - C14 `=11`, C15 `=16`
  - from C16 on: `=C{prev}-C{prev-1}+1+C{prev}`
    (i.e. cumulative: previous total + (previous increment + 1))

This is the **source of truth for required credits and Nova rewards per
rebirth number** that `Main` references. It is a long monotonically increasing
table (29 rows, extends to rebirth 28+).

--------------------------------------------------------------------------------
## 7. Behaviors the new module MUST replicate
--------------------------------------------------------------------------------
1. **Snapshot log → per-minute rate.** Accept an ordered list of
   (timestamp, balance) pairs for Credits and for Upgrade Chips. Compute
   `rate/min = balanceDelta / (timeDeltaDays * 1440)` between consecutive
   snapshots. (From `Credits/Upgrade Chips Calculations` G column.)
2. **ETA to target.** Given a current balance, a target balance, and a rate,
   compute `minutes = (target - current)/rate`, then decompose into
   H / M / S using INT + ROUNDDOWN. (From `TimeToCompletionCalculations`.)
3. **Dashboard rows per rebirth.** For each upcoming rebirth show: rebirth #,
   earning rate (B/Min), credits required, estimated completion in days and
   hours (`credits/rate/1440` and `/60`). (From `Main` A–F.)
4. **Cumulative Nova rewards.** Maintain a running Nova total where each
   step's increment = previous increment + 1, with a fixed base of 56 and
   starting values 11/16 at rebirths 14/15. (From `Main` D and
   `RebirthRequirementsRewards` C.)
5. **Nova/hour throughput.** `novaGained / estimatedMinutes` per rebirth.
   (From `Main` G.)
6. **Static requirement lookup.** A per-rebirth table of credits-required and
   nova-reward used to drive the dashboard. (From `RebirthRequirementsRewards`.)

## 8. Notes / caveats for implementers
--------------------------------------------------------------------------------
- No charts exist in the file despite the task mention — visualizations, if
  wanted, must be built fresh (trend lines of rate over time would be the
  natural analog of the per-snapshot logs).
- `Form Responses 1` is a separate raw log and is NOT wired into the
  calculation sheets by formula; decide whether the web module ingests it or
  treats the Calculations sheets as the single source of truth.
- The `Main` sheet's `B/Min (calc)` mixes sources (TimeToCompletionCalculations
  for early rows, Credits Calculations for later) — a web module should
  standardize on one rate source (recommended: the live Credits Calculations
  rate, or the player's current chosen rate).
- All time math assumes Excel datetime subtraction yields **days**; replicate
  by converting timedeltas to days before multiplying by 1440.
- Number formatting to preserve: B/Min → 3 decimals; ETC days → `[h]:mm:ss`;
  ETC hours & Nova/hour → 2 decimals / 3 decimals respectively.
