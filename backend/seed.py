"""
더미 데이터 시드 스크립트
- 서버가 localhost:8000 에서 실행 중이어야 합니다.
- 이미 존재하는 유저/그룹은 건너뜁니다 (멱등성).
- 실행: python seed.py
"""

import urllib.request
import json
import sys

API_BASE = "http://localhost:8000"


# ===== API 헬퍼 =====

def api_call(method, path, body=None, token=None):
    url = f"{API_BASE}{path}"
    data = json.dumps(body).encode() if body else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, {}
    except Exception as ex:
        print(f"  [연결 오류] {ex}")
        sys.exit(1)


def register(username, nickname, password="pass1234"):
    status, data = api_call("POST", "/auth/register", {
        "username": username, "nickname": nickname, "password": password,
    })
    if status in (200, 201):
        print(f"  [등록] {nickname} ({username})")
    elif status == 409:
        print(f"  [스킵] {nickname} ({username}) — 이미 존재")
    else:
        print(f"  [오류] {username}: {data.get('detail')}")


def login(username, password="pass1234"):
    status, data = api_call("POST", "/auth/login", {
        "username": username, "password": password,
    })
    if status == 200:
        return data["access_token"]
    print(f"  [로그인 실패] {username}: {data.get('detail')}")
    return None


def create_group(token, name):
    status, data = api_call("POST", "/api/groups", {"name": name}, token)
    if status == 201:
        print(f"  [그룹 생성] {name}  (초대 코드: {data['invite_code']})")
        return data
    print(f"  [그룹 생성 실패] {name}: {data.get('detail')}")
    return None


def join_group(token, invite_code, nickname=""):
    status, data = api_call("POST", "/api/groups/join", {"invite_code": invite_code}, token)
    if status == 200:
        print(f"  [참가] {nickname} → {data.get('name', invite_code)}")
    elif status == 409:
        print(f"  [스킵] {nickname} — 이미 가입됨")
    else:
        print(f"  [참가 실패] {nickname}: {data.get('detail')}")


def set_chess(token, chess_username, nickname=""):
    status, data = api_call("PATCH", "/api/me/chess", {"chess_username": chess_username}, token)
    if status == 200:
        print(f"  [Chess 연동] {nickname} → {chess_username}")
    else:
        print(f"  [연동 실패] {nickname}: {data.get('detail')}")


# ===== 시드 데이터 =====

USERS = [
    ("player01", "김철수"),
    ("player02", "이영희"),
    ("player03", "박민준"),
    ("player04", "최수진"),
    ("player05", "정도현"),
    ("player06", "한지민"),
    ("player07", "오세훈"),
    ("player08", "윤아름"),
    ("player09", "강태양"),
    ("player10", "임채원"),
]

CHESS_LINKS = {
    "player01": "hikaru",
    "player02": "magnuscarlsen",
    "player03": "GothamChess",
    "player04": "DanielNaroditsky",
    "player05": "firouzja2003",
}

GROUPS = [
    {
        "name": "아주대 체스부 A팀",
        "owner": "player01",
        "members": ["player02", "player03", "player04", "player05"],
    },
    {
        "name": "아주대 체스부 B팀",
        "owner": "player06",
        "members": ["player07", "player08", "player09", "player10"],
    },
    {
        "name": "최강 고수 모임",
        "owner": "player02",
        "members": ["player01", "player03", "player04"],
    },
]


# ===== 메인 =====

def main():
    # 서버 연결 확인
    status, _ = api_call("GET", "/health")
    if status != 200:
        print("서버가 응답하지 않습니다. 먼저 uvicorn main:app --reload 를 실행해주세요.")
        sys.exit(1)
    print("서버 연결 확인\n")

    # 1. 유저 등록
    print("=== 유저 등록 ===")
    for username, nickname in USERS:
        register(username, nickname)

    # 2. 전원 로그인 → 토큰 맵
    print("\n=== 로그인 ===")
    nicknames = {u: n for u, n in USERS}
    tokens = {}
    for username, nickname in USERS:
        t = login(username)
        if t:
            tokens[username] = t
            print(f"  [로그인 완료] {nickname}")

    # 3. 그룹 생성 + 멤버 참가
    print("\n=== 그룹 생성 및 참가 ===")
    for g in GROUPS:
        owner = g["owner"]
        token = tokens.get(owner)
        if not token:
            print(f"  [스킵] {g['name']} — 방장 토큰 없음")
            continue

        group = create_group(token, g["name"])
        if not group:
            continue

        invite_code = group["invite_code"]
        for member in g["members"]:
            mt = tokens.get(member)
            if mt:
                join_group(mt, invite_code, nicknames.get(member, member))

    # 4. Chess.com 연동 (백그라운드로 레이팅 자동 갱신됨)
    print("\n=== Chess.com 연동 ===")
    for username, chess_username in CHESS_LINKS.items():
        t = tokens.get(username)
        if t:
            set_chess(t, chess_username, nicknames.get(username, username))

    # 5. 완료 요약
    print("\n" + "=" * 44)
    print("시드 완료!")
    print(f"  유저 {len(USERS)}명 / 그룹 {len(GROUPS)}개 생성")
    print("\n테스트 로그인 정보 (비밀번호 공통: pass1234)")
    for username, nickname in USERS[:3]:
        print(f"  {username}  →  {nickname}")
    print("=" * 44)


if __name__ == "__main__":
    main()