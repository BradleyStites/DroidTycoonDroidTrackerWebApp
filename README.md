# Droid Tycoon — Needed Droids Tracker

A self-contained panel that shows which droids are required for each rebirth
stage of the Droid Tycoon grind, built from the project's two workbooks
(`Driod Tycoon Rebirth.xlsx` + `Droid Tycoon Stats.xlsx`).

https://docs.google.com/spreadsheets/d/1us4tKuFXJ9LJVVsu1ZOyyu-ENkWXz3zUGQ-jHMCNpQc/edit?usp=sharing

## Installation

### Prerequisites
- **Operating system:** Windows 10+, macOS, or Linux. No OS-specific steps are required.
- **Python 3.8+** — used by the data-build scripts (`build_data.py`, `make_panel.py`, `build_db.py`). Check with:
  ```bash
  python --version
  ```
- **`openpyxl`** (Python library) — required only if you regenerate the data/DB from the source `.xlsx` workbooks. Install once with:
  ```bash
  pip install openpyxl
  ```
  (Use `pip3` if `pip` is not on your PATH.)
- **Node.js 22.5+** — required only for the live web UI server (`webui/server.js`). It uses Node's built-in `node:sqlite` module, so **no `npm install` is needed**. Check with:
  ```bash
  node --version
  ```

> Note: the shippable `index.html` already has its data inlined, and
> `webui/droid_tycoon.db` is committed, so a brand-new user can run the app
> immediately without installing anything. The steps above are only needed to
> edit the data pipeline or run the live server.

### Getting the code
Clone or download this repository, then open a terminal in the project root:
```bash
cd DroidTycoon
```
(On Windows you can also use Git Bash, PowerShell, or the normal Command Prompt.)

## Running the Application

There are two ways to use the tracker — pick whichever you need.

### Option A — Open the static panel (no setup)
The tracker is a self-contained HTML file; just open it in any browser:
- **Windows:** double-click `index.html`, or run `start index.html` from the
  project root.
- **macOS/Linux:** open `index.html` in your browser, or run `xdg-open index.html`.

No server, Python, or Node is required. The data is inlined into the page.

### Option B — Run the live web UI server
The `webui/` folder contains a Node.js server that serves the admin panel and
the droid tracker, backed live by `webui/droid_tycoon.db`.

1. Open a terminal and enter the server folder:
   ```bash
   cd webui
   ```
2. Start the server:
   ```bash
   node server.js
   ```
   Leave this terminal running in the background. On startup it prints:
   `Droid Tycoon UI running at http://localhost:8787`
3. Open the following URLs in your browser:
   - **Admin panel:** http://localhost:8787/
   - **Droid tracker:** http://localhost:8787/droidtycoon

**Stopping the server:** press `Ctrl+C` in that terminal.

#### Optional environment configuration
- **Change the port** (default `8787`):
  ```bash
  PORT=3000 node server.js      # macOS/Linux
  set PORT=3000 && node server.js   # Windows cmd
  $env:PORT=3000; node server.js    # Windows PowerShell
  ```

## Image
- Main Tracker Dashboard
![Screenshot](https://github.com/BradleyStites/DroidTycoonDroidTrackerWebApp/blob/main/Screenshot.png "Screenshot")
- Admin Panel
 **WIP**

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

## How to Operate
Navigate to the webui folder in the terminal and run: `node server.js` That 
will populate a local web server. Make sure to leave the terminal running 
in the background and navigate your browser to the URL designated 
in the termal. The default is URL is the admin panel, to access the droid
tracker - navigate to `{Provided URL}\droidtracker` 
(ex: [localhost://](http://localhost:8787/droidtycoon) in my case).




## Future Improvements
Future updates will integrate the droid checklist with the upcoming droids section, enabling users to mark off collected droids. This functionality will automatically filter the list based on color and completion status, thereby optimizing screen space and streamlining data presentation.
