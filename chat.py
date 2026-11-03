import json
import os
import re
from pathlib import Path

from tmuxctl import tmux

CLAUDE_HOME = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
TAIL = 1_500_000
MAX_READ = 4_000_000
MAX_RESULT = 4000
HOOK = re.compile(r"(Stop hook feedback\s*)?\S+ hook blocking error from command \"\w+\":\s*")
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
    for pane, _, _ in rows:
        if pane in live:
            return live[pane]
    by_pid = {d["pid"]: d for d in live.values()}
    if not by_pid:
        return None
    kids = _children()
    for pane, _, root in rows:
        todo = [int(root)]
        while todo:
            p = todo.pop()
            if p in by_pid:
                return {**by_pid[p], "pane": pane}
            todo += kids.get(p, [])
    return None


def transcript(sess: dict) -> Path | None:
    sid = sess.get("sessionId") or ""
    if not re.fullmatch(r"[0-9a-f-]{36}", sid):
        return None
    hits = sorted((CLAUDE_HOME / "projects").glob(f"*/{sid}.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    return hits[0] if hits else None


def _text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(x.get("text", "") for x in content if isinstance(x, dict) and x.get("type") == "text")
    return ""


def _tool_input(name: str, inp: dict) -> str:
    for k in ("command", "file_path", "pattern", "description", "url", "query", "prompt", "skill"):
        if isinstance(inp.get(k), str) and inp[k]:
            return inp[k]
    return json.dumps(inp, ensure_ascii=False)[:300]


def items(lines: list[bytes]) -> list[dict]:
    out = []
    for raw in lines:
        try:
            d = json.loads(raw)
        except ValueError:
            continue
        if d.get("isSidechain"):
            continue
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
                continue
            if d.get("isMeta"):
                continue
            text = _text(content)
            kind = (d.get("origin") or {}).get("kind")
            if kind == "task-notification" or text.lstrip().startswith("<"):
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
                    out.append({"k": "tool", "id": x.get("id"), "name": x.get("name", ""),
                                "input": _tool_input(x.get("name", ""), x.get("input") or {}), "ts": ts})
        elif t == "system" and d.get("subtype") == "away_summary" and d.get("content"):
            out.append({"k": "summary", "text": d["content"], "ts": ts})
        elif t == "system" and d.get("subtype") == "turn_duration":
            out.append({"k": "turn", "ms": d.get("durationMs", 0), "ts": ts})
    return out


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
    return {"start": start, "end": end, "items": items(buf.splitlines()), "reset": after is not None and start != after}
