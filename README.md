# Droid Tycoon — Needed Droids Tracker

A self-contained panel that shows which droids are required for each rebirth
stage of the Droid Tycoon grind, built from the project's two workbooks
(`Driod Tycoon Rebirth.xlsx` + `Droid Tycoon Stats.xlsx`).

## Image
![Screenshot](https://github.com/BradleyStites/DroidTycoonDroidTrackerWebApp/blob/main/Screenshot.png "Screenshot")

## Open it
Double-click **`index.html`** (or open it in any browser). No server needed —
the data is inlined into the page.

## What it shows
- **Rebirth Map**: a 4×27 grid (Super Rebirth × Rebirth). Each cell shows the
  3 required-droid color swatches. Click a cell to inspect the exact droids.
- **Current progress**: pick your current `SR`/`R`; past stages dim, your
  current stage is outlined green, and the **Upcoming Needed Droids** list
  shows the next N stages' required droids.
- **Stage Detail**: the exact droid names + colors for the selected stage, plus
  its credits/Nova cost (from the Stats workbook).
- **Droid Checklist**: all 63 distinct required droids with how many stages
  each appears in — tick off what you already own.
- **Color Legend**: the canonical color palette + a note about quarantined
  `(Incorrect)` data-error rows (excluded from the model).

## Regenerate after editing the workbooks
```bash
python build_data.py   # reads both xlsx -> data/rebirth_data.json
python make_panel.py   # injects data into the template -> index.html
```

- `build_data.py` extracts the normalized model (108 stages × 3 droids, 322
  requirements, 2 quarantined rows) into `data/rebirth_data.json`.
- `needed_droids_panel.html` is the editable template (with a `__DATA_JSON__`
  placeholder); `make_panel.py` produces the shippable `index.html`.
- `REBIRTH_DATA_SCHEMA.md` is the authoritative data-model spec.

## Data model (from REBIRTH_DATA_SCHEMA.md)
Each stage key `(Super Rebirth 1–4, Rebirth 1–27)` requires exactly 3 droids
`{ droid_name, droid_color }` = 108 stages, 324 rows. Rebirth is the inner
1-based counter (+1 per stage, wraps to 1 at 27); Super Rebirth is the outer
counter (+1 when Rebirth wraps). Costs are keyed per rebirth only.
