#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
chat2deja.py — 把 ChatGPT / Gemini / Grok 网页对话导出转成 deja 三个空闲源的本地格式。

输入（按内容自动识别，不靠文件名）：
  A. ChatGPT 备份插件 zip   — accounts/*/conversations/*.json
  B. ChatGPT 官方导出 zip   — conversations.json
  C. Gemini 官方 Takeout zip/json — 我的活动/Gemini Apps/我的活动记录.json
     新格式(2026+)：title="Prompted <提问>" + details[].url=对话URL + safeHtmlItem[].html=<回复HTML>
     老格式：titleUrl + details Request/Response、userInteractions
  D. Grok 官方导出 zip/json — prod-grok-backend.json
  E. AfterChat 增量 zip/md — Markdown（## Metadata / - **URL:** … / ### 🧑‍💻 User / ### 🤖 Assistant）

输出（幂等；内容没变就不重写，避免 deja 无谓重读）：
  amp-threads\<id>.json                                  ChatGPT → Amp thread      (DEJA_AMP_ROOT)
  gemini-home\tmp\Gemini\chats\<id>.jsonl                Gemini  → Gemini CLI      (DEJA_GEMINI_ROOT)
  grok-home\sessions\<enc-cwd>\<id>\{summary,updates}    Grok    → Grok CLI        (DEJA_GROK_ROOT）

合并规则：同一对话多来源（官方底档 + AfterChat 增量）按 (role,text) 跨来源去重；
同来源内的重复发言（例如连说两次“继续”）保留，不会误删。
"""
import sys, os, json, re, hashlib, zipfile, urllib.parse
from datetime import datetime, timezone, timedelta
from html.parser import HTMLParser

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

BASE = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.path.join(BASE, "_state")
INBOX = os.path.join(BASE, "_inbox")
SYNC = os.path.join(BASE, "_sync")
AMP = os.path.join(BASE, "amp-threads")
GEM = os.path.join(BASE, "gemini-home", "tmp")
GRK = os.path.join(BASE, "grok-home", "sessions")
STATE_FILE = os.path.join(STATE_DIR, "processed.jsonl")
GDRIVE_TAKEOUT = r"G:\我的云端硬盘\Takeout"

USAGE = r"""用法: python chat2deja.py [选项]

默认只扫描 _inbox + _sync（递归，含 _sync 下的 <平台> 子目录；_failed 子目录跳过）。
  --force          忽略处理记录，全部重新转换（输出幂等，通常不需要）
  --with-downloads 一次性回填：额外扫描 ~/Downloads
  --with-takeout   一次性回填：额外扫描 G:\我的云端硬盘\Takeout
  -h, --help       显示本帮助（不写盘）
"""

if __name__ == "__main__" and ("--help" in sys.argv[1:] or "-h" in sys.argv[1:]):
    print(USAGE)
    sys.exit(0)

for d in (STATE_DIR, INBOX, SYNC, AMP, GEM, GRK):
    os.makedirs(d, exist_ok=True)

TZ = timezone(timedelta(hours=8))  # Asia/Shanghai

CHATGPT_URI = "file:///C:/Users/SsuJo_/Chats/ChatGPT"
GEMINI_URI = "file:///C:/Users/SsuJo_/Chats/Gemini"
GROK_CWD = "C:\\Users\\SsuJo_\\Chats\\Grok"
GROK_ENC = urllib.parse.quote(GROK_CWD, safe="")

def log(msg):
    print(msg, flush=True)

# ---------------------------------------------------------------- helpers
def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def fingerprint(path):
    """大文件（>=128MB，常在云盘挂载）用 size+mtime，避免每天整份读取。"""
    st = os.stat(path)
    if st.st_size >= 128 * 1024 * 1024:
        return "big:%d:%d" % (st.st_size, int(st.st_mtime))
    return "sha:" + sha256_file(path)

def iso_z(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def sanitize(name, maxlen=60):
    keep = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", str(name or "").strip())
    keep = re.sub(r"\s+", " ", keep).strip(" .")
    return keep[:maxlen] or "untitled"

def parse_any_time(v):
    """epoch 秒/毫秒、ISO（含 Z / 偏移）、AfterChat 的 'YYYY-MM-DD HH:MM:SS +08:00'。"""
    if v in (None, "", 0):
        return None
    try:
        if isinstance(v, (int, float)):
            return epoch_to_dt(float(v))
        s = str(v).strip()
        if re.fullmatch(r"\d{9,13}", s):
            return epoch_to_dt(int(s))
        try:  # 标准 ISO 优先：正确处理 Z / ±hh:mm
            return datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            pass
        m = re.match(r"(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\s*([+-]\d{2}):?(\d{2}))?", s)
        if m:  # 无偏移 → 视作 +08
            tz = TZ
            if m.group(3):
                sign = -1 if m.group(3).startswith("-") else 1
                tz = timezone(sign * timedelta(hours=int(m.group(3)[1:3]), minutes=int(m.group(4))))
            return datetime.strptime(f"{m.group(1)} {m.group(2)}", "%Y-%m-%d %H:%M:%S").replace(tzinfo=tz)
        return None
    except Exception:
        return None

def epoch_to_dt(x):
    if x > 10 ** 14:  # 毫秒
        x /= 1000.0
    return datetime.fromtimestamp(x, TZ)

def load_state():
    seen = set()
    if os.path.exists(STATE_FILE):
        for line in open(STATE_FILE, "r", encoding="utf-8"):
            try:
                seen.add(json.loads(line).get("sha", ""))
            except Exception:
                pass
    return seen

def append_state(fp, kind, note):
    with open(STATE_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps({"sha": fp, "kind": kind, "note": note}, ensure_ascii=False) + "\n")

# ---------------------------------------------------------------- HTML → 纯文本
class _HTMLText(HTMLParser):
    SKIP = {"script", "style", "head", "svg"}
    BLOCK = {"p", "div", "br", "h1", "h2", "h3", "h4", "h5", "h6",
             "ul", "ol", "li", "tr", "table", "blockquote", "pre", "hr", "section"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        elif tag == "li":
            self.parts.append("\n- ")
        elif tag in self.BLOCK:
            self.parts.append("\n")
        elif tag in ("td", "th"):
            self.parts.append(" | ")

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)

def html_to_text(html):
    if not html or not html.strip():
        return ""
    p = _HTMLText()
    try:
        p.feed(html)
        p.close()
    except Exception:
        return re.sub(r"<[^>]+>", " ", html).strip()
    text = "".join(p.parts).replace("\u00a0", " ")
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in text.split("\n")]
    out = []
    for ln in lines:
        if not ln and (not out or not out[-1]):
            continue
        out.append(ln)
    return "\n".join(out).strip()

# ================================================================ writers
def E(role, text, ts=None, src=""):
    return {"role": role, "text": text, "ts": ts, "src": src}

class Writer:
    """按 target 缓存“对话 → 消息”，多来源合并去重，最后统一落盘（内容不变不重写）。"""
    def __init__(self):
        self.buckets = {}
        self.written = 0
        self.unchanged = 0

    def add(self, target, conv_id, title, uri, msgs):
        b = self.buckets.setdefault(target, {})
        rec = b.get(conv_id)
        if rec is None:
            rec = {"title": "", "uri": uri, "start": None, "last": None, "msgs": [], "seen": {}}
            b[conv_id] = rec
        if title and (not rec["title"] or rec["title"] == "untitled"):
            rec["title"] = title
        for m in msgs:
            text = (m.get("text") or "").strip()
            if not text:
                continue
            m["text"] = text
            key = (m["role"], text)
            prev = rec["seen"].get(key)
            if prev:
                # 跨来源同文 → 合并；同来源且同一时刻 → 同一条重复导入
                if any(p[0] != m["src"] or p[1] == m["ts"] for p in prev):
                    continue
            rec["msgs"].append(m)
            rec["seen"].setdefault(key, []).append((m["src"], m["ts"]))
            ts = m.get("ts")
            if ts:
                if rec["start"] is None or ts < rec["start"]:
                    rec["start"] = ts
                if rec["last"] is None or ts > rec["last"]:
                    rec["last"] = ts

    def flush(self):
        out = {"amp": 0, "gemini": 0, "grok": 0}
        for target, convs in self.buckets.items():
            for conv_id, rec in convs.items():
                try:
                    if not rec["msgs"]:
                        continue
                    if target == "amp":
                        changed = self._write_amp(conv_id, rec); out["amp"] += 1
                    elif target == "gemini":
                        changed = self._write_gemini(conv_id, rec); out["gemini"] += 1
                    elif target == "grok":
                        changed = self._write_grok(conv_id, rec); out["grok"] += 1
                    else:
                        continue
                    if changed:
                        self.written += 1
                    else:
                        self.unchanged += 1
                except Exception as e:
                    log(f"  ! 写出失败 {target}/{conv_id}: {e}")
        return out

    @staticmethod
    def _sorted(rec, start):
        return sorted(rec["msgs"], key=lambda m: m["ts"] or start)

    def _write_amp(self, conv_id, rec):
        start = rec["start"] or datetime.now(TZ)
        doc = {
            "id": conv_id,
            "title": rec["title"] or "untitled",
            "created": int(start.timestamp() * 1000),
            "env": {"initial": {"trees": [{"uri": rec["uri"]}]}},
            "messages": [{"role": m["role"], "content": [{"type": "text", "text": m["text"]}]}
                         for m in self._sorted(rec, start)],
        }
        return self._write_bytes(os.path.join(AMP, sanitize(conv_id, 80) + ".json"),
                                 json.dumps(doc, ensure_ascii=False).encode("utf-8"))

    def _write_gemini(self, conv_id, rec):
        start = rec["start"] or datetime.now(TZ)
        pdir = os.path.join(GEM, "Gemini", "chats")
        os.makedirs(pdir, exist_ok=True)
        lines = [json.dumps({"sessionId": conv_id, "startTime": iso_z(start),
                             "lastUpdated": iso_z(rec["last"] or start)}, ensure_ascii=False)]
        for i, m in enumerate(self._sorted(rec, start)):
            ts = m["ts"] or start + timedelta(seconds=i + 1)
            lines.append(json.dumps({"id": f"m{i}", "timestamp": iso_z(ts),
                                     "type": "user" if m["role"] == "user" else "gemini",
                                     "content": m["text"]}, ensure_ascii=False))
        return self._write_bytes(os.path.join(pdir, sanitize(conv_id, 80) + ".jsonl"),
                                 ("\n".join(lines) + "\n").encode("utf-8"))

    def _write_grok(self, conv_id, rec):
        start = rec["start"] or datetime.now(TZ)
        sdir = os.path.join(GRK, GROK_ENC, sanitize(conv_id, 80))
        os.makedirs(sdir, exist_ok=True)
        lines = []
        for i, m in enumerate(self._sorted(rec, start)):
            ts = m["ts"] or start + timedelta(seconds=i + 1)
            upd = {"sessionUpdate": "user_message_chunk" if m["role"] == "user" else "agent_message_chunk",
                   "content": {"type": "text", "text": m["text"]},
                   "_meta": {"promptIndex": i} if m["role"] == "user" else {"promptId": f"prompt-{i}"}}
            lines.append(json.dumps({"timestamp": int(ts.timestamp()), "params": {"update": upd}},
                                    ensure_ascii=False))
        summary = {"info": {"id": conv_id, "cwd": GROK_CWD},
                   "session_summary": "",
                   "generated_title": rec["title"] or "untitled",
                   "created_at": iso_z(start), "updated_at": iso_z(rec["last"] or start)}
        ok1 = self._write_bytes(os.path.join(sdir, "summary.json"),
                                json.dumps(summary, ensure_ascii=False).encode("utf-8"))
        ok2 = self._write_bytes(os.path.join(sdir, "updates.jsonl"),
                                (("\n".join(lines) + "\n") if lines else "").encode("utf-8"))
        return ok1 or ok2

    @staticmethod
    def _write_bytes(path, data):
        try:
            if os.path.exists(path) and os.path.getsize(path) == len(data):
                with open(path, "rb") as f:
                    if f.read() == data:
                        return False
        except Exception:
            pass
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
        return True

WRITER = Writer()

# ================================================================ A/B: ChatGPT
def read_chatgpt_conversation(doc):
    """标准 ChatGPT 后端对话 JSON → (conv_id, title, create_dt, [msgs])；只走 weight=1 主链。"""
    mapping = doc.get("mapping") or {}
    if not mapping:
        return None
    conv_id = doc.get("conversation_id") or doc.get("id") or doc.get("uuid")
    title = doc.get("title") or ""
    create = parse_any_time(doc.get("create_time"))
    root = None
    for nid, node in mapping.items():
        if not (node.get("parent") or {}).get("id"):
            root = nid
            break
    if root is None:
        return None
    msgs = []
    nid = root
    visited = set()
    while nid and nid not in visited:
        visited.add(nid)
        node = mapping.get(nid) or {}
        msg = node.get("message")
        if msg:
            role = (msg.get("author") or {}).get("role")
            if role in ("user", "assistant"):
                parts = (msg.get("content") or {}).get("parts") or []
                text = "\n".join(p for p in parts if isinstance(p, str)).strip()
                if text:
                    msgs.append(E(role, text, parse_any_time(msg.get("create_time")), "chatgpt"))
        children = node.get("children") or []
        if not children:
            break
        nxt = None
        for c in children:
            cm = (mapping.get(c) or {}).get("message") or {}
            if cm.get("weight") == 1:
                nxt = c
                break
        nid = nxt or children[-1]
    if not msgs:
        return None
    return conv_id, title, create, msgs

def add_chatgpt_doc(doc):
    r = read_chatgpt_conversation(doc)
    if not r:
        return 0
    conv_id, title, create, msgs = r
    if not conv_id:
        return 0
    WRITER.add("amp", str(conv_id), title, CHATGPT_URI, msgs)
    return 1

def handle_chatgpt_zip(zf, name):
    n = 0
    for entry in zf.infolist():
        if entry.is_dir() or not entry.filename.endswith(".json"):
            continue
        fn = entry.filename.replace("\\", "/")
        if "/conversations/" in fn or os.path.basename(fn) == "conversations.json":
            try:
                payload = json.loads(zf.read(entry).decode("utf-8"))
            except Exception:
                continue
            if isinstance(payload, list):
                for doc in payload:
                    n += add_chatgpt_doc(doc)
            else:
                n += add_chatgpt_doc(payload)
    log(f"  ChatGPT「{name}」: {n} conversations")
    return n

# ================================================================ C: Gemini（官方 Takeout）
def _gemini_items(data):
    if isinstance(data, dict):
        for k in ("items", "activity"):
            v = data.get(k)
            if isinstance(v, list):
                return v
        return []
    return data if isinstance(data, list) else []

def _is_gemini_payload(data):
    items = _gemini_items(data)
    if not items:
        return False
    head = [x for x in items[:50] if isinstance(x, dict)]
    return any(("time" in x) and ("title" in x or "titleUrl" in x or "details" in x) for x in head)

def gemini_events_to_writer(data, name):
    items = _gemini_items(data)
    convs = {}
    skipped = 0
    for ev in items:
        if not isinstance(ev, dict):
            continue
        # 1) 对话 URL：新格式在 details[].url/name；老格式在 titleUrl
        url = ""
        for d in ev.get("details") or []:
            u = str((d or {}).get("url") or (d or {}).get("name") or "")
            if "gemini.google.com/app/" in u:
                url = u
                break
        if not url:
            url = str(ev.get("titleUrl") or "")
        if not url:
            for ui in ev.get("userInteractions") or []:
                u = str(((ui or {}).get("userInteraction") or {}).get("url") or "")
                if "gemini.google.com/app/" in u:
                    url = u
                    break
        m = re.search(r"/app/([a-zA-Z0-9_]+)", url)
        if not m:
            skipped += 1
            continue
        cid = m.group(1)
        t = parse_any_time(ev.get("time"))
        msgs = []

        # 2) 新格式（2026+）：title="Prompted <提问>"，safeHtmlItem[].html = 回复
        title = (ev.get("title") or "").strip()
        prompt = re.sub(r"^(?:Prompted|Asked|Said)\s+", "", title).strip()
        prompt = re.sub(r"^Added chat from link:\s*", "", prompt).strip()
        files = [f for f in (ev.get("attachedFiles") or []) if isinstance(f, str)]
        if not prompt and files:
            imgs = [f for f in files if re.search(r"\.(?:jpe?g|png|webp|heic|gif)$", f, re.I)]
            others = [f for f in files if f not in imgs]
            bits = []
            if imgs:
                bits.append(f"[图片 {len(imgs)} 张]")
            if others:
                bits.append("[附件] " + ", ".join(others[:4]) + (" …" if len(others) > 4 else ""))
            prompt = " ".join(bits)
        if prompt:
            msgs.append(E("user", prompt, t, "gemini-takeout"))
        resp = html_to_text("".join(str((x or {}).get("html") or "") for x in (ev.get("safeHtmlItem") or [])))
        if resp:
            msgs.append(E("assistant", resp, t, "gemini-takeout"))

        # 3) 老格式 A：details name=Request/Response（新格式里 details 是 URL，不会命中）
        for d in ev.get("details") or []:
            nm = str((d or {}).get("name", "")).strip().lower()
            v = str((d or {}).get("value", "")).strip()
            if not v:
                continue
            if "request" in nm:
                msgs.append(E("user", v, t, "gemini-takeout"))
            elif "response" in nm:
                msgs.append(E("assistant", v, t, "gemini-takeout"))

        # 4) 老格式 B：userInteractions
        for ui in ev.get("userInteractions") or []:
            u = (ui or {}).get("userInteraction") or {}
            for key, role in (("request", "user"), ("response", "assistant")):
                raw = u.get(key)
                if raw in (None, ""):
                    continue
                txt = None
                if isinstance(raw, str):
                    try:
                        j = json.loads(raw)
                        if isinstance(j, list):
                            txt = "\n".join(str(x.get("text", x)) if isinstance(x, dict) else str(x) for x in j)
                        elif isinstance(j, dict):
                            txt = str(j.get("text") or j.get("content") or "")
                    except Exception:
                        txt = raw
                else:
                    txt = str(raw)
                if txt and txt.strip():
                    msgs.append(E(role, txt.strip(), t, "gemini-takeout"))

        if msgs:
            convs.setdefault(cid, []).extend(msgs)

    for cid, msgs in convs.items():
        first_user = next((m["text"] for m in msgs if m["role"] == "user"), "")
        WRITER.add("gemini", cid, sanitize(first_user, 40), GEMINI_URI, msgs)
    log(f"  Gemini 官方「{name}」: {len(convs)} conversations（无对话链接的事件 {skipped} 条跳过）")
    return len(convs)

def _gemini_payload_from_zip(zf):
    """在 zip 里按内容找 Gemini 活动记录 JSON（文件名可能是中文）。"""
    cands = []
    for e in zf.infolist():
        if e.is_dir() or e.file_size == 0 or e.file_size > 400 * 1024 * 1024:
            continue
        fn = e.filename.replace("\\", "/")
        low = fn.lower()
        if not low.endswith(".json"):
            continue
        if "gemini" in low or "我的活动" in fn or "my activity" in low:
            cands.append((e.file_size, e))
    for _, e in sorted(cands, key=lambda x: -x[0]):
        try:
            data = json.loads(zf.read(e).decode("utf-8"))
        except Exception:
            continue
        if _is_gemini_payload(data):
            return data, e.filename
    return None, None

def handle_gemini_zip(zf, name):
    data, entry = _gemini_payload_from_zip(zf)
    if data is None:
        return 0
    return gemini_events_to_writer(data, f"{name} :: {os.path.basename(entry)}")

# ================================================================ D: Grok 官方导出
def handle_grok_payload(data, name):
    convs = data.get("conversations") or []
    n = 0
    for c in convs:
        conv = c.get("conversation") or {}
        cid = conv.get("id")
        title = conv.get("title") or ""
        msgs = []
        for w in c.get("responses") or []:
            r = w.get("response") or {}
            sender = str(r.get("sender", "")).lower()
            text = str(r.get("message") or "").strip()
            if not text:
                continue
            role = "user" if sender in ("human", "user") else "assistant"
            msgs.append(E(role, text, parse_any_time(r.get("create_time") or r.get("createTime")), "grok-official"))
        if cid and msgs:
            WRITER.add("grok", str(cid), title, GROK_CWD, msgs)
            n += 1
    log(f"  Grok 官方「{name}」: {n} conversations")
    return n

def handle_grok_zip(zf, name):
    for entry in zf.infolist():
        if entry.is_dir():
            continue
        if os.path.basename(entry.filename.replace("\\", "/")) == "prod-grok-backend.json":
            return handle_grok_payload(json.loads(zf.read(entry).decode("utf-8")), name)
    return 0

# ================================================================ E: AfterChat markdown
MD_URL = re.compile(r"^\s*-\s*\*\*URL:\*\*\s*(\S+)", re.M)
MD_TIME = re.compile(r"^\s*-\s*\*\*Time:\*\*\s*(.+)$", re.M)
MD_USER = re.compile(r"^###\s+(?:🧑‍💻\s*)?User\s*$", re.M)
MD_ASST = re.compile(r"^###\s+(?:🤖\s*)?Assistant\s*$", re.M)
FNAME_TS = re.compile(r"^\d{8}-\d{6}-(.+?)\.md$", re.I)

def parse_afterchat_markdown(text, title_hint=None):
    urls = MD_URL.findall(text)
    if not urls:
        return None
    # 优先带对话 id 的 URL
    url = urls[0]
    for u in urls:
        if re.search(r"/app/[a-zA-Z0-9_]+", u) or re.search(r"grok\.com/c/|conversation=", u):
            url = u
            break
    tm = MD_TIME.search(text)
    ts = parse_any_time(tm.group(1).strip()) if tm else None
    conv_start = text.find("## Conversation")
    body = text[conv_start:] if conv_start >= 0 else text
    marks = [(m.start(), "user") for m in MD_USER.finditer(body)]
    marks += [(m.start(), "assistant") for m in MD_ASST.finditer(body)]
    marks.sort()
    msgs = []
    for i, (s, role) in enumerate(marks):
        seg_end = marks[i + 1][0] if i + 1 < len(marks) else len(body)
        chunk = body[s:seg_end]
        seg = "\n".join(chunk.splitlines()[1:]).strip()
        if not seg:
            continue
        # 每条消息给一个递增秒数：保留同文重复，且同一导出重复导入时时间一致可去重
        msgs.append(E(role, seg, (ts + timedelta(seconds=len(msgs))) if ts else None, "afterchat"))
    if not msgs:
        return None
    return url, ts, title_hint, msgs

def route_afterchat_md(text, title_hint):
    r = parse_afterchat_markdown(text, title_hint)
    if not r:
        return None
    url, ts, title_hint, msgs = r
    if "gemini.google.com" in url:
        m = re.search(r"/app/([a-zA-Z0-9_]+)", url)
        if m:
            WRITER.add("gemini", m.group(1), title_hint, GEMINI_URI, msgs)
            return "gemini"
    elif "grok.com" in url or "x.com/i/grok" in url:
        m = re.search(r"(?:grok\.com/c/|conversation=)([a-zA-Z0-9_-]+)", url)
        if m:
            WRITER.add("grok", m.group(1), title_hint, GROK_CWD, msgs)
            return "grok"
    return None

def handle_afterchat_zip(zf, name):
    n = {"gemini": 0, "grok": 0}
    for entry in zf.infolist():
        if entry.is_dir() or not entry.filename.lower().endswith(".md"):
            continue
        fn = os.path.basename(entry.filename.replace("\\", "/"))
        fm = FNAME_TS.match(fn)
        title_hint = fm.group(1) if fm else None
        try:
            text = zf.read(entry).decode("utf-8")
        except Exception:
            continue
        which = route_afterchat_md(text, title_hint)
        if which:
            n[which] += 1
    log(f"  AfterChat「{name}」: gemini={n['gemini']} grok={n['grok']}")
    return n["gemini"] + n["grok"]

# ================================================================ dispatcher
ZIP_HINTS = ("chatgpt", "increment", "takeout", "grok", "afterchat", "gemini", "backup", "export", "聊天")
JSON_HINTS = ("myactivity", "我的活动", "my activity", "grok", "conversations.json")
JSON_GEMINI_MARKS = (b'"safeHtmlItem"', b'"titleUrl"', b'"userInteractions"', b'"attachedFiles"')

def classify_and_process(path, seen, force=False):
    fp = fingerprint(path)
    if fp in seen and not force:
        log(f"  [跳过] 已处理: {os.path.basename(path)}")
        return 0, False
    kind, n = "unknown", 0
    low = os.path.basename(path).lower()
    try:
        if low.endswith(".zip"):
            with zipfile.ZipFile(path) as zf:
                names = [e.filename.replace("\\", "/") for e in zf.infolist() if not e.is_dir()]
                has_cgpt = any(("/conversations/" in x or os.path.basename(x) == "conversations.json")
                               and x.endswith(".json") for x in names)
                has_grok = any(os.path.basename(x) == "prod-grok-backend.json" for x in names)
                has_gm = any(x.lower().endswith(".json") and ("gemini" in x.lower() or "我的活动" in x)
                             for x in names)
                has_md = any(x.lower().endswith(".md") for x in names)
                if has_cgpt:
                    kind = "chatgpt"; n = handle_chatgpt_zip(zf, os.path.basename(path))
                elif has_grok:
                    kind = "grok-official"; n = handle_grok_zip(zf, os.path.basename(path))
                elif has_gm:
                    kind = "gemini-takeout"; n = handle_gemini_zip(zf, os.path.basename(path))
                elif has_md:
                    kind = "afterchat"; n = handle_afterchat_zip(zf, os.path.basename(path))
        elif low.endswith(".json"):
            with open(path, "rb") as f:
                head = f.read(65536)
            if any(mark in head for mark in JSON_GEMINI_MARKS) or \
                    (head.lstrip().startswith(b"[") and b'"time"' in head and b'"title"' in head):
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                kind = "gemini-takeout-json"
                n = gemini_events_to_writer(data, os.path.basename(path))
            elif "grok" in low or b'"conversations"' in head:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                kind = "grok-official-json"
                n = handle_grok_payload(data, os.path.basename(path))
        elif low.endswith(".md"):
            kind = "afterchat-md"
            with open(path, "r", encoding="utf-8") as f:
                text = f.read()
            fm = FNAME_TS.match(os.path.basename(path))
            which = route_afterchat_md(text, fm.group(1) if fm else None)
            n = 1 if which else 0
    except Exception as e:
        log(f"  ! 处理失败 {os.path.basename(path)}: {type(e).__name__}: {e}")
        kind = "error"
    if kind not in ("error", "unknown"):
        append_state(fp, kind, os.path.basename(path))
    return n, True

# ================================================================ main
def main():
    args = sys.argv[1:]
    force = "--force" in args
    with_downloads = "--with-downloads" in args
    with_takeout = "--with-takeout" in args
    seen = load_state()
    if force:
        log("chat2deja: --force 已忽略处理记录，全部重新转换")
    roots = [INBOX, SYNC]
    if with_downloads:
        roots.append(os.path.join(os.path.expanduser("~"), "Downloads"))
    if with_takeout:
        roots.append(GDRIVE_TAKEOUT)
    log("chat2deja: 扫描 " + " + ".join(roots))
    for root in roots:
        if not os.path.isdir(root):
            continue
        items = []
        try:
            for dirpath, dirnames, filenames in os.walk(root):
                # _failed 目录里的文件没有有效 AfterChat 元数据，绝不摄入
                dirnames[:] = [d for d in dirnames if d != "_failed"]
                for fn in filenames:
                    if not fn.lower().endswith((".zip", ".json", ".md")):
                        continue
                    full = os.path.join(dirpath, fn)
                    if "_failed" in os.path.relpath(full, root).split(os.sep)[:-1]:
                        continue
                    if os.path.isfile(full):
                        items.append((os.path.getmtime(full), full))
        except Exception as e:
            log(f"  ! 无法列出 {root}: {e}")
            continue
        for _, full in sorted(items):
            low = os.path.basename(full).lower()
            if low.endswith(".zip") and not any(k in low for k in ZIP_HINTS):
                continue  # 未知名 zip 不碰
            if low.endswith(".json") and not any(k in low for k in JSON_HINTS):
                continue  # 散装 json 只认这几种
            if low.endswith(".md") and "chatgpt" in low:
                continue  # ChatGPT 有专用备份 zip，md 跳过
            classify_and_process(full, seen, force)
    counts = WRITER.flush()
    log(f"转换完成: amp={counts['amp']} gemini={counts['gemini']} grok={counts['grok']}"
        f"（写出 {WRITER.written}，内容未变 {WRITER.unchanged}）")
    _compact_state()
    if any(counts.values()):
        log("提示: 运行 sync.cmd / deja index 刷新索引")
    return 0

def _compact_state():
    """处理记录按指纹去重，避免 --force 重跑后无限增长。"""
    try:
        recs = {}
        for line in open(STATE_FILE, "r", encoding="utf-8"):
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("sha"):
                recs[r["sha"]] = r
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            for r in recs.values():
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
    except Exception as e:
        log(f"  ! 处理记录整理失败: {e}")

if __name__ == "__main__":
    sys.exit(main())
