"""
seed.py — 테스트 데이터 대량 삽입 스크립트

Usage (backend/ 디렉터리에서 실행):
    python seed.py

주의: 기존 데이터를 전부 삭제하고 새로운 테스트 데이터를 삽입합니다.

생성 데이터 요약`
  • 유저 15명  (비밀번호: 1234)
  • 그룹 2개
      G1 아주대 체스 동아리 : 12명, 투표 14개 (완료12 · 진행중1 · 투표중1)
      G2 체스 초보반        :  6명, 투표  3개 (완료3)
  • 초대코드: G1=ABCD1234 / G2=EF567890
"""

import bcrypt
import io
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

# Windows 터미널 인코딩 문제 방지
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

DB_PATH = os.environ.get("DB_PATH", "chess_club.db")
KST     = timezone(timedelta(hours=9))

# ─── 샘플 PGN ────────────────────────────────────────────────────────────────

PGN_W = """\
[Event "Club Match"]
[White "White"]
[Black "Black"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 \
8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 \
14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0"""

PGN_B = """\
[Event "Club Match"]
[White "White"]
[Black "Black"]
[Result "0-1"]

1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. Nf3 O-O 6. Be2 e5 7. O-O Nc6 \
8. d5 Ne7 9. Nd2 Nd7 10. b4 f5 11. f3 f4 12. Nb3 a5 13. bxa5 Nc5 14. Nxc5 \
dxc5 15. a4 Qe8 16. Kh1 Nf5 17. Bd3 Ng3+ 18. Kg1 Nxf1 19. Qxf1 h5 0-1"""

PGN_D = """\
[Event "Club Match"]
[White "White"]
[Black "Black"]
[Result "1/2-1/2"]

1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Be3 e5 \
7. Nb3 Be6 8. f3 Be7 9. Qd2 O-O 10. g4 d5 11. exd5 Nxd5 12. Nxd5 Bxd5 \
13. g5 Nc6 14. f4 Nb4 15. fxe5 Bc4 16. Bxc4 Qd4 17. Qxd4 Nc6 \
18. Qd2 Nxe5 1/2-1/2"""


# ─── 유틸 ────────────────────────────────────────────────────────────────────

def kst(delta_days: int = 0, delta_hours: int = 0) -> str:
    dt = datetime.now(KST) - timedelta(days=delta_days, hours=delta_hours)
    return dt.replace(tzinfo=None).isoformat(timespec="seconds")


def hp(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()


# ─── 메인 ────────────────────────────────────────────────────────────────────

def seed():
    # 테이블이 없으면 생성
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from main import init_db, migrate_db
    init_db()
    migrate_db()

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # ── 기존 데이터 삭제 ─────────────────────────────────────────────────────
    print("[1/6] 기존 데이터 삭제...")
    for tbl in ("poll_votes", "matches", "polls", "announcements",
                "user_groups", "group_settings", "groups", "users"):
        conn.execute(f"DELETE FROM {tbl}")
    try:
        conn.execute("DELETE FROM sqlite_sequence")
    except sqlite3.OperationalError:
        pass
    conn.commit()

    # ── 유저 15명 ────────────────────────────────────────────────────────────
    print("[2/6] 유저 15명 생성...")

    #            아이디    이름      Chess.com          레이팅  갱신(일 전)
    users_raw = [
        ("admin",  "김민준", "kiminjun_chess",  1852,  3),
        ("user02", "이서연", "seoyeon_chess",   1724,  1),
        ("user03", "박지호", "parkjiho99",      1651,  5),
        ("user04", "최유진", None,              None,  None),
        ("user05", "정하은", "chess_haeun",     1583,  2),
        ("user06", "강도현", "dohyun_kang",     1491,  4),
        ("user07", "윤서희", None,              None,  None),
        ("user08", "장민서", "minseojang",      1415,  3),
        ("user09", "임태양", "taeyang_im",      1382,  6),
        ("user10", "한소율", None,              None,  None),
        ("user11", "오지훈", "ojihun_chess",    1321,  2),
        ("user12", "신예린", "yerin_shin",      1293,  4),
        ("user13", "권태준", None,              None,  None),
        ("user14", "류하늘", "hanuel_ryu",      1254,  1),
        ("user15", "배민아", "baemina_chess",   1208,  7),
    ]

    u: dict[str, int] = {}
    for username, nickname, chess_un, rating, upd in users_raw:
        updated_at = kst(delta_days=upd) if upd is not None else None
        cur = conn.execute(
            """INSERT INTO users
               (username, nickname, password, chess_username, rating_rapid, rating_updated_at)
               VALUES (?,?,?,?,?,?)""",
            (username, nickname, hp("1234"), chess_un, rating, updated_at),
        )
        u[username] = cur.lastrowid
    conn.commit()

    # ── 그룹 2개 ─────────────────────────────────────────────────────────────
    print("[3/6] 그룹 2개 생성...")

    g1 = conn.execute(
        "INSERT INTO groups (name, owner_id, invite_code, created_at) VALUES (?,?,?,?)",
        ("아주대 체스 동아리", u["admin"], "ABCD1234", kst(delta_days=120)),
    ).lastrowid

    g2 = conn.execute(
        "INSERT INTO groups (name, owner_id, invite_code, created_at) VALUES (?,?,?,?)",
        ("체스 초보반", u["user03"], "EF567890", kst(delta_days=40)),
    ).lastrowid
    conn.commit()

    # ── 멤버 배정 ────────────────────────────────────────────────────────────
    print("[4/6] 멤버 배정...")

    g1_roster = [
        ("admin",  "방장", 120), ("user02", "임원", 115), ("user03", "임원", 110),
        ("user04", "회원", 100), ("user05", "회원",  95), ("user06", "회원",  90),
        ("user07", "회원",  85), ("user08", "회원",  80), ("user09", "회원",  75),
        ("user10", "회원",  70), ("user11", "회원",  65), ("user12", "회원",  60),
    ]
    for username, role, days in g1_roster:
        conn.execute(
            "INSERT INTO user_groups (user_id, group_id, role, joined_at) VALUES (?,?,?,?)",
            (u[username], g1, role, kst(delta_days=days)),
        )

    g2_roster = [
        ("user03", "방장", 40), ("user07", "임원", 38),
        ("user10", "회원", 35), ("user13", "회원", 30),
        ("user14", "회원", 25), ("user15", "회원", 20),
    ]
    for username, role, days in g2_roster:
        conn.execute(
            "INSERT INTO user_groups (user_id, group_id, role, joined_at) VALUES (?,?,?,?)",
            (u[username], g2, role, kst(delta_days=days)),
        )

    conn.execute(
        "INSERT INTO group_settings (group_id,pts_win,pts_draw,pts_loss,is_color_automatic) VALUES (?,3,1,0,1)",
        (g1,),
    )
    conn.execute(
        "INSERT INTO group_settings (group_id,pts_win,pts_draw,pts_loss,is_color_automatic) VALUES (?,2,1,0,1)",
        (g2,),
    )
    conn.commit()

    # ── 투표/경기 헬퍼 ───────────────────────────────────────────────────────

    def make_poll(group_id, creator_id, title, days_ago, voters, pairs, poll_status):
        """
        voters : [user_id, ...]
        pairs  : [(p1_uid, p2_uid, winner_uid_or_None, pgn_or_None), ...]
                 winner=None → 무승부(finished) 또는 미완료(playing)
        """
        created_at = kst(delta_days=days_ago)
        poll_id = conn.execute(
            "INSERT INTO polls (group_id,created_by,title,status,created_at) VALUES (?,?,?,?,?)",
            (group_id, creator_id, title, poll_status, created_at),
        ).lastrowid

        for v in voters:
            conn.execute(
                "INSERT INTO poll_votes (poll_id,user_id,voted_at) VALUES (?,?,?)",
                (poll_id, v, created_at),
            )

        if poll_status in ("finished", "playing"):
            played_at = kst(delta_days=max(0, days_ago - 1))
            for p1, p2, winner, pgn in pairs:
                m_status = (
                    "finished"
                    if poll_status == "finished" or winner is not None
                    else "playing"
                )
                conn.execute(
                    """INSERT INTO matches
                       (group_id,poll_id,player1_id,player2_id,winner_id,
                        recorded_by,status,played_at,pgn_data)
                       VALUES (?,?,?,?,?,?,?,?,?)""",
                    (group_id, poll_id, p1, p2, winner,
                     creator_id, m_status, played_at, pgn),
                )

    # ── G1 투표 (12 finished + 1 playing + 1 voting) ─────────────────────────
    print("[5/6] G1 투표 14개 생성...")

    P  = [u[r[0]] for r in g1_roster]   # P[0..11]
    AD = u["admin"]
    W, B, D = PGN_W, PGN_B, PGN_D

    g1_polls = [
        # ── finished 12개 (히스토리 2페이지 분량) ──────────────────────────
        ("1월 1주차 정기전", 90,
         [P[0],P[1],P[2],P[3],P[4],P[5],P[6],P[7]],
         [(P[0],P[7],P[0],W),(P[1],P[6],P[6],B),(P[2],P[5],P[2],D),(P[3],P[4],None,None)],
         "finished"),

        ("1월 2주차 정기전", 83,
         [P[0],P[1],P[2],P[3],P[4],P[5],P[6],P[7],P[8],P[9]],
         [(P[0],P[9],P[0],W),(P[1],P[8],P[1],W),(P[2],P[7],P[7],B),
          (P[3],P[6],P[3],D),(P[4],P[5],None,None)],
         "finished"),

        ("2월 정기전", 76,
         [P[0],P[1],P[2],P[3],P[4],P[5],P[6],P[7]],
         [(P[0],P[7],P[0],W),(P[1],P[6],P[6],B),(P[2],P[5],None,D),(P[3],P[4],P[3],None)],
         "finished"),

        ("3월 1주차 정기전", 69,
         [P[0],P[1],P[2],P[4],P[6],P[8],P[10],P[11]],
         [(P[0],P[11],P[0],W),(P[1],P[10],P[1],W),(P[2],P[8],P[8],B),(P[4],P[6],None,D)],
         "finished"),

        ("3월 2주차 정기전", 62,
         [P[0],P[1],P[3],P[5],P[7],P[9]],
         [(P[0],P[9],P[0],W),(P[1],P[7],None,D),(P[3],P[5],P[5],B)],
         "finished"),

        ("4월 1주차 정기전", 55,
         [P[0],P[1],P[2],P[3],P[4],P[5],P[6],P[7],P[8],P[9],P[10],P[11]],
         [(P[0],P[11],P[0],W),(P[1],P[10],P[10],B),(P[2],P[9],P[2],W),
          (P[3],P[8],None,D),(P[4],P[7],P[4],W),(P[5],P[6],P[6],B)],
         "finished"),

        ("4월 2주차 정기전", 48,
         [P[0],P[2],P[4],P[6],P[8],P[10]],
         [(P[0],P[10],P[0],W),(P[2],P[8],P[8],B),(P[4],P[6],None,D)],
         "finished"),

        ("5월 1주차 정기전", 35,
         [P[0],P[1],P[2],P[3],P[4],P[5],P[6],P[7]],
         [(P[0],P[7],P[0],W),(P[1],P[6],P[1],W),(P[2],P[5],P[5],B),(P[3],P[4],None,None)],
         "finished"),

        ("5월 2주차 정기전", 28,
         [P[0],P[1],P[3],P[5],P[7],P[9],P[11]],   # 7명 → 3쌍 + bye
         [(P[0],P[1],P[0],W),(P[3],P[11],P[11],B),(P[5],P[9],None,D)],
         "finished"),

        ("6월 1주차 정기전", 21,
         [P[0],P[1],P[2],P[3],P[4],P[5],P[6],P[7],P[8],P[9],P[10],P[11]],
         [(P[0],P[11],P[0],W),(P[1],P[10],P[1],W),(P[2],P[9],P[9],B),
          (P[3],P[8],P[3],W),(P[4],P[7],None,D),(P[5],P[6],P[6],B)],
         "finished"),

        ("6월 2주차 정기전", 14,
         [P[0],P[1],P[2],P[3],P[4],P[5]],
         [(P[0],P[5],P[0],W),(P[1],P[4],None,D),(P[2],P[3],P[2],W)],
         "finished"),

        ("6월 3주차 정기전", 7,
         [P[0],P[1],P[2],P[4],P[6],P[8],P[10],P[11]],
         [(P[0],P[11],P[0],W),(P[1],P[10],P[10],B),(P[2],P[8],None,D),(P[4],P[6],P[4],W)],
         "finished"),

        # ── playing 1개 (일부 경기만 완료) ────────────────────────────────
        ("6월 4주차 정기전", 2,
         [P[0],P[1],P[2],P[3],P[4],P[5],P[6],P[7]],
         [(P[0],P[7],P[0],W),(P[1],P[6],None,None),(P[2],P[5],None,None),(P[3],P[4],None,None)],
         "playing"),
    ]

    for title, days_ago, voters, pairs, status in g1_polls:
        make_poll(g1, AD, title, days_ago, voters, pairs, status)

    # 투표 중 1개
    now = kst()
    voting_id = conn.execute(
        "INSERT INTO polls (group_id,created_by,title,status,created_at) VALUES (?,?,?,?,?)",
        (g1, AD, "6월 5주차 정기전", "voting", now),
    ).lastrowid
    for v in [P[0], P[1], P[2], P[3], P[4]]:
        conn.execute(
            "INSERT INTO poll_votes (poll_id,user_id,voted_at) VALUES (?,?,?)",
            (voting_id, v, now),
        )

    conn.commit()

    # ── G2 투표 3개 ──────────────────────────────────────────────────────────
    print("[6/6] G2 투표 3개 생성...")

    Q    = [u[r[0]] for r in g2_roster]   # Q[0..5]
    GD2  = u["user03"]

    g2_polls = [
        ("초보반 1회 대전", 35,
         [Q[0],Q[1],Q[2],Q[3]],
         [(Q[0],Q[3],Q[0],None),(Q[1],Q[2],Q[2],None)],
         "finished"),

        ("초보반 2회 대전", 20,
         [Q[0],Q[2],Q[3],Q[4],Q[5]],   # 5명 → 2쌍 + bye
         [(Q[0],Q[5],Q[0],None),(Q[2],Q[4],None,None)],
         "finished"),

        ("초보반 3회 대전", 7,
         [Q[0],Q[1],Q[2],Q[3],Q[4],Q[5]],
         [(Q[0],Q[5],Q[0],None),(Q[1],Q[4],Q[4],None),(Q[2],Q[3],None,None)],
         "finished"),
    ]

    for title, days_ago, voters, pairs, status in g2_polls:
        make_poll(g2, GD2, title, days_ago, voters, pairs, status)

    conn.commit()

    # ── 공지사항 ─────────────────────────────────────────────────────────────
    print("[7/7] 공지사항 생성...")

    announcements = [
        (g1, AD, "여름 정기전 일정 안내", "7월 첫째 주부터 정기전이 매주 토요일 오후 2시에 진행됩니다. 참석 가능 여부를 투표로 남겨주세요.", 1),
        (g1, AD, "동아리방 위치 변경 안내", "다음 주부터 동아리방이 학생회관 302호로 변경됩니다. 착오 없으시길 바랍니다.", 10),
        (g2, GD2, "초보반 신규 회원 모집", "체스를 처음 시작하는 분들을 위한 초보반에 신규 회원을 모집합니다. 관심 있는 분은 방장에게 문의해주세요.", 5),
    ]
    for group_id, author_id, title, content, days_ago in announcements:
        conn.execute(
            "INSERT INTO announcements (group_id, author_id, title, content, created_at) VALUES (?,?,?,?,?)",
            (group_id, author_id, title, content, kst(delta_days=days_ago)),
        )

    conn.commit()
    conn.close()

    # ── 완료 출력 ────────────────────────────────────────────────────────────
    print()
    print("완료!")
    print()
    print("┌─────────────────────────────────────────────┐")
    print("│        테스트 계정  (비밀번호: 1234)          │")
    print("├──────────┬──────────┬──────────────────────┤")
    print("│  아이디  │   이름   │  역할 / 레이팅        │")
    print("├──────────┼──────────┼──────────────────────┤")
    print("│  admin   │  김민준  │  G1 방장  / 1852     │")
    print("│  user02  │  이서연  │  G1 임원  / 1724     │")
    print("│  user03  │  박지호  │  G1 임원  G2 방장     │")
    print("│  user04  │  최유진  │  G1 회원  (미연동)    │")
    print("│  user05  │  정하은  │  G1 회원  / 1583     │")
    print("│   ...    │   ...    │  G1 회원              │")
    print("│  user13  │  권태준  │  G2 회원  (미연동)    │")
    print("│  user14  │  류하늘  │  G2 회원  / 1254     │")
    print("│  user15  │  배민아  │  G2 회원  / 1208     │")
    print("├──────────┴──────────┴──────────────────────┤")
    print("│  G1 초대코드: ABCD1234                      │")
    print("│  G2 초대코드: EF567890                      │")
    print("└─────────────────────────────────────────────┘")
    print()
    print("  G1: 완료 투표 12개 → 히스토리 2페이지")
    print("      진행 중 1개 (6월 4주차)  ·  투표 중 1개 (6월 5주차)")
    print("  G2: 완료 투표 3개")


if __name__ == "__main__":
    seed()
