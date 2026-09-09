"""
테스트용 더미 데이터 생성 스크립트.

실행: py seed_data.py
- 기존 chess_club.db 파일에 데이터를 추가합니다 (기존 데이터는 건드리지 않음).
- 모든 유저 비밀번호는 "password123" 입니다.

커버하는 시나리오:
  - 유저: chess.com 연동/미연동, 레이팅 최근/오래됨, 로그인 세션 有/無, 만료된 토큰
  - 그룹A "체스 동아리 A": 방장/임원/회원 역할, 다양한 매치·투표·공지·폴더·로그를 모두 갖춘 "풍성한" 그룹
  - 그룹B "신생 동아리 B": 방장 혼자뿐인 빈 그룹 (빈 상태 UI 테스트용)
  - 매치: 공식/친선, 승/패/무, PGN 있음/없음, 진행중(playing)/완료(finished), 노트 有/無, 폴더 배정
  - 투표: 투표중(voting, 투표자 0명/일부/전원), 대진 생성됨(playing), 완료(finished, 부전승 포함)
  - 활동 로그, 공지사항 다건
"""
import sqlite3
import secrets
import bcrypt
from datetime import datetime, timedelta, timezone

DB_PATH = "chess_club.db"

KST = timezone(timedelta(hours=9))


def now_kst() -> datetime:
    return datetime.now(KST).replace(tzinfo=None)


def ts(offset_days: int = 0, offset_hours: int = 0) -> str:
    return (now_kst() - timedelta(days=offset_days, hours=offset_hours)).isoformat(
        sep=" ", timespec="seconds"
    )


def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()


PASSWORD = "1"
PW_HASH = hash_password(PASSWORD)


def main():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # ---------- 유저 ----------
    # label(내부 참조용), username(로그인 아이디), nickname, chess_username, rating,
    # rating_age_hours(None=미연동), has_session, token_expired
    users = [
        ("alice",   "test1",  "테스트1",  "hikaru",       None, None,  True,  False),   # chess.com 존재하지만 미연동
        ("bob",     "test2",  "테스트2",  "magnuscarlsen", 2850, 0.5,  True,  False),   # 방금 갱신됨
        ("charlie", "test3",  "테스트3",  "fabianocaruana", 2780, 48,  False, False),   # 오래된 레이팅, 로그아웃 상태
        ("dave",    "test4",  "테스트4",  None,           None, None,  True,  False),   # chess.com 미연동
        ("erin",    "test5",  "테스트5",  "invalidusername999", None, 5, True, False),  # 연동했지만 조회 실패(레이팅 없음)
        ("frank",   "test6",  "테스트6",  "anishgiri",    2650, 2,    False, True),     # 세션 만료
        ("grace",   "test7",  "테스트7",  None,           None, None,  True,  False),   # 신규 가입, 그룹 없음
        ("henry",   "test8",  "테스트8",  "wesleyso",     2400, 12,   True,  False),
        ("ivy",     "test9",  "테스트9",  None,           None, None,  True,  False),
        ("jack",    "test10", "테스트10", "levonaronian", 2550, 24,   True,  False),
    ]

    user_ids = {}
    for label, username, nickname, chess_username, rating, rating_age_h, has_session, token_expired in users:
        cur.execute("SELECT id FROM users WHERE username = ?", (username,))
        row = cur.fetchone()
        if row:
            user_ids[label] = row["id"]
            continue

        token = secrets.token_hex(32) if has_session else None
        if has_session:
            expires_at = ts(offset_days=-30) if token_expired else (
                now_kst() + timedelta(days=30)
            ).isoformat(timespec="seconds")
        else:
            expires_at = None

        rating_updated_at = ts(offset_hours=rating_age_h) if rating_age_h is not None else None

        cur.execute(
            """INSERT INTO users
               (username, nickname, password, token, token_expires_at,
                chess_username, rating_rapid, rating_updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (username, nickname, PW_HASH, token, expires_at,
             chess_username, rating, rating_updated_at),
        )
        user_ids[label] = cur.lastrowid

    conn.commit()

    # ---------- 그룹 A: 풍성한 데이터 ----------
    cur.execute("SELECT id FROM groups WHERE name = ?", ("체스 동아리 A",))
    row = cur.fetchone()
    if row:
        group_a = row["id"]
    else:
        invite_code = secrets.token_hex(4).upper()
        cur.execute(
            "INSERT INTO groups (name, owner_id, invite_code, created_at) VALUES (?, ?, ?, ?)",
            ("체스 동아리 A", user_ids["alice"], invite_code, ts(offset_days=90)),
        )
        group_a = cur.lastrowid

        # 멤버 + 역할 (방장 alice, 임원 bob/charlie, 나머지 회원)
        roles = {
            "alice": "방장", "bob": "임원", "charlie": "임원",
            "dave": "회원", "erin": "회원", "frank": "회원",
            "henry": "회원", "ivy": "회원",
        }
        for uname, role in roles.items():
            cur.execute(
                "INSERT INTO user_groups (user_id, group_id, role, joined_at) VALUES (?, ?, ?, ?)",
                (user_ids[uname], group_a, role, ts(offset_days=80)),
            )

        cur.execute(
            """INSERT INTO group_settings (group_id, pts_win, pts_draw, pts_loss, is_color_automatic)
               VALUES (?, 3, 1, 0, 1)""",
            (group_a,),
        )

        # 공지사항 (여러 건, 최신순 확인용)
        announcements = [
            ("정기 모임 안내", "매주 토요일 오후 2시에 정기 모임을 진행합니다. 많은 참여 부탁드립니다.", "alice", 60),
            ("신규 회원 환영", "이번 주 새로 가입하신 헨리님, 아이비님을 환영합니다!", "bob", 30),
            ("대회 일정 공지", "다음 달 15일에 내부 리그전이 예정되어 있습니다. 참가 신청은 링크를 확인해주세요.", "alice", 5),
            ("규정 변경 안내", "무승부 시 승점이 1점에서 변경되었습니다. 그룹 설정을 확인해주세요.", "charlie", 1),
        ]
        for title, content, author, days_ago in announcements:
            cur.execute(
                "INSERT INTO announcements (group_id, author_id, title, content, created_at) VALUES (?, ?, ?, ?, ?)",
                (group_a, user_ids[author], title, content, ts(offset_days=days_ago)),
            )

        # 매치 폴더
        cur.execute(
            "INSERT INTO match_folders (group_id, name, created_by, created_at) VALUES (?, ?, ?, ?)",
            (group_a, "결승 토너먼트", user_ids["alice"], ts(offset_days=10)),
        )
        folder_id = cur.lastrowid
        cur.execute(
            "INSERT INTO match_folders (group_id, name, created_by, created_at) VALUES (?, ?, ?, ?)",
            (group_a, "8월 친선전 모음", user_ids["bob"], ts(offset_days=20)),
        )
        folder2_id = cur.lastrowid

        # ---- 완료된 투표 1: 정상 종료 (짝수 인원, 매치 다 완료) ----
        cur.execute(
            "INSERT INTO polls (group_id, created_by, title, status, is_official, created_at) VALUES (?, ?, ?, 'finished', 1, ?)",
            (group_a, user_ids["alice"], "9월 1주차 정기전", ts(offset_days=14)),
        )
        poll1 = cur.lastrowid
        for uname in ("alice", "bob", "charlie", "dave"):
            cur.execute(
                "INSERT INTO poll_votes (poll_id, user_id, voted_at) VALUES (?, ?, ?)",
                (poll1, user_ids[uname], ts(offset_days=14, offset_hours=1)),
            )
        finished_matches_poll1 = [
            ("alice", "bob", "alice", False, "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6", None, folder_id),
            ("charlie", "dave", None, False, "1. d4 d5 2. c4 e6 3. Nc3 Nf6", None, None),  # 무승부
        ]
        for p1, p2, winner, is_friendly, pgn, note, fid in finished_matches_poll1:
            cur.execute(
                """INSERT INTO matches
                   (group_id, poll_id, player1_id, player2_id, winner_id, recorded_by,
                    status, is_official, note, folder_id, pgn_data, played_at)
                   VALUES (?, ?, ?, ?, ?, ?, 'finished', ?, ?, ?, ?, ?)""",
                (group_a, poll1, user_ids[p1], user_ids[p2],
                 user_ids[winner] if winner else None, user_ids["alice"],
                 0 if is_friendly else 1, note, fid, pgn, ts(offset_days=14, offset_hours=2)),
            )

        # ---- 완료된 투표 2: 홀수 인원 -> 부전승 발생 ----
        cur.execute(
            "INSERT INTO polls (group_id, created_by, title, status, is_official, created_at) VALUES (?, ?, ?, 'finished', 1, ?)",
            (group_a, user_ids["bob"], "9월 2주차 정기전 (부전승 케이스)", ts(offset_days=7)),
        )
        poll2 = cur.lastrowid
        for uname in ("alice", "bob", "charlie", "henry", "ivy"):
            cur.execute(
                "INSERT INTO poll_votes (poll_id, user_id, voted_at) VALUES (?, ?, ?)",
                (poll2, user_ids[uname], ts(offset_days=7, offset_hours=1)),
            )
        finished_matches_poll2 = [
            ("alice", "charlie", "charlie", "1. c4 e5 2. Nc3 Nf6"),
            ("bob", "henry", "bob", "1. Nf3 d5 2. g3 Nf6 3. Bg2 e6"),
        ]
        for p1, p2, winner, pgn in finished_matches_poll2:
            cur.execute(
                """INSERT INTO matches
                   (group_id, poll_id, player1_id, player2_id, winner_id, recorded_by,
                    status, is_official, pgn_data, played_at)
                   VALUES (?, ?, ?, ?, ?, ?, 'finished', 1, ?, ?)""",
                (group_a, poll2, user_ids[p1], user_ids[p2], user_ids[winner],
                 user_ids["bob"], pgn, ts(offset_days=7, offset_hours=2)),
            )
        _log(cur, group_a, user_ids["bob"], "투표_종료", "'9월 2주차 정기전 (부전승 케이스)' 종료, 2경기 생성, 아이비님 제외")

        # ---- 진행중 투표 (playing): 매치 일부 완료, 일부 진행중 ----
        cur.execute(
            "INSERT INTO polls (group_id, created_by, title, status, is_official, created_at) VALUES (?, ?, ?, 'playing', 1, ?)",
            (group_a, user_ids["alice"], "9월 3주차 정기전 (진행중)", ts(offset_hours=5)),
        )
        poll3 = cur.lastrowid
        for uname in ("alice", "bob", "charlie", "dave", "henry", "ivy"):
            cur.execute(
                "INSERT INTO poll_votes (poll_id, user_id, voted_at) VALUES (?, ?, ?)",
                (poll3, user_ids[uname], ts(offset_hours=4)),
            )
        # 완료된 매치 1개 + 진행중 매치 2개
        cur.execute(
            """INSERT INTO matches
               (group_id, poll_id, player1_id, player2_id, winner_id, recorded_by,
                status, is_official, pgn_data, played_at)
               VALUES (?, ?, ?, ?, ?, ?, 'finished', 1, ?, ?)""",
            (group_a, poll3, user_ids["alice"], user_ids["dave"], user_ids["alice"],
             user_ids["alice"], "1. e4 c5 2. Nf3 d6", ts(offset_hours=2)),
        )
        cur.execute(
            """INSERT INTO matches
               (group_id, poll_id, player1_id, player2_id, recorded_by, status, is_official)
               VALUES (?, ?, ?, ?, ?, 'playing', 1)""",
            (group_a, poll3, user_ids["bob"], user_ids["charlie"], user_ids["alice"]),
        )
        cur.execute(
            """INSERT INTO matches
               (group_id, poll_id, player1_id, player2_id, recorded_by, status, is_official)
               VALUES (?, ?, ?, ?, ?, 'playing', 1)""",
            (group_a, poll3, user_ids["henry"], user_ids["ivy"], user_ids["alice"]),
        )

        # ---- 투표중(voting) 폴 1: 일부만 투표 ----
        cur.execute(
            "INSERT INTO polls (group_id, created_by, title, status, is_official, created_at) VALUES (?, ?, ?, 'voting', 1, ?)",
            (group_a, user_ids["charlie"], "9월 4주차 정기전 (투표중)", ts(offset_hours=1)),
        )
        poll4 = cur.lastrowid
        for uname in ("alice", "charlie", "henry"):
            cur.execute(
                "INSERT INTO poll_votes (poll_id, user_id, voted_at) VALUES (?, ?, ?)",
                (poll4, user_ids[uname], ts(offset_hours=1)),
            )

        # ---- 투표중(voting) 폴 2: 비공식 + 아무도 투표 안 함 (빈 상태) ----
        cur.execute(
            "INSERT INTO polls (group_id, created_by, title, status, is_official, created_at) VALUES (?, ?, ?, 'voting', 0, ?)",
            (group_a, user_ids["bob"], "번개 친선전 (비공식)", ts(offset_hours=0)),
        )

        # ---- 친선 매치 (poll 없이 직접 등록, note/폴더 포함) ----
        friendly_matches = [
            ("dave", "erin", "dave", "즉흥 대국, 재미로 진행", folder2_id, "1. d4 Nf6 2. c4 g6"),
            ("frank", "jack", None, "시간 부족으로 무승부 합의", folder2_id, None),
            ("ivy", "grace", "grace", "", None, None),
        ]
        for p1, p2, winner, note, fid, pgn in friendly_matches:
            cur.execute(
                """INSERT INTO matches
                   (group_id, player1_id, player2_id, winner_id, recorded_by,
                    status, is_official, note, folder_id, pgn_data, played_at)
                   VALUES (?, ?, ?, ?, ?, 'finished', 0, ?, ?, ?, ?)""",
                (group_a, user_ids[p1], user_ids[p2],
                 user_ids[winner] if winner else None, user_ids["alice"],
                 note, fid, pgn, ts(offset_days=3)),
            )

        # ---- 활동 로그 다건 ----
        logs = [
            ("alice", "그룹_생성", "'체스 동아리 A' 그룹 생성"),
            ("alice", "역할_변경", "밥님 역할 변경: 회원 → 임원"),
            ("alice", "역할_변경", "찰리님 역할 변경: 회원 → 임원"),
            ("bob", "투표_생성", "'9월 1주차 정기전' 투표 생성"),
            ("alice", "투표_종료", "'9월 1주차 정기전' 종료, 2경기 생성"),
            ("charlie", "멤버_강퇴", "테스트유저님 강퇴"),
            ("alice", "공지_작성", "'대회 일정 공지' 작성"),
        ]
        for uname, action, detail in logs:
            _log(cur, group_a, user_ids[uname], action, detail)

    # ---------- 그룹 B: 방장 혼자뿐인 빈 그룹 (빈 상태 테스트) ----------
    cur.execute("SELECT id FROM groups WHERE name = ?", ("신생 동아리 B",))
    if not cur.fetchone():
        invite_code_b = secrets.token_hex(4).upper()
        cur.execute(
            "INSERT INTO groups (name, owner_id, invite_code, created_at) VALUES (?, ?, ?, ?)",
            ("신생 동아리 B", user_ids["grace"], invite_code_b, ts(offset_hours=2)),
        )
        group_b = cur.lastrowid
        cur.execute(
            "INSERT INTO user_groups (user_id, group_id, role, joined_at) VALUES (?, ?, '방장', ?)",
            (user_ids["grace"], group_b, ts(offset_hours=2)),
        )
        cur.execute(
            "INSERT INTO group_settings (group_id, pts_win, pts_draw, pts_loss, is_color_automatic) VALUES (?, 3, 2, 1, 1)",
            (group_b,),
        )
        _log(cur, group_b, user_ids["grace"], "그룹_생성", "'신생 동아리 B' 그룹 생성")

    conn.commit()
    conn.close()

    print("더미 데이터 생성 완료.")
    print(f"모든 계정 비밀번호: {PASSWORD}")
    print("계정 목록:", ", ".join(u[1] for u in users))
    print("그룹: '체스 동아리 A' (풍성한 데이터), '신생 동아리 B' (빈 상태)")


def _log(cur, group_id, user_id, action, detail):
    cur.execute(
        "INSERT INTO activity_logs (group_id, user_id, action, detail) VALUES (?, ?, ?, ?)",
        (group_id, user_id, action, detail),
    )


if __name__ == "__main__":
    main()
