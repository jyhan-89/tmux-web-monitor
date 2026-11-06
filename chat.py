import json
import os
import re
import subprocess
import time
from pathlib import Path

from tmuxctl import BOX_BORDER, CLAUDE_WAITING, analyze, capture, tmux

CLAUDE_HOME = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
TAIL = 1_500_000
MAX_READ = 4_000_000
MAX_RESULT = 4000
HOOK = re.compile(r"(Stop hook feedback\s*)?\S+ hook blocking error from command \"\w+\":\s*")
OPTION = re.compile(r"^\s*(❯)?\s*(\d+)\.\s+(.+?)\s*$")
TAG = re.compile(r"<(system-reminder|task-notification)>.*?</\1>", re.S)


def _alive(pid: int) -> bool:
    try:
        return b"claude" in Path(f"/proc/{pid}/cmdline").read_bytes() or "claude" in os.readlink(f"/proc/{pid}/exe")
    except OSError:
        return False


def live_sessions() -> dict[str, dict]:
    out = {}
    for p in (CLAUDE_HOME / "sessions").glob("*.json"):
        try:
            d = json.loads(p.read_text())
        except (OSError, ValueError):
            continue
        pid = d.get("pid")
        if not isinstance(pid, int) or not _alive(pid):
            continue
        pane = (d.get("tmux") or "").rpartition(".")[2]
        if pane.startswith("%"):
            d["pane"] = pane
            out[pane] = d
    return out


def _children() -> dict[int, list[int]]:
    kids: dict[int, list[int]] = {}
    for st in Path("/proc").glob("[0-9]*/stat"):
        try:
            f = st.read_text().rsplit(")", 1)[1].split()
        except (OSError, IndexError):
            continue
        kids.setdefault(int(f[1]), []).append(int(st.parent.name))
    return kids


def find(name: str, live: dict[str, dict] | None = None) -> dict | None:
    r = tmux("list-panes", "-s", "-t", f"={name}", "-F", "#{pane_id}\t#{window_active}#{pane_active}\t#{pane_pid}")
    if r.returncode != 0:
        return None
    rows = [line.split("\t") for line in r.stdout.splitlines()]
    rows.sort(key=lambda x: x[1] != "11")
    live = live_sessions() if live is None else live
    for pane, flag, _ in rows:
        if pane in live:
            return {**live[pane], "active": flag == "11"}
    by_pid = {d["pid"]: d for d in live.values()}
    if not by_pid:
        return None
    kids = _children()
    for pane, flag, root in rows:
        todo = [int(root)]
        while todo:
            p = todo.pop()
            if p in by_pid:
                return {**by_pid[p], "pane": pane, "active": flag == "11"}
            todo += kids.get(p, [])
    return None


_paths: dict[str, Path] = {}
_miss: dict[str, float] = {}
_last: dict[Path, tuple[float, list[str]]] = {}


def transcript(sess: dict) -> Path | None:
    sid = sess.get("sessionId") or ""
    if not re.fullmatch(r"[0-9a-f-]{36}", sid):
        return None
    hit = _paths.get(sid)
    if hit and hit.exists():
        return hit
    if time.time() - _miss.get(sid, 0) < 60:
        return None
    hits = sorted((CLAUDE_HOME / "projects").glob(f"*/{sid}.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    if hits:
        _paths[sid] = hits[0]
    else:
        _miss[sid] = time.time()
    return hits[0] if hits else None


def last_said(sess: dict) -> list[str]:
    path = transcript(sess)
    if not path:
        return []
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return []
    hit = _last.get(path)
    if hit and hit[0] == mtime:
        return hit[1]
    size = path.stat().st_size
    with path.open("rb") as f:
        f.seek(max(0, size - 300_000))
        buf = f.read()
    said = []
    for it in reversed(items(buf.splitlines()[1:])):
        if it["k"] in ("text", "user") and len(it["text"].strip()) >= 12:
            lines = [re.sub(r"[*`#>|]+", "", x).strip() for x in it["text"].splitlines()]
            lines = [x for x in lines if len(x) > 6] or [x for x in lines if x]
            said = [("나: " if it["k"] == "user" else "") + " ".join(lines)[:300]]
            break
    _last[path] = (mtime, said)
    return said


def _text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(x.get("text", "") for x in content if isinstance(x, dict) and x.get("type") == "text")
    return ""


def _tool_input(name: str, inp: dict) -> str:
    if name == "TodoWrite":
        todos = inp.get("todos") or []
        return f"할 일 {sum(t.get('status') == 'completed' for t in todos)}/{len(todos)}"
    for k in ("command", "file_path", "pattern", "description", "url", "query", "prompt", "skill"):
        if isinstance(inp.get(k), str) and inp[k]:
            return inp[k]
    return json.dumps(inp, ensure_ascii=False)[:300]


def _lines(prefix: str, text: str) -> str:
    return "\n".join(prefix + x for x in str(text).splitlines())


def _tool_detail(name: str, inp: dict) -> str:
    if name == "Bash":
        return inp.get("command", "") + (f"\n# {inp['description']}" if inp.get("description") else "")
    if name == "Edit":
        return f"{inp.get('file_path', '')}\n{_lines('- ', inp.get('old_string', ''))}\n{_lines('+ ', inp.get('new_string', ''))}"
    if name == "MultiEdit":
        parts = [inp.get("file_path", "")]
        for e in inp.get("edits") or []:
            parts += [_lines("- ", e.get("old_string", "")), _lines("+ ", e.get("new_string", "")), ""]
        return "\n".join(parts)
    if name == "Write":
        return f"{inp.get('file_path', '')}\n{_lines('+ ', inp.get('content', ''))}"
    if name == "TodoWrite":
        mark = {"completed": "✓", "in_progress": "▸"}
        return "\n".join(f"{mark.get(t.get('status'), '·')} {t.get('content', '')}" for t in inp.get("todos") or [])
    return json.dumps(inp, ensure_ascii=False, indent=1)


def items(lines: list[bytes], offs: list[int] | None = None) -> list[dict]:
    out = []
    for i, raw in enumerate(lines):
        mark = len(out)
        _item(raw, out)
        if offs is not None:
            for it in out[mark:]:
                it["o"] = offs[i]
    return out


def _item(raw: bytes, out: list) -> None:
    try:
        d = json.loads(raw)
    except ValueError:
        return
    if d.get("isSidechain"):
        return
    t, ts = d.get("type"), d.get("timestamp", "")
    msg = d.get("message") or {}
    content = msg.get("content")
    if t == "user":
        if isinstance(content, list) and any(isinstance(x, dict) and x.get("type") == "tool_result" for x in content):
            for x in content:
                if isinstance(x, dict) and x.get("type") == "tool_result":
                    text = _text(x.get("content"))
                    out.append({"k": "result", "id": x.get("tool_use_id"), "error": bool(x.get("is_error")),
                                "text": text[:MAX_RESULT], "cut": len(text) > MAX_RESULT})
            return
        if d.get("isCompactSummary"):
            out.append({"k": "summary", "text": "대화가 길어 앞부분을 요약하고 이어서 한다", "ts": ts})
            return
        if d.get("isMeta"):
            return
        text = _text(content)
        if isinstance(content, list) and any(isinstance(x, dict) and x.get("type") == "image" for x in content):
            text = (text + "\n[이미지]").strip()
        kind = (d.get("origin") or {}).get("kind")
        if text.strip().startswith("[Request interrupted by user"):
            out.append({"k": "note", "text": "사용자가 중단함", "ts": ts})
        elif kind == "task-notification" or text.lstrip().startswith("<"):
            body = TAG.sub("", text).strip() or re.sub(r"<[^>]+>", " ", text)
            body = HOOK.sub("", body)
            out.append({"k": "note", "text": re.sub(r"\s+", " ", body).strip()[:600], "ts": ts})
        elif text.strip():
            out.append({"k": "user", "text": text, "ts": ts})
    elif t == "assistant" and isinstance(content, list):
        for x in content:
            if not isinstance(x, dict):
                continue
            if x.get("type") == "text" and x.get("text", "").strip():
                out.append({"k": "text", "text": x["text"], "ts": ts})
            elif x.get("type") == "tool_use":
                name, inp = x.get("name", ""), x.get("input") or {}
                out.append({"k": "tool", "id": x.get("id"), "name": name, "input": _tool_input(name, inp),
                            "detail": _tool_detail(name, inp)[:MAX_RESULT], "ts": ts})
    elif t == "system" and d.get("subtype") == "away_summary" and d.get("content"):
        out.append({"k": "summary", "text": d["content"], "ts": ts})
    elif t == "system" and d.get("subtype") == "turn_duration":
        out.append({"k": "turn", "ms": d.get("durationMs", 0), "ts": ts})


def read(path: Path, after: int | None = None, before: int | None = None) -> dict:
    size = path.stat().st_size
    with path.open("rb") as f:
        if after is not None and 0 <= after <= size:
            start = after if size - after <= MAX_READ else size - TAIL
            end = size
        else:
            end = size if before is None else max(0, min(before, size))
            start = max(0, end - TAIL)
        f.seek(start)
        buf = f.read(end - start)
    if start > 0 and (after is None or start != after):
        nl = buf.find(b"\n")
        buf = buf[nl + 1:] if nl >= 0 else b""
        start = end - len(buf)
    cut = buf.rfind(b"\n") + 1
    if before is None:
        end = start + cut
    buf = buf[:cut] if before is None else buf
    lines, offs, pos = [], [], start
    for raw in buf.splitlines(keepends=True):
        lines.append(raw.rstrip(b"\n"))
        offs.append(pos)
        pos += len(raw)
    return {"start": start, "end": end, "items": items(lines, offs), "reset": after is not None and start != after}


def _strip(line: str) -> str:
    return line.strip().strip("│").rstrip()


def prompt(text: str) -> dict | None:
    lines = [_strip(x) for x in text.splitlines()[-60:]]
    if not CLAUDE_WAITING.search("\n".join(lines[-30:])):
        return None
    start = None
    for i in range(len(lines) - 1, -1, -1):
        m = OPTION.match(lines[i])
        if m and m.group(2) == "1":
            start = i
            break
    if start is None:
        return None
    opts, cur = [], 0
    for line in lines[start:]:
        m = OPTION.match(line)
        if m and int(m.group(2)) == len(opts) + 1:
            if m.group(1):
                cur = len(opts) + 1
            opts.append({"n": len(opts) + 1, "label": m.group(3), "desc": ""})
        elif line.strip() and opts and line.startswith((" ", "\t")) and not opts[-1]["desc"]:
            opts[-1]["desc"] = line.strip()
        elif not line.strip() or not opts:
            continue
        else:
            break
    if len(opts) < 2 or not cur:
        return None
    top = 0
    for i in range(start - 1, -1, -1):
        if BOX_BORDER.match(lines[i]) or lines[i].strip().startswith(("╭", "╰")):
            top = i + 1
            break
    body = [x.strip() for x in lines[top:start] if x.strip()][-15:]
    return {"body": "\n".join(body), "options": opts, "cur": cur}


ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def draft(raw: str) -> str:
    lines = raw.splitlines()
    plain = [ANSI.sub("", x) for x in lines]
    borders = [i for i, x in enumerate(plain) if BOX_BORDER.match(x)][-2:]
    if len(borders) < 2:
        return ""
    top, bot = borders
    box, rawbox = plain[top + 1:bot], lines[top + 1:bot]
    if not box or "❯" not in box[0]:
        return ""
    head = rawbox[0].split("❯", 1)[1]
    while head:
        head = head.lstrip("\xa0 ")
        m = ANSI.match(head)
        if not m:
            break
        if re.search(r"[\[;]2m$", m.group(0)):
            return ""
        head = head[m.end():]
    out = [box[0].split("❯", 1)[1].replace("\xa0", " ").strip()] + [x.replace("\xa0", " ")[2:].rstrip() for x in box[1:]]
    return "\n".join(out).strip()


def screen(pane: str) -> tuple[str, dict | None, str]:
    raw = tmux("capture-pane", "-p", "-e", "-t", pane).stdout.rstrip("\n")
    text = capture(pane)
    state, _ = analyze("claude", text)
    return state, prompt(text) if state == "waiting" else None, draft(raw) if state == "idle" else ""


def clear_input(pane: str) -> str:
    state, _, d = screen(pane)
    if state == "working" or not d:
        return d
    tmux("send-keys", "-t", pane, "End")
    tmux("send-keys", "-t", pane, "-N", str(len(d) + 2), "BSpace")
    time.sleep(0.15)
    return screen(pane)[2]


def type_into(pane: str, text: str, enter: bool) -> None:
    if text:
        buf = f"mon-{os.getpid()}-{time.time_ns()}"
        r = subprocess.run(["tmux", "load-buffer", "-b", buf, "-"], input=text, capture_output=True, text=True)
        if r.returncode != 0:
            raise ValueError(r.stderr.strip() or "tmux 명령 실패")
        tmux("paste-buffer", "-p", "-d", "-b", buf, "-t", pane)
    if enter:
        if text:
            time.sleep(0.05)
        tmux("send-keys", "-t", pane, "Enter")


def choose(pane: str, n: int, label: str) -> None:
    p = prompt(capture(pane))
    if not p or not any(o["n"] == n and o["label"] == label for o in p["options"]):
        raise ValueError("선택지가 바뀌었습니다 — 화면을 다시 확인하세요")
    d = n - p["cur"]
    keys = ["Down"] * d if d > 0 else ["Up"] * -d
    r = tmux("send-keys", "-t", pane, *keys, "Enter")
    if r.returncode != 0:
        raise ValueError(r.stderr.strip() or "tmux 명령 실패")
