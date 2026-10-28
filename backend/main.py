from fastapi import FastAPI, HTTPException, Header, Depends, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse, JSONResponse
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import http_exception_handler
from starlette.exceptions import HTTPException as StarletteHTTPException
from slowapi import Limiter
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from services.matchmaker import make_pairs
from i18n_messages import localize, to_english, wants_english, validation_message_en
from pydantic import BaseModel, Field, StringConstraints
from typing import Optional, Annotated
from datetime import datetime, timezone, timedelta
import sqlite3
import hashlib
import secrets
import bcrypt
import urllib.request
import json
import mimetypes
import os
import re
import contextlib
import concurrent.futures

_origins_env = os.environ.get("ALLOWED_ORIGINS", "")
ALLOWED_ORIGINS = _origins_env.split(",") if _origins_env else ["*"]

TOKEN_EXPIRE_DAYS = 30

USERNAME_RE = re.compile(r'^[a-zA-Z0-9_가-힣]+$')

limiter = Limiter(key_func=get_remote_address)

app = FastAPI(title="체스 동아리 API", version="0.2.0")
app.state.limiter = limiter


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    """slowapi 기본 응답({"error": "Rate limit exceeded: ..."})은 프론트가 읽는 detail이 없고
    한국어 화면에도 영어로 나와서, 안내 문구를 detail로 내려준다 (Retry-After 등 헤더는 유지)."""
    response = JSONResponse(
        status_code=429,
        content={"detail": localize(request, "요청이 너무 많습니다. 잠시 후 다시 시도해주세요.")},
    )
    return request.app.state.limiter._inject_headers(response, request.state.view_rate_limit)


@app.exception_handler(StarletteHTTPException)
async def localized_http_exception_handler(request: Request, exc: StarletteHTTPException):
    """라우트는 한국어 메시지로 HTTPException을 던지고, 영어 화면에서 온 요청이면 여기서 번역한다."""
    if isinstance(exc.detail, str) and wants_english(request):
        exc = StarletteHTTPException(status_code=exc.status_code, detail=to_english(exc.detail), headers=exc.headers)
    return await http_exception_handler(request, exc)

_VALIDATION_FIELD_LABELS = {
    "username": "아이디", "nickname": "이름",
    "password": "비밀번호", "new_password": "새 비밀번호", "current_password": "현재 비밀번호",
    "title": "제목", "content": "내용", "note": "메모",
    "chess_username": "Chess.com 아이디", "name": "이름",
    "pts_win": "승리 승점", "pts_draw": "무승부 승점", "pts_loss": "패배 승점",
}


def _josa(word: str, with_batchim: str, without_batchim: str) -> str:
    """한글 단어 끝 받침 유무에 따라 올바른 조사(은/는, 을/를 등)를 붙여 반환."""
    if not word:
        return without_batchim
    last = word[-1]
    if "가" <= last <= "힣":
        has_batchim = (ord(last) - ord("가")) % 28 != 0
        return with_batchim if has_batchim else without_batchim
    return without_batchim  # 영문 등은 기본형 사용


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """
    Pydantic 검증 실패 시 FastAPI 기본 응답은 detail이 배열([{type, loc, msg, ...}])이라
    프론트에서 문자열로 그대로 출력하면 '[object Object]'가 뜬다.
    사람이 읽을 수 있는 한 줄 문자열로 변환해 내려준다.
    """
    first = exc.errors()[0]
    field = str(first["loc"][-1]) if first.get("loc") else ""
    err_type = first.get("type", "")
    ctx = first.get("ctx", {})
    if wants_english(request):
        return JSONResponse(status_code=422, content={"detail": validation_message_en(field, err_type, ctx)})

    label = _VALIDATION_FIELD_LABELS.get(field, field or "입력값")
    eun_neun = _josa(label, "은", "는")
    eul_reul = _josa(label, "을", "를")

    if err_type == "string_too_short" and ctx.get("min_length") == 1:
        detail = f"{label}{eul_reul} 입력해주세요."
    elif err_type == "string_too_short":
        detail = f"{label}{eun_neun} {ctx.get('min_length')}자 이상이어야 합니다."
    elif err_type == "string_too_long":
        detail = f"{label}{eun_neun} {ctx.get('max_length')}자 이하여야 합니다."
    elif err_type == "greater_than_equal":
        detail = f"{label}{eun_neun} {ctx.get('ge')} 이상이어야 합니다."
    elif err_type == "less_than_equal":
        detail = f"{label}{eun_neun} {ctx.get('le')} 이하여야 합니다."
    elif err_type == "greater_than":
        detail = f"{label}{eun_neun} {ctx.get('gt')}보다 커야 합니다."
    elif err_type == "less_than":
        detail = f"{label}{eun_neun} {ctx.get('lt')}보다 작아야 합니다."
    elif err_type == "missing":
        detail = f"{label}{eul_reul} 입력해주세요."
    else:
        detail = f"{label} 값이 올바르지 않습니다."

    return JSONResponse(status_code=422, content={"detail": detail})


app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_PATH      = os.environ.get("DB_PATH", "chess_club.db")
TURSO_URL    = os.environ.get("TURSO_DATABASE_URL", "")
TURSO_TOKEN  = os.environ.get("TURSO_AUTH_TOKEN", "")

KST = timezone(timedelta(hours=9))


def now_kst() -> datetime:
    return datetime.now(KST).replace(tzinfo=None)

# Chess.com PubAPI 가이드라인: User-Agent 명시 필수
CHESS_COM_USER_AGENT = "ChessClubApp/1.0 (chess club rating tracker)"


@contextlib.contextmanager
def get_db():
    if TURSO_URL and TURSO_TOKEN:
        import turso_http
        conn = turso_http.connect(TURSO_URL, TURSO_TOKEN)
    else:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    """테이블이 없을 때만 생성 (신규 설치 기준)."""
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                username          TEXT    UNIQUE NOT NULL,
                nickname          TEXT    NOT NULL,
                password          TEXT    NOT NULL,
                token             TEXT,
                token_expires_at  TEXT,
                chess_username    TEXT,
                rating_rapid      INTEGER,
                rating_updated_at TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS groups (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT    NOT NULL,
                owner_id    INTEGER NOT NULL,
                invite_code TEXT    UNIQUE NOT NULL,
                created_at  TEXT    DEFAULT (datetime('now', '+9 hours')),
                FOREIGN KEY (owner_id) REFERENCES users(id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS user_groups (
                user_id   INTEGER NOT NULL,
                group_id  INTEGER NOT NULL,
                role      TEXT    NOT NULL DEFAULT '회원',
                joined_at TEXT    DEFAULT (datetime('now', '+9 hours')),
                PRIMARY KEY (user_id, group_id),
                FOREIGN KEY (user_id)  REFERENCES users(id),
                FOREIGN KEY (group_id) REFERENCES groups(id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS matches (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id    INTEGER NOT NULL,
                poll_id     INTEGER,
                player1_id  INTEGER NOT NULL,
                player2_id  INTEGER NOT NULL,
                winner_id   INTEGER,
                recorded_by INTEGER NOT NULL,
                status      TEXT    NOT NULL DEFAULT 'playing',
                is_official INTEGER NOT NULL DEFAULT 1,
                note        TEXT,
                folder_id   INTEGER,
                player1_rating INTEGER,
                player2_rating INTEGER,
                played_at   TEXT    DEFAULT (datetime('now', '+9 hours')),
                FOREIGN KEY (group_id)    REFERENCES groups(id),
                FOREIGN KEY (poll_id)     REFERENCES polls(id),
                FOREIGN KEY (player1_id)  REFERENCES users(id),
                FOREIGN KEY (player2_id)  REFERENCES users(id),
                FOREIGN KEY (winner_id)   REFERENCES users(id),
                FOREIGN KEY (recorded_by) REFERENCES users(id),
                FOREIGN KEY (folder_id)   REFERENCES match_folders(id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS polls (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id    INTEGER NOT NULL,
                created_by  INTEGER NOT NULL,
                title       TEXT    NOT NULL DEFAULT '',
                status      TEXT    NOT NULL DEFAULT 'voting',
                is_official INTEGER NOT NULL DEFAULT 1,
                created_at  TEXT    DEFAULT (datetime('now', '+9 hours')),
                FOREIGN KEY (group_id)   REFERENCES groups(id),
                FOREIGN KEY (created_by) REFERENCES users(id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS group_settings (
                group_id            INTEGER PRIMARY KEY,
                pts_win             INTEGER NOT NULL DEFAULT 3,
                pts_draw            INTEGER NOT NULL DEFAULT 2,
                pts_loss            INTEGER NOT NULL DEFAULT 1,
                is_color_automatic  INTEGER NOT NULL DEFAULT 1,
                FOREIGN KEY (group_id) REFERENCES groups(id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS poll_votes (
                poll_id        INTEGER NOT NULL,
                user_id        INTEGER NOT NULL,
                rating_at_vote INTEGER,
                voted_at TEXT    DEFAULT (datetime('now', '+9 hours')),
                PRIMARY KEY (poll_id, user_id),
                FOREIGN KEY (poll_id) REFERENCES polls(id),
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS announcements (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id   INTEGER NOT NULL,
                author_id  INTEGER NOT NULL,
                title      TEXT    NOT NULL,
                content    TEXT    NOT NULL,
                created_at TEXT    DEFAULT (datetime('now', '+9 hours')),
                FOREIGN KEY (group_id)  REFERENCES groups(id),
                FOREIGN KEY (author_id) REFERENCES users(id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS activity_logs (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id   INTEGER NOT NULL,
                user_id    INTEGER NOT NULL,
                action     TEXT    NOT NULL,
                detail     TEXT    NOT NULL DEFAULT '',
                created_at TEXT    DEFAULT (datetime('now', '+9 hours')),
                FOREIGN KEY (group_id) REFERENCES groups(id),
                FOREIGN KEY (user_id)  REFERENCES users(id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS match_folders (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id   INTEGER NOT NULL,
                name       TEXT    NOT NULL,
                created_by INTEGER NOT NULL,
                created_at TEXT    DEFAULT (datetime('now', '+9 hours')),
                FOREIGN KEY (group_id)   REFERENCES groups(id),
                FOREIGN KEY (created_by) REFERENCES users(id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS chess_rating_cache (
                user_id        INTEGER PRIMARY KEY,
                data           TEXT    NOT NULL,
                months_fetched INTEGER NOT NULL DEFAULT 0,
                fetched_at     TEXT    NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        """)
        conn.commit()


def migrate_db():
    """기존 DB에 신규 컬럼이 없을 경우 안전하게 추가 (OperationalError 무시)."""
    migrations = [
        "ALTER TABLE users ADD COLUMN chess_username TEXT",
        "ALTER TABLE users ADD COLUMN rating_rapid INTEGER",
        "ALTER TABLE users ADD COLUMN rating_updated_at TEXT",
        "ALTER TABLE users ADD COLUMN token_expires_at TEXT",
        "ALTER TABLE user_groups ADD COLUMN joined_at TEXT DEFAULT (datetime('now', '+9 hours'))",
        "ALTER TABLE user_groups ADD COLUMN role TEXT NOT NULL DEFAULT '회원'",
        "ALTER TABLE matches ADD COLUMN poll_id INTEGER",
        "ALTER TABLE matches ADD COLUMN status TEXT NOT NULL DEFAULT 'playing'",
        "ALTER TABLE polls ADD COLUMN title TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE matches ADD COLUMN pgn_data TEXT",
        "ALTER TABLE group_settings ADD COLUMN is_color_automatic INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE matches ADD COLUMN is_official INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE matches ADD COLUMN note TEXT",
        "ALTER TABLE matches ADD COLUMN folder_id INTEGER",
        "ALTER TABLE polls ADD COLUMN is_official INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE matches ADD COLUMN player1_rating INTEGER",
        "ALTER TABLE matches ADD COLUMN player2_rating INTEGER",
        "ALTER TABLE poll_votes ADD COLUMN rating_at_vote INTEGER",
        """CREATE TABLE IF NOT EXISTS match_folders (
               id         INTEGER PRIMARY KEY AUTOINCREMENT,
               group_id   INTEGER NOT NULL,
               name       TEXT    NOT NULL,
               created_by INTEGER NOT NULL,
               created_at TEXT    DEFAULT (datetime('now', '+9 hours')),
               FOREIGN KEY (group_id)   REFERENCES groups(id),
               FOREIGN KEY (created_by) REFERENCES users(id)
           )""",
        """CREATE TABLE IF NOT EXISTS activity_logs (
               id         INTEGER PRIMARY KEY AUTOINCREMENT,
               group_id   INTEGER NOT NULL,
               user_id    INTEGER NOT NULL,
               action     TEXT    NOT NULL,
               detail     TEXT    NOT NULL DEFAULT '',
               created_at TEXT    DEFAULT (datetime('now', '+9 hours')),
               FOREIGN KEY (group_id) REFERENCES groups(id),
               FOREIGN KEY (user_id)  REFERENCES users(id)
           )""",
    ]
    with get_db() as conn:
        for sql in migrations:
            try:
                conn.execute(sql)
                conn.commit()
            except sqlite3.OperationalError:
                pass  # 이미 존재하는 컬럼 — 정상

        # group_settings 테이블이 없는 기존 DB에 생성
        try:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS group_settings (
                    group_id            INTEGER PRIMARY KEY,
                    pts_win             INTEGER NOT NULL DEFAULT 3,
                    pts_draw            INTEGER NOT NULL DEFAULT 2,
                    pts_loss            INTEGER NOT NULL DEFAULT 1,
                    is_color_automatic  INTEGER NOT NULL DEFAULT 1,
                    FOREIGN KEY (group_id) REFERENCES groups(id)
                )
            """)
            conn.commit()
        except Exception:
            pass

        # polls 테이블이 없는 기존 DB에 생성
        try:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS polls (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    group_id    INTEGER NOT NULL,
                    created_by  INTEGER NOT NULL,
                    title       TEXT    NOT NULL DEFAULT '',
                    status      TEXT    NOT NULL DEFAULT 'voting',
                    is_official INTEGER NOT NULL DEFAULT 1,
                    created_at  TEXT    DEFAULT (datetime('now', '+9 hours')),
                    FOREIGN KEY (group_id)   REFERENCES groups(id),
                    FOREIGN KEY (created_by) REFERENCES users(id)
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS poll_votes (
                    poll_id  INTEGER NOT NULL,
                    user_id  INTEGER NOT NULL,
                    voted_at TEXT    DEFAULT (datetime('now', '+9 hours')),
                    PRIMARY KEY (poll_id, user_id),
                    FOREIGN KEY (poll_id) REFERENCES polls(id),
                    FOREIGN KEY (user_id) REFERENCES users(id)
                )
            """)
            conn.commit()
        except Exception:
            pass

        # announcements 테이블이 없는 기존 DB에 생성
        try:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS announcements (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    group_id   INTEGER NOT NULL,
                    author_id  INTEGER NOT NULL,
                    title      TEXT    NOT NULL,
                    content    TEXT    NOT NULL,
                    created_at TEXT    DEFAULT (datetime('now', '+9 hours')),
                    FOREIGN KEY (group_id)  REFERENCES groups(id),
                    FOREIGN KEY (author_id) REFERENCES users(id)
                )
            """)
            conn.commit()
        except Exception:
            pass

        # chess_rating_cache 테이블이 없는 기존 DB에 생성
        try:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS chess_rating_cache (
                    user_id        INTEGER PRIMARY KEY,
                    data           TEXT    NOT NULL,
                    months_fetched INTEGER NOT NULL DEFAULT 0,
                    fetched_at     TEXT    NOT NULL,
                    FOREIGN KEY (user_id) REFERENCES users(id)
                )
            """)
            conn.commit()
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE chess_rating_cache ADD COLUMN months_fetched INTEGER NOT NULL DEFAULT 0")
            conn.commit()
        except sqlite3.OperationalError:
            pass  # 이미 존재하는 컬럼 — 정상

        # 기존 그룹 방장에게 '방장' 역할 부여
        try:
            conn.execute("""
                UPDATE user_groups SET role = '방장'
                WHERE user_id = (SELECT owner_id FROM groups WHERE id = user_groups.group_id)
                  AND role = '회원'
            """)
            conn.commit()
        except Exception:
            pass


init_db()
migrate_db()


# ---------- 유틸 ----------

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def _verify_password(plain: str, stored: str) -> bool:
    """bcrypt 해시 검증. 구형 sha256 해시이면 평문 비교 후 True 반환해 마이그레이션 트리거."""
    if _is_sha256(stored):
        return hashlib.sha256(plain.encode()).hexdigest() == stored
    return bcrypt.checkpw(plain.encode(), stored.encode())


def _is_sha256(h: str) -> bool:
    return len(h) == 64 and all(c in "0123456789abcdef" for c in h)


def _token_valid(row) -> bool:
    """저장된 토큰이 있고 만료되지 않았는지."""
    if not row["token"]:
        return False
    if not row["token_expires_at"]:
        return True
    try:
        return now_kst() <= datetime.fromisoformat(row["token_expires_at"])
    except ValueError:
        return True


def get_current_user(authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="인증이 필요합니다.")
    token = authorization[7:]
    with get_db() as conn:
        row = conn.execute("SELECT * FROM users WHERE token = ?", (token,)).fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="유효하지 않은 토큰입니다.")
    if row["token_expires_at"]:
        try:
            expires = datetime.fromisoformat(row["token_expires_at"])
            if now_kst() > expires:
                raise HTTPException(status_code=401, detail="세션이 만료되었습니다. 다시 로그인해주세요.")
        except ValueError:
            pass
    return row


# ---------- Chess.com 서비스 ----------

def fetch_chess_ratings(chess_username: str) -> dict:
    """
    Chess.com PubAPI에서 rapid 레이팅 조회.
    - User-Agent 필수: Chess.com 가이드라인 준수
    - 타임아웃 15초, 실패 시 빈 dict 반환 + 서버 콘솔에 오류 출력
    """
    url = f"https://api.chess.com/pub/player/{chess_username.lower()}/stats"
    req = urllib.request.Request(url, headers={"User-Agent": CHESS_COM_USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
            return {
                "rating_rapid": data.get("chess_rapid", {}).get("last", {}).get("rating"),
            }
    except urllib.error.HTTPError as e:
        print(f"[Chess.com] HTTP {e.code} - {chess_username}", flush=True)
        return {}
    except urllib.error.URLError as e:
        print(f"[Chess.com] 연결 오류 - {chess_username}: {e.reason}", flush=True)
        return {}
    except Exception as e:
        print(f"[Chess.com] 기타 오류 - {chess_username}: {e}", flush=True)
        return {}


def _should_refresh(rating_updated_at: Optional[str]) -> bool:
    """마지막 업데이트로부터 1시간 이상 경과했으면 True (Rate Limiting 방지)."""
    if not rating_updated_at:
        return True
    try:
        elapsed = (now_kst() - datetime.fromisoformat(rating_updated_at)).total_seconds()
        return elapsed > 3600
    except Exception:
        return True


def update_user_rating(user_id: int, chess_username: str):
    """BackgroundTask: Chess.com 레이팅을 가져와 DB에 저장."""
    ratings = fetch_chess_ratings(chess_username)
    if not ratings:
        return
    with get_db() as conn:
        conn.execute(
            """UPDATE users
               SET rating_rapid = ?, rating_updated_at = ?
               WHERE id = ?""",
            (
                ratings.get("rating_rapid"),
                now_kst().isoformat(timespec="seconds"),
                user_id,
            ),
        )
        conn.commit()


CHESS_TREND_CACHE_TTL_SECONDS = 3600
CHESS_TREND_MAX_MONTHS = 60  # 최대 5년치 월간 아카이브까지만 조회 (응답 속도·API 호출 수 보호)

PERIOD_TO_DAYS   = {"7d": 7, "30d": 30, "1y": 365, "all": None}
# 기간별로 실제 필요한 최소 아카이브 개월 수(여유분 포함) — 짧은 기간 조회 시 불필요하게
# 전체 기록을 긁어오지 않도록 캐시를 필요한 만큼만 점진적으로 채운다.
PERIOD_TO_MONTHS = {"7d": 2, "30d": 2, "1y": 13, "all": CHESS_TREND_MAX_MONTHS}


def fetch_chess_rating_trend(chess_username: str, max_months: int = CHESS_TREND_MAX_MONTHS) -> list:
    """
    Chess.com 월별 게임 아카이브(pubapi)를 순회하며 래피드(rapid) 경기 종료 시점의
    레이팅을 모아, 하루 단위(그 날 마지막 경기 기준)로 집계한
    [{"date": "YYYY-MM-DD", "rating": N}, ...] 리스트를 오름차순으로 반환.
    실패 시 빈 리스트 반환.
    """
    username_lower = chess_username.lower()
    archives_url = f"https://api.chess.com/pub/player/{username_lower}/games/archives"
    req = urllib.request.Request(archives_url, headers={"User-Agent": CHESS_COM_USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            archive_urls = json.loads(resp.read()).get("archives", [])
    except Exception as e:
        print(f"[Chess.com] 아카이브 목록 조회 실패 - {chess_username}: {e}", flush=True)
        return []

    archive_urls = archive_urls[-max_months:]  # 최신 월부터 max_months개만 사용

    def _fetch_month(url: str) -> list:
        req = urllib.request.Request(url, headers={"User-Agent": CHESS_COM_USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read()).get("games", [])
        except Exception as e:
            print(f"[Chess.com] 월간 아카이브 조회 실패 - {url}: {e}", flush=True)
            return []

    # 월별 아카이브는 서로 독립적인 요청이므로 스레드풀로 동시에 가져와 응답 시간을 단축
    all_games = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
        for games in pool.map(_fetch_month, archive_urls):
            all_games.extend(games)

    daily_last = {}  # date_str -> (end_time, rating)
    for g in all_games:
        if g.get("time_class") != "rapid":
            continue
        end_time = g.get("end_time")
        if not end_time:
            continue

        white, black = g.get("white", {}), g.get("black", {})
        if white.get("username", "").lower() == username_lower:
            rating = white.get("rating")
        elif black.get("username", "").lower() == username_lower:
            rating = black.get("rating")
        else:
            continue
        if rating is None:
            continue

        date_str = datetime.fromtimestamp(end_time, tz=timezone.utc).astimezone(KST).strftime("%Y-%m-%d")
        existing = daily_last.get(date_str)
        if not existing or end_time > existing[0]:
            daily_last[date_str] = (end_time, rating)

    return [{"date": d, "rating": v[1]} for d, v in sorted(daily_last.items())]


# ---------- 스키마 ----------

# 앞뒤 공백을 먼저 제거한 뒤 길이 검사 (공백만 입력 → "입력해주세요", 공백은 10자에 포함 안 됨)
Nickname = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=10)]


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=20)
    nickname: Nickname
    password: str = Field(min_length=4, max_length=128)


class LoginRequest(BaseModel):
    username: str
    password: str


class CreateGroupRequest(BaseModel):
    name: str = Field(min_length=2, max_length=50)


class JoinGroupRequest(BaseModel):
    invite_code: str


class UpdateChessRequest(BaseModel):
    chess_username: str


class CreatePollRequest(BaseModel):
    title: str = ""
    is_official: bool = True


class GroupSettingsRequest(BaseModel):
    pts_win:            int = Field(ge=0, le=99)
    pts_draw:           int = Field(ge=0, le=99)
    pts_loss:           int = Field(ge=0, le=99)
    is_color_automatic: bool = True


class MatchResultRequest(BaseModel):
    winner_id: Optional[int] = None


class UpdatePGNRequest(BaseModel):
    pgn_data: str


class EditMatchRequest(BaseModel):
    player1_id: int
    player2_id: int
    result: str  # "p1_win" | "p2_win" | "draw" | "none"


class AddMatchRequest(BaseModel):
    player1_id: int
    player2_id: int
    result: str  # "p1_win" | "p2_win" | "draw"


class FriendlyMatchRequest(BaseModel):
    player1_id: int
    player2_id: int
    result: str  # "p1_win" | "p2_win" | "draw"
    note: str = Field(default="", max_length=500)


class CreateFolderRequest(BaseModel):
    name: str = Field(min_length=1, max_length=50)


class RenameFolderRequest(BaseModel):
    name: str = Field(min_length=1, max_length=50)


class AssignFolderRequest(BaseModel):
    match_ids: list[int] = Field(min_length=1)
    folder_id: Optional[int] = None  # null이면 폴더에서 뺌


class UpdateProfileRequest(BaseModel):
    nickname: Nickname


class UpdatePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=4, max_length=128)


class UpdateMemberRoleRequest(BaseModel):
    role: str  # '임원' or '회원'


class TransferOwnerRequest(BaseModel):
    member_id: int


class RenameGroupRequest(BaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=50)]


class CreateAnnouncementRequest(BaseModel):
    title: str = Field(min_length=1, max_length=100)
    content: str = Field(min_length=1, max_length=2000)


# ---------- 인증 ----------

@app.get("/health")
def health_check(request: Request):
    return {"status": "ok", "message": localize(request, "체스 동아리 서버 가동 중")}


@app.get("/")
def root():
    return RedirectResponse(url="/index/index.html")


@app.post("/auth/register")
def register(req: RegisterRequest):
    if not USERNAME_RE.match(req.username):
        raise HTTPException(status_code=400, detail="아이디는 영문, 숫자, 한글, 밑줄(_)만 사용할 수 있습니다.")

    try:
        with get_db() as conn:
            conn.execute(
                "INSERT INTO users (username, nickname, password) VALUES (?, ?, ?)",
                (req.username, req.nickname, hash_password(req.password)),
            )
            conn.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="이미 사용 중인 아이디입니다.")

    return {"message": "회원가입 완료"}


@app.post("/auth/login")
@limiter.limit("10/minute")
def login(request: Request, req: LoginRequest, background_tasks: BackgroundTasks):
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE username = ?",
            (req.username,),
        ).fetchone()

    if not row or not _verify_password(req.password, row["password"]):
        raise HTTPException(status_code=401, detail="아이디 또는 비밀번호가 틀렸습니다.")

    # 아직 유효한 토큰이 있으면 그대로 재사용한다. 새로 발급하면 기존 토큰이 무효가 되어
    # 로그인 요청이 중복되거나(버튼 연타) 다른 기기에서 로그인했을 때 먼저 로그인한 쪽이 튕긴다.
    token = row["token"] if _token_valid(row) else secrets.token_hex(32)
    expires_at = (now_kst() + timedelta(days=TOKEN_EXPIRE_DAYS)).isoformat(timespec="seconds")
    with get_db() as conn:
        if _is_sha256(row["password"]):
            conn.execute(
                "UPDATE users SET password = ? WHERE username = ?",
                (hash_password(req.password), req.username),
            )
        # 토큰이 읽은 시점 그대로일 때만 바꾼다. 동시에 들어온 다른 로그인이 먼저 새 토큰을
        # 저장했다면 이 UPDATE는 건너뛰고, 아래에서 그 토큰을 함께 쓴다.
        conn.execute(
            "UPDATE users SET token = ?, token_expires_at = ? WHERE username = ? AND token IS ?",
            (token, expires_at, req.username, row["token"]),
        )
        token = conn.execute(
            "SELECT token FROM users WHERE username = ?", (req.username,)
        ).fetchone()["token"]
        conn.commit()

    # 연동된 Chess.com 계정이 있고 1시간 이상 지났을 때만 백그라운드 갱신
    if row["chess_username"] and _should_refresh(row["rating_updated_at"]):
        background_tasks.add_task(update_user_rating, row["id"], row["chess_username"])

    return {"access_token": token, "nickname": row["nickname"]}


@app.post("/auth/logout")
def logout(user=Depends(get_current_user)):
    with get_db() as conn:
        conn.execute(
            "UPDATE users SET token = NULL, token_expires_at = NULL WHERE id = ?",
            (user["id"],),
        )
        conn.commit()
    return {"message": "로그아웃되었습니다."}


# ---------- 유저 ----------

@app.get("/api/me")
def get_me(user=Depends(get_current_user)):
    return {
        "id": user["id"],
        "username": user["username"],
        "nickname": user["nickname"],
        "chess_username": user["chess_username"],
        "rating_rapid": user["rating_rapid"],
        "rating_updated_at": user["rating_updated_at"],
    }


@app.get("/api/me/stats")
def get_my_stats(user=Depends(get_current_user)):
    """
    로그인한 사용자의 전체(모든 그룹, 공식+친선) 경기 데이터를 집계해
    마이페이지 통계 대시보드에 필요한 지표를 반환.
    """
    uid = user["id"]
    with get_db() as conn:
        matches = conn.execute(
            """SELECT id, player1_id, player2_id, winner_id, played_at, is_official
               FROM matches
               WHERE status = 'finished' AND (player1_id = ? OR player2_id = ?)
               ORDER BY played_at DESC, id DESC""",
            (uid, uid),
        ).fetchall()

        played = len(matches)
        wins   = sum(1 for m in matches if m["winner_id"] == uid)
        draws  = sum(1 for m in matches if m["winner_id"] is None)
        losses = played - wins - draws
        win_rate = round(wins / played * 100, 1) if played else 0.0

        # ---- 라이벌 전적: 상대별 전적을 집계해 대결 횟수 상위 5명 ----
        rival_stats = {}
        for m in matches:
            opp_id = m["player2_id"] if m["player1_id"] == uid else m["player1_id"]
            s = rival_stats.setdefault(opp_id, {"played": 0, "wins": 0, "draws": 0, "losses": 0})
            s["played"] += 1
            if m["winner_id"] == uid:
                s["wins"] += 1
            elif m["winner_id"] is None:
                s["draws"] += 1
            else:
                s["losses"] += 1

        rival_ids = sorted(rival_stats, key=lambda k: (-rival_stats[k]["played"], k))[:5]
        # 라이벌 + 최근 10경기 상대 닉네임을 한 번에 조회
        recent_opp_ids = [
            m["player2_id"] if m["player1_id"] == uid else m["player1_id"] for m in matches[:10]
        ]
        lookup_ids = list(set(rival_ids) | set(recent_opp_ids))
        nicknames = {}
        if lookup_ids:
            placeholders = ",".join("?" for _ in lookup_ids)
            nicknames = {
                row["id"]: row["nickname"]
                for row in conn.execute(
                    f"SELECT id, nickname FROM users WHERE id IN ({placeholders})",
                    lookup_ids,
                ).fetchall()
            }
        rivals = [
            {"id": rid, "nickname": nicknames.get(rid, "알 수 없음"), **rival_stats[rid]}
            for rid in rival_ids
        ]

        # ---- 최근 폼: 최근 10경기, 오래된 -> 최신 순으로 반환 ----
        recent_form = []
        for m in reversed(matches[:10]):
            opp_id = m["player2_id"] if m["player1_id"] == uid else m["player1_id"]
            opp_nick = nicknames.get(opp_id, "알 수 없음")
            if m["winner_id"] == uid:
                result = "win"
            elif m["winner_id"] is None:
                result = "draw"
            else:
                result = "loss"
            recent_form.append({
                "match_id": m["id"],
                "result": result,
                "opponent_nickname": opp_nick,
                "played_at": m["played_at"],
                "is_official": bool(m["is_official"]),
            })

    return {
        "summary": {
            "played": played, "wins": wins, "draws": draws, "losses": losses,
            "win_rate": win_rate,
        },
        "rivals": rivals,
        "recent_form": recent_form,
    }


@app.patch("/api/me/profile")
def update_profile(req: UpdateProfileRequest, user=Depends(get_current_user)):
    nickname = req.nickname.strip()
    if len(nickname) < 1:
        raise HTTPException(status_code=400, detail="닉네임을 입력해주세요.")
    with get_db() as conn:
        conn.execute("UPDATE users SET nickname = ? WHERE id = ?", (nickname, user["id"]))
        conn.commit()
    return {"message": "닉네임이 변경되었습니다.", "nickname": nickname}


@app.patch("/api/me/password")
def update_password(req: UpdatePasswordRequest, user=Depends(get_current_user)):
    if not _verify_password(req.current_password, user["password"]):
        raise HTTPException(status_code=400, detail="현재 비밀번호가 일치하지 않습니다.")
    with get_db() as conn:
        conn.execute(
            "UPDATE users SET password = ? WHERE id = ?",
            (hash_password(req.new_password), user["id"]),
        )
        conn.commit()
    return {"message": "비밀번호가 변경되었습니다."}


@app.post("/api/me/chess/refresh")
def refresh_chess_rating(user=Depends(get_current_user)):
    """Chess.com 레이팅을 동기적으로 즉시 조회·저장하고 결과를 반환."""
    chess_username = user["chess_username"]
    if not chess_username:
        raise HTTPException(status_code=400, detail="Chess.com 아이디가 설정되지 않았습니다.")

    url = f"https://api.chess.com/pub/player/{chess_username.lower()}/stats"
    req = urllib.request.Request(url, headers={"User-Agent": CHESS_COM_USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
            rating_rapid = data.get("chess_rapid", {}).get("last", {}).get("rating")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise HTTPException(status_code=404,
                detail=f"Chess.com에서 '{chess_username}' 계정을 찾을 수 없습니다.")
        raise HTTPException(status_code=502, detail=f"Chess.com API 오류 (HTTP {e.code})")
    except urllib.error.URLError:
        raise HTTPException(status_code=502, detail="Chess.com에 연결할 수 없습니다.")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"레이팅 조회 중 오류: {e}")

    now = now_kst().isoformat(timespec="seconds")
    with get_db() as conn:
        conn.execute(
            "UPDATE users SET rating_rapid = ?, rating_updated_at = ? WHERE id = ?",
            (rating_rapid, now, user["id"]),
        )
        conn.commit()

    return {
        "chess_username": chess_username,
        "rating_rapid": rating_rapid,
        "updated_at": now,
    }


@app.get("/api/me/chess/rating-trend")
def get_my_rating_trend(period: str = "30d", refresh: bool = False, user=Depends(get_current_user)):
    """
    Chess.com 실제 대국 기록(래피드)에서 레이팅 추이를 뽑아 기간별로 반환.
    전체 기간 데이터는 그룹당 1시간 캐시하고, period 파라미터로 그 중 일부만 잘라 응답.
    """
    if period not in PERIOD_TO_DAYS:
        raise HTTPException(status_code=400, detail="period는 7d, 30d, 1y, all 중 하나여야 합니다.")

    chess_username = user["chess_username"]
    if not chess_username:
        raise HTTPException(status_code=400, detail="Chess.com 계정이 연동되어 있지 않습니다.")

    required_months = PERIOD_TO_MONTHS[period]

    with get_db() as conn:
        cache = conn.execute(
            "SELECT data, fetched_at, months_fetched FROM chess_rating_cache WHERE user_id = ?",
            (user["id"],),
        ).fetchone()

        is_fresh = False
        if cache:
            try:
                age = (now_kst() - datetime.fromisoformat(cache["fetched_at"])).total_seconds()
                is_fresh = age <= CHESS_TREND_CACHE_TTL_SECONDS
            except Exception:
                is_fresh = False

        cached_months = cache["months_fetched"] if cache else 0
        need_fetch = refresh or not cache or not is_fresh or cached_months < required_months

        if need_fetch:
            # 캐시가 신선한데 기간만 부족하면 필요한 만큼만 확장, 그 외엔 이번 기간에 필요한 만큼만 새로 조회
            months_to_fetch = max(required_months, cached_months) if is_fresh else required_months
            points = fetch_chess_rating_trend(chess_username, months_to_fetch)
            fetched_at = now_kst().isoformat(timespec="seconds")
            conn.execute(
                """INSERT INTO chess_rating_cache (user_id, data, months_fetched, fetched_at)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(user_id) DO UPDATE SET
                       data = excluded.data,
                       months_fetched = excluded.months_fetched,
                       fetched_at = excluded.fetched_at""",
                (user["id"], json.dumps(points), months_to_fetch, fetched_at),
            )
            conn.commit()
        else:
            points = json.loads(cache["data"])
            fetched_at = cache["fetched_at"]

    days = PERIOD_TO_DAYS[period]
    if days is not None:
        cutoff = (now_kst() - timedelta(days=days)).strftime("%Y-%m-%d")
        points = [p for p in points if p["date"] >= cutoff]

    return {
        "chess_username": chess_username,
        "period": period,
        "points": points,
        "fetched_at": fetched_at,
    }


@app.patch("/api/me/chess")
def update_chess_username(
    req: UpdateChessRequest,
    background_tasks: BackgroundTasks,
    user=Depends(get_current_user),
):
    chess_username = req.chess_username.strip()
    if not chess_username:
        raise HTTPException(status_code=400, detail="Chess.com 아이디를 입력해주세요.")
    if not re.match(r'^[a-zA-Z0-9_-]{3,25}$', chess_username):
        raise HTTPException(status_code=400, detail="Chess.com 아이디는 3~25자의 영문자, 숫자, -, _만 사용 가능합니다.")

    with get_db() as conn:
        conn.execute(
            "UPDATE users SET chess_username = ? WHERE id = ?",
            (chess_username, user["id"]),
        )
        # 계정을 바꾼 경우 이전 아이디 기준으로 캐시된 레이팅 추이가 남아있지 않도록 초기화
        conn.execute("DELETE FROM chess_rating_cache WHERE user_id = ?", (user["id"],))
        conn.commit()

    # 연동 즉시 레이팅 갱신 (1시간 제한 없이)
    background_tasks.add_task(update_user_rating, user["id"], chess_username)
    return {"message": "Chess.com 계정이 연동되었습니다.", "chess_username": chess_username}


# ---------- 그룹 ----------

@app.get("/api/groups")
def list_groups(user=Depends(get_current_user)):
    with get_db() as conn:
        rows = conn.execute(
            """SELECT g.id, g.name, g.invite_code, u.nickname AS owner_nickname,
                      (SELECT COUNT(*) FROM user_groups WHERE group_id = g.id) AS member_count
               FROM groups g
               JOIN user_groups ug ON g.id = ug.group_id AND ug.user_id = ?
               JOIN users u ON g.owner_id = u.id
               ORDER BY g.created_at DESC""",
            (user["id"],),
        ).fetchall()
    return [dict(r) for r in rows]


@app.post("/api/groups", status_code=201)
def create_group(req: CreateGroupRequest, user=Depends(get_current_user)):
    if len(req.name.strip()) < 2:
        raise HTTPException(status_code=400, detail="그룹 이름은 2자 이상이어야 합니다.")

    invite_code = secrets.token_hex(4).upper()

    with get_db() as conn:
        cursor = conn.execute(
            "INSERT INTO groups (name, owner_id, invite_code) VALUES (?, ?, ?)",
            (req.name.strip(), user["id"], invite_code),
        )
        group_id = cursor.lastrowid
        conn.execute(
            "INSERT INTO user_groups (user_id, group_id, role) VALUES (?, ?, '방장')",
            (user["id"], group_id),
        )
        conn.commit()

    return {"id": group_id, "name": req.name.strip(), "invite_code": invite_code}


@app.post("/api/groups/join")
def join_group(req: JoinGroupRequest, user=Depends(get_current_user)):
    with get_db() as conn:
        group = conn.execute(
            "SELECT * FROM groups WHERE invite_code = ?",
            (req.invite_code.strip().upper(),),
        ).fetchone()

        if not group:
            raise HTTPException(status_code=404, detail="유효하지 않은 초대 코드입니다.")

        already = conn.execute(
            "SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], group["id"]),
        ).fetchone()

        if already:
            raise HTTPException(status_code=409, detail="이미 가입된 그룹입니다.")

        try:
            conn.execute(
                "INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)",
                (user["id"], group["id"]),
            )
            conn.commit()
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail="이미 가입된 그룹입니다.")

    return {"id": group["id"], "name": group["name"]}


@app.delete("/api/groups/{group_id}")
def delete_group(group_id: int, user=Depends(get_current_user)):
    with get_db() as conn:
        row = conn.execute(
            "SELECT role FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], group_id),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=403, detail="해당 그룹의 멤버가 아닙니다.")
        if row["role"] != "방장":
            raise HTTPException(status_code=403, detail="방장만 그룹을 삭제할 수 있습니다.")

        if not conn.execute("SELECT 1 FROM groups WHERE id = ?", (group_id,)).fetchone():
            raise HTTPException(status_code=404, detail="그룹을 찾을 수 없습니다.")

        # 관련 데이터 순서대로 cascade 삭제
        conn.execute(
            "DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE group_id = ?)",
            (group_id,),
        )
        conn.execute("DELETE FROM matches WHERE group_id = ?", (group_id,))
        conn.execute("DELETE FROM polls WHERE group_id = ?", (group_id,))
        conn.execute("DELETE FROM match_folders WHERE group_id = ?", (group_id,))
        conn.execute("DELETE FROM announcements WHERE group_id = ?", (group_id,))
        conn.execute("DELETE FROM activity_logs WHERE group_id = ?", (group_id,))
        conn.execute("DELETE FROM user_groups WHERE group_id = ?", (group_id,))
        conn.execute("DELETE FROM group_settings WHERE group_id = ?", (group_id,))
        conn.execute("DELETE FROM groups WHERE id = ?", (group_id,))
        conn.commit()

    return {"message": "그룹이 삭제되었습니다."}


@app.delete("/api/groups/{group_id}/members/{member_id}")
def kick_member(group_id: int, member_id: int, user=Depends(get_current_user)):
    with get_db() as conn:
        my_row = conn.execute(
            "SELECT role FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], group_id),
        ).fetchone()
        if not my_row:
            raise HTTPException(status_code=403, detail="해당 그룹의 멤버가 아닙니다.")
        if my_row["role"] not in ("방장", "임원"):
            raise HTTPException(status_code=403, detail="권한이 없습니다.")

        if member_id == user["id"]:
            raise HTTPException(status_code=400, detail="자신을 강퇴할 수 없습니다.")

        target_row = conn.execute(
            "SELECT role FROM user_groups WHERE user_id = ? AND group_id = ?",
            (member_id, group_id),
        ).fetchone()
        if not target_row:
            raise HTTPException(status_code=404, detail="해당 멤버를 찾을 수 없습니다.")
        if target_row["role"] == "방장":
            raise HTTPException(status_code=400, detail="방장은 강퇴할 수 없습니다.")
        if my_row["role"] == "임원" and target_row["role"] == "임원":
            raise HTTPException(status_code=403, detail="임원은 다른 임원을 강퇴할 수 없습니다.")

        target_user = conn.execute(
            "SELECT nickname FROM users WHERE id = ?", (member_id,)
        ).fetchone()
        target_nick = target_user["nickname"] if target_user else f"#{member_id}"
        _remove_member(conn, group_id, member_id)
        _log(conn, group_id, user["id"], "멤버_강퇴", f"{target_nick}님 강퇴")
        conn.commit()

    return {"message": "멤버가 강퇴되었습니다."}


def _remove_member(conn, group_id: int, user_id: int):
    """그룹에서 멤버를 뺀다. 아직 투표 중인 투표의 참여 기록도 함께 지워
    (나간 사람이 참여자 명단에 남거나 인원 수에 잡히지 않도록). 지난 경기 기록은 남긴다."""
    conn.execute(
        """DELETE FROM poll_votes
           WHERE user_id = ? AND poll_id IN (
               SELECT id FROM polls WHERE group_id = ? AND status = 'voting')""",
        (user_id, group_id),
    )
    conn.execute(
        "DELETE FROM user_groups WHERE user_id = ? AND group_id = ?",
        (user_id, group_id),
    )


@app.post("/api/groups/{group_id}/leave")
def leave_group(group_id: int, user=Depends(get_current_user)):
    with get_db() as conn:
        row = conn.execute(
            "SELECT role FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], group_id),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=403, detail="해당 그룹의 멤버가 아닙니다.")
        if row["role"] == "방장":
            raise HTTPException(status_code=400, detail="방장은 그룹을 나갈 수 없습니다. 먼저 다른 멤버에게 방장을 넘겨주세요.")

        _remove_member(conn, group_id, user["id"])
        _log(conn, group_id, user["id"], "멤버_탈퇴", f"{user['nickname']}님 탈퇴")
        conn.commit()

    return {"message": "그룹에서 나갔습니다."}


@app.post("/api/groups/{group_id}/transfer-owner")
def transfer_owner(group_id: int, req: TransferOwnerRequest, user=Depends(get_current_user)):
    """방장 권한을 다른 멤버에게 넘긴다. 기존 방장은 임원이 된다."""
    with get_db() as conn:
        my_row = conn.execute(
            "SELECT role FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], group_id),
        ).fetchone()
        if not my_row:
            raise HTTPException(status_code=403, detail="해당 그룹의 멤버가 아닙니다.")
        if my_row["role"] != "방장":
            raise HTTPException(status_code=403, detail="방장만 방장을 넘길 수 있습니다.")
        if req.member_id == user["id"]:
            raise HTTPException(status_code=400, detail="자신에게는 방장을 넘길 수 없습니다.")

        target = conn.execute(
            """SELECT u.nickname FROM user_groups ug JOIN users u ON u.id = ug.user_id
               WHERE ug.user_id = ? AND ug.group_id = ?""",
            (req.member_id, group_id),
        ).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="해당 멤버를 찾을 수 없습니다.")

        conn.execute("UPDATE user_groups SET role = '방장' WHERE user_id = ? AND group_id = ?",
                     (req.member_id, group_id))
        conn.execute("UPDATE user_groups SET role = '임원' WHERE user_id = ? AND group_id = ?",
                     (user["id"], group_id))
        conn.execute("UPDATE groups SET owner_id = ? WHERE id = ?", (req.member_id, group_id))
        _log(conn, group_id, user["id"], "방장_위임", f"{target['nickname']}님에게 방장 위임")
        conn.commit()

    return {"message": "방장을 넘겼습니다."}


@app.patch("/api/groups/{group_id}")
def rename_group(group_id: int, req: RenameGroupRequest, user=Depends(get_current_user)):
    with get_db() as conn:
        _check_admin(conn, user["id"], group_id)
        group = conn.execute("SELECT name FROM groups WHERE id = ?", (group_id,)).fetchone()
        if not group:
            raise HTTPException(status_code=404, detail="그룹을 찾을 수 없습니다.")
        if group["name"] != req.name:
            conn.execute("UPDATE groups SET name = ? WHERE id = ?", (req.name, group_id))
            _log(conn, group_id, user["id"], "그룹_이름변경", f"'{group['name']}' → '{req.name}'")
        conn.commit()

    return {"name": req.name}


@app.post("/api/groups/{group_id}/invite-code")
def regenerate_invite_code(group_id: int, user=Depends(get_current_user)):
    """초대 코드를 새로 발급한다. 이전 코드로는 더 이상 가입할 수 없다."""
    with get_db() as conn:
        _check_admin(conn, user["id"], group_id)
        for _ in range(5):   # 드물게 다른 그룹 코드와 겹치면 다시 생성
            code = secrets.token_hex(4).upper()
            if not conn.execute("SELECT 1 FROM groups WHERE invite_code = ?", (code,)).fetchone():
                break
        conn.execute("UPDATE groups SET invite_code = ? WHERE id = ?", (code, group_id))
        _log(conn, group_id, user["id"], "초대코드_재발급", "초대 코드 재발급")
        conn.commit()

    return {"invite_code": code}


# ---------- 그룹 멤버 ----------

@app.get("/api/groups/{group_id}/members")
def get_group_members(group_id: int, user=Depends(get_current_user)):
    with get_db() as conn:
        if not conn.execute(
            "SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], group_id),
        ).fetchone():
            raise HTTPException(status_code=403, detail="해당 그룹의 멤버가 아닙니다.")

        group = conn.execute(
            """SELECT g.id, g.name, g.invite_code, g.created_at, u.nickname AS owner_nickname
               FROM groups g
               JOIN users u ON g.owner_id = u.id
               WHERE g.id = ?""",
            (group_id,),
        ).fetchone()

        if not group:
            raise HTTPException(status_code=404, detail="그룹을 찾을 수 없습니다.")

        members = conn.execute(
            """SELECT u.id, u.nickname, u.chess_username, u.rating_rapid,
                      u.rating_updated_at, ug.role
               FROM users u
               JOIN user_groups ug ON u.id = ug.user_id
               WHERE ug.group_id = ?
               ORDER BY COALESCE(u.rating_rapid, 0) DESC""",
            (group_id,),
        ).fetchall()

    member_list = [dict(m) for m in members]

    linked = sum(1 for m in member_list if m["chess_username"])
    rated  = [m["rating_rapid"] for m in member_list if m["rating_rapid"]]
    avg_rapid = round(sum(rated) / len(rated)) if rated else None
    current_role = next((m["role"] for m in member_list if m["id"] == user["id"]), "회원")

    return {
        "group": dict(group),
        "members": member_list,
        "current_role": current_role,
        "stats": {
            "member_count": len(member_list),
            "linked_count": linked,
            "avg_rapid": avg_rapid,
        },
    }


# ---------- 멤버 역할 변경 ----------

@app.patch("/api/groups/{group_id}/members/{member_id}/role")
def update_member_role(
    group_id: int,
    member_id: int,
    req: UpdateMemberRoleRequest,
    user=Depends(get_current_user),
):
    if req.role not in ("임원", "회원"):
        raise HTTPException(status_code=400, detail="역할은 '임원' 또는 '회원'만 설정할 수 있습니다.")

    with get_db() as conn:
        my_row = conn.execute(
            "SELECT role FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], group_id),
        ).fetchone()
        if not my_row:
            raise HTTPException(status_code=403, detail="해당 그룹의 멤버가 아닙니다.")
        if my_row["role"] != "방장":
            raise HTTPException(status_code=403, detail="방장만 역할을 변경할 수 있습니다.")

        if member_id == user["id"]:
            raise HTTPException(status_code=400, detail="자신의 역할은 변경할 수 없습니다.")

        target_row = conn.execute(
            "SELECT role FROM user_groups WHERE user_id = ? AND group_id = ?",
            (member_id, group_id),
        ).fetchone()
        if not target_row:
            raise HTTPException(status_code=404, detail="해당 멤버를 찾을 수 없습니다.")
        if target_row["role"] == "방장":
            raise HTTPException(status_code=400, detail="방장의 역할은 변경할 수 없습니다.")

        target_user = conn.execute(
            "SELECT nickname FROM users WHERE id = ?", (member_id,)
        ).fetchone()
        target_nick = target_user["nickname"] if target_user else f"#{member_id}"
        conn.execute(
            "UPDATE user_groups SET role = ? WHERE user_id = ? AND group_id = ?",
            (req.role, member_id, group_id),
        )
        _log(conn, group_id, user["id"], "역할_변경",
             f"{target_nick}님 역할 변경: {target_row['role']} → {req.role}")
        conn.commit()

    return {"message": f"역할이 '{req.role}'(으)로 변경되었습니다.", "role": req.role}


# ---------- 공지사항 ----------

@app.get("/api/groups/{group_id}/announcements/latest")
def get_latest_announcement(group_id: int, user=Depends(get_current_user)):
    with get_db() as conn:
        if not conn.execute(
            "SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], group_id),
        ).fetchone():
            raise HTTPException(status_code=403, detail="해당 그룹의 멤버가 아닙니다.")

        row = conn.execute(
            """SELECT a.id, a.title, a.content, a.created_at, u.nickname AS author_nickname
               FROM announcements a
               JOIN users u ON a.author_id = u.id
               WHERE a.group_id = ?
               ORDER BY a.created_at DESC, a.id DESC
               LIMIT 1""",
            (group_id,),
        ).fetchone()

    return dict(row) if row else None


@app.get("/api/groups/{group_id}/announcements")
def list_announcements(group_id: int, user=Depends(get_current_user)):
    with get_db() as conn:
        if not conn.execute(
            "SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], group_id),
        ).fetchone():
            raise HTTPException(status_code=403, detail="해당 그룹의 멤버가 아닙니다.")

        rows = conn.execute(
            """SELECT a.id, a.title, a.content, a.created_at, u.nickname AS author_nickname
               FROM announcements a
               JOIN users u ON a.author_id = u.id
               WHERE a.group_id = ?
               ORDER BY a.created_at DESC, a.id DESC""",
            (group_id,),
        ).fetchall()

    return [dict(r) for r in rows]


@app.post("/api/groups/{group_id}/announcements", status_code=201)
def create_announcement(group_id: int, req: CreateAnnouncementRequest, user=Depends(get_current_user)):
    title   = req.title.strip()
    content = req.content.strip()
    if not title:
        raise HTTPException(status_code=400, detail="제목을 입력해주세요.")
    if not content:
        raise HTTPException(status_code=400, detail="내용을 입력해주세요.")

    with get_db() as conn:
        _check_admin(conn, user["id"], group_id)
        cursor = conn.execute(
            "INSERT INTO announcements (group_id, author_id, title, content) VALUES (?, ?, ?, ?)",
            (group_id, user["id"], title, content),
        )
        announcement_id = cursor.lastrowid
        conn.commit()

    return {"id": announcement_id, "title": title, "content": content}


@app.put("/api/announcements/{announcement_id}")
def update_announcement(announcement_id: int, req: CreateAnnouncementRequest, user=Depends(get_current_user)):
    title   = req.title.strip()
    content = req.content.strip()
    if not title:
        raise HTTPException(status_code=400, detail="제목을 입력해주세요.")
    if not content:
        raise HTTPException(status_code=400, detail="내용을 입력해주세요.")

    with get_db() as conn:
        ann = conn.execute("SELECT group_id FROM announcements WHERE id = ?", (announcement_id,)).fetchone()
        if not ann:
            raise HTTPException(status_code=404, detail="공지사항을 찾을 수 없습니다.")
        _check_admin(conn, user["id"], ann["group_id"])
        conn.execute(
            "UPDATE announcements SET title = ?, content = ? WHERE id = ?",
            (title, content, announcement_id),
        )
        conn.commit()

    return {"id": announcement_id, "title": title, "content": content}


@app.delete("/api/announcements/{announcement_id}")
def delete_announcement(announcement_id: int, user=Depends(get_current_user)):
    with get_db() as conn:
        ann = conn.execute("SELECT * FROM announcements WHERE id = ?", (announcement_id,)).fetchone()
        if not ann:
            raise HTTPException(status_code=404, detail="공지사항을 찾을 수 없습니다.")
        _check_admin(conn, user["id"], ann["group_id"])
        conn.execute("DELETE FROM announcements WHERE id = ?", (announcement_id,))
        conn.commit()

    return {"message": "공지사항이 삭제되었습니다."}


# ---------- 매치 ----------

@app.get("/api/groups/{group_id}/matches")
def get_group_matches(group_id: int, offset: int = 0, limit: int = 30, user=Depends(get_current_user)):
    """완료된 경기를 최신순으로 limit개씩 반환 (offset으로 '더보기')."""
    offset = max(0, offset)
    limit  = min(max(1, limit), 100)
    with get_db() as conn:
        if not conn.execute(
            "SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], group_id),
        ).fetchone():
            raise HTTPException(status_code=403, detail="해당 그룹의 멤버가 아닙니다.")

        matches = conn.execute(
            """SELECT m.id, m.played_at, m.pgn_data, m.is_official, m.note,
                      m.player1_rating, m.player2_rating,
                      p1.id AS player1_id, p1.nickname AS player1_nickname,
                      p2.id AS player2_id, p2.nickname AS player2_nickname,
                      w.id AS winner_id, w.nickname AS winner_nickname
               FROM matches m
               JOIN users p1 ON m.player1_id = p1.id
               JOIN users p2 ON m.player2_id = p2.id
               LEFT JOIN users w ON m.winner_id = w.id
               WHERE m.group_id = ? AND m.status = 'finished'
               ORDER BY m.played_at DESC, m.id DESC   -- 같은 시각 경기도 페이지 사이에서 빠지거나 겹치지 않게
               LIMIT ? OFFSET ?""",
            (group_id, limit, offset),
        ).fetchall()

    return [dict(m) for m in matches]


@app.get("/api/groups/{group_id}/history")
def get_group_history(group_id: int, page: int = 1, user=Depends(get_current_user)):
    """완료된 투표 목록을 10개씩 페이징하여 반환."""
    per_page = 10
    page     = max(1, page)
    offset   = (page - 1) * per_page

    with get_db() as conn:
        if not conn.execute(
            "SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], group_id),
        ).fetchone():
            raise HTTPException(status_code=403, detail="해당 그룹의 멤버가 아닙니다.")

        total = conn.execute(
            "SELECT COUNT(*) FROM polls WHERE group_id = ? AND status = 'finished'",
            (group_id,),
        ).fetchone()[0]

        pages = max(1, (total + per_page - 1) // per_page)

        polls = conn.execute(
            """SELECT p.id, p.title, p.created_at, p.is_official,
                      COUNT(m.id) AS match_count
               FROM polls p
               LEFT JOIN matches m ON m.poll_id = p.id AND m.status = 'finished'
               WHERE p.group_id = ? AND p.status = 'finished'
               GROUP BY p.id
               ORDER BY p.created_at DESC
               LIMIT ? OFFSET ?""",
            (group_id, per_page, offset),
        ).fetchall()

    return {
        "polls": [dict(p) for p in polls],
        "total": total,
        "page":  page,
        "pages": pages,
    }


@app.get("/api/polls/{poll_id}/matches")
def get_poll_matches(poll_id: int, user=Depends(get_current_user)):
    """특정 투표의 완료된 경기 목록 반환 (lazy loading용)."""
    with get_db() as conn:
        poll = conn.execute("SELECT * FROM polls WHERE id = ?", (poll_id,)).fetchone()
        if not poll:
            raise HTTPException(status_code=404, detail="투표를 찾을 수 없습니다.")
        if not conn.execute(
            "SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], poll["group_id"]),
        ).fetchone():
            raise HTTPException(status_code=403, detail="해당 그룹의 멤버가 아닙니다.")

        matches = conn.execute(
            """SELECT m.id, m.played_at, m.pgn_data,
                      m.player1_rating, m.player2_rating,
                      p1.id AS player1_id, p1.nickname AS player1_nickname,
                      p2.id AS player2_id, p2.nickname AS player2_nickname,
                      w.id AS winner_id, w.nickname AS winner_nickname
               FROM matches m
               JOIN users p1 ON m.player1_id = p1.id
               JOIN users p2 ON m.player2_id = p2.id
               LEFT JOIN users w ON m.winner_id = w.id
               WHERE m.poll_id = ? AND m.status = 'finished'
               ORDER BY m.id""",
            (poll_id,),
        ).fetchall()

    return [dict(m) for m in matches]


# ---------- 투표 ----------

def _check_admin(conn, user_id: int, group_id: int):
    """방장/임원 여부 확인. 아니면 403 raise."""
    row = conn.execute(
        "SELECT role FROM user_groups WHERE user_id = ? AND group_id = ?",
        (user_id, group_id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=403, detail="해당 그룹의 멤버가 아닙니다.")
    if row["role"] not in ("방장", "임원"):
        raise HTTPException(status_code=403, detail="권한이 없습니다.")
    return row["role"]


def _log(conn, group_id: int, user_id: int, action: str, detail: str = ""):
    conn.execute(
        "INSERT INTO activity_logs (group_id, user_id, action, detail) VALUES (?, ?, ?, ?)",
        (group_id, user_id, action, detail),
    )


@app.post("/api/groups/{group_id}/polls", status_code=201)
def create_poll(group_id: int, req: CreatePollRequest, user=Depends(get_current_user)):
    with get_db() as conn:
        _check_admin(conn, user["id"], group_id)
        cursor = conn.execute(
            "INSERT INTO polls (group_id, created_by, title, is_official) VALUES (?, ?, ?, ?)",
            (group_id, user["id"], req.title.strip(), int(req.is_official)),
        )
        poll_id = cursor.lastrowid
        conn.commit()
    return {"id": poll_id, "status": "voting", "is_official": req.is_official}


@app.get("/api/groups/{group_id}/polls/active")
def get_active_polls(group_id: int, user=Depends(get_current_user)):
    """활성 투표(voting/playing) 전체를 배열로 반환."""
    with get_db() as conn:
        if not conn.execute(
            "SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], group_id),
        ).fetchone():
            raise HTTPException(status_code=403, detail="해당 그룹의 멤버가 아닙니다.")

        polls = conn.execute(
            "SELECT * FROM polls WHERE group_id = ? AND status IN ('voting','playing') ORDER BY id",
            (group_id,),
        ).fetchall()

        result = []
        for poll in polls:
            votes = conn.execute(
                """SELECT pv.user_id, u.nickname, pv.voted_at, pv.rating_at_vote
                   FROM poll_votes pv
                   JOIN users u ON pv.user_id = u.id
                   WHERE pv.poll_id = ?
                   ORDER BY pv.voted_at""",
                (poll["id"],),
            ).fetchall()
            my_vote = any(v["user_id"] == user["id"] for v in votes)
            matches = []
            if poll["status"] == "playing":
                rows = conn.execute(
                    """SELECT m.id, m.status, m.winner_id, m.pgn_data,
                              m.player1_rating, m.player2_rating,
                              p1.id AS player1_id, p1.nickname AS player1_nickname,
                              p2.id AS player2_id, p2.nickname AS player2_nickname,
                              w.nickname AS winner_nickname
                       FROM matches m
                       JOIN users p1 ON m.player1_id = p1.id
                       JOIN users p2 ON m.player2_id = p2.id
                       LEFT JOIN users w ON m.winner_id = w.id
                       WHERE m.poll_id = ?
                       ORDER BY m.id""",
                    (poll["id"],),
                ).fetchall()
                matches = [dict(r) for r in rows]
            result.append({
                "poll":    dict(poll),
                "votes":   [dict(v) for v in votes],
                "my_vote": my_vote,
                "matches": matches,
            })

    return result


@app.post("/api/polls/{poll_id}/vote")
def toggle_vote(poll_id: int, user=Depends(get_current_user)):
    with get_db() as conn:
        poll = conn.execute("SELECT * FROM polls WHERE id = ?", (poll_id,)).fetchone()
        if not poll:
            raise HTTPException(status_code=404, detail="투표를 찾을 수 없습니다.")
        if poll["status"] != "voting":
            raise HTTPException(status_code=400, detail="투표가 종료되었습니다.")
        if not conn.execute(
            "SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], poll["group_id"]),
        ).fetchone():
            raise HTTPException(status_code=403, detail="그룹 멤버가 아닙니다.")

        existing = conn.execute(
            "SELECT 1 FROM poll_votes WHERE poll_id = ? AND user_id = ?",
            (poll_id, user["id"]),
        ).fetchone()

        try:
            if existing:
                conn.execute(
                    "DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?",
                    (poll_id, user["id"]),
                )
                voted = False
            else:
                voter_rating = conn.execute(
                    "SELECT rating_rapid FROM users WHERE id = ?", (user["id"],)
                ).fetchone()["rating_rapid"]
                conn.execute(
                    "INSERT INTO poll_votes (poll_id, user_id, rating_at_vote) VALUES (?, ?, ?)",
                    (poll_id, user["id"], voter_rating),
                )
                voted = True
            conn.commit()
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail="이미 처리된 요청입니다. 다시 시도해주세요.")

    return {"voted": voted}


@app.delete("/api/polls/{poll_id}/votes/{user_id}")
def cancel_member_vote(poll_id: int, user_id: int, user=Depends(get_current_user)):
    """방장/임원이 진행 중인 투표에서 특정 참가자의 투표를 강제로 취소."""
    with get_db() as conn:
        poll = conn.execute("SELECT * FROM polls WHERE id = ?", (poll_id,)).fetchone()
        if not poll:
            raise HTTPException(status_code=404, detail="투표를 찾을 수 없습니다.")
        if poll["status"] != "voting":
            raise HTTPException(status_code=400, detail="투표 중인 상태에서만 참가자의 투표를 취소할 수 있습니다.")

        _check_admin(conn, user["id"], poll["group_id"])  # 방장/임원만 가능

        existing = conn.execute(
            "SELECT 1 FROM poll_votes WHERE poll_id = ? AND user_id = ?",
            (poll_id, user_id),
        ).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="해당 참가자의 투표 기록이 없습니다.")

        target = conn.execute("SELECT nickname FROM users WHERE id = ?", (user_id,)).fetchone()
        target_nick = target["nickname"] if target else f"#{user_id}"

        conn.execute(
            "DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?",
            (poll_id, user_id),
        )
        _log(conn, poll["group_id"], user["id"], "투표_취소",
             f"'{poll['title'] or '투표'}' - {target_nick}님의 투표를 취소함")
        conn.commit()

    return {"message": f"{target_nick}님의 투표가 취소되었습니다."}


@app.post("/api/polls/{poll_id}/close")
def close_poll(poll_id: int, user=Depends(get_current_user)):
    with get_db() as conn:
        poll = conn.execute("SELECT * FROM polls WHERE id = ?", (poll_id,)).fetchone()
        if not poll:
            raise HTTPException(status_code=404, detail="투표를 찾을 수 없습니다.")
        if poll["status"] != "voting":
            raise HTTPException(status_code=400, detail="이미 종료된 투표입니다.")

        _check_admin(conn, user["id"], poll["group_id"])

        voters = conn.execute(
            """SELECT u.id, u.nickname, u.rating_rapid, ug.role
               FROM poll_votes pv
               JOIN users u ON pv.user_id = u.id
               JOIN user_groups ug ON u.id = ug.user_id AND ug.group_id = ?
               WHERE pv.poll_id = ?""",
            (poll["group_id"], poll_id),
        ).fetchall()

        if len(voters) < 2:
            raise HTTPException(status_code=400, detail="매치 생성에는 최소 2명의 참여자가 필요합니다.")

        setting = conn.execute(
            "SELECT is_color_automatic FROM group_settings WHERE group_id = ?",
            (poll["group_id"],),
        ).fetchone()
        is_color_automatic = bool(setting["is_color_automatic"]) if setting else True

        voter_list = [dict(v) for v in voters]
        pairs, bye_player = make_pairs(voter_list, conn, poll["group_id"], is_color_automatic)

        for p1, p2 in pairs:
            conn.execute(
                """INSERT INTO matches
                   (group_id, poll_id, player1_id, player2_id, recorded_by, status, is_official,
                    player1_rating, player2_rating)
                   VALUES (?, ?, ?, ?, ?, 'playing', ?, ?, ?)""",
                (poll["group_id"], poll_id, p1["id"], p2["id"], user["id"], poll["is_official"],
                 p1["rating_rapid"], p2["rating_rapid"]),
            )

        conn.execute("UPDATE polls SET status = 'playing' WHERE id = ?", (poll_id,))
        bye_str = f", {bye_player['nickname']}님 제외" if bye_player else ""
        _log(conn, poll["group_id"], user["id"], "투표_종료",
             f"'{poll['title']}' 종료, {len(pairs)}경기 생성{bye_str}")
        conn.commit()

    result = {"message": "투표가 종료되고 대진이 생성되었습니다.", "match_count": len(pairs)}
    if bye_player:
        result["bye_player"] = bye_player["nickname"]
    return result


@app.post("/api/polls/{poll_id}/matches", status_code=201)
def add_match_to_poll(poll_id: int, req: AddMatchRequest, user=Depends(get_current_user)):
    if req.result not in ("p1_win", "p2_win", "draw"):
        raise HTTPException(status_code=400, detail="결과는 p1_win, p2_win, draw 중 하나여야 합니다.")
    if req.player1_id == req.player2_id:
        raise HTTPException(status_code=400, detail="백과 흑 선수는 달라야 합니다.")

    with get_db() as conn:
        poll = conn.execute("SELECT * FROM polls WHERE id = ?", (poll_id,)).fetchone()
        if not poll:
            raise HTTPException(status_code=404, detail="투표를 찾을 수 없습니다.")
        if poll["status"] == "finished":
            raise HTTPException(status_code=400, detail="이미 완료된 투표에는 경기를 추가할 수 없습니다.")

        _check_admin(conn, user["id"], poll["group_id"])

        for pid in (req.player1_id, req.player2_id):
            if not conn.execute(
                "SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?",
                (pid, poll["group_id"]),
            ).fetchone():
                raise HTTPException(status_code=400, detail="선택한 선수가 해당 그룹 멤버가 아닙니다.")

        winner_id = (
            req.player1_id if req.result == "p1_win" else
            req.player2_id if req.result == "p2_win" else
            None
        )

        player_rows = conn.execute(
            "SELECT id, nickname, rating_rapid FROM users WHERE id IN (?, ?)",
            (req.player1_id, req.player2_id),
        ).fetchall()
        nicks   = {row["id"]: row["nickname"] for row in player_rows}
        ratings = {row["id"]: row["rating_rapid"] for row in player_rows}
        result_str = {"p1_win": f"{nicks[req.player1_id]} 승", "p2_win": f"{nicks[req.player2_id]} 승", "draw": "무승부"}[req.result]

        conn.execute(
            """INSERT INTO matches
               (group_id, poll_id, player1_id, player2_id, winner_id, recorded_by, status, is_official,
                player1_rating, player2_rating)
               VALUES (?, ?, ?, ?, ?, ?, 'finished', ?, ?, ?)""",
            (poll["group_id"], poll_id, req.player1_id, req.player2_id, winner_id, user["id"], poll["is_official"],
             ratings[req.player1_id], ratings[req.player2_id]),
        )
        _log(conn, poll["group_id"], user["id"], "경기_추가",
             f"'{poll['title']}': {nicks[req.player1_id]}(백) vs {nicks[req.player2_id]}(흑) — {result_str}")
        conn.commit()

    return {"message": "경기가 추가되었습니다."}


@app.post("/api/groups/{group_id}/matches/friendly", status_code=201)
def record_friendly_match(group_id: int, req: FriendlyMatchRequest, user=Depends(get_current_user)):
    """투표 절차 없이 친선 경기를 즉시 기록. 항상 is_official=False로 저장됨."""
    if req.result not in ("p1_win", "p2_win", "draw"):
        raise HTTPException(status_code=400, detail="결과는 p1_win, p2_win, draw 중 하나여야 합니다.")
    if req.player1_id == req.player2_id:
        raise HTTPException(status_code=400, detail="백과 흑 선수는 달라야 합니다.")

    with get_db() as conn:
        if not conn.execute(
            "SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], group_id),
        ).fetchone():
            raise HTTPException(status_code=403, detail="해당 그룹의 멤버가 아닙니다.")

        for pid in (req.player1_id, req.player2_id):
            if not conn.execute(
                "SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?",
                (pid, group_id),
            ).fetchone():
                raise HTTPException(status_code=400, detail="선택한 선수가 해당 그룹 멤버가 아닙니다.")

        winner_id = (
            req.player1_id if req.result == "p1_win" else
            req.player2_id if req.result == "p2_win" else
            None
        )

        player_rows = conn.execute(
            "SELECT id, nickname, rating_rapid FROM users WHERE id IN (?, ?)",
            (req.player1_id, req.player2_id),
        ).fetchall()
        nicks   = {row["id"]: row["nickname"] for row in player_rows}
        ratings = {row["id"]: row["rating_rapid"] for row in player_rows}
        result_str = {"p1_win": f"{nicks[req.player1_id]} 승", "p2_win": f"{nicks[req.player2_id]} 승", "draw": "무승부"}[req.result]

        cursor = conn.execute(
            """INSERT INTO matches
               (group_id, poll_id, player1_id, player2_id, winner_id, recorded_by, status, is_official, note,
                player1_rating, player2_rating)
               VALUES (?, NULL, ?, ?, ?, ?, 'finished', 0, ?, ?, ?)""",
            (group_id, req.player1_id, req.player2_id, winner_id, user["id"], req.note.strip(),
             ratings[req.player1_id], ratings[req.player2_id]),
        )
        match_id = cursor.lastrowid
        _log(conn, group_id, user["id"], "친선경기_기록",
             f"{nicks[req.player1_id]}(백) vs {nicks[req.player2_id]}(흑) — {result_str}")
        conn.commit()

    return {"id": match_id, "message": "친선 경기가 기록되었습니다."}


# ---------- 친선 경기 폴더 ----------

@app.get("/api/groups/{group_id}/friendly-folders")
def list_friendly_folders(group_id: int, user=Depends(get_current_user)):
    with get_db() as conn:
        if not conn.execute(
            "SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], group_id),
        ).fetchone():
            raise HTTPException(status_code=403, detail="해당 그룹의 멤버가 아닙니다.")

        folders = conn.execute(
            """SELECT f.id, f.name, f.created_at, u.nickname AS created_by_nickname,
                      COUNT(m.id) AS match_count
               FROM match_folders f
               JOIN users u ON f.created_by = u.id
               LEFT JOIN matches m ON m.folder_id = f.id
               WHERE f.group_id = ?
               GROUP BY f.id
               ORDER BY f.created_at DESC""",
            (group_id,),
        ).fetchall()

    return [dict(f) for f in folders]


@app.post("/api/groups/{group_id}/friendly-folders", status_code=201)
def create_friendly_folder(group_id: int, req: CreateFolderRequest, user=Depends(get_current_user)):
    with get_db() as conn:
        _check_admin(conn, user["id"], group_id)
        cursor = conn.execute(
            "INSERT INTO match_folders (group_id, name, created_by) VALUES (?, ?, ?)",
            (group_id, req.name.strip(), user["id"]),
        )
        folder_id = cursor.lastrowid
        _log(conn, group_id, user["id"], "폴더_생성", f"'{req.name.strip()}' 폴더 생성")
        conn.commit()

    return {"id": folder_id, "name": req.name.strip()}


def _get_folder_or_404(conn, folder_id: int):
    folder = conn.execute("SELECT * FROM match_folders WHERE id = ?", (folder_id,)).fetchone()
    if not folder:
        raise HTTPException(status_code=404, detail="폴더를 찾을 수 없습니다.")
    return folder


@app.put("/api/friendly-folders/{folder_id}")
def rename_friendly_folder(folder_id: int, req: RenameFolderRequest, user=Depends(get_current_user)):
    with get_db() as conn:
        folder = _get_folder_or_404(conn, folder_id)
        _check_admin(conn, user["id"], folder["group_id"])

        conn.execute(
            "UPDATE match_folders SET name = ? WHERE id = ?",
            (req.name.strip(), folder_id),
        )
        _log(conn, folder["group_id"], user["id"], "폴더_수정",
             f"'{folder['name']}' → '{req.name.strip()}'")
        conn.commit()

    return {"id": folder_id, "name": req.name.strip()}


@app.delete("/api/friendly-folders/{folder_id}")
def delete_friendly_folder(folder_id: int, user=Depends(get_current_user)):
    with get_db() as conn:
        folder = _get_folder_or_404(conn, folder_id)
        _check_admin(conn, user["id"], folder["group_id"])

        conn.execute("UPDATE matches SET folder_id = NULL WHERE folder_id = ?", (folder_id,))
        conn.execute("DELETE FROM match_folders WHERE id = ?", (folder_id,))
        _log(conn, folder["group_id"], user["id"], "폴더_삭제", f"'{folder['name']}' 폴더 삭제")
        conn.commit()

    return {"message": "폴더가 삭제되었습니다."}


@app.get("/api/friendly-folders/{folder_id}/matches")
def get_folder_matches(folder_id: int, user=Depends(get_current_user)):
    with get_db() as conn:
        folder = _get_folder_or_404(conn, folder_id)
        if not conn.execute(
            "SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], folder["group_id"]),
        ).fetchone():
            raise HTTPException(status_code=403, detail="해당 그룹의 멤버가 아닙니다.")

        matches = conn.execute(
            """SELECT m.id, m.played_at, m.note,
                      m.player1_rating, m.player2_rating,
                      p1.id AS player1_id, p1.nickname AS player1_nickname,
                      p2.id AS player2_id, p2.nickname AS player2_nickname,
                      w.id AS winner_id, w.nickname AS winner_nickname
               FROM matches m
               JOIN users p1 ON m.player1_id = p1.id
               JOIN users p2 ON m.player2_id = p2.id
               LEFT JOIN users w ON m.winner_id = w.id
               WHERE m.folder_id = ?
               ORDER BY m.played_at DESC""",
            (folder_id,),
        ).fetchall()

    return {"folder": {"id": folder["id"], "name": folder["name"]}, "matches": [dict(m) for m in matches]}


@app.get("/api/groups/{group_id}/matches/friendly")
def list_friendly_matches(group_id: int, user=Depends(get_current_user)):
    """직접 기록된(투표 없는) 친선 경기 전체 목록. 폴더 관리 UI에서 사용."""
    with get_db() as conn:
        if not conn.execute(
            "SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], group_id),
        ).fetchone():
            raise HTTPException(status_code=403, detail="해당 그룹의 멤버가 아닙니다.")

        matches = conn.execute(
            """SELECT m.id, m.played_at, m.note, m.folder_id, f.name AS folder_name,
                      m.player1_rating, m.player2_rating,
                      p1.id AS player1_id, p1.nickname AS player1_nickname,
                      p2.id AS player2_id, p2.nickname AS player2_nickname,
                      w.id AS winner_id, w.nickname AS winner_nickname
               FROM matches m
               JOIN users p1 ON m.player1_id = p1.id
               JOIN users p2 ON m.player2_id = p2.id
               LEFT JOIN users w ON m.winner_id = w.id
               LEFT JOIN match_folders f ON m.folder_id = f.id
               WHERE m.group_id = ? AND m.is_official = 0 AND m.poll_id IS NULL
               ORDER BY m.played_at DESC""",
            (group_id,),
        ).fetchall()

    return [dict(m) for m in matches]


@app.post("/api/groups/{group_id}/friendly-matches/assign-folder")
def assign_matches_to_folder(group_id: int, req: AssignFolderRequest, user=Depends(get_current_user)):
    with get_db() as conn:
        _check_admin(conn, user["id"], group_id)

        if req.folder_id is not None:
            folder = conn.execute(
                "SELECT * FROM match_folders WHERE id = ? AND group_id = ?",
                (req.folder_id, group_id),
            ).fetchone()
            if not folder:
                raise HTTPException(status_code=404, detail="폴더를 찾을 수 없습니다.")

        placeholders = ",".join("?" * len(req.match_ids))
        rows = conn.execute(
            f"""SELECT id FROM matches
                WHERE id IN ({placeholders}) AND group_id = ? AND is_official = 0 AND poll_id IS NULL""",
            (*req.match_ids, group_id),
        ).fetchall()
        valid_ids = [r["id"] for r in rows]
        if not valid_ids:
            raise HTTPException(status_code=400, detail="유효한 친선 경기가 없습니다.")

        vp = ",".join("?" * len(valid_ids))
        conn.execute(
            f"UPDATE matches SET folder_id = ? WHERE id IN ({vp})",
            (req.folder_id, *valid_ids),
        )

        action = "친선경기_폴더담기" if req.folder_id is not None else "친선경기_폴더빼기"
        _log(conn, group_id, user["id"], action, f"{len(valid_ids)}개 경기")
        conn.commit()

    return {"message": f"{len(valid_ids)}개 경기가 처리되었습니다.", "updated": valid_ids}


@app.post("/api/polls/{poll_id}/reopen")
def reopen_poll(poll_id: int, user=Depends(get_current_user)):
    with get_db() as conn:
        poll = conn.execute("SELECT * FROM polls WHERE id = ?", (poll_id,)).fetchone()
        if not poll:
            raise HTTPException(status_code=404, detail="투표를 찾을 수 없습니다.")
        if poll["status"] != "playing":
            raise HTTPException(status_code=400, detail="대진이 생성된 투표만 다시 열 수 있습니다.")
        _check_admin(conn, user["id"], poll["group_id"])
        conn.execute("DELETE FROM matches WHERE poll_id = ?", (poll_id,))
        conn.execute("UPDATE polls SET status = 'voting' WHERE id = ?", (poll_id,))
        _log(conn, poll["group_id"], user["id"], "투표_재개", f"'{poll['title']}' 투표 다시하기")
        conn.commit()
    return {"message": "투표가 다시 시작되었습니다."}


@app.delete("/api/polls/{poll_id}")
def delete_poll(poll_id: int, user=Depends(get_current_user)):
    with get_db() as conn:
        poll = conn.execute("SELECT * FROM polls WHERE id = ?", (poll_id,)).fetchone()
        if not poll:
            raise HTTPException(status_code=404, detail="투표를 찾을 수 없습니다.")
        if poll["status"] != "voting":
            raise HTTPException(status_code=400, detail="진행 중이거나 완료된 투표는 삭제할 수 없습니다.")
        _check_admin(conn, user["id"], poll["group_id"])
        _log(conn, poll["group_id"], user["id"], "투표_삭제", f"'{poll['title']}' 투표 삭제")
        conn.execute("DELETE FROM poll_votes WHERE poll_id = ?", (poll_id,))
        conn.execute("DELETE FROM polls WHERE id = ?", (poll_id,))
        conn.commit()
    return {"message": "투표가 삭제되었습니다."}


# ---------- 순위표 ----------

@app.get("/api/groups/{group_id}/leaderboard")
def get_leaderboard(group_id: int, user=Depends(get_current_user)):
    with get_db() as conn:
        current_role_row = conn.execute(
            "SELECT role FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], group_id),
        ).fetchone()
        if not current_role_row:
            raise HTTPException(status_code=403, detail="해당 그룹의 멤버가 아닙니다.")
        current_role = current_role_row["role"]

        group = conn.execute("SELECT name FROM groups WHERE id = ?", (group_id,)).fetchone()

        s = conn.execute(
            "SELECT pts_win, pts_draw, pts_loss, is_color_automatic FROM group_settings WHERE group_id = ?",
            (group_id,),
        ).fetchone()
        pts_win            = s["pts_win"]            if s else 3
        pts_draw           = s["pts_draw"]           if s else 2
        pts_loss           = s["pts_loss"]           if s else 1
        is_color_automatic = bool(s["is_color_automatic"]) if s else True

        # 멤버별 전적을 쿼리 한 번으로 집계 (멤버 수만큼 DB 왕복하지 않도록)
        rows = conn.execute(
            """SELECT u.id, u.nickname, u.chess_username, u.rating_rapid,
                      COUNT(m.id) AS played,
                      COALESCE(SUM(m.winner_id = u.id), 0) AS wins,
                      COALESCE(SUM(m.id IS NOT NULL AND m.winner_id IS NULL), 0) AS draws
               FROM users u
               JOIN user_groups ug ON u.id = ug.user_id AND ug.group_id = ?
               LEFT JOIN matches m
                      ON m.group_id = ug.group_id AND m.status = 'finished' AND m.is_official = 1
                     AND (m.player1_id = u.id OR m.player2_id = u.id)
               GROUP BY u.id""",
            (group_id,),
        ).fetchall()

        standings = []
        for r in rows:
            played, wins, draws = r["played"], r["wins"], r["draws"]
            losses = played - wins - draws
            standings.append({
                "id": r["id"],
                "nickname": r["nickname"],
                "chess_username": r["chess_username"],
                "rating_rapid": r["rating_rapid"],
                "played": played,
                "wins": wins,
                "draws": draws,
                "losses": losses,
                "points": wins * pts_win + draws * pts_draw + losses * pts_loss,
            })

        standings.sort(key=lambda x: (-x["points"], -x["wins"], x["nickname"]))

    return {
        "group_name": group["name"] if group else "",
        "current_role": current_role,
        "settings": {"pts_win": pts_win, "pts_draw": pts_draw, "pts_loss": pts_loss, "is_color_automatic": is_color_automatic},
        "standings": standings,
    }


@app.get("/api/groups/{group_id}/members/{member_id}/profile")
def get_member_profile(group_id: int, member_id: int, user=Depends(get_current_user)):
    with get_db() as conn:
        if not conn.execute(
            "SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], group_id),
        ).fetchone():
            raise HTTPException(status_code=403, detail="해당 그룹의 멤버가 아닙니다.")

        member = conn.execute(
            """SELECT u.id, u.nickname, u.chess_username, u.rating_rapid, u.rating_updated_at, ug.role
               FROM users u
               JOIN user_groups ug ON u.id = ug.user_id
               WHERE ug.group_id = ? AND u.id = ?""",
            (group_id, member_id),
        ).fetchone()
        if not member:
            raise HTTPException(status_code=404, detail="해당 그룹의 멤버가 아닙니다.")

        s = conn.execute(
            "SELECT pts_win, pts_draw, pts_loss FROM group_settings WHERE group_id = ?",
            (group_id,),
        ).fetchone()
        pts_win  = s["pts_win"]  if s else 3
        pts_draw = s["pts_draw"] if s else 2
        pts_loss = s["pts_loss"] if s else 1

        results = conn.execute(
            """SELECT winner_id FROM matches
               WHERE group_id = ? AND status = 'finished' AND is_official = 1
                 AND (player1_id = ? OR player2_id = ?)""",
            (group_id, member_id, member_id),
        ).fetchall()
        played = len(results)
        wins   = sum(1 for r in results if r["winner_id"] == member_id)
        draws  = sum(1 for r in results if r["winner_id"] is None)
        losses = played - wins - draws
        points = wins * pts_win + draws * pts_draw + losses * pts_loss

        recent_matches = conn.execute(
            """SELECT m.id, m.played_at, m.is_official, m.note,
                      p1.id AS player1_id, p1.nickname AS player1_nickname,
                      p2.id AS player2_id, p2.nickname AS player2_nickname,
                      w.id AS winner_id, w.nickname AS winner_nickname
               FROM matches m
               JOIN users p1 ON m.player1_id = p1.id
               JOIN users p2 ON m.player2_id = p2.id
               LEFT JOIN users w ON m.winner_id = w.id
               WHERE m.group_id = ? AND m.status = 'finished'
                 AND (m.player1_id = ? OR m.player2_id = ?)
               ORDER BY m.played_at DESC
               LIMIT 10""",
            (group_id, member_id, member_id),
        ).fetchall()

        head_to_head = None
        if member_id != user["id"]:
            h2h = conn.execute(
                """SELECT winner_id FROM matches
                   WHERE group_id = ? AND status = 'finished'
                     AND ((player1_id = ? AND player2_id = ?) OR (player1_id = ? AND player2_id = ?))""",
                (group_id, member_id, user["id"], user["id"], member_id),
            ).fetchall()
            h2h_played     = len(h2h)
            h2h_member_win = sum(1 for r in h2h if r["winner_id"] == member_id)
            h2h_draws      = sum(1 for r in h2h if r["winner_id"] is None)
            h2h_my_wins    = h2h_played - h2h_member_win - h2h_draws
            head_to_head = {
                "played": h2h_played,
                "my_wins": h2h_my_wins,
                "draws": h2h_draws,
                "member_wins": h2h_member_win,
            }

    return {
        "id": member["id"],
        "nickname": member["nickname"],
        "chess_username": member["chess_username"],
        "rating_rapid": member["rating_rapid"],
        "rating_updated_at": member["rating_updated_at"],
        "role": member["role"],
        "record": {"played": played, "wins": wins, "draws": draws, "losses": losses, "points": points},
        "recent_matches": [dict(m) for m in recent_matches],
        "head_to_head": head_to_head,
    }


@app.get("/api/groups/{group_id}/settings")
def get_group_settings(group_id: int, user=Depends(get_current_user)):
    with get_db() as conn:
        if not conn.execute(
            "SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], group_id),
        ).fetchone():
            raise HTTPException(status_code=403, detail="해당 그룹의 멤버가 아닙니다.")
        s = conn.execute(
            "SELECT pts_win, pts_draw, pts_loss, is_color_automatic FROM group_settings WHERE group_id = ?",
            (group_id,),
        ).fetchone()
    return {
        "pts_win":            s["pts_win"]            if s else 3,
        "pts_draw":           s["pts_draw"]           if s else 2,
        "pts_loss":           s["pts_loss"]           if s else 1,
        "is_color_automatic": bool(s["is_color_automatic"]) if s else True,
    }


@app.put("/api/groups/{group_id}/settings")
def update_group_settings(group_id: int, req: GroupSettingsRequest, user=Depends(get_current_user)):
    with get_db() as conn:
        _check_admin(conn, user["id"], group_id)
        conn.execute(
            """INSERT INTO group_settings (group_id, pts_win, pts_draw, pts_loss, is_color_automatic)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(group_id) DO UPDATE SET
                   pts_win            = excluded.pts_win,
                   pts_draw           = excluded.pts_draw,
                   pts_loss           = excluded.pts_loss,
                   is_color_automatic = excluded.is_color_automatic""",
            (group_id, req.pts_win, req.pts_draw, req.pts_loss, int(req.is_color_automatic)),
        )
        conn.commit()
    return {
        "pts_win": req.pts_win, "pts_draw": req.pts_draw, "pts_loss": req.pts_loss,
        "is_color_automatic": req.is_color_automatic,
    }


@app.patch("/api/matches/{match_id}/result")
def record_match_result(match_id: int, req: MatchResultRequest, user=Depends(get_current_user)):
    with get_db() as conn:
        match = conn.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
        if not match:
            raise HTTPException(status_code=404, detail="매치를 찾을 수 없습니다.")

        is_player = user["id"] in (match["player1_id"], match["player2_id"])
        if not is_player:
            _check_admin(conn, user["id"], match["group_id"])  # 방장/임원 또는 경기 당사자만 가능

        if req.winner_id is not None and req.winner_id not in (match["player1_id"], match["player2_id"]):
            raise HTTPException(status_code=400, detail="승자는 해당 매치의 선수여야 합니다.")

        nicks = {
            row["id"]: row["nickname"]
            for row in conn.execute(
                "SELECT id, nickname FROM users WHERE id IN (?, ?)",
                (match["player1_id"], match["player2_id"]),
            ).fetchall()
        }
        p1n, p2n = nicks[match["player1_id"]], nicks[match["player2_id"]]
        result_str = "무승부" if req.winner_id is None else f"{nicks[req.winner_id]} 승"

        conn.execute(
            "UPDATE matches SET winner_id = ?, status = 'finished' WHERE id = ?",
            (req.winner_id, match_id),
        )

        # 모든 매치가 끝났으면 poll도 finished
        if match["poll_id"]:
            remaining = conn.execute(
                "SELECT COUNT(*) FROM matches WHERE poll_id = ? AND status = 'playing' AND id != ?",
                (match["poll_id"], match_id),
            ).fetchone()[0]
            if remaining == 0:
                conn.execute(
                    "UPDATE polls SET status = 'finished' WHERE id = ?",
                    (match["poll_id"],),
                )

        action = "경기_결과수정" if match["status"] == "finished" else "경기_결과기록"
        _log(conn, match["group_id"], user["id"], action,
             f"{p1n}(백) vs {p2n}(흑) — {result_str}")
        conn.commit()

    was_finished = match["status"] == "finished"
    return {"message": "결과가 수정되었습니다." if was_finished else "결과가 기록되었습니다."}


@app.patch("/api/matches/{match_id}/pgn")
def update_match_pgn(match_id: int, req: UpdatePGNRequest, user=Depends(get_current_user)):
    with get_db() as conn:
        match = conn.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
        if not match:
            raise HTTPException(status_code=404, detail="매치를 찾을 수 없습니다.")

        if not conn.execute(
            "SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], match["group_id"]),
        ).fetchone():
            raise HTTPException(status_code=403, detail="해당 그룹의 멤버만 기보를 저장할 수 있습니다.")

        pgn = req.pgn_data.strip()
        if not pgn:
            raise HTTPException(status_code=400, detail="기보 내용을 입력해주세요.")

        conn.execute("UPDATE matches SET pgn_data = ? WHERE id = ?", (pgn, match_id))
        conn.commit()

    return {"message": "기보가 저장되었습니다."}


@app.put("/api/matches/{match_id}/edit")
def edit_match(match_id: int, req: EditMatchRequest, user=Depends(get_current_user)):
    if req.result not in ("p1_win", "p2_win", "draw", "none"):
        raise HTTPException(status_code=400, detail="올바르지 않은 결과값입니다.")
    if req.player1_id == req.player2_id:
        raise HTTPException(status_code=400, detail="백과 흑 선수는 달라야 합니다.")

    with get_db() as conn:
        match = conn.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
        if not match:
            raise HTTPException(status_code=404, detail="매치를 찾을 수 없습니다.")

        _check_admin(conn, user["id"], match["group_id"])

        for pid in (req.player1_id, req.player2_id):
            if not conn.execute(
                "SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?",
                (pid, match["group_id"]),
            ).fetchone():
                raise HTTPException(status_code=400, detail="선택한 선수가 해당 그룹 멤버가 아닙니다.")

        all_ids = {match["player1_id"], match["player2_id"], req.player1_id, req.player2_id}
        nick_rows = conn.execute(
            f"SELECT id, nickname, rating_rapid FROM users WHERE id IN ({','.join('?'*len(all_ids))})",
            list(all_ids),
        ).fetchall()
        nicks   = {r["id"]: r["nickname"] for r in nick_rows}
        ratings = {r["id"]: r["rating_rapid"] for r in nick_rows}
        # 선수가 그대로면 기존에 기록된 당시 레이팅을 보존하고, 선수가 바뀐 자리만 현재 레이팅으로 새로 스냅샷
        player1_rating = match["player1_rating"] if req.player1_id == match["player1_id"] else ratings.get(req.player1_id)
        player2_rating = match["player2_rating"] if req.player2_id == match["player2_id"] else ratings.get(req.player2_id)

        def _result_label(p1_id, p2_id, w_id, st):
            if st == "playing": return "미입력"
            if w_id is None: return "무승부"
            return f"{nicks.get(w_id, '?')} 승"

        old_result = _result_label(match["player1_id"], match["player2_id"],
                                   match["winner_id"], match["status"])
        before = f"{nicks.get(match['player1_id'],'?')}(백) vs {nicks.get(match['player2_id'],'?')}(흑) {old_result}"

        if req.result == "p1_win":
            winner_id, status = req.player1_id, "finished"
        elif req.result == "p2_win":
            winner_id, status = req.player2_id, "finished"
        elif req.result == "draw":
            winner_id, status = None, "finished"
        else:
            winner_id, status = None, "playing"

        after_result = _result_label(req.player1_id, req.player2_id, winner_id, status)
        after = f"{nicks.get(req.player1_id,'?')}(백) vs {nicks.get(req.player2_id,'?')}(흑) {after_result}"

        conn.execute(
            """UPDATE matches
               SET player1_id=?, player2_id=?, winner_id=?, status=?, player1_rating=?, player2_rating=?
               WHERE id=?""",
            (req.player1_id, req.player2_id, winner_id, status, player1_rating, player2_rating, match_id),
        )

        if match["poll_id"]:
            remaining = conn.execute(
                "SELECT COUNT(*) FROM matches WHERE poll_id=? AND status='playing'",
                (match["poll_id"],),
            ).fetchone()[0]
            conn.execute(
                "UPDATE polls SET status=? WHERE id=?",
                ("finished" if remaining == 0 else "playing", match["poll_id"]),
            )

        _log(conn, match["group_id"], user["id"], "경기_수정",
             f"수정 전: {before} / 수정 후: {after}")
        conn.commit()

    return {"message": "경기 정보가 수정되었습니다."}


@app.delete("/api/matches/{match_id}")
def delete_match(match_id: int, user=Depends(get_current_user)):
    """경기 기록 삭제. 방장/임원만 가능."""
    with get_db() as conn:
        match = conn.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
        if not match:
            raise HTTPException(status_code=404, detail="매치를 찾을 수 없습니다.")

        _check_admin(conn, user["id"], match["group_id"])  # 방장/임원만 가능

        nicks = {
            row["id"]: row["nickname"]
            for row in conn.execute(
                "SELECT id, nickname FROM users WHERE id IN (?, ?)",
                (match["player1_id"], match["player2_id"]),
            ).fetchall()
        }
        p1n = nicks.get(match["player1_id"], "?")
        p2n = nicks.get(match["player2_id"], "?")

        conn.execute("DELETE FROM matches WHERE id = ?", (match_id,))

        if match["poll_id"]:
            remaining = conn.execute(
                "SELECT COUNT(*) FROM matches WHERE poll_id = ? AND status = 'playing'",
                (match["poll_id"],),
            ).fetchone()[0]
            conn.execute(
                "UPDATE polls SET status = ? WHERE id = ?",
                ("finished" if remaining == 0 else "playing", match["poll_id"]),
            )

        _log(conn, match["group_id"], user["id"], "경기_삭제", f"{p1n}(백) vs {p2n}(흑) 경기 삭제")
        conn.commit()

    return {"message": "경기 기록이 삭제되었습니다."}


# ---------- 활동 로그 ----------

VALID_LOG_ACTIONS = {
    "투표_종료", "투표_재개", "투표_삭제", "투표_취소",
    "경기_결과기록", "경기_결과수정", "경기_수정", "경기_추가", "경기_삭제",
    "친선경기_기록", "친선경기_폴더담기", "친선경기_폴더빼기",
    "폴더_생성", "폴더_수정", "폴더_삭제",
    "멤버_강퇴", "멤버_탈퇴", "역할_변경", "방장_위임",
    "그룹_이름변경", "초대코드_재발급",
}

@app.get("/api/groups/{group_id}/activity-logs")
def get_activity_logs(
    group_id: int,
    action: str = None,
    limit: int = 50,
    offset: int = 0,
    user=Depends(get_current_user),
):
    if action and action not in VALID_LOG_ACTIONS:
        raise HTTPException(status_code=400, detail="유효하지 않은 활동 유형입니다.")
    offset = max(0, offset)
    limit  = min(max(1, limit), 100)
    with get_db() as conn:
        _check_admin(conn, user["id"], group_id)
        action_sql = " AND al.action = ?" if action else ""
        params = (group_id, action, limit, offset) if action else (group_id, limit, offset)
        rows = conn.execute(
            f"""SELECT al.id, al.action, al.detail, al.created_at,
                       u.nickname AS actor
                FROM activity_logs al
                JOIN users u ON al.user_id = u.id
                WHERE al.group_id = ?{action_sql}
                ORDER BY al.created_at DESC, al.id DESC LIMIT ? OFFSET ?""",
            params,
        ).fetchall()
    return [dict(r) for r in rows]


# ---------- 대시보드 ----------

@app.get("/api/dashboard")
def get_dashboard(group_id: int, user=Depends(get_current_user)):
    with get_db() as conn:
        # 요청자가 해당 그룹 멤버인지 확인
        if not conn.execute(
            "SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], group_id),
        ).fetchone():
            raise HTTPException(status_code=403, detail="해당 그룹의 멤버가 아닙니다.")

        group = conn.execute(
            """SELECT g.id, g.name, g.invite_code, g.created_at, u.nickname AS owner_nickname
               FROM groups g
               JOIN users u ON g.owner_id = u.id
               WHERE g.id = ?""",
            (group_id,),
        ).fetchone()

        if not group:
            raise HTTPException(status_code=404, detail="그룹을 찾을 수 없습니다.")

        # 래피드 레이팅 내림차순 정렬 (미연동 멤버는 하단)
        members = conn.execute(
            """SELECT u.id, u.nickname, u.chess_username,
                      u.rating_rapid, u.rating_updated_at,
                      ug.joined_at
               FROM users u
               JOIN user_groups ug ON u.id = ug.user_id
               WHERE ug.group_id = ?
               ORDER BY COALESCE(u.rating_rapid, 0) DESC""",
            (group_id,),
        ).fetchall()

    member_list = [dict(m) for m in members]
    linked = sum(1 for m in member_list if m["chess_username"])
    rated = [m["rating_rapid"] for m in member_list if m["rating_rapid"]]
    avg_rapid = round(sum(rated) / len(rated)) if rated else None

    return {
        "group": dict(group),
        "leaderboard": member_list,
        "stats": {
            "member_count": len(member_list),
            "linked_count": linked,
            "avg_rapid": avg_rapid,
        },
    }


# ===== 프론트엔드 정적 파일 서빙 (모든 API 라우트 이후에 마운트) =====
# 기보 뷰어 엔진(Stockfish)의 .wasm — OS의 MIME 표에 없으면 application/wasm으로 나가지 않아
# 브라우저가 스트리밍 컴파일을 못 하므로 명시해 둔다
mimetypes.add_type("application/wasm", ".wasm")
_frontend = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend")
if os.path.isdir(_frontend):
    app.mount("/", StaticFiles(directory=_frontend, html=True), name="static")
