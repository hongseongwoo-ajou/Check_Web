"""
영어 화면용 서버 메시지 번역.

라우트 코드는 지금처럼 한국어 메시지로 HTTPException을 던지고, main.py의 예외 처리기가
요청의 Accept-Language가 영어일 때만 이 표로 바꿔 내려준다. 표에 없는 메시지는 한국어 그대로.
새 에러 메시지를 추가하면 EN에도 한 줄 추가할 것.
"""
import re

EN = {
    # 인증·계정
    "인증이 필요합니다.": "Authentication required.",
    "유효하지 않은 토큰입니다.": "Invalid session. Please log in again.",
    "세션이 만료되었습니다. 다시 로그인해주세요.": "Your session has expired. Please log in again.",
    "아이디 또는 비밀번호가 틀렸습니다.": "Incorrect username or password.",
    "아이디는 영문, 숫자, 한글, 밑줄(_)만 사용할 수 있습니다.": "Usernames may only contain letters, numbers, Korean characters and underscores (_).",
    "이미 사용 중인 아이디입니다.": "That username is already taken.",
    "현재 비밀번호가 일치하지 않습니다.": "Your current password is incorrect.",
    "닉네임을 입력해주세요.": "Please enter a name.",
    "요청이 너무 많습니다. 잠시 후 다시 시도해주세요.": "Too many requests. Please try again in a moment.",
    # Chess.com
    "Chess.com 계정이 연동되어 있지 않습니다.": "No Chess.com account is linked.",
    "Chess.com 아이디가 설정되지 않았습니다.": "No Chess.com username is set.",
    "Chess.com 아이디는 3~25자의 영문자, 숫자, -, _만 사용 가능합니다.": "Chess.com usernames must be 3-25 characters of letters, numbers, - or _.",
    "Chess.com 아이디를 입력해주세요.": "Please enter your Chess.com username.",
    "Chess.com에 연결할 수 없습니다.": "Could not connect to Chess.com.",
    "period는 7d, 30d, 1y, all 중 하나여야 합니다.": "period must be one of 7d, 30d, 1y, all.",
    # 그룹·멤버
    "그룹 이름은 2자 이상이어야 합니다.": "Group name must be at least 2 characters.",
    "그룹을 찾을 수 없습니다.": "Group not found.",
    "유효하지 않은 초대 코드입니다.": "Invalid invite code.",
    "이미 가입된 그룹입니다.": "You are already a member of this group.",
    "해당 그룹의 멤버가 아닙니다.": "You are not a member of this group.",
    "그룹 멤버가 아닙니다.": "You are not a member of this group.",
    "권한이 없습니다.": "You don't have permission to do that.",
    "방장만 그룹을 삭제할 수 있습니다.": "Only the owner can delete the group.",
    "방장만 역할을 변경할 수 있습니다.": "Only the owner can change roles.",
    "방장은 강퇴할 수 없습니다.": "The owner cannot be kicked.",
    "방장의 역할은 변경할 수 없습니다.": "The owner's role cannot be changed.",
    "임원은 다른 임원을 강퇴할 수 없습니다.": "Officers cannot kick other officers.",
    "자신을 강퇴할 수 없습니다.": "You cannot kick yourself.",
    "자신의 역할은 변경할 수 없습니다.": "You cannot change your own role.",
    "해당 멤버를 찾을 수 없습니다.": "Member not found.",
    "역할은 '임원' 또는 '회원'만 설정할 수 있습니다.": "Role must be either officer or member.",
    "방장은 그룹을 나갈 수 없습니다. 먼저 다른 멤버에게 방장을 넘겨주세요.": "The owner can't leave the group. Transfer ownership to another member first.",
    "방장만 방장을 넘길 수 있습니다.": "Only the owner can transfer ownership.",
    "자신에게는 방장을 넘길 수 없습니다.": "You can't transfer ownership to yourself.",
    "유효하지 않은 활동 유형입니다.": "Invalid activity type.",
    # 공지
    "공지사항을 찾을 수 없습니다.": "Announcement not found.",
    "제목을 입력해주세요.": "Please enter a title.",
    "내용을 입력해주세요.": "Please enter the content.",
    # 투표
    "투표를 찾을 수 없습니다.": "Poll not found.",
    "투표가 종료되었습니다.": "This poll has closed.",
    "이미 종료된 투표입니다.": "This poll has already been closed.",
    "이미 처리된 요청입니다. 다시 시도해주세요.": "This request was already processed. Please try again.",
    "투표 중인 상태에서만 참가자의 투표를 취소할 수 있습니다.": "Votes can only be cancelled while the poll is open.",
    "해당 참가자의 투표 기록이 없습니다.": "This participant has not voted.",
    "매치 생성에는 최소 2명의 참여자가 필요합니다.": "At least 2 participants are needed to create pairings.",
    "대진이 생성된 투표만 다시 열 수 있습니다.": "Only polls with pairings can be reopened.",
    "진행 중이거나 완료된 투표는 삭제할 수 없습니다.": "Polls that are in progress or finished cannot be deleted.",
    "이미 완료된 투표에는 경기를 추가할 수 없습니다.": "Matches cannot be added to a finished poll.",
    # 경기
    "매치를 찾을 수 없습니다.": "Match not found.",
    "결과는 p1_win, p2_win, draw 중 하나여야 합니다.": "Result must be one of p1_win, p2_win, draw.",
    "올바르지 않은 결과값입니다.": "Invalid result.",
    "백과 흑 선수는 달라야 합니다.": "White and Black must be different players.",
    "선택한 선수가 해당 그룹 멤버가 아닙니다.": "The selected player is not a member of this group.",
    "승자는 해당 매치의 선수여야 합니다.": "The winner must be one of the match's players.",
    "기보 내용을 입력해주세요.": "Please enter the PGN.",
    "해당 그룹의 멤버만 기보를 저장할 수 있습니다.": "Only members of this group can save PGNs.",
    "유효한 친선 경기가 없습니다.": "No valid friendly matches were selected.",
    "폴더를 찾을 수 없습니다.": "Folder not found.",
    # 기타
    "체스 동아리 서버 가동 중": "Chess club server is running",
}

# 값이 들어가는 메시지
EN_PATTERNS = [
    (re.compile(r"^Chess\.com에서 '(.+)' 계정을 찾을 수 없습니다\.$"), r"Chess.com account '\1' was not found."),
    (re.compile(r"^Chess\.com API 오류 \(HTTP (\d+)\)$"), r"Chess.com API error (HTTP \1)"),
    (re.compile(r"^레이팅 조회 중 오류: (.*)$", re.S), r"Error while fetching rating: \1"),
]

# 입력값 검증 오류용 필드 이름
FIELD_LABELS_EN = {
    "username": "Username", "nickname": "Name",
    "password": "Password", "new_password": "New password", "current_password": "Current password",
    "title": "Title", "content": "Content", "note": "Note",
    "chess_username": "Chess.com username", "name": "Name",
    "pts_win": "Points for a win", "pts_draw": "Points for a draw", "pts_loss": "Points for a loss",
}


def wants_english(request) -> bool:
    """Accept-Language의 첫 번째 언어가 영어면 True (프론트가 선택된 언어를 보내준다)."""
    first = request.headers.get("accept-language", "").split(",")[0].strip().lower()
    return first.startswith("en")


def to_english(text: str) -> str:
    if text in EN:
        return EN[text]
    for pattern, repl in EN_PATTERNS:
        if pattern.match(text):
            return pattern.sub(repl, text)
    return text


def localize(request, text: str) -> str:
    return to_english(text) if wants_english(request) else text


def validation_message_en(field: str, err_type: str, ctx: dict) -> str:
    label = FIELD_LABELS_EN.get(field, field or "Input")
    if err_type == "string_too_short" and ctx.get("min_length") == 1:
        return f"{label} is required."
    if err_type == "string_too_short":
        return f"{label} must be at least {ctx.get('min_length')} characters."
    if err_type == "string_too_long":
        return f"{label} must be at most {ctx.get('max_length')} characters."
    if err_type == "greater_than_equal":
        return f"{label} must be at least {ctx.get('ge')}."
    if err_type == "less_than_equal":
        return f"{label} must be at most {ctx.get('le')}."
    if err_type == "greater_than":
        return f"{label} must be greater than {ctx.get('gt')}."
    if err_type == "less_than":
        return f"{label} must be less than {ctx.get('lt')}."
    if err_type == "missing":
        return f"{label} is required."
    return f"{label} is invalid."
