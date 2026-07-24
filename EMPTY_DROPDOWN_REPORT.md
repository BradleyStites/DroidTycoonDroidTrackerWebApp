# Bug Report: Empty Dropdown in the "Needed Droids" Panel

## Summary (one line)
The "Needed Droids Tracker" template file `needed_droids_panel.html` is opened
directly, but it still contains its `__DATA_JSON__` build placeholder instead of
real data — so `JSON.parse("__DATA_JSON__")` throws, and the two `<select>`
dropdowns never get their `<option>` children. They render empty.

## Where the bug is
File: `needed_droids_panel.html`  (repo root of Droid Tycoon)
Line 158:
    <script id="data" type="application/json">__DATA_JSON__</script>

The inline `<script id="data">` is meant to be replaced at build time by
`make_panel.py` with a JSON blob. In the raw template it still reads the
literal text `__DATA_JSON__`.

## The failure chain (verified by running the page's exact code path)
1. `needed_droids_panel.html` line 160:
       const DATA = JSON.parse(document.getElementById('data').textContent);
   `textContent` is the string `"__DATA_JSON__"`.
2. `JSON.parse("__DATA_JSON__")` throws `Unexpected token '_'` immediately.
3. Because this is a top-level statement, the exception aborts the entire
   `<script>` block. None of the code after it runs.
4. The dropdown-population loop (lines 193-198) never executes:
       const srSel = document.getElementById('cur-sr');
       const rbSel = document.getElementById('cur-rb');
       for (let s=SR_MIN; s<=SR_MAX; s++) srSel.add(new Option('SR '+s, s));
       for (let r=RB_MIN; r<=RB_MAX; r++) rbSel.add(new Option('R '+r, r));
   So `<select id="cur-sr">` and `<select id="cur-rb">` keep their zero
   `<option>` children → the dropdowns show NO options ("empty dropdown").

A secondary symptom: every other panel (Rebirth Map grid, Stage Detail,
Upcoming, Checklist, Legend) also stays blank, because their render functions
run later in the same aborted script.

## Expected data shape (what `__DATA_JSON__` SHOULD be replaced with)
A JSON object matching `data/rebirth_data.json` (produced by `build_data.py`),
with at minimum these fields the template reads:
    {
      "super_cycle_range": [1, 4],          // drives cur-sr options (4)
      "rebirth_range":     [1, 27],         // drives cur-rb options (27)
      "stages": { "1-1": { super_rebirth, rebirth, droids:[{droid_name,droid_color}...] }, ... },  // 108 stages
      "totals":   { stages, super_cycles, rebirths_per_cycle, droids_total, distinct_droid_names },
      "droids_per_stage": 3,
      "reference": { droids:[...65], colors:[...], ranks:[...], super_cycles:[...], rebirths:[...] },
      "quarantined": [ ... ],
      "cost_curve": { ... }
    }

## Missing data path (root cause = no data, not a code logic error)
The template has NO data because the build step was never run (or the template
was opened instead of the built output). The intended pipeline:

    build_data.py   ──reads──▶  Droid Tycoon Rebirth Tracking System/Driod Tycoon Rebirth.xlsx
                  ──reads──▶  Droid Tycoon Stat Tracking/Droid Tycoon Stats.xlsx
                  ──writes─▶  data/rebirth_data.json

    make_panel.py   ──reads──▶  data/rebirth_data.json  +  needed_droids_panel.html (template)
                  ──writes─▶  index.html  (data inlined, placeholder REPLACED)

The built `index.html` (already present, 41 KB) DOES contain the inlined data
and works — its dropdowns populate 4 + 27 options and the grid renders. So the
fix is to open/serve `index.html`, not `needed_droids_panel.html`.

## Verification performed
- Ran the template's exact parse call against the literal `__DATA_JSON__` ->
  `JSON.parse` throws (reproduced the empty-dropdown cause deterministically).
- Confirmed the built `index.html` parses OK and would get superRebirth=4,
  rebirth=27 options, stages=108.
- Confirmed the OTHER "needed droids" system (the live `webui/` server app) is
  unaffected: `GET /api/filters` returns 4 super cycles, 27 rebirth levels,
  65 droids, 7 colors; all dropdowns there populate correctly.

## Fix (for the next worker)
Either:
  (a) Open the built `index.html` (data already inlined) — no code change
      needed; OR
  (b) Regenerate it: `python build_data.py && python make_panel.py`
      (requires openpyxl; the two source xlsx workbooks must be present).

The template file itself is working as designed — it is not meant to be opened
directly; it is a build input. If users keep double-clicking it, the practical
fix is to (1) point them at `index.html`, and/or (2) make the template fail
loudly when the placeholder is still present (e.g. render a "run make_panel.py"
banner) instead of a silent empty page.
