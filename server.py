import asyncio
import fcntl
import json
import os
import pty
import re
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import (
    APIRouter,
    Depends,
    FastAPI,
    HTTPException,
    Request,
    Response,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from send2trash import send2trash

import auth
import chat
import push
import store
from tmuxctl import capture, list_sessions, session_exists, tmux, valid_name

STATIC_DIR = Path(__file__).parent / "static"
BASE_PATH = "/" + os.environ.get("BASE_PATH", "/dev").strip("/")
BASE_PREFIX = BASE_PATH.rstrip("/")
COOKIE = "tmuxweb_session"
LOOPBACK = {"127.0.0.1", "::1"}
LOCAL_HOST = re.compile(r"^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$")
MAX_UPLOAD = 200 * 1024 * 1024
FILES_ROOT = Path(os.environ.get("TMUX_WEB_FILES_ROOT", "~")).expanduser().resolve()
MAX_TEXT = 2 * 1024 * 1024
APP_VERSION = str(max(int(p.stat().st_mtime) for p in STATIC_DIR.rglob("*") if p.is_file()))


@asynccontextmanager
async def lifespan(_app: FastAPI):
    task = asyncio.create_task(push.monitor())
    yield
    task.cancel()


app = FastAPI(lifespan=lifespan)


@app.middleware("http")
async def revalidate_static(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith(f"{BASE_PREFIX}/static/"):
        response.headers.setdefault("Cache-Control", "no-cache")
    return response
router = APIRouter()


def require_login(request: Request) -> None:
    if not auth.valid_session(request.cookies.get(COOKIE)):
        raise HTTPException(status_code=401, detail="로그인이 필요합니다")


api = APIRouter(prefix="/api", dependencies=[Depends(require_login)])


def client_ip(request: Request) -> str:
    ip = request.client.host if request.client else "?"
    if ip in ("127.0.0.1", "::1"):
        forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        ip = request.headers.get("x-real-ip") or forwarded or ip
    return ip


def is_local(request: Request) -> bool:
    if not request.client or request.client.host not in LOOPBACK:
        return False
    forwarded = [request.headers.get("x-real-ip", "")] + request.headers.get("x-forwarded-for", "").split(",")
    if any(ip.strip() and ip.strip() not in LOOPBACK for ip in forwarded):
        return False
    host = request.headers.get("host", "")
    origin = request.headers.get("origin")
    return bool(LOCAL_HOST.match(host)) and (origin is None or origin.split("://", 1)[-1] == host)


def run(*args: str) -> None:
    res = tmux(*args)
    if res.returncode != 0:
        raise HTTPException(400, res.stderr.strip() or "tmux 명령 실패")


def find_session(name: str) -> dict:
    for s in list_sessions():
        if s["name"] == name:
            return s
    raise HTTPException(404, "세션이 없습니다")


@router.get("/")
def index(request: Request):
    if not auth.is_configured():
        return RedirectResponse(f"{BASE_PREFIX}/setup")
    if not auth.valid_session(request.cookies.get(COOKIE)):
        return RedirectResponse(f"{BASE_PREFIX}/login")
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})


@router.get("/login")
def login_page():
    return FileResponse(STATIC_DIR / "login.html")


@router.get("/setup")
def setup_page():
    return FileResponse(STATIC_DIR / "setup.html")


@router.get("/sw.js")
def service_worker():
    return FileResponse(STATIC_DIR / "sw.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})


@router.get("/ca.crt")
def ca_certificate():
    ca = Path(os.environ.get("TMUX_WEB_TLS", "~/.config/tmux-web/tls")).expanduser() / "ca.crt"
    if not ca.exists():
        raise HTTPException(404, "CA 인증서가 없습니다 (deploy/make-cert.sh 실행 필요)")
    return FileResponse(ca, media_type="application/x-x509-ca-cert", filename="tmux-web-ca.crt")


@router.get("/manifest.webmanifest")
def manifest():
    return FileResponse(STATIC_DIR / "manifest.webmanifest", media_type="application/manifest+json")


class Login(BaseModel):
    username: str
    password: str


@router.post("/api/login")
def api_login(body: Login, request: Request, response: Response):
    ip = client_ip(request)
    if not auth.is_configured():
        raise HTTPException(503, "계정이 아직 없습니다. 이 PC에서 계정을 먼저 만드세요")
    if auth.locked_out(ip):
        raise HTTPException(429, "로그인 시도가 너무 많습니다. 5분 후 다시 시도하세요")
    if not auth.verify(body.username, body.password):
        auth.record_fail(ip)
        raise HTTPException(401, "아이디 또는 비밀번호가 올바르지 않습니다")
    https = (
        request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
        or request.headers.get("origin", "").startswith("https://")
    )
    response.set_cookie(
        COOKIE,
        auth.create_session(),
        max_age=auth.SESSION_TTL,
        path=f"{BASE_PREFIX}/",
        httponly=True,
        samesite="strict",
        secure=https,
    )
    return {"ok": True}


@router.get("/api/setup")
def api_setup_status(request: Request):
    local = is_local(request)
    return {
        "configured": auth.is_configured(),
        "local": local,
        "username": auth.username() if local else None,
    }


class Setup(BaseModel):
    username: str
    password: str


@router.post("/api/setup")
def api_setup(body: Setup, request: Request):
    if not is_local(request):
        raise HTTPException(403, "계정 설정은 이 PC에서 localhost 주소로 접속했을 때만 가능합니다")
    username = body.username.strip()
    if not username or len(username) > 32 or any(c.isspace() for c in username):
        raise HTTPException(400, "아이디는 공백 없이 1~32자로 입력하세요")
    if len(body.password) < 8:
        raise HTTPException(400, "비밀번호는 8자 이상이어야 합니다")
    auth.set_password(username, body.password)
    return {"ok": True}


def file_edit_enabled() -> bool:
    return bool(store.load_config().get("file_edit", False))


@router.get("/api/settings")
def api_settings(request: Request):
    return {"file_edit": file_edit_enabled(), "local": is_local(request)}


class Settings(BaseModel):
    file_edit: bool


@router.post("/api/settings")
def api_save_settings(body: Settings, request: Request):
    if not is_local(request):
        raise HTTPException(403, "서버 설정은 이 PC에서 localhost 주소로 접속했을 때만 바꿀 수 있습니다")
    cfg = store.load_config()
    cfg["file_edit"] = body.file_edit
    store.save_config(cfg)
    return {"file_edit": body.file_edit}


@router.post("/api/logout")
def api_logout(request: Request, response: Response):
    auth.drop_session(request.cookies.get(COOKIE))
    response.delete_cookie(COOKIE, path=f"{BASE_PREFIX}/")
    return {"ok": True}


@api.get("/version")
def api_version():
    return {"version": APP_VERSION}


@api.get("/sessions")
def api_sessions():
    sessions = list_sessions()
    live = chat.live_sessions()
    group_of = store.group_of()
    company_of = store.company_of()
    for s in sessions:
        s["group"] = group_of.get(s["name"])
        s["company"], s["dept"] = company_of.get(s["name"], (None, None))
        st = push.status.get(s["name"], {})
        s["state"] = st.get("state", "")
        s["preview"] = st.get("preview", [])
        mine = [live[p["id"]] for w in s["windows"] for p in w["panes"] if p["id"] in live]
        s["claude"] = bool(mine)
        if mine:
            s["preview"] = chat.last_said(mine[0]) or s["preview"]
    return sessions


class NewSession(BaseModel):
    name: str
    cwd: str | None = None
    command: str | None = None


@api.post("/sessions")
def api_create_session(body: NewSession):
    name = body.name.strip()
    if not valid_name(name):
        raise HTTPException(400, "세션 이름이 비어 있거나 '.' ':' 가 들어 있습니다")
    cwd = os.path.expanduser((body.cwd or "").strip() or "~")
    if not os.path.isdir(cwd):
        raise HTTPException(400, f"폴더가 없습니다: {cwd}")
    run("new-session", "-d", "-s", name, "-c", cwd)
    store.add_recent_dir(cwd)
    if body.command and body.command.strip():
        run("send-keys", "-t", f"={name}:", body.command.strip(), "Enter")
    return {"ok": True}


class Rename(BaseModel):
    new_name: str


@api.patch("/sessions/{name}")
def api_rename_session(name: str, body: Rename):
    new = body.new_name.strip()
    if not valid_name(new):
        raise HTTPException(400, "세션 이름이 비어 있거나 '.' ':' 가 들어 있습니다")
    run("rename-session", "-t", f"={name}", new)
    store.rename_session(name, new)
    return {"ok": True}


@api.delete("/sessions/{name}")
def api_kill_session(name: str):
    run("kill-session", "-t", f"={name}")
    store.forget_session(name)
    return {"ok": True}


class Select(BaseModel):
    window: int
    pane: int | None = None


@api.post("/sessions/{name}/select")
def api_select(name: str, body: Select):
    run("select-window", "-t", f"={name}:{body.window}")
    if body.pane is not None:
        run("select-pane", "-t", f"={name}:{body.window}.{body.pane}")
    return {"ok": True}


@api.post("/sessions/{name}/windows")
def api_new_window(name: str):
    s = find_session(name)
    run("new-window", "-t", f"={name}:", "-c", s["path"] or os.path.expanduser("~"))
    return {"ok": True}


@api.delete("/sessions/{name}/windows/{window}")
def api_kill_window(name: str, window: int):
    run("kill-window", "-t", f"={name}:{window}")
    return {"ok": True}


class WindowRename(BaseModel):
    new_name: str


@api.patch("/sessions/{name}/windows/{window}")
def api_rename_window(name: str, window: int, body: WindowRename):
    new = body.new_name.strip()
    if not new:
        raise HTTPException(400, "창 이름을 입력하세요")
    run("rename-window", "-t", f"={name}:{window}", new)
    return {"ok": True}


@api.delete("/sessions/{name}/windows/{window}/panes/{pane}")
def api_kill_pane(name: str, window: int, pane: int):
    run("kill-pane", "-t", f"={name}:{window}.{pane}")
    return {"ok": True}


@api.get("/sessions/{name}/capture")
def api_capture(name: str, lines: int = 2000):
    s = find_session(name)
    return {"text": capture(s["pane_id"], history=max(0, min(lines, 50000)))}


@api.get("/sessions/{name}/chat")
def api_chat(name: str, after: int | None = None, before: int | None = None, sid: str = ""):
    find_session(name)
    sess = chat.find(name)
    path = sess and chat.transcript(sess)
    if not path:
        return {"claude": False}
    if sid != sess["sessionId"]:
        after = before = None
    state, ask = chat.screen(sess["pane"])
    return {"claude": True, "sid": sess["sessionId"], "pane": sess["pane"], "state": state, "prompt": ask,
            **chat.read(path, after, before)}


class Choose(BaseModel):
    n: int
    label: str


@api.post("/sessions/{name}/choose")
def api_choose(name: str, body: Choose):
    find_session(name)
    sess = chat.find(name)
    if not sess:
        raise HTTPException(409, "Claude가 떠 있지 않습니다")
    try:
        chat.choose(sess["pane"], body.n, body.label)
    except ValueError as e:
        raise HTTPException(409, str(e))
    return {"ok": True}


@api.post("/sessions/{name}/upload")
async def api_upload(name: str, file: UploadFile):
    s = find_session(name)
    folder = Path(s["path"] or os.path.expanduser("~"))
    base = re.sub(r"[/\\\x00]", "_", Path(file.filename or "upload").name).lstrip(".") or "upload"
    dest = folder / base
    stem, suffix, n = dest.stem, dest.suffix, 1
    while dest.exists():
        dest = folder / f"{stem}-{n}{suffix}"
        n += 1
    size = 0
    try:
        with open(dest, "xb") as f:
            while chunk := await file.read(1 << 20):
                size += len(chunk)
                if size > MAX_UPLOAD:
                    raise HTTPException(413, "파일이 너무 큽니다 (최대 200MB)")
                f.write(chunk)
    except HTTPException:
        dest.unlink(missing_ok=True)
        raise
    except OSError as e:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, f"저장 실패: {e}")
    return {"path": str(dest), "size": size}


def valid_group(name: str) -> str:
    parts = [p.strip() for p in name.strip().strip("/").split("/")]
    if not parts or any(not p or len(p) > 40 for p in parts) or len(parts) > 6:
        raise HTTPException(400, "그룹 이름은 1~40자로 입력하세요 (하위 그룹은 '/'로 구분, 최대 6단계)")
    return "/".join(parts)


@api.get("/groups")
def api_groups():
    return list(store.groups())


class GroupName(BaseModel):
    name: str


@api.post("/groups")
def api_create_group(body: GroupName):
    try:
        store.create_group(valid_group(body.name))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


class GroupRename(BaseModel):
    new_name: str


@api.patch("/groups/{name:path}")
def api_rename_group(name: str, body: GroupRename):
    try:
        store.rename_group(name, valid_group(body.new_name))
    except KeyError as e:
        raise HTTPException(404, e.args[0])
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@api.delete("/groups/{name:path}")
def api_delete_group(name: str, kill: bool = False):
    try:
        members = store.delete_group(name)
    except KeyError as e:
        raise HTTPException(404, e.args[0])
    killed, failed = [], []
    if kill:
        existing = {s["name"] for s in list_sessions()}
        for s in members:
            if s not in existing:
                continue
            if tmux("kill-session", "-t", f"={s}").returncode == 0:
                killed.append(s)
            else:
                failed.append(s)
    return {"killed": killed, "failed": failed}


class MoveGroup(BaseModel):
    group: str | None


@api.put("/sessions/{name}/group")
def api_move_session(name: str, body: MoveGroup):
    try:
        store.move_session(name, body.group)
    except KeyError as e:
        raise HTTPException(404, e.args[0])
    return {"ok": True}


COMPANY_CMD = os.environ.get("TMUX_WEB_COMPANY_CMD", "").strip()
COMPANY_NAME = re.compile(r"^[a-z][a-z0-9-]{1,19}$")
SECTION_CMD = os.environ.get("TMUX_WEB_SECTION_CMD", "").strip()
DEPTS = ("개발", "검증", "운영")


@api.get("/companies")
def api_companies():
    return {"maker": bool(COMPANY_CMD), "sectionMaker": bool(SECTION_CMD),
            "companies": [{"name": n, "repo": c["repo"], "ws": c["ws"], "parent": c["parent"]} for n, c in store.companies().items()]}


class NewCompany(BaseModel):
    name: str
    repo: str


@api.post("/companies")
def api_create_company(body: NewCompany):
    if not COMPANY_CMD:
        raise HTTPException(400, "회사 만들기 명령(TMUX_WEB_COMPANY_CMD)이 설정되지 않았습니다")
    name = body.name.strip()
    if not COMPANY_NAME.match(name):
        raise HTTPException(400, "회사 이름은 영문 소문자로 시작하는 2~20자(소문자·숫자·-)로 입력하세요")
    repo = os.path.realpath(os.path.expanduser(body.repo.strip()))
    if not os.path.isdir(os.path.join(repo, ".git")) and not os.path.isfile(os.path.join(repo, ".git")):
        raise HTTPException(400, f"git 저장소 최상위 폴더가 아닙니다: {repo}")
    try:
        r = subprocess.run([*COMPANY_CMD.split(), name, repo], capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        raise HTTPException(500, "회사 만들기가 5분 안에 끝나지 않았습니다")
    out = (r.stdout + r.stderr).strip()
    if r.returncode != 0:
        raise HTTPException(400, out[-2000:] or f"실패 (종료 코드 {r.returncode})")
    return {"ok": True, "output": out[-4000:]}


class NewSection(BaseModel):
    section: str
    dept: str | None = None
    paths: str | None = None


@api.post("/companies/{name}/sections")
def api_add_section(name: str, body: NewSection):
    if not SECTION_CMD:
        raise HTTPException(400, "섹션 추가 명령(TMUX_WEB_SECTION_CMD)이 설정되지 않았습니다")
    if name not in store.companies():
        raise HTTPException(404, f"회사가 없습니다: {name}")
    sec = body.section.strip()
    if not COMPANY_NAME.match(sec):
        raise HTTPException(400, "섹션 이름은 영문 소문자로 시작하는 2~20자(소문자·숫자·-)로 입력하세요")
    cmd = [*SECTION_CMD.split(), name, sec]
    if body.dept:
        if body.dept not in DEPTS:
            raise HTTPException(400, "부서는 개발·검증·운영 중 하나입니다")
        cmd += ["--dept", body.dept]
    if body.paths and body.paths.strip():
        cmd += ["--paths", body.paths.strip()]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        raise HTTPException(500, "섹션 추가가 5분 안에 끝나지 않았습니다")
    out = (r.stdout + r.stderr).strip()
    if r.returncode != 0:
        raise HTTPException(400, out[-2000:] or f"실패 (종료 코드 {r.returncode})")
    return {"ok": True, "output": out[-4000:]}


@api.delete("/companies/{name}")
def api_delete_company(name: str):
    try:
        members = store.delete_company(name)
    except KeyError as e:
        raise HTTPException(404, e.args[0])
    return {"released": members}


def safe_path(path: str | None) -> Path:
    p = Path(os.path.expanduser(path or str(FILES_ROOT)))
    if not p.is_absolute():
        p = FILES_ROOT / p
    try:
        real = p.resolve(strict=True)
    except (FileNotFoundError, RuntimeError):
        raise HTTPException(404, "파일이나 폴더가 없습니다")
    if not real.is_relative_to(FILES_ROOT):
        raise HTTPException(403, f"{FILES_ROOT} 밖은 볼 수 없습니다")
    return real


@api.get("/files/list")
def api_files_list(path: str | None = None):
    d = safe_path(path)
    if not d.is_dir():
        raise HTTPException(400, "폴더가 아닙니다")
    entries = []
    try:
        items = list(os.scandir(d))
    except PermissionError:
        raise HTTPException(403, "폴더를 읽을 권한이 없습니다")
    for e in items[:5000]:
        try:
            st = e.stat()
            is_dir = e.is_dir()
        except OSError:
            st, is_dir = None, False
        entries.append({
            "name": e.name,
            "dir": is_dir,
            "link": e.is_symlink(),
            "size": st.st_size if st and not is_dir else None,
            "mtime": int(st.st_mtime) if st else None,
        })
    entries.sort(key=lambda x: (not x["dir"], x["name"].lower()))
    return {
        "path": str(d),
        "root": str(FILES_ROOT),
        "parent": str(d.parent) if d != FILES_ROOT else None,
        "entries": entries,
        "truncated": len(items) > 5000,
        "file_edit": file_edit_enabled(),
    }


def decode_text(data: bytes) -> tuple[str, str | None]:
    for enc in ("utf-8", "cp949"):
        try:
            return data.decode(enc), enc
        except UnicodeDecodeError:
            pass
    return data.decode("utf-8", errors="replace"), None


@api.get("/files/read")
def api_files_read(path: str):
    f = safe_path(path)
    if not f.is_file():
        raise HTTPException(400, "파일이 아닙니다")
    st = f.stat()
    try:
        with open(f, "rb") as fh:
            data = fh.read(MAX_TEXT)
    except PermissionError:
        raise HTTPException(403, "파일을 읽을 권한이 없습니다")
    if b"\x00" in data[:8192]:
        return {"path": str(f), "size": st.st_size, "binary": True}
    text, encoding = decode_text(data)
    truncated = st.st_size > MAX_TEXT
    return {
        "path": str(f),
        "size": st.st_size,
        "binary": False,
        "truncated": truncated,
        "text": text,
        "mtime": str(st.st_mtime_ns),
        "encoding": encoding,
        "newline": "\r\n" if b"\r\n" in data else "\n",
        "editable": file_edit_enabled() and not truncated and encoding is not None and os.access(f, os.W_OK),
    }


class FileWrite(BaseModel):
    path: str
    text: str
    mtime: str | None = None
    encoding: str = "utf-8"
    newline: str = "\n"


@api.put("/files/write")
def api_files_write(body: FileWrite):
    if not file_edit_enabled():
        raise HTTPException(403, "파일 수정이 꺼져 있습니다. 서버 PC의 설정 화면(/dev/setup)에서 켤 수 있습니다")
    f = safe_path(body.path)
    if not f.is_file():
        raise HTTPException(400, "파일이 아닙니다")
    if body.encoding not in ("utf-8", "cp949") or body.newline not in ("\n", "\r\n"):
        raise HTTPException(400, "지원하지 않는 인코딩/줄바꿈입니다")
    if body.mtime is not None and str(f.stat().st_mtime_ns) != str(body.mtime):
        raise HTTPException(409, "다른 곳에서 파일이 바뀌었습니다")
    text = body.text.replace("\r\n", "\n")
    if body.newline == "\r\n":
        text = text.replace("\n", "\r\n")
    try:
        data = text.encode(body.encoding)
    except UnicodeEncodeError:
        raise HTTPException(400, f"{body.encoding.upper()}로 저장할 수 없는 글자가 들어 있습니다")
    if len(data) > MAX_TEXT:
        raise HTTPException(413, "파일이 너무 큽니다 (최대 2MB)")
    try:
        fd, tmp = tempfile.mkstemp(dir=f.parent, prefix=f".{f.name}.", suffix=".tmp")
    except PermissionError:
        fd = None
    try:
        if fd is None:
            with open(f, "wb") as fh:
                fh.write(data)
        else:
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
            shutil.copymode(f, tmp)
            os.replace(tmp, f)
    except PermissionError:
        raise HTTPException(403, "파일을 쓸 권한이 없습니다")
    finally:
        if fd is not None and os.path.exists(tmp):
            os.unlink(tmp)
    return {"mtime": str(f.stat().st_mtime_ns), "size": len(data)}


def require_file_edit() -> None:
    if not file_edit_enabled():
        raise HTTPException(403, "파일 수정이 꺼져 있습니다. 서버 PC의 설정 화면(/dev/setup)에서 켤 수 있습니다")


def valid_entry_name(name: str) -> str:
    name = name.strip()
    if not name or name in (".", "..") or "/" in name or "\x00" in name or len(name.encode()) > 255:
        raise HTTPException(400, "사용할 수 없는 이름입니다")
    return name


def safe_entry(path: str) -> Path:
    p = Path(os.path.expanduser(path))
    if not p.is_absolute():
        p = FILES_ROOT / p
    parent = safe_path(str(p.parent))
    entry = parent / p.name
    if not os.path.lexists(entry):
        raise HTTPException(404, "파일이나 폴더가 없습니다")
    if entry == FILES_ROOT or p.name in ("", ".", ".."):
        raise HTTPException(403, "이 폴더는 바꿀 수 없습니다")
    return entry


def unique_path(folder: Path, name: str) -> Path:
    dest = folder / name
    stem, suffix = (name, "") if name.startswith(".") and name.count(".") == 1 else (Path(name).stem, Path(name).suffix)
    n = 1
    while os.path.lexists(dest):
        dest = folder / (f"{stem} ({n}){suffix}" if n > 1 else f"{stem} (복사본){suffix}")
        n += 1
    return dest


class NewEntry(BaseModel):
    folder: str
    name: str
    kind: str


@api.post("/files/new")
def api_files_new(body: NewEntry):
    require_file_edit()
    folder = safe_path(body.folder)
    if not folder.is_dir():
        raise HTTPException(400, "폴더가 아닙니다")
    dest = folder / valid_entry_name(body.name)
    if os.path.lexists(dest):
        raise HTTPException(409, "같은 이름이 이미 있습니다")
    try:
        if body.kind == "dir":
            dest.mkdir()
        elif body.kind == "file":
            dest.touch(exist_ok=False)
        else:
            raise HTTPException(400, "kind는 file 또는 dir")
    except PermissionError:
        raise HTTPException(403, "쓰기 권한이 없습니다")
    return {"path": str(dest)}


class RenameEntry(BaseModel):
    path: str
    new_name: str


@api.post("/files/rename")
def api_files_rename(body: RenameEntry):
    require_file_edit()
    src = safe_entry(body.path)
    dest = src.parent / valid_entry_name(body.new_name)
    if dest == src:
        return {"path": str(dest)}
    if os.path.lexists(dest):
        raise HTTPException(409, "같은 이름이 이미 있습니다")
    try:
        os.rename(src, dest)
    except PermissionError:
        raise HTTPException(403, "쓰기 권한이 없습니다")
    return {"path": str(dest)}


class Transfer(BaseModel):
    paths: list[str]
    dest: str
    mode: str


@api.post("/files/transfer")
def api_files_transfer(body: Transfer):
    require_file_edit()
    if body.mode not in ("copy", "move"):
        raise HTTPException(400, "mode는 copy 또는 move")
    folder = safe_path(body.dest)
    if not folder.is_dir():
        raise HTTPException(400, "대상이 폴더가 아닙니다")
    done, failed = [], []
    for raw in body.paths[:500]:
        try:
            src = safe_entry(raw)
            if src.is_dir() and not src.is_symlink() and (folder == src or folder.is_relative_to(src)):
                raise HTTPException(400, "폴더를 자기 자신 안으로 옮기거나 복사할 수 없습니다")
            if body.mode == "move":
                if src.parent == folder:
                    continue
                dest = folder / src.name
                if os.path.lexists(dest):
                    raise HTTPException(409, "같은 이름이 이미 있습니다")
                shutil.move(str(src), str(dest))
            else:
                dest = unique_path(folder, src.name)
                if src.is_dir() and not src.is_symlink():
                    shutil.copytree(src, dest, symlinks=True)
                else:
                    shutil.copy2(src, dest, follow_symlinks=False)
            done.append(str(dest))
        except HTTPException as e:
            failed.append({"path": raw, "error": e.detail})
        except OSError as e:
            failed.append({"path": raw, "error": e.strerror or str(e)})
    return {"done": done, "failed": failed}


class DeleteEntries(BaseModel):
    paths: list[str]


@api.post("/files/delete")
def api_files_delete(body: DeleteEntries):
    require_file_edit()
    done, failed = [], []
    for raw in body.paths[:500]:
        try:
            send2trash(str(safe_entry(raw)))
            done.append(raw)
        except HTTPException as e:
            failed.append({"path": raw, "error": e.detail})
        except OSError as e:
            failed.append({"path": raw, "error": e.strerror or str(e)})
    return {"done": done, "failed": failed}


@api.get("/files/raw")
def api_files_raw(path: str, download: bool = False):
    f = safe_path(path)
    if not f.is_file():
        raise HTTPException(400, "파일이 아닙니다")
    headers = {
        "Content-Security-Policy": "sandbox",
        "X-Content-Type-Options": "nosniff",
    }
    if download:
        return FileResponse(f, filename=f.name, headers=headers)
    return FileResponse(f, headers=headers, content_disposition_type="inline", filename=f.name)


PERSIST_DIR = Path(
    os.environ.get("TMUX_PERSIST_DIR")
    or Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share") / "tmux-persist"
)


def persist_bin() -> str | None:
    for cand in (
        os.environ.get("TMUX_PERSIST_BIN"),
        shutil.which("tmux-persist"),
        str(Path.home() / ".local/bin/tmux-persist"),
        str(Path(__file__).parent / "addons/tmux-persist/tmux-persist"),
    ):
        if cand and os.access(cand, os.X_OK):
            return cand
    return None


def persist_auto() -> bool:
    if shutil.which("systemctl"):
        r = subprocess.run(["systemctl", "--user", "is-active", "tmux-persist-save.timer"], capture_output=True, text=True)
        return r.stdout.strip() == "active"
    if shutil.which("launchctl"):
        r = subprocess.run(["launchctl", "list", "kr.tmuxweb.persist-save"], capture_output=True, text=True)
        return r.returncode == 0
    return False


def run_persist(*args: str) -> str:
    b = persist_bin()
    if not b:
        raise HTTPException(404, "tmux-persist가 설치되어 있지 않습니다 (install 스크립트를 --with-persist 로 실행)")
    env = {k: v for k, v in os.environ.items() if k != "TMUX"}
    r = subprocess.run([b, *args], capture_output=True, text=True, env=env, timeout=120)
    out = (r.stdout + r.stderr).strip()
    if r.returncode != 0:
        raise HTTPException(500, out or "tmux-persist 실행 실패")
    return out


@api.get("/persist")
def api_persist():
    snaps = []
    snap_dir = PERSIST_DIR / "snapshots"
    last = (PERSIST_DIR / "last").resolve() if (PERSIST_DIR / "last").exists() else None
    if snap_dir.is_dir():
        for p in sorted(snap_dir.iterdir(), reverse=True)[:100]:
            try:
                st = json.loads((p / "state.json").read_text())
            except (OSError, ValueError):
                continue
            names = [x.get("name", "") for x in st.get("sessions", [])]
            snaps.append({"name": p.name, "sessions": names, "latest": p.resolve() == last})
    return {"installed": persist_bin() is not None, "auto": persist_auto(), "snapshots": snaps}


@api.post("/persist/save")
def api_persist_save():
    return {"output": run_persist("save")}


class PersistRestore(BaseModel):
    snapshot: str | None = None


@api.post("/persist/restore")
def api_persist_restore(body: PersistRestore):
    args = ["restore"]
    if body.snapshot:
        if not re.fullmatch(r"[0-9A-Za-z_.-]+", body.snapshot) or not (PERSIST_DIR / "snapshots" / body.snapshot).is_dir():
            raise HTTPException(400, "스냅샷이 없습니다")
        args.append(body.snapshot)
    return {"output": run_persist(*args)}


class Config(BaseModel):
    snippets: list[str]


LAYOUTS_FILE = "layouts.json"


def valid_layout_name(name: str) -> str:
    name = name.strip()
    if not name or len(name) > 40 or "/" in name:
        raise HTTPException(400, "구성 이름은 1~40자, '/' 없이 입력하세요")
    return name


@api.get("/layouts")
def api_layouts():
    items = []
    for name, v in store.load(LAYOUTS_FILE, {}).items():
        desks = v.get("desks", [])
        items.append({
            "name": name,
            "saved_at": v.get("saved_at", 0),
            "desks": [d.get("name", "") for d in desks],
        })
    return sorted(items, key=lambda x: -x["saved_at"])


@api.get("/layouts/{name}")
def api_layout(name: str):
    v = store.load(LAYOUTS_FILE, {}).get(name)
    if v is None:
        raise HTTPException(404, "저장된 구성이 없습니다")
    return v


class LayoutBody(BaseModel):
    desks: list[dict]
    deskIdx: int = 0


@api.put("/layouts/{name}")
def api_save_layout(name: str, body: LayoutBody):
    name = valid_layout_name(name)
    if not body.desks or len(body.desks) > 30:
        raise HTTPException(400, "데스크탑은 1~30개여야 합니다")
    data = {"desks": body.desks, "deskIdx": body.deskIdx, "saved_at": int(time.time())}
    if len(json.dumps(data)) > 300_000:
        raise HTTPException(413, "구성이 너무 큽니다")
    layouts = store.load(LAYOUTS_FILE, {})
    layouts[name] = data
    store.save(LAYOUTS_FILE, layouts)
    return {"ok": True}


@api.delete("/layouts/{name}")
def api_delete_layout(name: str):
    layouts = store.load(LAYOUTS_FILE, {})
    if layouts.pop(name, None) is None:
        raise HTTPException(404, "저장된 구성이 없습니다")
    store.save(LAYOUTS_FILE, layouts)
    return {"ok": True}


@api.get("/config")
def api_config():
    return store.load_config()


@api.put("/config")
def api_save_config(body: Config):
    cfg = store.load_config()
    cfg["snippets"] = [s for s in (x.strip() for x in body.snippets) if s][:50]
    store.save_config(cfg)
    return cfg


@api.get("/dirs")
def api_dirs():
    home = Path.home()
    candidates = list(store.load_config()["recent_dirs"])
    candidates += [s["path"] for s in list_sessions() if s["path"]]
    for parent in (home / "Workspace", home / "dev", home):
        if parent.is_dir():
            candidates += sorted(str(p) for p in parent.iterdir() if p.is_dir() and not p.name.startswith("."))
    seen, dirs = set(), []
    for d in candidates:
        if d not in seen and os.path.isdir(d):
            seen.add(d)
            dirs.append(d)
    return {"home": str(home), "root": str(FILES_ROOT), "dirs": dirs[:60]}


@api.get("/push/key")
def api_push_key():
    return {"key": push.public_key()}


class Subscription(BaseModel):
    endpoint: str
    keys: dict[str, str]


@api.post("/push/subscribe")
def api_push_subscribe(sub: Subscription):
    push.subscribe(sub.model_dump())
    return {"ok": True}


class Unsubscribe(BaseModel):
    endpoint: str


@api.post("/push/unsubscribe")
def api_push_unsubscribe(body: Unsubscribe):
    push.unsubscribe(body.endpoint)
    return {"ok": True}


@api.post("/push/test")
def api_push_test():
    return {"sent": push.send_all("🔔 tmux 모니터", "알림이 정상적으로 설정되었습니다")}


router.include_router(api)


def set_winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def scroll_pane(name: str, lines: int, cols: int, rows: int) -> bytes:
    target = f"={name}:"
    flags = tmux("display", "-p", "-t", target,
                 "#{pane_in_mode} #{mouse_standard_flag}#{mouse_button_flag}#{mouse_any_flag} #{mouse_sgr_flag}").stdout.split()
    in_mode, wants_mouse, sgr = flags[0] == "1", "1" in flags[1], flags[2] == "1"
    if wants_mouse and not in_mode:
        button = 64 if lines > 0 else 65
        col, row = max(cols // 2, 1), max(rows // 2, 1)
        if sgr:
            event = f"\x1b[<{button};{col};{row}M".encode()
        else:
            event = b"\x1b[M" + bytes([32 + button, 32 + min(col, 223), 32 + min(row, 223)])
        return event * min(abs(lines), 30)
    if lines > 0:
        tmux("copy-mode", "-e", "-t", target)
    tmux("send-keys", "-t", target, "-X", "-N", str(min(abs(lines), 200)),
         "scroll-up" if lines > 0 else "scroll-down")
    return b""


def origin_allowed(ws: WebSocket) -> bool:
    origin = ws.headers.get("origin")
    host = ws.headers.get("host")
    return origin is None or origin.split("://", 1)[-1] == host


@router.websocket("/ws/{name}")
async def ws_attach(ws: WebSocket, name: str):
    if not origin_allowed(ws):
        await ws.close()
        return
    await ws.accept()
    if not auth.valid_session(ws.cookies.get(COOKIE)):
        await ws.close(code=4401)
        return
    if not session_exists(name):
        await ws.close(code=4404)
        return

    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ.pop("TMUX", None)
        os.execvp("tmux", ["tmux", "-u", "attach-session", "-t", f"={name}"])

    loop = asyncio.get_running_loop()
    output: asyncio.Queue[bytes | None] = asyncio.Queue()

    def on_readable():
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if not data:
            loop.remove_reader(fd)
            output.put_nowait(None)
        else:
            output.put_nowait(data)

    loop.add_reader(fd, on_readable)

    async def pump_output():
        while (data := await output.get()) is not None:
            await ws.send_bytes(data)
        await ws.close()

    sender = asyncio.create_task(pump_output())
    size = (80, 24)
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            if msg["type"] == "input":
                os.write(fd, msg["data"].encode())
            elif msg["type"] == "resize":
                size = (int(msg["cols"]), int(msg["rows"]))
                set_winsize(fd, size[1], size[0])
            elif msg["type"] == "ping":
                output.put_nowait(b"")
            elif msg["type"] == "scroll":
                wheel = await loop.run_in_executor(None, scroll_pane, name, int(msg["lines"]), *size)
                if wheel:
                    os.write(fd, wheel)
            elif msg["type"] == "scroll-exit":
                await loop.run_in_executor(None, tmux, "send-keys", "-t", f"={name}:", "-X", "cancel")
    except (WebSocketDisconnect, RuntimeError, OSError):
        pass
    finally:
        sender.cancel()
        loop.remove_reader(fd)
        try:
            os.kill(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass
        os.close(fd)
        await loop.run_in_executor(None, os.waitpid, pid, 0)


app.include_router(router, prefix=BASE_PREFIX)
app.mount(f"{BASE_PREFIX}/static", StaticFiles(directory=STATIC_DIR), name="static")

if BASE_PATH != "/":

    @app.get("/")
    @app.get(BASE_PATH)
    def redirect_to_base():
        return RedirectResponse(BASE_PATH + "/")


if __name__ == "__main__":
    import sys

    import uvicorn

    if not auth.is_configured():
        port_ = os.environ.get("PORT", "8765")
        print(f"로그인 계정이 없습니다. 이 PC의 브라우저에서 http://localhost:{port_}{BASE_PREFIX}/setup 을 열어 만드세요",
              file=sys.stderr)
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8765"))
    uvicorn.run(app, host=host, port=port)
