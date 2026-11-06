import json
import os
import re
import sqlite3
import subprocess
import time
from pathlib import Path

import chat
import store

CMD = os.environ.get("TMUX_WEB_SECTIONS_CMD", "").strip() or (
    str(Path(os.environ["TMUX_WEB_SECTION_CMD"]).with_name("sections")) if os.environ.get("TMUX_WEB_SECTION_CMD") else "")
_cache: tuple[float, dict] = (0.0, {})


def sections() -> dict[str, dict]:
    global _cache
    if time.time() - _cache[0] < 5:
        return _cache[1]
    out = {}
    for comp, c in store.companies().items():
        db = Path(c.get("ws") or "") / "requests" / "sections.db"
        if not c.get("ws") or not db.exists():
            continue
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            con.row_factory = sqlite3.Row
            rows = con.execute("select s.name, s.session, s.dir, s.managed, s.ondemand, coalesce(t.claude_sid, '') sid from section s left join state t using(name)").fetchall()
            con.close()
        except sqlite3.Error:
            continue
        for r in rows:
            out[r["session"]] = {**dict(r), "company": comp, "ws": c["ws"]}
    _cache = (time.time(), out)
    return out


def of(session: str) -> dict | None:
    return sections().get(session)


def project(d: str) -> Path:
    return chat.CLAUDE_HOME / "projects" / re.sub(r"[^A-Za-z0-9]", "-", d)


def conversations(sec: dict) -> list[dict]:
    files = sorted(project(sec["dir"]).glob("*.jsonl"), key=lambda f: f.stat().st_mtime, reverse=True)
    out = []
    for f in files[:50]:
        first = ""
        try:
            with f.open("rb") as fh:
                for raw in fh:
                    if b'"type":"user"' not in raw:
                        continue
                    m = json.loads(raw).get("message", {}).get("content")
                    first = m if isinstance(m, str) else next((x.get("text", "") for x in m or [] if isinstance(x, dict) and x.get("type") == "text"), "")
                    if first and not first.startswith("<"):
                        break
                    first = ""
        except (OSError, ValueError):
            pass
        st = f.stat()
        out.append({"sid": f.stem, "mtime": st.st_mtime, "size": st.st_size, "first": first[:120]})
    return out


def transcript(sec: dict, sid: str = "") -> Path | None:
    if sid and re.fullmatch(r"[0-9a-f-]{36}", sid):
        f = project(sec["dir"]) / f"{sid}.jsonl"
        return f if f.exists() else None
    files = sorted(project(sec["dir"]).glob("*.jsonl"), key=lambda f: f.stat().st_mtime)
    return files[-1] if files else None


def run(sec: dict, *args: str) -> str:
    if not CMD:
        raise RuntimeError("섹션 명령(TMUX_WEB_SECTIONS_CMD)이 없습니다")
    r = subprocess.run([CMD, sec["ws"], *args], capture_output=True, text=True, timeout=30)
    _cache_clear()
    if r.returncode:
        raise RuntimeError((r.stderr or r.stdout).strip().splitlines()[-1] if (r.stderr or r.stdout).strip() else "실패")
    return r.stdout.strip()


def _cache_clear() -> None:
    global _cache
    _cache = (0.0, {})
