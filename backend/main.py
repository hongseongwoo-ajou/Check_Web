from fastapi import FastAPI, HTTPException, Header, Depends, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from services.matchmaker import make_pairs
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timezone, timedelta
import sqlite3
import hashlib
import secrets
import urllib.request
import json
import os

app = FastAPI(title="체스 동아리 API", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_PATH = os.environ.get("DB_PATH", "chess_club.db")

KST = timezone(timedelta(hours=9))


def now_kst() -> datetime:
    return datetime.now(KST).replace(tzinfo=None)

# Chess.com PubAPI 가이드라인: User-Agent 명시 필수
CHESS_COM_USER_AGENT = "ChessClubApp/1.0 (chess club rating tracker)"


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


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
                played_at   TEXT    DEFAULT (datetime('now', '+9 hours')),
                FOREIGN KEY (group_id)    REFERENCES groups(id),
                FOREIGN KEY (poll_id)     REFERENCES polls(id),
                FOREIGN KEY (player1_id)  REFERENCES users(id),
                FOREIGN KEY (player2_id)  REFERENCES users(id),
                FOREIGN KEY (winner_id)   REFERENCES users(id),
                FOREIGN KEY (recorded_by) REFERENCES users(id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS polls (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id   INTEGER NOT NULL,
                created_by INTEGER NOT NULL,
                title      TEXT    NOT NULL DEFAULT '',
                status     TEXT    NOT NULL DEFAULT 'voting',
                created_at TEXT    DEFAULT (datetime('now', '+9 hours')),
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
                poll_id  INTEGER NOT NULL,
                user_id  INTEGER NOT NULL,
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
        conn.commit()


def migrate_db():
    """기존 DB에 신규 컬럼이 없을 경우 안전하게 추가 (OperationalError 무시)."""
    migrations = [
        "ALTER TABLE users ADD COLUMN chess_username TEXT",
        "ALTER TABLE users ADD COLUMN rating_rapid INTEGER",
        "ALTER TABLE users ADD COLUMN rating_updated_at TEXT",
        "ALTER TABLE user_groups ADD COLUMN joined_at TEXT DEFAULT (datetime('now', '+9 hours'))",
        "ALTER TABLE user_groups ADD COLUMN role TEXT NOT NULL DEFAULT '회원'",
        "ALTER TABLE matches ADD COLUMN poll_id INTEGER",
        "ALTER TABLE matches ADD COLUMN status TEXT NOT NULL DEFAULT 'playing'",
        "ALTER TABLE polls ADD COLUMN title TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE matches ADD COLUMN pgn_data TEXT",
        "ALTER TABLE group_settings ADD COLUMN is_color_automatic INTEGER NOT NULL DEFAULT 1",
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
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    group_id   INTEGER NOT NULL,
                    created_by INTEGER NOT NULL,
                    title      TEXT    NOT NULL DEFAULT '',
                    status     TEXT    NOT NULL DEFAULT 'voting',
                    created_at TEXT    DEFAULT (datetime('now', '+9 hours')),
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
    return hashlib.sha256(password.encode()).hexdigest()


def get_current_user(authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="인증이 필요합니다.")
    token = authorization[7:]
    with get_db() as conn:
        row = conn.execute("SELECT * FROM users WHERE token = ?", (token,)).fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="유효하지 않은 토큰입니다.")
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


# ---------- 스키마 ----------

class RegisterRequest(BaseModel):
    username: str
    nickname: str
    password: str


class LoginRequest(BaseModel):
    username: str
    password: str


class CreateGroupRequest(BaseModel):
    name: str


class JoinGroupRequest(BaseModel):
    invite_code: str


class UpdateChessRequest(BaseModel):
    chess_username: str


class CreatePollRequest(BaseModel):
    title: str = ""


class GroupSettingsRequest(BaseModel):
    pts_win:            int
    pts_draw:           int
    pts_loss:           int
    is_color_automatic: bool = True


class MatchResultRequest(BaseModel):
    winner_id: Optional[int] = None


class UpdatePGNRequest(BaseModel):
    pgn_data: str


class UpdateProfileRequest(BaseModel):
    nickname: str


class UpdatePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class UpdateMemberRoleRequest(BaseModel):
    role: str  # '임원' or '회원'


class CreateAnnouncementRequest(BaseModel):
    title: str
    content: str


# ---------- 인증 ----------

@app.get("/health")
async def health_check():
    return {"status": "ok", "message": "체스 동아리 서버 가동 중"}


@app.get("/")
async def root():
    return RedirectResponse(url="/index/index.html")


@app.post("/auth/register")
async def register(req: RegisterRequest):
    if len(req.username) < 3:
        raise HTTPException(status_code=400, detail="아이디는 3자 이상이어야 합니다.")
    if len(req.password) < 4:
        raise HTTPException(status_code=400, detail="비밀번호는 4자 이상이어야 합니다.")

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
async def login(req: LoginRequest, background_tasks: BackgroundTasks):
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE username = ? AND password = ?",
            (req.username, hash_password(req.password)),
        ).fetchone()

    if not row:
        raise HTTPException(status_code=401, detail="아이디 또는 비밀번호가 틀렸습니다.")

    token = secrets.token_hex(32)
    with get_db() as conn:
        conn.execute("UPDATE users SET token = ? WHERE username = ?", (token, req.username))
        conn.commit()

    # 연동된 Chess.com 계정이 있고 1시간 이상 지났을 때만 백그라운드 갱신
    if row["chess_username"] and _should_refresh(row["rating_updated_at"]):
        background_tasks.add_task(update_user_rating, row["id"], row["chess_username"])

    return {"access_token": token, "nickname": row["nickname"]}


# ---------- 유저 ----------

@app.get("/api/me")
async def get_me(user=Depends(get_current_user)):
    return {
        "id": user["id"],
        "username": user["username"],
        "nickname": user["nickname"],
        "chess_username": user["chess_username"],
        "rating_rapid": user["rating_rapid"],
        "rating_updated_at": user["rating_updated_at"],
    }


@app.patch("/api/me/profile")
async def update_profile(req: UpdateProfileRequest, user=Depends(get_current_user)):
    nickname = req.nickname.strip()
    if len(nickname) < 1:
        raise HTTPException(status_code=400, detail="닉네임을 입력해주세요.")
    with get_db() as conn:
        conn.execute("UPDATE users SET nickname = ? WHERE id = ?", (nickname, user["id"]))
        conn.commit()
    return {"message": "닉네임이 변경되었습니다.", "nickname": nickname}


@app.patch("/api/me/password")
async def update_password(req: UpdatePasswordRequest, user=Depends(get_current_user)):
    if hash_password(req.current_password) != user["password"]:
        raise HTTPException(status_code=400, detail="현재 비밀번호가 일치하지 않습니다.")
    if len(req.new_password) < 4:
        raise HTTPException(status_code=400, detail="새 비밀번호는 4자 이상이어야 합니다.")
    with get_db() as conn:
        conn.execute(
            "UPDATE users SET password = ? WHERE id = ?",
            (hash_password(req.new_password), user["id"]),
        )
        conn.commit()
    return {"message": "비밀번호가 변경되었습니다."}


@app.post("/api/me/chess/refresh")
async def refresh_chess_rating(user=Depends(get_current_user)):
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


@app.patch("/api/me/chess")
async def update_chess_username(
    req: UpdateChessRequest,
    background_tasks: BackgroundTasks,
    user=Depends(get_current_user),
):
    chess_username = req.chess_username.strip()
    if not chess_username:
        raise HTTPException(status_code=400, detail="Chess.com 아이디를 입력해주세요.")

    with get_db() as conn:
        conn.execute(
            "UPDATE users SET chess_username = ? WHERE id = ?",
            (chess_username, user["id"]),
        )
        conn.commit()

    # 연동 즉시 레이팅 갱신 (1시간 제한 없이)
    background_tasks.add_task(update_user_rating, user["id"], chess_username)
    return {"message": "Chess.com 계정이 연동되었습니다.", "chess_username": chess_username}


# ---------- 그룹 ----------

@app.get("/api/groups")
async def list_groups(user=Depends(get_current_user)):
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
async def create_group(req: CreateGroupRequest, user=Depends(get_current_user)):
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
async def join_group(req: JoinGroupRequest, user=Depends(get_current_user)):
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

        conn.execute(
            "INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)",
            (user["id"], group["id"]),
        )
        conn.commit()

    return {"id": group["id"], "name": group["name"]}


@app.delete("/api/groups/{group_id}")
async def delete_group(group_id: int, user=Depends(get_current_user)):
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
        conn.execute("DELETE FROM user_groups WHERE group_id = ?", (group_id,))
        conn.execute("DELETE FROM group_settings WHERE group_id = ?", (group_id,))
        conn.execute("DELETE FROM groups WHERE id = ?", (group_id,))
        conn.commit()

    return {"message": "그룹이 삭제되었습니다."}


@app.delete("/api/groups/{group_id}/members/{member_id}")
async def kick_member(group_id: int, member_id: int, user=Depends(get_current_user)):
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

        conn.execute(
            "DELETE FROM user_groups WHERE user_id = ? AND group_id = ?",
            (member_id, group_id),
        )
        conn.commit()

    return {"message": "멤버가 강퇴되었습니다."}


# ---------- 그룹 멤버 ----------

@app.get("/api/groups/{group_id}/members")
async def get_group_members(group_id: int, user=Depends(get_current_user)):
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
async def update_member_role(
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

        conn.execute(
            "UPDATE user_groups SET role = ? WHERE user_id = ? AND group_id = ?",
            (req.role, member_id, group_id),
        )
        conn.commit()

    return {"message": f"역할이 '{req.role}'(으)로 변경되었습니다.", "role": req.role}


# ---------- 공지사항 ----------

@app.get("/api/groups/{group_id}/announcements/latest")
async def get_latest_announcement(group_id: int, user=Depends(get_current_user)):
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
async def list_announcements(group_id: int, user=Depends(get_current_user)):
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
async def create_announcement(group_id: int, req: CreateAnnouncementRequest, user=Depends(get_current_user)):
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


@app.delete("/api/announcements/{announcement_id}")
async def delete_announcement(announcement_id: int, user=Depends(get_current_user)):
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
async def get_group_matches(group_id: int, user=Depends(get_current_user)):
    with get_db() as conn:
        if not conn.execute(
            "SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], group_id),
        ).fetchone():
            raise HTTPException(status_code=403, detail="해당 그룹의 멤버가 아닙니다.")

        matches = conn.execute(
            """SELECT m.id, m.played_at, m.pgn_data,
                      p1.id AS player1_id, p1.nickname AS player1_nickname,
                      p2.id AS player2_id, p2.nickname AS player2_nickname,
                      w.id AS winner_id, w.nickname AS winner_nickname
               FROM matches m
               JOIN users p1 ON m.player1_id = p1.id
               JOIN users p2 ON m.player2_id = p2.id
               LEFT JOIN users w ON m.winner_id = w.id
               WHERE m.group_id = ? AND m.status = 'finished'
               ORDER BY m.played_at DESC
               LIMIT 30""",
            (group_id,),
        ).fetchall()

    return [dict(m) for m in matches]


@app.get("/api/groups/{group_id}/history")
async def get_group_history(group_id: int, page: int = 1, user=Depends(get_current_user)):
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
            """SELECT p.id, p.title, p.created_at,
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
async def get_poll_matches(poll_id: int, user=Depends(get_current_user)):
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


@app.post("/api/groups/{group_id}/polls", status_code=201)
async def create_poll(group_id: int, req: CreatePollRequest, user=Depends(get_current_user)):
    with get_db() as conn:
        _check_admin(conn, user["id"], group_id)
        cursor = conn.execute(
            "INSERT INTO polls (group_id, created_by, title) VALUES (?, ?, ?)",
            (group_id, user["id"], req.title.strip()),
        )
        poll_id = cursor.lastrowid
        conn.commit()
    return {"id": poll_id, "status": "voting"}


@app.get("/api/groups/{group_id}/polls/active")
async def get_active_polls(group_id: int, user=Depends(get_current_user)):
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
                """SELECT pv.user_id, u.nickname, pv.voted_at
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
async def toggle_vote(poll_id: int, user=Depends(get_current_user)):
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

        if existing:
            conn.execute(
                "DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?",
                (poll_id, user["id"]),
            )
            voted = False
        else:
            conn.execute(
                "INSERT INTO poll_votes (poll_id, user_id) VALUES (?, ?)",
                (poll_id, user["id"]),
            )
            voted = True
        conn.commit()

    return {"voted": voted}


@app.post("/api/polls/{poll_id}/close")
async def close_poll(poll_id: int, user=Depends(get_current_user)):
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
                """INSERT INTO matches (group_id, poll_id, player1_id, player2_id, recorded_by, status)
                   VALUES (?, ?, ?, ?, ?, 'playing')""",
                (poll["group_id"], poll_id, p1["id"], p2["id"], user["id"]),
            )

        conn.execute("UPDATE polls SET status = 'playing' WHERE id = ?", (poll_id,))
        conn.commit()

    result = {"message": "투표가 종료되고 대진이 생성되었습니다.", "match_count": len(pairs)}
    if bye_player:
        result["bye_player"] = bye_player["nickname"]
    return result


@app.delete("/api/polls/{poll_id}")
async def delete_poll(poll_id: int, user=Depends(get_current_user)):
    with get_db() as conn:
        poll = conn.execute("SELECT * FROM polls WHERE id = ?", (poll_id,)).fetchone()
        if not poll:
            raise HTTPException(status_code=404, detail="투표를 찾을 수 없습니다.")
        if poll["status"] != "voting":
            raise HTTPException(status_code=400, detail="진행 중이거나 완료된 투표는 삭제할 수 없습니다.")
        _check_admin(conn, user["id"], poll["group_id"])
        conn.execute("DELETE FROM poll_votes WHERE poll_id = ?", (poll_id,))
        conn.execute("DELETE FROM polls WHERE id = ?", (poll_id,))
        conn.commit()
    return {"message": "투표가 삭제되었습니다."}


# ---------- 순위표 ----------

@app.get("/api/groups/{group_id}/leaderboard")
async def get_leaderboard(group_id: int, user=Depends(get_current_user)):
    with get_db() as conn:
        if not conn.execute(
            "SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], group_id),
        ).fetchone():
            raise HTTPException(status_code=403, detail="해당 그룹의 멤버가 아닙니다.")

        group = conn.execute("SELECT name FROM groups WHERE id = ?", (group_id,)).fetchone()
        current_role_row = conn.execute(
            "SELECT role FROM user_groups WHERE user_id = ? AND group_id = ?",
            (user["id"], group_id),
        ).fetchone()
        current_role = current_role_row["role"] if current_role_row else "회원"

        s = conn.execute(
            "SELECT pts_win, pts_draw, pts_loss, is_color_automatic FROM group_settings WHERE group_id = ?",
            (group_id,),
        ).fetchone()
        pts_win            = s["pts_win"]            if s else 3
        pts_draw           = s["pts_draw"]           if s else 2
        pts_loss           = s["pts_loss"]           if s else 1
        is_color_automatic = bool(s["is_color_automatic"]) if s else True

        members = conn.execute(
            """SELECT u.id, u.nickname, u.chess_username, u.rating_rapid
               FROM users u
               JOIN user_groups ug ON u.id = ug.user_id
               WHERE ug.group_id = ?""",
            (group_id,),
        ).fetchall()

        standings = []
        for m in members:
            uid = m["id"]
            results = conn.execute(
                """SELECT winner_id FROM matches
                   WHERE group_id = ? AND status = 'finished'
                     AND (player1_id = ? OR player2_id = ?)""",
                (group_id, uid, uid),
            ).fetchall()

            played = len(results)
            wins   = sum(1 for r in results if r["winner_id"] == uid)
            draws  = sum(1 for r in results if r["winner_id"] is None)
            losses = played - wins - draws
            points = wins * pts_win + draws * pts_draw + losses * pts_loss

            standings.append({
                "id": uid,
                "nickname": m["nickname"],
                "chess_username": m["chess_username"],
                "rating_rapid": m["rating_rapid"],
                "played": played,
                "wins": wins,
                "draws": draws,
                "losses": losses,
                "points": points,
            })

        standings.sort(key=lambda x: (-x["points"], -x["wins"], x["nickname"]))

    return {
        "group_name": group["name"] if group else "",
        "current_role": current_role,
        "settings": {"pts_win": pts_win, "pts_draw": pts_draw, "pts_loss": pts_loss, "is_color_automatic": is_color_automatic},
        "standings": standings,
    }


@app.get("/api/groups/{group_id}/settings")
async def get_group_settings(group_id: int, user=Depends(get_current_user)):
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
async def update_group_settings(group_id: int, req: GroupSettingsRequest, user=Depends(get_current_user)):
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
async def record_match_result(match_id: int, req: MatchResultRequest, user=Depends(get_current_user)):
    with get_db() as conn:
        match = conn.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
        if not match:
            raise HTTPException(status_code=404, detail="매치를 찾을 수 없습니다.")

        _check_admin(conn, user["id"], match["group_id"])  # 방장/임원만 가능

        if req.winner_id is not None and req.winner_id not in (match["player1_id"], match["player2_id"]):
            raise HTTPException(status_code=400, detail="승자는 해당 매치의 선수여야 합니다.")

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

        conn.commit()

    was_finished = match["status"] == "finished"
    return {"message": "결과가 수정되었습니다." if was_finished else "결과가 기록되었습니다."}


@app.patch("/api/matches/{match_id}/pgn")
async def update_match_pgn(match_id: int, req: UpdatePGNRequest, user=Depends(get_current_user)):
    with get_db() as conn:
        match = conn.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
        if not match:
            raise HTTPException(status_code=404, detail="매치를 찾을 수 없습니다.")

        is_player = user["id"] in (match["player1_id"], match["player2_id"])
        if not is_player:
            role_row = conn.execute(
                "SELECT role FROM user_groups WHERE user_id = ? AND group_id = ?",
                (user["id"], match["group_id"]),
            ).fetchone()
            if not role_row or role_row["role"] not in ("방장", "임원"):
                raise HTTPException(status_code=403, detail="권한이 없습니다. 경기 당사자 또는 임원/방장만 기보를 저장할 수 있습니다.")

        pgn = req.pgn_data.strip()
        if not pgn:
            raise HTTPException(status_code=400, detail="기보 내용을 입력해주세요.")

        conn.execute("UPDATE matches SET pgn_data = ? WHERE id = ?", (pgn, match_id))
        conn.commit()

    return {"message": "기보가 저장되었습니다."}


# ---------- 대시보드 ----------

@app.get("/api/dashboard")
async def get_dashboard(group_id: int, user=Depends(get_current_user)):
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
_frontend = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend")
if os.path.isdir(_frontend):
    app.mount("/", StaticFiles(directory=_frontend, html=True), name="static")
