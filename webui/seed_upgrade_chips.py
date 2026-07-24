#!/usr/bin/env python3
"""
seed_upgrade_chips.py

Populate (or refresh) the `rebirth_upgrade_chips` table in droid_tycoon.db from
the Stats workbook's `Upgrade Chips Calculations` sheet.

That sheet logs the player's accumulated Upgrade Chips at each
(Super Rebirth, Rebirth) stage. The *highest* reading for each stage is taken
as that stage's chip total — matching how the in-game resource only ever grows.

This is split out of build_db.py so the chips can be re-seeded (e.g. after a
workbook update) without rebuilding the entire database and losing the live
player_stage / edited droid_rebirths state.

Usage:
    python seed_upgrade_chips.py            # seeds the local droid_tycoon.db
    python seed_upgrade_chips.py --replace  # wipe + reseed instead of upsert
"""

import argparse
import os
import sqlite3

import openpyxl

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(BASE)  # DroidTycoon/
STATS_XLSX = os.path.join(
    ROOT, "Droid Tycoon Stat Tracking", "Droid Tycoon Stats.xlsx"
)
DB_PATH = os.path.join(BASE, "droid_tycoon.db")


def extract_chip_rows(path):
    """Return [(super_rebirth, rebirth, chips), ...] keyed per stage.

    The highest reading per (SR, RB) stage wins, since the resource only grows.
    """
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb["Upgrade Chips Calculations"]
    best = {}  # (sr, rb) -> chips
    header_skipped = False
    for row in ws.iter_rows(values_only=True):
        if not header_skipped:
            # Header row: SR, R, Upgrade Chips, Time, Delta, Time Delta, Chips/Min
            header_skipped = True
            continue
        if not row or row[0] is None:
            continue
        sr, rb = row[0], row[1]
        chips = row[2] if len(row) > 2 else None
        if sr is None or rb is None or chips is None:
            continue
        # Guard against a stray header/blank line slipping through.
        try:
            key = (int(sr), int(rb))
        except (TypeError, ValueError):
            continue
        val = float(chips)
        if key not in best or val > best[key]:
            best[key] = val
    wb.close()
    return [(sr, rb, chips) for (sr, rb), chips in sorted(best.items())]


def main():
    if not os.path.exists(STATS_XLSX):
        raise SystemExit(f"Missing stats workbook: {STATS_XLSX}")
    if not os.path.exists(DB_PATH):
        raise SystemExit(f"Missing database: {DB_PATH}\nRun: python build_db.py")

    chip_rows = extract_chip_rows(STATS_XLSX)

    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS rebirth_upgrade_chips (
            super_rebirth INTEGER NOT NULL,
            rebirth       INTEGER NOT NULL,
            chips         REAL    NOT NULL,
            PRIMARY KEY (super_rebirth, rebirth)
        )
        """
    )
    if ARGS.replace:
        cur.execute("DELETE FROM rebirth_upgrade_chips")
    cur.executemany(
        "INSERT OR REPLACE INTO rebirth_upgrade_chips (super_rebirth, rebirth, chips) VALUES (?,?,?)",
        chip_rows,
    )
    con.commit()
    n = cur.execute("SELECT COUNT(*) FROM rebirth_upgrade_chips").fetchone()[0]
    con.close()

    print(f"Seeded {len(chip_rows)} upgrade-chip rows (table now has {n}).")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Seed rebirth upgrade chips.")
    parser.add_argument(
        "--replace",
        action="store_true",
        help="wipe the table before seeding (default: upsert)",
    )
    ARGS = parser.parse_args()
    main()
