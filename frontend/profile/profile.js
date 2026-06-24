const API_BASE = (() => {
    const { protocol, hostname, port } = window.location;
    if (protocol === 'file:') return 'http://localhost:8000';
    if ((hostname === 'localhost' || hostname === '127.0.0.1') && port !== '8000') return 'http://localhost:8000';
    return '';
})();

// ===== 인증 가드 =====

const token = localStorage.getItem('token');
if (!token) {
    window.location.href = '../login/login.html';
}

// ===== API 헬퍼 =====

async function apiFetch(path, options = {}) {
    try {
        const res = await fetch(`${API_BASE}${path}`, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                ...(options.headers || {}),
            },
        });

        if (res.status === 401) {
            localStorage.clear();
            window.location.href = '../login/login.html';
            return null;
        }

        const data = await res.json();
        return { ok: res.ok, status: res.status, data };
    } catch {
        return { ok: false, status: 0, data: { detail: '서버에 연결할 수 없습니다.' } };
    }
}

function setMsg(id, text, type = '') {
    const el = document.getElementById(id);
    el.textContent = text;
    el.className = 'status-msg' + (type ? ` ${type}` : '');
}

function formatDate(dateStr) {
    if (!dateStr) return '-';
    try {
        const d = new Date(dateStr.replace(' ', 'T') + '+09:00');
        return d.toLocaleString('ko-KR', {
            timeZone: 'Asia/Seoul',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return dateStr.slice(0, 10);
    }
}

// ===== 유저 정보 로드 =====

let currentUser = null;

async function loadUser() {
    const result = await apiFetch('/api/me');
    if (!result || !result.ok) return;

    currentUser = result.data;

    document.getElementById('display-username').textContent = currentUser.username;
    document.getElementById('input-nickname').value = currentUser.nickname || '';
    document.getElementById('input-chess-username').value = currentUser.chess_username || '';

    renderRatings(currentUser);
}

function renderRatings(user) {
    const blitzEl   = document.getElementById('display-blitz');
    const rapidEl   = document.getElementById('display-rapid');
    const updatedEl = document.getElementById('display-updated');

    if (user.rating_blitz) {
        blitzEl.textContent = user.rating_blitz;
        blitzEl.className = 'rating-value';
    } else {
        blitzEl.textContent = '-';
        blitzEl.className = 'rating-value muted';
    }

    if (user.rating_rapid) {
        rapidEl.textContent = user.rating_rapid;
        rapidEl.className = 'rating-value';
    } else {
        rapidEl.textContent = '-';
        rapidEl.className = 'rating-value muted';
    }

    updatedEl.textContent = user.rating_updated_at ? formatDate(user.rating_updated_at) : '-';
    updatedEl.className = user.rating_updated_at ? 'rating-value small' : 'rating-value muted';
}

// ===== 로그아웃 =====

document.getElementById('btn-logout').addEventListener('click', () => {
    localStorage.clear();
    window.location.href = '../login/login.html';
});

// ===== 기본 정보 저장 =====

document.getElementById('btn-save-profile').addEventListener('click', async () => {
    const nickname = document.getElementById('input-nickname').value.trim();
    setMsg('profile-msg', '');

    if (!nickname) {
        setMsg('profile-msg', '닉네임을 입력해주세요.', 'error');
        return;
    }

    const btn = document.getElementById('btn-save-profile');
    btn.disabled = true;
    btn.textContent = '저장 중...';

    try {
        const result = await apiFetch('/api/me/profile', {
            method: 'PATCH',
            body: JSON.stringify({ nickname }),
        });
        if (!result) return;

        if (result.ok) {
            currentUser.nickname = result.data.nickname;
            localStorage.setItem('nickname', result.data.nickname);
            setMsg('profile-msg', '닉네임이 변경되었습니다.', 'success');
            setTimeout(() => setMsg('profile-msg', ''), 3000);
        } else {
            setMsg('profile-msg', result.data.detail || '저장에 실패했습니다.', 'error');
        }
    } finally {
        btn.disabled = false;
        btn.textContent = '저장';
    }
});

document.getElementById('input-nickname').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-save-profile').click();
});

// ===== Chess.com 저장 및 레이팅 조회 =====

document.getElementById('btn-save-chess').addEventListener('click', async () => {
    const chessUsername = document.getElementById('input-chess-username').value.trim();
    setMsg('chess-msg', '');

    if (!chessUsername) {
        setMsg('chess-msg', 'Chess.com 아이디를 입력해주세요.', 'error');
        return;
    }

    const btn = document.getElementById('btn-save-chess');
    btn.disabled = true;
    btn.textContent = '조회 중...';

    try {
        // 1. 아이디 저장
        const patch = await apiFetch('/api/me/chess', {
            method: 'PATCH',
            body: JSON.stringify({ chess_username: chessUsername }),
        });
        if (!patch) return;
        if (!patch.ok) {
            setMsg('chess-msg', patch.data.detail || '저장에 실패했습니다.', 'error');
            return;
        }

        currentUser.chess_username = chessUsername;
        setMsg('chess-msg', '저장 완료! 레이팅 조회 중...', 'success');

        // 2. 즉시 레이팅 조회
        const refresh = await apiFetch('/api/me/chess/refresh', { method: 'POST' });
        if (!refresh) return;

        if (refresh.ok) {
            currentUser.rating_blitz = refresh.data.rating_blitz;
            currentUser.rating_rapid = refresh.data.rating_rapid;
            currentUser.rating_updated_at = refresh.data.updated_at;
            renderRatings(currentUser);
            setMsg('chess-msg', '레이팅이 업데이트되었습니다.', 'success');
            setTimeout(() => setMsg('chess-msg', ''), 3000);
        } else {
            setMsg('chess-msg', refresh.data.detail || '레이팅 조회 실패 — Chess.com 아이디를 확인해주세요.', 'error');
        }
    } finally {
        btn.disabled = false;
        btn.textContent = '저장 및 조회';
    }
});

// ===== 레이팅 새로고침 =====

document.getElementById('btn-refresh-chess').addEventListener('click', async () => {
    setMsg('chess-msg', '');

    if (!currentUser?.chess_username) {
        setMsg('chess-msg', '먼저 Chess.com 아이디를 저장해주세요.', 'error');
        return;
    }

    const btn = document.getElementById('btn-refresh-chess');
    btn.disabled = true;
    btn.textContent = '조회 중...';

    try {
        const result = await apiFetch('/api/me/chess/refresh', { method: 'POST' });
        if (!result) return;

        if (result.ok) {
            currentUser.rating_blitz = result.data.rating_blitz;
            currentUser.rating_rapid = result.data.rating_rapid;
            currentUser.rating_updated_at = result.data.updated_at;
            renderRatings(currentUser);
            setMsg('chess-msg', '레이팅이 업데이트되었습니다.', 'success');
            setTimeout(() => setMsg('chess-msg', ''), 3000);
        } else {
            setMsg('chess-msg', result.data.detail || '레이팅 조회에 실패했습니다.', 'error');
        }
    } finally {
        btn.disabled = false;
        btn.textContent = '레이팅 새로고침';
    }
});

document.getElementById('input-chess-username').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-save-chess').click();
});

// ===== 비밀번호 변경 =====

document.getElementById('btn-change-password').addEventListener('click', async () => {
    const currentPw  = document.getElementById('input-current-pw').value;
    const newPw      = document.getElementById('input-new-pw').value;
    const confirmPw  = document.getElementById('input-confirm-pw').value;
    setMsg('password-msg', '');

    if (!currentPw || !newPw || !confirmPw) {
        setMsg('password-msg', '모든 항목을 입력해주세요.', 'error');
        return;
    }
    if (newPw !== confirmPw) {
        setMsg('password-msg', '새 비밀번호가 일치하지 않습니다.', 'error');
        return;
    }
    if (newPw.length < 4) {
        setMsg('password-msg', '새 비밀번호는 4자 이상이어야 합니다.', 'error');
        return;
    }

    const btn = document.getElementById('btn-change-password');
    btn.disabled = true;
    btn.textContent = '변경 중...';

    try {
        const result = await apiFetch('/api/me/password', {
            method: 'PATCH',
            body: JSON.stringify({ current_password: currentPw, new_password: newPw }),
        });
        if (!result) return;

        if (result.ok) {
            setMsg('password-msg', '비밀번호가 변경되었습니다.', 'success');
            document.getElementById('input-current-pw').value = '';
            document.getElementById('input-new-pw').value = '';
            document.getElementById('input-confirm-pw').value = '';
        } else {
            setMsg('password-msg', result.data.detail || '비밀번호 변경에 실패했습니다.', 'error');
        }
    } finally {
        btn.disabled = false;
        btn.textContent = '비밀번호 변경';
    }
});

// ===== 실행 =====

loadUser();
