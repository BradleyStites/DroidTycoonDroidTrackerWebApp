#!/usr/bin/env python
"""
make_panel.py
Injects the extracted data model into the panel template and writes a fully
self-contained index.html (data inline, so it opens from file:// with no server).

Run order:
  python build_data.py   # produce data/rebirth_data.json
  python make_panel.py   # produce index.html
"""
import json
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(ROOT, "needed_droids_panel.html")
DATA = os.path.join(ROOT, "data", "rebirth_data.json")
OUT = os.path.join(ROOT, "index.html")

PLACEHOLDER = "__DATA_JSON__"


def main():
    if not os.path.exists(DATA):
        raise SystemExit("data/rebirth_data.json not found. Run build_data.py first.")
    with open(TEMPLATE, "r", encoding="utf-8") as f:
        tpl = f.read()
    with open(DATA, "r", encoding="utf-8") as f:
        model = json.load(f)

    # Compact JSON inline (keep unicode readable)
    payload = json.dumps(model, ensure_ascii=False, separators=(",", ":"))
    if PLACEHOLDER not in tpl:
        raise SystemExit(f"placeholder {PLACEHOLDER!r} missing from template.")
    html = tpl.replace(PLACEHOLDER, payload)

    with open(OUT, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"Wrote {OUT} ({len(html)} bytes, data inline)")


if __name__ == "__main__":
    main()
