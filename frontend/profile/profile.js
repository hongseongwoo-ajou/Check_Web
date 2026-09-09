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
            localStorage.removeItem('token');
            localStorage.removeItem('username');
            localStorage.removeItem('nickname');
            window.location.href = '../login/login.html';
            return null;
        }

        const data = await res.json();
        return { ok: res.ok, status: res.status, data };
    } catch {
        return { ok: false, status: 0, data: { detail: t('auth.serverUnreachable') } };
    }
}

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
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
    const rapidEl   = document.getElementById('display-rapid');
    const updatedEl = document.getElementById('display-updated');

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

// ===== 통계 대시보드 =====

let ratingChartInstance = null;

async function loadStats() {
    const result = await apiFetch('/api/me/stats');
    if (!result || !result.ok) {
        const failMsg = '<p class="stats-empty">불러오지 못했습니다.</p>';
        document.getElementById('stats-summary-grid').innerHTML = failMsg;
        document.getElementById('recent-form-row').innerHTML = failMsg;
        document.getElementById('rivals-list').innerHTML = failMsg;
        return;
    }

    const { summary, recent_form, rivals } = result.data;
    renderStatsSummary(summary);
    renderRecentForm(recent_form);
    renderRivals(rivals);
}

function renderStatsSummary(s) {
    const el = document.getElementById('stats-summary-grid');

    if (!s.played) {
        el.innerHTML = '<p class="stats-empty">아직 기록된 경기가 없습니다.</p>';
        return;
    }

    el.innerHTML = `
        <div class="stat-box">
            <span class="stat-box-label">총 경기</span>
            <span class="stat-box-value">${s.played}</span>
        </div>
        <div class="stat-box wins">
            <span class="stat-box-label">승</span>
            <span class="stat-box-value">${s.wins}</span>
        </div>
        <div class="stat-box draws">
            <span class="stat-box-label">무</span>
            <span class="stat-box-value">${s.draws}</span>
        </div>
        <div class="stat-box losses">
            <span class="stat-box-label">패</span>
            <span class="stat-box-value">${s.losses}</span>
        </div>
        <div class="stat-box win-rate">
            <span class="stat-box-label">승률</span>
            <span class="stat-box-value">${s.win_rate}%</span>
        </div>`;
}

// ===== 레이팅 변화 추이 (Chess.com 실제 대국 기록 기반) =====

let currentRatingPeriod = '30d';

function formatChartDate(dateStr) {
    // dateStr: "YYYY-MM-DD"
    const [, m, d] = dateStr.split('-');
    return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
}

async function loadRatingTrend(period) {
    currentRatingPeriod = period;

    const canvas     = document.getElementById('rating-chart');
    const loadingMsg = document.getElementById('rating-chart-loading');
    const emptyMsg   = document.getElementById('rating-chart-empty');

    canvas.classList.add('hidden');
    emptyMsg.classList.add('hidden');
    emptyMsg.textContent = '';
    loadingMsg.classList.remove('hidden');

    if (!currentUser?.chess_username) {
        loadingMsg.classList.add('hidden');
        emptyMsg.textContent = t('profile.linkChessToSeeTrend');
        emptyMsg.classList.remove('hidden');
        return;
    }

    const result = await apiFetch(`/api/me/chess/rating-trend?period=${period}`);
    loadingMsg.classList.add('hidden');

    // 그 사이 다른 기간 탭을 눌렀다면 이전 응답은 버림
    if (period !== currentRatingPeriod) return;

    if (!result || !result.ok) {
        emptyMsg.textContent = result?.data?.detail || t('profile.ratingTrendLoadError');
        emptyMsg.classList.remove('hidden');
        return;
    }

    const points = result.data.points;
    if (!points.length) {
        emptyMsg.textContent = t('profile.noRapidGamesInPeriod');
        emptyMsg.classList.remove('hidden');
        return;
    }

    canvas.classList.remove('hidden');
    renderRatingChart(points);
}

function renderRatingChart(points) {
    if (ratingChartInstance) {
        ratingChartInstance.destroy();
    }

    const canvas = document.getElementById('rating-chart');
    ratingChartInstance = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: points.map(p => formatChartDate(p.date)),
            datasets: [{
                label: t('profile.rapidLabel'),
                data: points.map(p => p.rating),
                borderColor: '#e2b96f',
                backgroundColor: 'rgba(226, 185, 111, 0.15)',
                pointBackgroundColor: '#e2b96f',
                pointRadius: points.length > 60 ? 0 : 3,
                pointHoverRadius: 5,
                tension: 0.2,
                fill: true,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
            },
            scales: {
                x: {
                    ticks: { color: '#888', maxRotation: 0, autoSkip: true, maxTicksLimit: 10 },
                    grid: { color: 'rgba(255,255,255,0.05)' },
                },
                y: {
                    ticks: { color: '#888' },
                    grid: { color: 'rgba(255,255,255,0.05)' },
                },
            },
        },
    });
}

document.querySelectorAll('.period-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.period-tab').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        loadRatingTrend(btn.dataset.period);
    });
});

function renderRecentForm(matches) {
    const el = document.getElementById('recent-form-row');

    if (!matches.length) {
        el.innerHTML = '<p class="stats-empty">아직 기록된 경기가 없습니다.</p>';
        return;
    }

    const labelMap = { win: '승', draw: '무', loss: '패' };
    el.innerHTML = matches.map(m => {
        const title = `${formatDate(m.played_at)} · vs ${m.opponent_nickname} · ${m.is_official ? t('common.official') : t('common.friendly')}`;
        return `<span class="form-badge ${m.result}" title="${escapeHtml(title)}">${labelMap[m.result]}</span>`;
    }).join('');
}

function renderRivals(rivals) {
    const el = document.getElementById('rivals-list');

    if (!rivals.length) {
        el.innerHTML = '<p class="stats-empty">아직 함께 대결한 상대가 없습니다.</p>';
        return;
    }

    el.innerHTML = rivals.map((r, i) => `
        <div class="rival-row">
            <span class="rival-rank">${i + 1}</span>
            <span class="rival-name">${escapeHtml(r.nickname)}</span>
            <span class="rival-played">총 ${r.played}전</span>
            <span class="rival-record">
                <span class="r-win">${r.wins}승</span> <span class="r-draw">${r.draws}무</span> <span class="r-loss">${r.losses}패</span>
            </span>
        </div>`).join('');
}

// ===== 로그아웃 =====

document.getElementById('btn-logout').addEventListener('click', () => {
    localStorage.removeItem('token');
    localStorage.removeItem('username');
    localStorage.removeItem('nickname');
    window.location.href = '../login/login.html';
});

// ===== 기본 정보 저장 =====

document.getElementById('btn-save-profile').addEventListener('click', async () => {
    const nickname = document.getElementById('input-nickname').value.trim();
    setMsg('profile-msg', '');

    if (!nickname) {
        setMsg('profile-msg', t('profile.nicknameRequired'), 'error');
        return;
    }

    const btn = document.getElementById('btn-save-profile');
    btn.disabled = true;
    btn.textContent = t('profile.saving');

    try {
        const result = await apiFetch('/api/me/profile', {
            method: 'PATCH',
            body: JSON.stringify({ nickname }),
        });
        if (!result) return;

        if (result.ok) {
            currentUser.nickname = result.data.nickname;
            localStorage.setItem('nickname', result.data.nickname);
            setMsg('profile-msg', t('profile.nicknameUpdated'), 'success');
            setTimeout(() => setMsg('profile-msg', ''), 3000);
        } else {
            setMsg('profile-msg', result.data.detail || t('profile.saveFailed'), 'error');
        }
    } finally {
        btn.disabled = false;
        btn.textContent = t('profile.save');
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
        setMsg('chess-msg', t('profile.chessUsernameRequired'), 'error');
        return;
    }

    const btn = document.getElementById('btn-save-chess');
    btn.disabled = true;
    btn.textContent = t('profile.fetching');

    try {
        // 1. 아이디 저장
        const patch = await apiFetch('/api/me/chess', {
            method: 'PATCH',
            body: JSON.stringify({ chess_username: chessUsername }),
        });
        if (!patch) return;
        if (!patch.ok) {
            setMsg('chess-msg', patch.data.detail || t('profile.saveFailed'), 'error');
            return;
        }

        currentUser.chess_username = chessUsername;
        setMsg('chess-msg', t('profile.chessSavedFetching'), 'success');

        // 2. 즉시 레이팅 조회
        const refresh = await apiFetch('/api/me/chess/refresh', { method: 'POST' });
        if (!refresh) return;

        if (refresh.ok) {
            currentUser.rating_rapid = refresh.data.rating_rapid;
            currentUser.rating_updated_at = refresh.data.updated_at;
            renderRatings(currentUser);
            loadRatingTrend(currentRatingPeriod);
            setMsg('chess-msg', t('profile.ratingUpdated'), 'success');
            setTimeout(() => setMsg('chess-msg', ''), 3000);
        } else {
            setMsg('chess-msg', refresh.data.detail || t('profile.chessFetchFailed'), 'error');
        }
    } finally {
        btn.disabled = false;
        btn.textContent = t('profile.saveAndFetch');
    }
});

// ===== 레이팅 새로고침 =====

document.getElementById('btn-refresh-chess').addEventListener('click', async () => {
    setMsg('chess-msg', '');

    if (!currentUser?.chess_username) {
        setMsg('chess-msg', t('profile.chessUsernameRequiredFirst'), 'error');
        return;
    }

    const btn = document.getElementById('btn-refresh-chess');
    btn.disabled = true;
    btn.textContent = t('profile.fetching');

    try {
        const result = await apiFetch('/api/me/chess/refresh', { method: 'POST' });
        if (!result) return;

        if (result.ok) {
            currentUser.rating_rapid = result.data.rating_rapid;
            currentUser.rating_updated_at = result.data.updated_at;
            renderRatings(currentUser);
            setMsg('chess-msg', t('profile.ratingUpdated'), 'success');
            setTimeout(() => setMsg('chess-msg', ''), 3000);
        } else {
            setMsg('chess-msg', result.data.detail || t('profile.ratingFetchFailed'), 'error');
        }
    } finally {
        btn.disabled = false;
        btn.textContent = t('profile.refreshRating');
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
        setMsg('password-msg', t('profile.allFieldsRequired'), 'error');
        return;
    }
    if (newPw !== confirmPw) {
        setMsg('password-msg', t('profile.passwordMismatch'), 'error');
        return;
    }
    if (newPw.length < 4) {
        setMsg('password-msg', t('auth.passwordLengthError'), 'error');
        return;
    }

    const btn = document.getElementById('btn-change-password');
    btn.disabled = true;
    btn.textContent = t('profile.changing');

    try {
        const result = await apiFetch('/api/me/password', {
            method: 'PATCH',
            body: JSON.stringify({ current_password: currentPw, new_password: newPw }),
        });
        if (!result) return;

        if (result.ok) {
            setMsg('password-msg', t('profile.passwordChanged'), 'success');
            document.getElementById('input-current-pw').value = '';
            document.getElementById('input-new-pw').value = '';
            document.getElementById('input-confirm-pw').value = '';
        } else {
            setMsg('password-msg', result.data.detail || t('profile.passwordChangeFailed'), 'error');
        }
    } finally {
        btn.disabled = false;
        btn.textContent = t('profile.changePassword');
    }
});

// ===== 실행 =====

loadUser().then(() => loadRatingTrend(currentRatingPeriod));
loadStats();
