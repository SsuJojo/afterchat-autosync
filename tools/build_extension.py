#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_extension.py — copy the patched userscript bundle into the MV3 extension.

The extension injects the exact same bundle that Tampermonkey installs, in a MAIN-world
content script.  Keeping the copy generated (rather than committed by hand) prevents the
extension and the userscript from drifting apart.

Usage:
    python -X utf8 tools/build_extension.py
    python -X utf8 tools/build_extension.py --check
"""

import argparse
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DIST = REPO_ROOT / "dist" / "afterchat-autosync.user.js"
VENDOR = REPO_ROOT / "vendor" / "afterchat.user.js"
VERSION_FILE = REPO_ROOT / "version.json"
MANIFEST = REPO_ROOT / "extension" / "manifest.json"
OUT = REPO_ROOT / "extension" / "patched.user.js"

RE_MATCH = re.compile(r"^//\s*@match\s+(\S+)\s*$", re.MULTILINE)


def read_text(path: Path) -> str:
    return path.read_bytes().decode("utf-8-sig", errors="replace").replace("\r\n", "\n")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="only verify, do not write")
    ap.add_argument("--sync-version", action="store_true",
                    help="write version.json.release into extension/manifest.json before building")
    args = ap.parse_args()

    for p in (DIST, VENDOR, MANIFEST, VERSION_FILE):
        if not p.is_file():
            print(f"missing required file: {p}", file=sys.stderr)
            return 1

    release = json.loads(read_text(VERSION_FILE))["release"]
    manifest = json.loads(read_text(MANIFEST))
    if args.sync_version and manifest.get("version") != release:
        manifest["version"] = release
        MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"synced manifest version -> {release}")
    elif manifest.get("version") != release:
        print(f"version mismatch: manifest {manifest.get('version')} != version.json {release}; "
              "run with --sync-version", file=sys.stderr)
        return 1

    bundle = read_text(DIST)
    if "// >>> AC-SYNC BEGIN <<<" not in bundle or "// >>> AC-SYNC END <<<" not in bundle:
        print("dist bundle is missing the AC-SYNC block; run patch_afterchat.py first", file=sys.stderr)
        return 1

    header_matches = RE_MATCH.findall(read_text(VENDOR))
    manifest_text = read_text(MANIFEST)
    # Every upstream @match must be present as a manifest host permission / content-script match.
    missing = [m for m in header_matches if f'"{m}"' not in manifest_text]
    if missing:
        print("manifest is missing match patterns: " + ", ".join(missing), file=sys.stderr)
        return 1

    if args.check:
        if not OUT.is_file() or read_text(OUT) != bundle:
            print(f"{OUT} is missing or stale; run build_extension.py", file=sys.stderr)
            return 1
        print(f"extension bundle OK ({len(bundle)} bytes, {len(header_matches)} match patterns)")
        return 0

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(bundle.encode("utf-8"))
    print(f"wrote {OUT.relative_to(REPO_ROOT)} ({len(bundle)} bytes, {len(header_matches)} match patterns)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
