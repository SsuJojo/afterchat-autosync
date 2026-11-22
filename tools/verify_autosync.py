# -*- coding: utf-8 -*-
"""静态验收：AfterChat AutoSync 交付物。不联网、不改文件。"""
import argparse
import os
import re
import sys
from pathlib import Path

DEFAULT_BASE = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description="AfterChat AutoSync 静态验收")
parser.add_argument("--base", default=str(DEFAULT_BASE), help="项目根目录，默认为本脚本所在仓库")
args = parser.parse_args()

BASE = os.path.abspath(args.base)
TOOLS = os.path.join(BASE, "tools")
MODULE = os.path.join(TOOLS, "ac-sync.module.js")
PATCH = os.path.join(TOOLS, "patch_afterchat.py")
OUT = os.path.join(BASE, "dist", "afterchat-autosync.user.js")
CONVERTER = os.path.join(BASE, "chat2deja.py")
README = os.path.join(BASE, "README.md")

failed = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (("  -- " + detail) if detail else ""))
    if not ok:
        failed.append(name)


def text(path):
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
        return f.read()


check("module exists", os.path.isfile(MODULE))
check("patch script exists", os.path.isfile(PATCH))
check("converter exists", os.path.isfile(CONVERTER))
check("README exists", os.path.isfile(README))

mod = text(MODULE) or ""
if mod:
    check("module: no IIFE wrapper", not re.search(r"^\s*\(\s*function\s*\(", mod, re.M))
    check("module: no module.exports", "module.exports" not in mod)
    # 顶层 return 检测：按花括号深度判断（模块整体缩进 2 空格且无 IIFE 包裹）
    depth = 0
    top_return = False
    for _line in mod.splitlines():
        _code = _line.split("//")[0]
        if depth <= 0 and re.search(r"\breturn\b", _code):
            top_return = True
        depth += _code.count("{") - _code.count("}")
    check("module: no top-level return", not top_return)
    all_platforms = [
        "m365", "copilot", "ima", "zai", "chatglm", "duck", "pplx",
        "deepseek", "qwen", "qianwen", "yuanbao", "hunyuan", "kimi",
        "doubao", "minimax", "aistudio", "openai", "grok", "grokcom",
        "gemini", "gaim", "arena", "mistral", "sakana", "claude",
        "poe", "monica", "stepfun", "stepfunchat",
    ]
    check("module: all 29 platforms enabled",
          all(("'" + p + "'") in mod for p in all_platforms))
    check("module: FSA directory picker", "showDirectoryPicker" in mod)
    check("module: permission query", "queryPermission" in mod and "requestPermission" in mod)
    check("module: IndexedDB handle store", "indexedDB" in mod and "acSyncDb" in mod)
    check("module: own anchor key", "ac-sync-anchor-" in mod)
    check("module: no writes to AfterChat anchor",
          not re.search(r"m365-export-anchor-[^'\"]*['\"][^)]*setItem", mod))
    check("module: read-only (no conversation creation APIs)",
          not re.search(r"createConversation|newConversation|sendChatMessage|conversation/create", mod, re.I))
    check("module: retries/failure log", "_failed" in mod and "lastError" in mod)
    check("module: scheduler 10min + boot", bool(re.search(
        r"AC_SYNC_BASE_INTERVAL\s*=\s*10\s*\*\s*60\s*\*\s*1000", mod)) and bool(re.search(
        r"AC_SYNC_BOOT_DELAY\s*=\s*15\s*\*\s*1000", mod)))
    check("module: single-flight lock", bool(re.search(r"syncing|inFlight|running", mod, re.I)))
    check("module: diagnostics hook", "__AC_SYNC__" in mod)
    check("module: stable picker id",
          "AC_SYNC_PICKER_ID" in mod and "showDirectoryPicker({ id: AC_SYNC_PICKER_ID" in mod)
    check("module: explicit select-directory action", "acSyncSelectDirectory" in mod and "选择目录" in mod)
    check("module: enable accepts reusable handle", "async function acSyncEnableSync(handle)" in mod)
    check("module: rebind forces fresh picker", bool(re.search(
        r"async function acSyncChangeDirectory\(\)[\s\S]{0,200}acSyncPickDirectory", mod)))

patch = text(PATCH) or ""
if patch:
    for flag in ("--source-file", "--source-url", "--module", "--out", "--version-tag", "--check"):
        check("patch CLI " + flag, flag in patch)
    check("patch: injection markers", "AC-SYNC BEGIN" in patch and "AC-SYNC END" in patch)
    check("patch: anchor detection", "try { initialize(); } catch {}" in patch)
    check("patch: version bump", "@version" in patch)
    check("patch: idempotent replace", bool(re.search(r"replace|find|index", patch, re.I)))

cv = text(CONVERTER) or ""
if cv:
    check("converter: SYNC root", re.search(r"^SYNC\s*=\s*os\.path\.join\(BASE,\s*[\"']_sync[\"']\)", cv, re.M) is not None)
    check("converter: --with-downloads", "--with-downloads" in cv)
    check("converter: --with-takeout", "--with-takeout" in cv)
    check("converter: skips _failed", "_failed" in cv)
    check("converter: recursive walk", "os.walk" in cv)
    check("converter: --force preserved", "--force" in cv)
    check("converter: platform hint from _sync", "platform_hint" in cv and "WEB_PLATFORM_NAMES" in cv)
    check("converter: generic Web -> Amp fallback",
          'WRITER.add("amp", conv_id, label, url, msgs)' in cv)
    check("converter: every AfterChat md gets a route",
          "platform_hint or platform_from_url(url) or \"web\"" in cv and
          "n = 1 if which else 0" in cv)

rd = text(README) or ""
if rd:
    check("README: AutoSync section", "AfterChat AutoSync" in rd)
    check("README: optional directory", "选目录" in rd or "自选" in rd)
    check("README: no daily Downloads scan", "--with-downloads" in rd)
    check("README: all-platform scope", "29 个" in rd and "全面" in rd)

if os.path.isfile(OUT):
    out = text(OUT) or ""
    check("built: one BEGIN marker", out.count("AC-SYNC BEGIN") == 1, str(out.count("AC-SYNC BEGIN")))
    check("built: one END marker", out.count("AC-SYNC END") == 1, str(out.count("AC-SYNC END")))
    check("built: version suffix", bool(re.search(r"// @version\s+\S+-ac\d+", out)))
    check("built: auto update metadata", "@updateURL" in out and "@downloadURL" in out)
    check("built: contains module", "showDirectoryPicker" in out)
    check("built: stable picker id", "AC_SYNC_PICKER_ID" in out)
else:
    print("SKIP built userscript checks (not generated yet)")

print("\n%d check(s) failed" % len(failed))
sys.exit(1 if failed else 0)
