import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import chat


def line(**d) -> bytes:
    return json.dumps(d, ensure_ascii=False).encode() + b"\n"


def user(text, kind="human", **kw):
    return line(type="user", message={"role": "user", "content": text}, origin={"kind": kind}, timestamp="t", **kw)


def tool_use(i, name, inp):
    return line(type="assistant", message={"content": [{"type": "tool_use", "id": i, "name": name, "input": inp}]})


def tool_result(i, text, err=False):
    return line(type="user", message={"content": [{"type": "tool_result", "tool_use_id": i, "content": text, "is_error": err}]})


def say(text):
    return line(type="assistant", message={"content": [{"type": "thinking", "thinking": "x"}, {"type": "text", "text": text}]})


def test_items_maps_conversation():
    lines = [
        user("안녕"),
        user("<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command \"Stop\": [요청함] 1건\n</system-reminder>", kind="task-notification"),
        user("숨김", isMeta=True),
        user("요약본", isCompactSummary=True),
        say("답입니다"),
        tool_use("a", "Bash", {"command": "ls -l", "description": "목록"}),
        tool_result("a", "x" * 5000),
        tool_use("b", "Edit", {"file_path": "/f.py", "old_string": "a\nb", "new_string": "c"}),
        tool_result("b", "실패", err=True),
        tool_use("c", "TodoWrite", {"todos": [{"content": "하나", "status": "completed"}, {"content": "둘", "status": "in_progress"}]}),
        line(type="assistant", isSidechain=True, message={"content": [{"type": "text", "text": "서브"}]}),
        line(type="system", subtype="away_summary", content="자리 비운 사이"),
        line(type="system", subtype="turn_duration", durationMs=1234),
        b"{broken\n",
    ]
    it = chat.items([x.rstrip(b"\n") for x in lines])
    assert [i["k"] for i in it] == ["user", "note", "summary", "text", "tool", "result", "tool", "result", "tool", "summary", "turn"]
    assert it[1]["text"] == "[요청함] 1건"
    assert it[4]["input"] == "ls -l" and it[4]["detail"] == "ls -l\n# 목록"
    assert it[5]["cut"] and len(it[5]["text"]) == chat.MAX_RESULT
    assert it[6]["detail"] == "/f.py\n- a\n- b\n+ c" and it[7]["error"]
    assert it[8]["input"] == "할 일 1/2" and it[8]["detail"] == "✓ 하나\n▸ 둘"


def test_read_tail_after_before(tmp_path, monkeypatch):
    monkeypatch.setattr(chat, "TAIL", 200)
    p = tmp_path / "s.jsonl"
    p.write_bytes(b"".join(say(f"말 {i:03d}") for i in range(40)))
    r = chat.read(p)
    assert r["end"] == p.stat().st_size and 0 < r["start"] < r["end"]
    assert r["items"][-1]["text"] == "말 039" and not r["reset"]
    with p.open("ab") as f:
        f.write(say("새 말") + say("덜 쓴")[:-5])
    a = chat.read(p, after=r["end"])
    assert [i["text"] for i in a["items"]] == ["새 말"] and not a["reset"]
    assert chat.read(p, after=a["end"])["items"] == []
    b = chat.read(p, before=r["start"])
    assert b["end"] == r["start"] and b["items"][-1]["text"] == f"말 {int(r['items'][0]['text'][2:]) - 1:03d}"
    assert chat.read(p, after=p.stat().st_size + 10)["reset"]


def test_read_jumps_when_far_behind(tmp_path, monkeypatch):
    monkeypatch.setattr(chat, "TAIL", 200)
    monkeypatch.setattr(chat, "MAX_READ", 500)
    p = tmp_path / "s.jsonl"
    p.write_bytes(b"".join(say(f"말 {i:03d}") for i in range(40)))
    r = chat.read(p, after=0)
    assert r["reset"] and r["items"][-1]["text"] == "말 039"


PERMISSION = """● Bash(rm -rf build)
────────────────────────────────
 Bash command

   rm -rf build

 Do you want to proceed?
   1. Yes
 ❯ 2. Yes, and don't ask again
   3. No, and tell Claude what to do differently (esc)

 Esc to cancel · Tab to amend
"""

QUESTION = """╭────────────────────────────╮
│ ☐ 범위                     │
│                            │
│ 어디까지 할까요?           │
│                            │
│ ❯ 1. 1단계만               │
│      대화 보기만           │
│   2. 전부                  │
│   3. Type something.       │
╰────────────────────────────╯
 Enter to select · ↑/↓ to navigate · Esc to cancel
"""


def test_prompt_parses_menus():
    p = chat.prompt(PERMISSION)
    assert p["cur"] == 2 and [o["label"] for o in p["options"]][0] == "Yes" and len(p["options"]) == 3
    assert p["body"] == "Bash command\nrm -rf build\nDo you want to proceed?"
    q = chat.prompt(QUESTION)
    assert q["cur"] == 1 and q["options"][0]["desc"] == "대화 보기만" and q["options"][2]["label"] == "Type something."
    assert chat.prompt("목록\n 1. a\n 2. b\n") is None
    assert chat.prompt("Do you want to proceed?\n 1. a\n 2. b\n") is None


def test_choose_moves_and_checks(monkeypatch):
    sent = []

    class R:
        returncode = 0
        stderr = ""

    monkeypatch.setattr(chat, "capture", lambda pane: PERMISSION)
    monkeypatch.setattr(chat, "tmux", lambda *a: sent.append(a) or R())
    chat.choose("%1", 3, "No, and tell Claude what to do differently (esc)")
    chat.choose("%1", 1, "Yes")
    chat.choose("%1", 2, "Yes, and don't ask again")
    assert sent == [("send-keys", "-t", "%1", "Down", "Enter"), ("send-keys", "-t", "%1", "Up", "Enter"),
                    ("send-keys", "-t", "%1", "Enter")]
    try:
        chat.choose("%1", 1, "No")
    except ValueError:
        pass
    else:
        raise AssertionError
    assert len(sent) == 3


def test_live_sessions_and_find(tmp_path, monkeypatch):
    monkeypatch.setattr(chat, "CLAUDE_HOME", tmp_path)
    (tmp_path / "sessions").mkdir()
    sid = "12345678-1234-1234-1234-123456789abc"
    (tmp_path / "sessions" / "1.json").write_text(json.dumps({"pid": 1, "sessionId": sid, "tmux": "dev:@3.%7"}))
    (tmp_path / "sessions" / "2.json").write_text(json.dumps({"pid": 2, "sessionId": sid, "tmux": "x:@1.%9"}))
    (tmp_path / "sessions" / "3.json").write_text("{bad")
    monkeypatch.setattr(chat, "_alive", lambda pid: pid == 1)
    live = chat.live_sessions()
    assert list(live) == ["%7"]

    class R:
        returncode = 0
        stdout = "%6\t10\t100\n%7\t11\t101\n"

    monkeypatch.setattr(chat, "tmux", lambda *a: R())
    assert chat.find("dev", live)["sessionId"] == sid
    proj = tmp_path / "projects" / "-w"
    proj.mkdir(parents=True)
    (proj / f"{sid}.jsonl").write_bytes(say("짧음") + say("이 일은 끝났고 다음 요청을 기다린다\n감시 재개") + say("감시 재개"))
    assert chat.transcript(live["%7"]) == proj / f"{sid}.jsonl"
    assert chat.last_said(live["%7"]) == ["이 일은 끝났고 다음 요청을 기다린다"]
