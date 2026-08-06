"""Restore the YGO activity-bar iconUrl in Cursor/VS Code state.

Cursor sometimes keeps the view container pinned but drops iconUrl (so you get
an empty slot, or nothing visible). Flutter-style entries always have iconUrl.
Run with Cursor fully quit when possible; if Cursor is open, reload after.

  python fix-activity-icon-cache.py
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import time
from pathlib import Path

HOME = Path.home()
APPDATA = Path(os.environ["APPDATA"])

TARGETS = [
    (
        APPDATA / "Cursor" / "User" / "globalStorage" / "state.vscdb",
        HOME / ".cursor" / "extensions" / "ygo-duel" / "media" / "icon.svg",
    ),
    (
        APPDATA / "Code" / "User" / "globalStorage" / "state.vscdb",
        HOME / ".vscode" / "extensions" / "ygo-duel" / "media" / "icon.svg",
    ),
]

VIEW_ID = "workbench.view.extension.ygoDuel"


def to_vscode_path(p: Path) -> str:
    s = str(p.resolve()).replace("\\", "/")
    if len(s) >= 2 and s[1] == ":":
        return "/" + s[0].lower() + s[1:]
    return s


def icon_url(icon_path: Path) -> dict:
    return {"$mid": 1, "path": to_vscode_path(icon_path), "scheme": "file"}


def fix_placeholders(data: list, icon_path: Path) -> bool:
    changed = False
    found = False
    for item in data:
        if item.get("id") != VIEW_ID:
            continue
        found = True
        new = icon_url(icon_path)
        old = item.get("iconUrl")
        item["iconUrl"] = new
        item["name"] = item.get("name") or "YGO Duel Mode"
        item["isBuiltin"] = False
        if "views" not in item:
            item["views"] = [{}]
        print(f"  placeholder iconUrl: {old} -> {new}")
        changed = True
    if not found:
        data.append(
            {
                "id": VIEW_ID,
                "iconUrl": icon_url(icon_path),
                "name": "YGO Duel Mode",
                "isBuiltin": False,
                "views": [{}],
            }
        )
        print("  inserted missing placeholder entry")
        changed = True
    return changed


def fix_pinned(data: list) -> bool:
    """Keep YGO pinned and move it near the top so it is not buried in overflow."""
    changed = False
    found = False
    for item in data:
        if item.get("id") != VIEW_ID:
            continue
        found = True
        if item.get("order", 99) > 5 or not item.get("pinned", False):
            print(f"  pinned order {item.get('order')} -> 5, pinned=True")
            item["order"] = 5
            item["pinned"] = True
            changed = True
    if not found:
        data.append(
            {"id": VIEW_ID, "pinned": True, "visible": False, "order": 5}
        )
        print("  inserted missing pinned entry")
        changed = True
    return changed


def fix(db_path: Path, icon_path: Path) -> None:
    if not db_path.is_file():
        print(f"skip (missing): {db_path}")
        return
    if not icon_path.is_file():
        print(f"skip (no icon at): {icon_path}")
        return

    bak = db_path.with_name(db_path.name + f".bak-ygo-{int(time.time())}")
    shutil.copy2(db_path, bak)
    print(f"backup: {bak}")

    con = sqlite3.connect(str(db_path))
    cur = con.cursor()

    def load(key: str):
        row = cur.execute(
            "SELECT value FROM ItemTable WHERE key=?", (key,)
        ).fetchone()
        if not row:
            return None
        raw = row[0]
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        return json.loads(raw)

    def save(key: str, value) -> None:
        cur.execute(
            "UPDATE ItemTable SET value=? WHERE key=?",
            (json.dumps(value, ensure_ascii=False), key),
        )

    changed = False
    ph = load("workbench.activity.placeholderViewlets")
    if ph is None:
        print("no placeholderViewlets key")
    else:
        if fix_placeholders(ph, icon_path):
            save("workbench.activity.placeholderViewlets", ph)
            changed = True

    pinned = load("workbench.activity.pinnedViewlets2")
    if pinned is None:
        print("no pinnedViewlets2 key")
    else:
        if fix_pinned(pinned):
            save("workbench.activity.pinnedViewlets2", pinned)
            changed = True

    if changed:
        con.commit()
        print(f"updated {db_path}")
    else:
        print(f"no changes needed in {db_path}")
    con.close()


def main() -> None:
    for db, icon in TARGETS:
        print(f"\n=== {db} ===")
        try:
            fix(db, icon)
        except sqlite3.OperationalError as e:
            print(f"FAILED ({e}). Fully quit Cursor/VS Code and re-run.")


if __name__ == "__main__":
    main()
