"""
지능형 매칭 알고리즘 — Greedy 최소 비용 매칭

cost(A, B) = |rating_A - rating_B| + RECENT_PENALTY (최근 맞붙은 이력 있을 때)

홀수 멤버 제외 우선순위: 방장/임원 → 회원 (주최자가 빠져 회원 전원 경기 가능)
"""
import random
from typing import Optional

RECENT_PENALTY   = 400   # 최근 대결 시 부과할 레이팅 포인트 패널티
DEFAULT_RATING   = 800   # 미등록 멤버의 기본 레이팅
LOOKBACK_MATCHES = 20    # 최근 대결 여부 판단에 사용할 경기 수


# ---------- 헬퍼 ----------

def _get_recent_pairs(conn, group_id: int) -> set:
    """
    그룹의 최근 LOOKBACK_MATCHES 경기를 조회해
    (min_id, max_id) 튜플 집합으로 반환.
    O(1) 조회를 위해 set 사용.
    """
    rows = conn.execute(
        """SELECT player1_id, player2_id
           FROM matches
           WHERE group_id = ? AND status = 'finished'
           ORDER BY played_at DESC
           LIMIT ?""",
        (group_id, LOOKBACK_MATCHES),
    ).fetchall()
    return {
        (min(r["player1_id"], r["player2_id"]),
         max(r["player1_id"], r["player2_id"]))
        for r in rows
    }


def _pair_cost(p1: dict, p2: dict, recent_pairs: set) -> float:
    """
    낮을수록 좋은 매칭.
    레이팅 차이 + 최근 대결 패널티.
    """
    r1 = p1["rating_blitz"] or DEFAULT_RATING
    r2 = p2["rating_blitz"] or DEFAULT_RATING
    cost = abs(r1 - r2)

    key = (min(p1["id"], p2["id"]), max(p1["id"], p2["id"]))
    if key in recent_pairs:
        cost += RECENT_PENALTY

    return cost


def _pick_bye(voters: list) -> dict:
    """
    홀수 인원일 때 제외(bye)할 플레이어 선정.
    1순위: 방장/임원 (주최자가 빠져 회원 전원 경기 가능)
    2순위: 무작위 회원
    """
    admins = [v for v in voters if v["role"] in ("방장", "임원")]
    if admins:
        return random.choice(admins)
    return random.choice(voters)


# ---------- 핵심 함수 ----------

def make_pairs(
    voters: list,
    conn,
    group_id: int,
) -> tuple[list, Optional[dict]]:
    """
    최소 비용 Greedy 매칭.

    Args:
        voters    – [{"id", "nickname", "rating_blitz", "role"}, ...]
        conn      – SQLite 커넥션 (최근 대결 조회용)
        group_id  – 그룹 ID

    Returns:
        pairs      – [(player1_dict, player2_dict), ...]
        bye_player – 제외된 플레이어 (None이면 짝수)

    시간 복잡도: O(N² log N)
    """
    active = list(voters)
    bye_player: Optional[dict] = None

    # 1. 홀수 처리
    if len(active) % 2 == 1:
        bye_player = _pick_bye(active)
        active = [v for v in active if v["id"] != bye_player["id"]]

    if len(active) < 2:
        return [], bye_player

    # 2. 최근 대결 이력 조회
    recent_pairs = _get_recent_pairs(conn, group_id)

    # 3. 모든 후보 페어 생성 + 비용 계산
    candidates: list[tuple[float, dict, dict]] = []
    for i in range(len(active)):
        for j in range(i + 1, len(active)):
            cost = _pair_cost(active[i], active[j], recent_pairs)
            candidates.append((cost, active[i], active[j]))

    candidates.sort(key=lambda x: x[0])

    # 4. Greedy 선택 — 비용이 낮은 순서대로, 아직 짝 없는 쌍만 확정
    paired: set[int] = set()
    pairs: list[tuple[dict, dict]] = []

    for _, p1, p2 in candidates:
        if p1["id"] not in paired and p2["id"] not in paired:
            pairs.append((p1, p2))
            paired.add(p1["id"])
            paired.add(p2["id"])

    return pairs, bye_player
