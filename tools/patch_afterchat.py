#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_afterchat.py — 把 ac-sync.module.js 注入 AfterChat 上游 userscript，产出可安装的
afterchat-autosync.user.js。

用法（Python 3, 仅标准库）:
  python patch_afterchat.py                          # 用缓存上游 + 本地模块生成产物
  python patch_afterchat.py --source-url <RAW_URL>   # 先联网拉上游（脚本负责，调用方自己跑）
  python patch_afterchat.py --check                  # 只校验已存在的产物，不写文件

设计要点（见 PLAN-AfterChat-AutoSync.md AC6）:
  - 注入口: `try { initialize(); } catch {}`（IIFE 内，可访问 PLATFORM_ADAPTERS 等闭包成员）；
    找不到时回退到注释 `// ---- 启动（不要改） ----`（先在其后几十行内再找 initialize 调用行）。
  - 模块用 BEGIN/END 标记包裹，幂等：已有块则原地整体替换，绝不重复。
  - @version 追加 -<tag>（默认 -ac1），幂等：先剥掉旧 -acN 再追加。
  - 默认写入 @updateURL/@downloadURL，指向 GitHub latest Release，供 Tampermonkey 自动升级。
  - @name/@namespace 不动，Tampermonkey 同名覆盖旧脚本槽位。
"""

import argparse
import re
import sys
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE_FILE = REPO_ROOT / "vendor" / "afterchat.user.js"
DEFAULT_MODULE = REPO_ROOT / "tools" / "ac-sync.module.js"
DEFAULT_OUT = REPO_ROOT / "dist" / "afterchat-autosync.user.js"
DEFAULT_VERSION_TAG = "ac1"
DEFAULT_UPDATE_URL = "https://github.com/SsuJojo/afterchat-autosync/releases/latest/download/afterchat-autosync.user.js"
DEFAULT_DOWNLOAD_URL = DEFAULT_UPDATE_URL

BEGIN_MARKER = "// >>> AC-SYNC BEGIN <<<"
END_MARKER = "// >>> AC-SYNC END <<<"

# 注入点：IIFE 结尾的初始化调用（前后允许任意空白/换行差异）
RE_INJECT = re.compile(r"^\s*try\s*\{\s*initialize\(\)\s*;\s*\}\s*catch\s*(\(\s*\))?\s*\{?\s*\}?\s*$")
# 回退锚点：启动注释（上游注释文字，若上游改版可能失效）
FALLBACK_COMMENT = "// ---- 启动"
# 版本后缀 -acN（幂等剥离用）
RE_VERSION_TAG_SUFFIX = re.compile(r"-ac\d+$", re.IGNORECASE)
AUTO_SYNC_NOTE = "（含 AC AutoSync 自动同步模块）"


class PatchError(Exception):
    """致命错误：给用户一条清楚的话，绝不静默产出坏脚本。"""


def read_text(path: Path, what: str) -> str:
    if not path.is_file():
        raise PatchError(f"{what}不存在: {path}")
    try:
        raw = path.read_bytes()
    except OSError as e:
        raise PatchError(f"读取{what}失败 {path}: {e}")
    # 容忍 UTF-8 BOM；容错解码（实际应为合法 UTF-8）
    text = raw.decode("utf-8-sig", errors="replace")
    # 容忍 CRLF，统一为 \n
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return text


def fetch_url(url: str) -> str:
    """可选功能：拉取上游 raw userscript。注意：本脚本实现它但调用者自行决定是否联网。"""
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "patch_afterchat.py/1.0 (+local packaging tool)"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
    except Exception as e:  # noqa: BLE001 — 网络错误种类太多，统一报清楚
        raise PatchError(f"下载上游脚本失败 {url}: {e}")
    text = data.decode("utf-8-sig", errors="replace")
    return text.replace("\r\n", "\n").replace("\r", "\n")


def validate_upstream(lines: list) -> None:
    if not any(ln.strip() == "// ==UserScript==" for ln in lines):
        raise PatchError("上游不是 userscript：找不到 `// ==UserScript==` 头。")
    if not any(ln.lstrip().startswith("// @version") for ln in lines):
        raise PatchError("上游缺少 `// @version` 元数据行。")


def find_inject_index(lines: list) -> tuple:
    """返回 (行下标0based, 用了哪个锚点)。找不到任何锚点则 raise。"""
    hits = [i for i, ln in enumerate(lines) if RE_INJECT.match(ln)]
    if len(hits) > 1:
        raise PatchError(
            f"注入口不唯一：找到 {len(hits)} 处 `try {{ initialize(); }}`，"
            "上游结构可能已大改，拒绝盲拼。"
        )
    if len(hits) == 1:
        return hits[0], "initialize 调用行"

    fb = [i for i, ln in enumerate(lines) if FALLBACK_COMMENT in ln]
    if not fb:
        raise PatchError(
            "找不到注入锚点：既没有 `try { initialize(); } catch {}`，"
            "也没有回退注释 `// ---- 启动（不要改） ----`。"
            "上游结构可能已大改，拒绝产出可能损坏的脚本。"
        )
    i = fb[0]
    # 回退注释通常紧邻 initialize 调用，在其后 30 行内再精确找一次
    for j in range(i + 1, min(i + 31, len(lines))):
        if RE_INJECT.match(lines[j]):
            return j, "回退注释后定位到的 initialize 调用行"
    return i, "回退注释行（紧邻其前插入）"


def strip_existing_block(lines: list) -> tuple:
    """移除已有的 BEGIN..END 块（含标记行）。返回 (新行列表, 是否移除过)。"""
    begins = [i for i, ln in enumerate(lines) if BEGIN_MARKER in ln]
    ends = [i for i, ln in enumerate(lines) if END_MARKER in ln]
    if not begins and not ends:
        return lines, False
    if len(begins) != 1 or len(ends) != 1:
        raise PatchError(
            f"上游产物中 AC-SYNC 标记异常（BEGIN×{len(begins)}, END×{len(ends)}），"
            "请手工检查后重跑。"
        )
    b, e = begins[0], ends[0]
    if e < b:
        raise PatchError("AC-SYNC 标记顺序错误（END 在 BEGIN 之前），请手工检查。")
    return lines[:b] + lines[e + 1:], True


def build_block(module_text: str) -> list:
    if BEGIN_MARKER in module_text or END_MARKER in module_text:
        raise PatchError("模块文件里已包含 AC-SYNC 标记字符串，会造成嵌套，拒绝注入。")
    module_text = module_text.strip("\n")
    # 不追加尾随空行：否则反复 patch 时空行会在块前后漂移，破坏逐字节幂等
    block = ["  " + BEGIN_MARKER, module_text, "  " + END_MARKER]
    return block


def bump_version(lines: list, tag: str) -> tuple:
    """@version 追加 -<tag>，幂等。返回 (新行列表, 旧版本, 新版本)。"""
    out = []
    old = new = None
    for ln in lines:
        m = re.match(r"^(\s*//\s*@version\s+)(.+?)\s*$", ln)
        if m and new is None:
            old = m.group(2)
            base = RE_VERSION_TAG_SUFFIX.sub("", old)
            new = f"{base}-{tag}"
            out.append(f"{m.group(1)}{new}")
        else:
            out.append(ln)
    if new is None:
        raise PatchError("找不到 `// @version` 行，无法打版本后缀。")
    return out, old, new


def set_update_urls(lines: list, update_url: str, download_url: str) -> list:
    """写入 Tampermonkey 自动更新元数据（幂等）。空参数表示不写对应行。"""
    update_url = (update_url or "").strip()
    download_url = (download_url or "").strip()
    if not update_url and not download_url:
        return lines

    out = []
    inserted = False
    for ln in lines:
        stripped = ln.lstrip()
        if stripped.startswith("// @updateURL") or stripped.startswith("// @downloadURL"):
            continue  # 移除旧值，保证重复打包不堆叠
        out.append(ln)
        if not inserted and stripped.startswith("// @version"):
            if update_url:
                out.append(f"// @updateURL    {update_url}")
            if download_url:
                out.append(f"// @downloadURL  {download_url}")
            inserted = True

    if not inserted:
        raise PatchError("找不到 `// @version` 行，无法插入 updateURL/downloadURL。")
    return out


def annotate_description(lines: list) -> list:
    """给 @description:zh-CN 追加自动同步说明（幂等，找不到就跳过）。"""
    out = []
    done = False
    for ln in lines:
        if not done and ln.lstrip().startswith("// @description:zh-CN"):
            if "AutoSync" not in ln:
                ln = ln.rstrip("\n") + AUTO_SYNC_NOTE
            done = True
        out.append(ln)
    return out


def write_output(path: Path, text: str) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not text.endswith("\n"):
        text += "\n"
    data = text.encode("utf-8")
    path.write_bytes(data)
    return len(data)


def patch(args) -> int:
    # 1) 读上游
    if args.source_url:
        source = fetch_url(args.source_url)
        src_label = args.source_url
    else:
        src_path = Path(args.source_file)
        source = read_text(src_path, "上游脚本")
        src_label = str(src_path)

    lines = source.split("\n")
    validate_upstream(lines)

    # 2) 读模块（此文件由另一任务并行维护，缺失时报清楚即可）
    module_path = Path(args.module)
    module_text = read_text(module_path, "AC-SYNC 模块")
    module_line_count = len([ln for ln in module_text.strip("\n").split("\n")]) if module_text.strip() else 0

    # 3) 幂等清理旧注入块
    lines, replaced = strip_existing_block(lines)

    # 4) 定位注入点（在清理后的文本上）
    idx, anchor_kind = find_inject_index(lines)

    # 5) 版本、描述与自动更新元数据
    lines, old_ver, new_ver = bump_version(lines, args.version_tag)
    lines = annotate_description(lines)
    lines = set_update_urls(lines, args.update_url, args.download_url)

    # 6) 插入模块块（在注入行之前，IIFE 内）
    block = build_block(module_text)
    out_lines = lines[:idx] + block + lines[idx:]

    out_text = "\n".join(out_lines)
    out_path = Path(args.out)
    size = write_output(out_path, out_text)

    # 注入行在产物中的行号（1-based）：模块块插在它前面
    inject_line_no = idx + 1 + len(block)

    print("=== patch_afterchat 完成 ===")
    print(f"上游          : {src_label}")
    print(f"锚点          : {anchor_kind}")
    print(f"模块          : {module_path} ({module_line_count} 行)")
    print(f"输出          : {out_path}")
    print(f"大小          : {size} bytes")
    print(f"版本          : {old_ver} -> {new_ver}")
    print(f"注入行号(产物): {inject_line_no} (紧邻 `try {{ initialize(); }}` 之前)")
    print(f"旧注入块      : {'已原地替换' if replaced else '无（首次注入）'}")
    return 0


def check(args) -> int:
    """--check：只校验产物，不写。"""
    out_path = Path(args.out)
    reasons = []
    ok = True

    try:
        text = read_text(out_path, "产物脚本")
    except PatchError as e:
        print(f"FAIL: {e}")
        return 1

    lines = text.split("\n")
    begins = [i for i, ln in enumerate(lines) if BEGIN_MARKER in ln]
    ends = [i for i, ln in enumerate(lines) if END_MARKER in ln]

    if len(begins) != 1:
        ok = False
        reasons.append(f"BEGIN 标记数量为 {len(begins)}（应恰为 1）")
    if len(ends) != 1:
        ok = False
        reasons.append(f"END 标记数量为 {len(ends)}（应恰为 1）")
    if len(begins) == 1 and len(ends) == 1 and ends[0] <= begins[0]:
        ok = False
        reasons.append(f"标记顺序错误: BEGIN@{begins[0] + 1} >= END@{ends[0] + 1}")

    # 版本后缀
    ver_lines = [ln for ln in lines if ln.lstrip().startswith("// @version")]
    if len(ver_lines) != 1:
        ok = False
        reasons.append(f"@version 行数量为 {len(ver_lines)}（应恰为 1）")
    else:
        ver = ver_lines[0].split("// @version", 1)[1].strip()
        if not re.search(r"-ac\d+$", ver, re.IGNORECASE):
            ok = False
            reasons.append(f"@version `{ver}` 缺少 -acN 后缀")
        elif args.version_tag and not ver.lower().endswith(f"-{args.version_tag.lower()}"):
            reasons.append(f"注意: 版本后缀不是 -{args.version_tag} 而是整个 `{ver}`（仅提示）")

    # 自动更新元数据
    for key, expected in (("updateURL", args.update_url), ("downloadURL", args.download_url)):
        expected = (expected or "").strip()
        if not expected:
            continue
        url_hits = [ln for ln in lines if ln.lstrip().startswith(f"// @{key}")]
        got = url_hits[0].split(f"// @{key}", 1)[1].strip() if len(url_hits) == 1 else None
        if got != expected:
            ok = False
            reasons.append(f"@{key} 数量/值异常：期望 `{expected}`，实际 `{got}`")

    # 注入点仍应存在且在块之后
    inject_hits = [i for i, ln in enumerate(lines) if RE_INJECT.match(ln)]
    if len(inject_hits) != 1:
        ok = False
        reasons.append(f"`try {{ initialize(); }}` 行数量为 {len(inject_hits)}（应恰为 1）")
    elif begins and inject_hits[0] <= begins[0]:
        ok = False
        reasons.append("注入块不在 initialize 调用之前（顺序异常）")

    if ok:
        print("PASS: 产物结构完好"
              + (f"；版本 {ver_lines[0].split('// @version', 1)[1].strip()}" if ver_lines else "")
              + (f"；注入块 @ {begins[0] + 1}–{ends[0] + 1}" if begins and ends else ""))
        for r in reasons:  # 仅提示级别
            print(f"  note: {r}")
        return 0
    print("FAIL:")
    for r in reasons:
        print(f"  - {r}")
    return 1


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        description="把 ac-sync.module.js 注入 AfterChat 上游 userscript，产出可安装的合并版脚本。",
    )
    p.add_argument("--source-file", default=DEFAULT_SOURCE_FILE,
                   help=f"上游 userscript 路径（默认 {DEFAULT_SOURCE_FILE}）")
    p.add_argument("--source-url", default=None,
                   help="可选：直接拉取上游 raw URL（优先于 --source-file；会发起网络请求）")
    p.add_argument("--module", default=DEFAULT_MODULE,
                   help=f"要注入的 AC-SYNC 模块路径（默认 {DEFAULT_MODULE}）")
    p.add_argument("--out", default=DEFAULT_OUT,
                   help=f"输出路径（默认 {DEFAULT_OUT}）")
    p.add_argument("--version-tag", default=DEFAULT_VERSION_TAG,
                   help=f"@version 后缀标签（默认 {DEFAULT_VERSION_TAG}，产物形如 1.24.1-ac1）")
    p.add_argument("--update-url", default=DEFAULT_UPDATE_URL,
                   help=f"写入 @updateURL 的稳定地址（默认 GitHub latest Release）")
    p.add_argument("--download-url", default=DEFAULT_DOWNLOAD_URL,
                   help=f"写入 @downloadURL 的稳定地址（默认 GitHub latest Release）")
    p.add_argument("--check", action="store_true",
                   help="只校验已存在的输出文件，不写不注入")
    args = p.parse_args(argv)

    try:
        if args.check:
            return check(args)
        return patch(args)
    except PatchError as e:
        print(f"错误: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
