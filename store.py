import json
import os
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("TMUX_WEB_CONFIG", "~/.config/tmux-web")).expanduser()

DEFAULT_CONFIG = {
    "snippets": ["claude", "claude --continue", "/compact", "/clear", "git status", "git log --oneline -10"],
    "recent_dirs": [],
}


def path(name: str) -> Path:
    return CONFIG_DIR / name


def load(name: str, default):
    try:
        return json.loads(path(name).read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save(name: str, data) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path(name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    tmp.replace(path(name))


def load_config() -> dict:
    return {**DEFAULT_CONFIG, **load("config.json", {})}


def save_config(cfg: dict) -> None:
    save("config.json", cfg)


def add_recent_dir(d: str) -> None:
    cfg = load_config()
    cfg["recent_dirs"] = [d] + [x for x in cfg["recent_dirs"] if x != d][:9]
    save_config(cfg)


def groups() -> dict[str, list[str]]:
    return load_config().get("groups", {})


def _save_groups(gs: dict[str, list[str]]) -> None:
    cfg = load_config()
    cfg["groups"] = gs
    save_config(cfg)


def group_of() -> dict[str, str]:
    return {s: g for g, members in groups().items() for s in members}


def _subtree(gs: dict, name: str) -> list[str]:
    return [k for k in gs if k == name or k.startswith(name + "/")]


def _with_parents(gs: dict, name: str) -> dict:
    parts = name.split("/")
    out = dict(gs)
    for i in range(1, len(parts)):
        out.setdefault("/".join(parts[:i]), [])
    return out


def create_group(name: str) -> None:
    gs = groups()
    if name in gs:
        raise ValueError("이미 있는 그룹입니다")
    gs = _with_parents(gs, name)
    gs[name] = []
    _save_groups(gs)


def rename_group(old: str, new: str) -> None:
    gs = groups()
    if old not in gs:
        raise KeyError("그룹이 없습니다")
    if new == old:
        return
    if new.startswith(old + "/"):
        raise ValueError("그룹을 자기 하위 그룹 안으로 옮길 수 없습니다")
    moved = _subtree(gs, old)
    targets = {k: new + k[len(old):] for k in moved}
    if any(t in gs and t not in moved for t in targets.values()):
        raise ValueError("이미 있는 그룹입니다")
    _save_groups(_with_parents({targets.get(k, k): v for k, v in gs.items()}, new))


def delete_group(name: str) -> list[str]:
    gs = groups()
    if name not in gs:
        raise KeyError("그룹이 없습니다")
    members = []
    for k in _subtree(gs, name):
        members += gs.pop(k)
    _save_groups(gs)
    return members


def move_session(session: str, group: str | None) -> None:
    gs = {g: [s for s in members if s != session] for g, members in groups().items()}
    if group is not None:
        if group not in gs:
            raise KeyError("그룹이 없습니다")
        gs[group].append(session)
        _drop_from_companies(session)
    _save_groups(gs)


def rename_session(old: str, new: str) -> None:
    gs = groups()
    if any(old in members for members in gs.values()):
        _save_groups({g: [new if s == old else s for s in members] for g, members in gs.items()})
    cs = companies()
    if any(old in c["members"] for c in cs.values()):
        for c in cs.values():
            if old in c["members"]:
                c["members"][new] = c["members"].pop(old)
        _save_companies(cs)


def forget_session(session: str) -> None:
    gs = groups()
    if any(session in members for members in gs.values()):
        _save_groups({g: [s for s in members if s != session] for g, members in gs.items()})
    _drop_from_companies(session)


def companies() -> dict[str, dict]:
    return {n: {"repo": c.get("repo", ""), "ws": c.get("ws", ""), "parent": c.get("parent", ""), "members": dict(c.get("members", {}))}
            for n, c in load_config().get("companies", {}).items()}


def _save_companies(cs: dict) -> None:
    cfg = load_config()
    cfg["companies"] = cs
    save_config(cfg)


def company_of() -> dict[str, tuple[str, str]]:
    return {s: (n, d) for n, c in companies().items() for s, d in c["members"].items()}


def _drop_from_companies(session: str) -> None:
    cs = companies()
    if any(session in c["members"] for c in cs.values()):
        for c in cs.values():
            c["members"].pop(session, None)
        _save_companies(cs)


def set_company(name: str, repo: str = "", ws: str = "", parent: str | None = None) -> None:
    cs = companies()
    if parent and (parent == name or parent not in cs):
        raise KeyError("상위 회사가 없습니다")
    c = cs.setdefault(name, {"repo": "", "ws": "", "parent": "", "members": {}})
    c["repo"] = repo or c["repo"]
    c["ws"] = ws or c["ws"]
    if parent is not None:
        c["parent"] = parent
    _save_companies(cs)


def company_assign(name: str, session: str, dept: str = "") -> None:
    cs = companies()
    if name not in cs:
        raise KeyError("회사가 없습니다")
    for c in cs.values():
        c["members"].pop(session, None)
    cs[name]["members"][session] = dept
    _save_companies(cs)
    gs = groups()
    if any(session in members for members in gs.values()):
        _save_groups({g: [s for s in members if s != session] for g, members in gs.items()})


def delete_company(name: str) -> list[str]:
    cs = companies()
    if name not in cs:
        raise KeyError("회사가 없습니다")
    members = list(cs.pop(name)["members"])
    for c in cs.values():
        if c["parent"] == name:
            c["parent"] = ""
    _save_companies(cs)
    return members
