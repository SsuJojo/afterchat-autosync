#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""同步 AfterChat 上游 userscript，并在上游变化时计算下一个发布版本。

CI 用法：
    python tools/sync_upstream.py
输出（供 GitHub Actions 使用）：
    changed=true|false
    upstream=<upstream version>
    release=<release version>
仅标准库；网络请求只读上游 raw 文件。
"""

import json
import os
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION_FILE = ROOT / "version.json"
VENDOR_FILE = ROOT / "vendor" / "afterchat.user.js"
USER_AGENT = "afterchat-autosync-ci/1.0"
RE_VERSION_LINE = re.compile(r"^\s*//\s*@version\s+(\S+)\s*$", re.MULTILINE)
RE_AC_SUFFIX = re.compile(r"-ac(\d+)$", re.IGNORECASE)


class SyncError(Exception):
    pass


def load_json(path: Path) -> dict:
    if not path.is_file():
        raise SyncError(f"缺少 {path}")
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        raise SyncError(f"读取/解析 {path} 失败: {e}")
    if not isinstance(data, dict):
        raise SyncError(f"{path} 不是 JSON 对象")
    return data


def normalize(text: str) -> str:
    # 只做行尾/BOM 归一，避免把无害的行尾差异当成上游更新。
    return text.replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff")


def fetch_text(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode("utf-8-sig", errors="replace")
    except Exception as e:  # noqa: BLE001
        raise SyncError(f"下载上游脚本失败 {url}: {e}")


def validate_upstream(text: str) -> str:
    if "// ==UserScript==" not in text:
        raise SyncError("上游不是 userscript：找不到 // ==UserScript== 头。")
    versions = RE_VERSION_LINE.findall(text)
    if len(versions) != 1:
        raise SyncError(f"上游 @version 行数量异常：{len(versions)}")
    return versions[0]


def next_release(current_release: str, upstream_changed: bool) -> str:
    if upstream_changed:
        return f"{current_release.split('-ac')[0] if '-ac' in current_release else current_release}-ac1"
    m = RE_AC_SUFFIX.search(current_release)
    if not m:
        return f"{current_release}-ac1"
    return f"{current_release[:m.start()]}-ac{int(m.group(1)) + 1}"


def write_outputs(changed: bool, upstream: str, release: str) -> None:
    gh_output = os.environ.get("GITHUB_OUTPUT")
    if gh_output:
        with open(gh_output, "a", encoding="utf-8") as f:
            f.write(f"changed={'true' if changed else 'false'}\n")
            f.write(f"upstream={upstream}\n")
            f.write(f"release={release}\n")
    print(f"changed={str(changed).lower()} upstream={upstream} release={release}")


def main() -> int:
    cfg = load_json(VERSION_FILE)
    url = cfg.get("source_url")
    if not url:
        raise SyncError("version.json 缺少 source_url")
    current_upstream = cfg.get("upstream")
    current_release = cfg.get("release")
    if not current_upstream or not current_release:
        raise SyncError("version.json 缺少 upstream/release")

    new_text = fetch_text(url)
    new_upstream = validate_upstream(new_text)
    new_normalized = normalize(new_text)

    vendor_text = None
    if VENDOR_FILE.is_file():
        vendor_text = normalize(VENDOR_FILE.read_text(encoding="utf-8-sig", errors="replace"))

    content_changed = vendor_text != new_normalized
    version_changed = new_upstream != current_upstream
    changed = content_changed or version_changed

    if changed:
        VENDOR_FILE.parent.mkdir(parents=True, exist_ok=True)
        VENDOR_FILE.write_text(new_normalized, encoding="utf-8", newline="\n")
        new_release = next_release(current_release, version_changed)
        cfg["upstream"] = new_upstream
        cfg["release"] = new_release
        with VERSION_FILE.open("w", encoding="utf-8", newline="\n") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
            f.write("\n")
        write_outputs(True, new_upstream, new_release)
    else:
        write_outputs(False, new_upstream, current_release)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SyncError as e:
        print(f"错误: {e}", file=sys.stderr)
        sys.exit(2)
