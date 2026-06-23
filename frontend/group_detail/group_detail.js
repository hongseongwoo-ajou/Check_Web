const API_BASE = 'http://localhost:8000';

// ===== 인증 가드 =====

const token = localStorage.getItem('token');
if (!token) window.location.href = '../login/login.html';

const params  = new URLSearchParams(window.location.search);
const groupId = params.get('group_id');
if (!groupId) window.location.href = '../lobby/lobby.html';

// ===== 상태 =====

let currentMembers = [];
let currentRole    = '회원';
let pendingMatchId = null;
let pendingP1Id    = null;
let pendingP2Id    = null;

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

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatDate(dateStr) {
    if (!dateStr) return '-';
    try {
        const d = new Date(dateStr.replace(' ', 'T') + (dateStr.includes('T') ? '' : 'Z'));
        return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
    } catch {
        return dateStr.slice(0, 10);
    }
}

const isAdmin = () => currentRole === '방장' || currentRole === '임원';

// ===== 멤버 목록 렌더링 =====

function renderMembers(members) {
    const listEl = document.getElementById('member-list');
    listEl.innerHTML = '';

    if (!members.length) {
        listEl.innerHTML = '<li class="loading-msg">멤버가 없습니다.</li>';
        return;
    }

    let displayRank = 0;
    let prevRating  = null;

    members.forEach((m, i) => {
        const hasRating = m.rating_blitz != null;
        if (hasRating && m.rating_blitz !== prevRating) {
            displayRank = i + 1;
            prevRating  = m.rating_blitz;
        }

        const rankClass = displayRank === 1 ? 'rank-1'
                        : displayRank === 2 ? 'rank-2'
                        : displayRank === 3 ? 'rank-3' : '';

        const roleBadge = m.role === '방장' ? '<span class="role-badge admin">방장</span>'
                        : m.role === '임원' ? '<span class="role-badge officer">임원</span>'
                        : '';

        const li = document.createElement('li');
        li.className = `member-item${rankClass ? ' ' + rankClass : ''}${!hasRating ? ' unlinked' : ''}`;
        li.innerHTML = `
            <span class="member-rank">${hasRating ? displayRank : '-'}</span>
            <span class="member-name">${escapeHtml(m.nickname)}${roleBadge}</span>
            <span class="member-rating">${hasRating ? `(${m.rating_blitz})` : '(미연동)'}</span>
        `;
        listEl.appendChild(li);
    });
}

// ===== 순위표 모달 =====

document.getElementById('btn-leaderboard').addEventListener('click', async () => {
    document.getElementById('lb-settings-panel').classList.add('hidden');
    document.getElementById('btn-settings-toggle').classList.remove('active', 'hidden');
    document.getElementById('btn-settings-toggle').classList.add('hidden');
    document.getElementById('modal-leaderboard').classList.remove('hidden');
    await loadLeaderboard();
});

document.getElementById('btn-settings-toggle').addEventListener('click', () => {
    const panel = document.getElementById('lb-settings-panel');
    const btn   = document.getElementById('btn-settings-toggle');
    const isOpen = !panel.classList.contains('hidden');
    panel.classList.toggle('hidden', isOpen);
    btn.classList.toggle('active', !isOpen);
});

document.getElementById('btn-save-pts').addEventListener('click', async () => {
    const ptsWin  = parseInt(document.getElementById('input-pts-win').value);
    const ptsDraw = parseInt(document.getElementById('input-pts-draw').value);
    const ptsLoss = parseInt(document.getElementById('input-pts-loss').value);
    const msgEl   = document.getElementById('settings-msg');
    msgEl.className  = 'settings-msg';
    msgEl.textContent = '';

    if ([ptsWin, ptsDraw, ptsLoss].some(v => isNaN(v) || v < 0 || v > 99)) {
        msgEl.className  = 'settings-msg error';
        msgEl.textContent = '0~99 사이 숫자를 입력해주세요.';
        return;
    }

    const btn = document.getElementById('btn-save-pts');
    btn.disabled = true;
    btn.textContent = '저장 중...';

    try {
        const result = await apiFetch(`/api/groups/${groupId}/settings`, {
            method: 'PUT',
            body: JSON.stringify({ pts_win: ptsWin, pts_draw: ptsDraw, pts_loss: ptsLoss }),
        });
        if (result?.ok) {
            msgEl.textContent = '저장되었습니다.';
            setTimeout(() => { msgEl.textContent = ''; }, 2000);
            await loadLeaderboard();
        } else {
            msgEl.className   = 'settings-msg error';
            msgEl.textContent = result?.data?.detail || '저장에 실패했습니다.';
        }
    } finally {
        btn.disabled    = false;
        btn.textContent = '저장';
    }
});

async function loadLeaderboard() {
    document.getElementById('lb-content').innerHTML = '<p class="loading-msg" style="text-align:center">불러오는 중...</p>';

    const result = await apiFetch(`/api/groups/${groupId}/leaderboard`);
    if (!result?.ok) {
        document.getElementById('lb-content').innerHTML =
            `<p class="empty-msg-sm" style="color:#e07070">
                순위표를 불러오지 못했습니다.<br>
                <span style="font-size:0.78rem">${escapeHtml(result?.data?.detail || '서버 오류')}</span>
             </p>`;
        return;
    }

    const { settings, standings, current_role: role } = result.data;

    const settingsToggle = document.getElementById('btn-settings-toggle');
    if (role === '방장' || role === '임원') {
        settingsToggle.classList.remove('hidden');
        document.getElementById('input-pts-win').value  = settings.pts_win;
        document.getElementById('input-pts-draw').value = settings.pts_draw;
        document.getElementById('input-pts-loss').value = settings.pts_loss;
    } else {
        settingsToggle.classList.add('hidden');
    }

    renderLeaderboard(standings, settings);
}

function renderLeaderboard(standings, settings) {
    document.getElementById('pts-rule-label').textContent =
        `승 ${settings.pts_win}점 · 무 ${settings.pts_draw}점 · 패 ${settings.pts_loss}점`;

    const el = document.getElementById('lb-content');

    if (!standings.length) {
        el.innerHTML = '<p class="empty-msg-sm">아직 경기 기록이 없습니다.</p>';
        return;
    }

    let prevPoints  = null;
    let displayRank = 0;

    const rows = standings.map((s, i) => {
        if (s.points !== prevPoints) {
            displayRank = i + 1;
            prevPoints  = s.points;
        }
        const rankClass = displayRank <= 3 ? `rank-${displayRank}` : '';
        const ratingStr = s.rating_blitz
            ? `<span class="lb-rating">(${s.rating_blitz})</span>`
            : '';
        return `
            <tr class="${rankClass}">
                <td class="lb-rank">${displayRank}</td>
                <td class="lb-name">${escapeHtml(s.nickname)}${ratingStr}</td>
                <td class="lb-stat">${s.played}</td>
                <td class="lb-stat lb-win">${s.wins}</td>
                <td class="lb-stat lb-draw">${s.draws}</td>
                <td class="lb-stat lb-loss">${s.losses}</td>
                <td class="lb-pts">${s.points}</td>
            </tr>`;
    }).join('');

    el.innerHTML = `
        <table class="lb-table">
            <thead>
                <tr>
                    <th class="lb-rank">#</th>
                    <th>선수</th>
                    <th class="lb-stat">경기</th>
                    <th class="lb-stat">승</th>
                    <th class="lb-stat">무</th>
                    <th class="lb-stat">패</th>
                    <th class="lb-pts">승점</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>`;
}

// ===== 투표 생성 모달 =====

document.getElementById('btn-confirm-create-poll').addEventListener('click', async () => {
    const title   = document.getElementById('input-poll-title').value.trim();
    const errorEl = document.getElementById('create-poll-error');
    errorEl.textContent = '';

    const btn = document.getElementById('btn-confirm-create-poll');
    btn.disabled = true;
    btn.textContent = '생성 중...';

    try {
        const result = await apiFetch(`/api/groups/${groupId}/polls`, {
            method: 'POST',
            body: JSON.stringify({ title }),
        });
        if (result?.ok) {
            document.getElementById('modal-create-poll').classList.add('hidden');
            await refreshPage();
        } else {
            errorEl.textContent = result?.data?.detail || '투표 생성에 실패했습니다.';
        }
    } finally {
        btn.disabled = false;
        btn.textContent = '생성';
    }
});

document.getElementById('input-poll-title').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-confirm-create-poll').click();
});

// ===== 투표 섹션 렌더링 =====

function renderPollSection(pollData) {
    const section = document.getElementById('poll-section');
    const { poll, votes, my_vote, matches } = pollData;

    if (!poll) {
        renderNoPoll(section);
    } else if (poll.status === 'voting') {
        renderVoting(section, poll, votes, my_vote);
    } else if (poll.status === 'playing') {
        renderPlaying(section, poll, matches);
    }
}

function renderNoPoll(section) {
    section.innerHTML = `
        <div class="card-head-row">
            <h2 class="card-heading">매치 관리</h2>
            ${isAdmin() ? '<button id="btn-create-poll" class="btn-create-poll">+ 매치 투표 생성</button>' : ''}
        </div>
        <p class="empty-msg-sm">현재 진행 중인 투표나 매치가 없습니다.</p>
    `;
    if (isAdmin()) {
        document.getElementById('btn-create-poll').addEventListener('click', () => {
            document.getElementById('input-poll-title').value = '';
            document.getElementById('create-poll-error').textContent = '';
            document.getElementById('modal-create-poll').classList.remove('hidden');
            setTimeout(() => document.getElementById('input-poll-title').focus(), 50);
        });
    }
}

function renderVoting(section, poll, votes, myVote) {
    const titleHtml = poll.title
        ? `<span class="poll-title-label">${escapeHtml(poll.title)}</span>`
        : '';

    const voterRows = votes.length
        ? votes.map((v, i) => `
            <div class="voter-item">
                <span class="voter-num">${i + 1}</span>
                <span class="voter-name">${escapeHtml(v.nickname)}</span>
            </div>`).join('')
        : '<p class="empty-msg-sm">아직 참여자가 없습니다.</p>';

    const adminBtns = isAdmin() ? `
        <button id="btn-close-poll" class="btn-close-poll">투표 종료 (${votes.length}명)</button>
        <button id="btn-delete-poll" class="btn-delete-poll">삭제</button>
    ` : '';

    section.innerHTML = `
        <div class="card-head-row">
            <div class="head-left">
                <h2 class="card-heading">참여 투표</h2>
                <span class="status-badge voting">투표 중</span>
            </div>
            <div class="head-buttons">
                <button id="btn-vote-toggle" class="btn-vote${myVote ? ' voted' : ''}">
                    ${myVote ? '참여 취소' : '참여'}
                </button>
                ${adminBtns}
            </div>
        </div>
        ${titleHtml ? `<p style="font-size:0.9rem;color:var(--color-text);margin-bottom:0.5rem">${titleHtml}</p>` : ''}
        <p class="vote-summary">참여자 <strong>${votes.length}</strong>명</p>
        <div class="voter-list">${voterRows}</div>
    `;

    document.getElementById('btn-vote-toggle').addEventListener('click', () => toggleVote(poll.id, myVote));
    if (isAdmin()) {
        document.getElementById('btn-close-poll').addEventListener('click', () => closePoll(poll.id, votes.length));
        document.getElementById('btn-delete-poll').addEventListener('click', () => deletePoll(poll.id));
    }
}

function renderPlaying(section, poll, matches) {
    const cards = matches.map(m => {
        if (m.status === 'finished') {
            const isDraw = !m.winner_id;
            const p1Win  = m.winner_id === m.player1_id;
            const p2Win  = m.winner_id === m.player2_id;
            return `
                <div class="match-card finished">
                    <div class="match-vs">
                        <span class="match-player${p1Win ? ' winner' : ''}">${escapeHtml(m.player1_nickname)}</span>
                        <span class="vs-label">vs</span>
                        <span class="match-player${p2Win ? ' winner' : ''}">${escapeHtml(m.player2_nickname)}</span>
                    </div>
                    <span class="match-result-badge ${isDraw ? 'draw' : 'win'}">
                        ${isDraw ? '무승부' : `${escapeHtml(m.winner_nickname)} 승`}
                    </span>
                </div>`;
        }
        return `
            <div class="match-card">
                <div class="match-vs">
                    <span class="match-player">${escapeHtml(m.player1_nickname)}</span>
                    <span class="vs-label">vs</span>
                    <span class="match-player">${escapeHtml(m.player2_nickname)}</span>
                </div>
                ${isAdmin()
                    ? `<button class="btn-record-result"
                            data-match-id="${m.id}"
                            data-p1-id="${m.player1_id}" data-p1-name="${escapeHtml(m.player1_nickname)}"
                            data-p2-id="${m.player2_id}" data-p2-name="${escapeHtml(m.player2_nickname)}">
                            경기 종료
                       </button>`
                    : ''}
            </div>`;
    }).join('');

    const allDone = matches.every(m => m.status === 'finished');

    section.innerHTML = `
        <div class="card-head-row">
            <div class="head-left">
                <h2 class="card-heading">대진표</h2>
                <span class="status-badge playing">${allDone ? '완료' : '진행 중'}</span>
            </div>
        </div>
        <div class="match-list-area">${cards}</div>
    `;

    if (isAdmin()) {
        section.querySelectorAll('.btn-record-result').forEach(btn => {
            btn.addEventListener('click', () => openResultModal(
                parseInt(btn.dataset.matchId),
                parseInt(btn.dataset.p1Id), btn.dataset.p1Name,
                parseInt(btn.dataset.p2Id), btn.dataset.p2Name,
            ));
        });
    }
}

// ===== 지난 경기 결과 =====

function renderHistory(matches) {
    const el = document.getElementById('match-history');

    if (!matches.length) {
        el.innerHTML = '<p class="empty-msg-sm">아직 기록된 경기가 없습니다.</p>';
        return;
    }

    el.innerHTML = matches.map(m => {
        const isDraw = !m.winner_id;
        const p1Win  = m.winner_id === m.player1_id;
        const p2Win  = m.winner_id === m.player2_id;
        return `
            <div class="match-item">
                <span class="match-players">
                    <span class="${p1Win ? 'match-winner-name' : ''}">${escapeHtml(m.player1_nickname)}</span>
                    <span style="color:var(--color-text-muted);margin:0 0.4rem">vs</span>
                    <span class="${p2Win ? 'match-winner-name' : ''}">${escapeHtml(m.player2_nickname)}</span>
                </span>
                <span class="match-result ${isDraw ? 'draw' : ''}">${isDraw ? '무승부' : `${escapeHtml(m.winner_nickname)} 승`}</span>
                <span class="match-date">${formatDate(m.played_at)}</span>
            </div>`;
    }).join('');
}

// ===== API 액션 =====

async function deletePoll(pollId) {
    if (!confirm('투표를 삭제하시겠습니까? 참여 정보도 모두 사라집니다.')) return;
    const result = await apiFetch(`/api/polls/${pollId}`, { method: 'DELETE' });
    if (result?.ok) {
        await refreshPage();
    } else {
        alert(result?.data?.detail || '삭제에 실패했습니다.');
    }
}

async function toggleVote(pollId, isCurrentlyVoted) {
    const btn = document.getElementById('btn-vote-toggle');
    if (btn) btn.disabled = true;
    const result = await apiFetch(`/api/polls/${pollId}/vote`, { method: 'POST' });
    if (result?.ok) {
        await refreshPoll();
    } else {
        alert(result?.data?.detail || '오류가 발생했습니다.');
        if (btn) btn.disabled = false;
    }
}

async function closePoll(pollId, voteCount) {
    if (voteCount < 2) {
        alert('매치 생성에는 최소 2명의 참여자가 필요합니다.');
        return;
    }
    if (!confirm(`${voteCount}명의 참여자로 대진을 생성하고 투표를 종료하시겠습니까?`)) return;

    const btn = document.getElementById('btn-close-poll');
    if (btn) { btn.disabled = true; btn.textContent = '생성 중...'; }

    const result = await apiFetch(`/api/polls/${pollId}/close`, { method: 'POST' });
    if (result?.ok) {
        await refreshPage();
    } else {
        alert(result?.data?.detail || '오류가 발생했습니다.');
        if (btn) { btn.disabled = false; }
    }
}

// ===== 결과 기록 모달 =====

function openResultModal(matchId, p1Id, p1Name, p2Id, p2Name) {
    pendingMatchId = matchId;
    pendingP1Id    = p1Id;
    pendingP2Id    = p2Id;
    document.getElementById('result-match-label').textContent = `${p1Name} vs ${p2Name}`;
    document.getElementById('btn-p1-win').textContent = `${p1Name} 승`;
    document.getElementById('btn-p2-win').textContent = `${p2Name} 승`;
    document.getElementById('result-error').textContent = '';
    setResultBtnsDisabled(false);
    document.getElementById('modal-result').classList.remove('hidden');
}

function setResultBtnsDisabled(disabled) {
    ['btn-p1-win', 'btn-draw', 'btn-p2-win'].forEach(id => {
        document.getElementById(id).disabled = disabled;
    });
}

async function recordResult(winnerId) {
    setResultBtnsDisabled(true);
    const result = await apiFetch(`/api/matches/${pendingMatchId}/result`, {
        method: 'PATCH',
        body: JSON.stringify({ winner_id: winnerId }),
    });
    if (result?.ok) {
        document.getElementById('modal-result').classList.add('hidden');
        await refreshPage();
    } else {
        document.getElementById('result-error').textContent =
            result?.data?.detail || '오류가 발생했습니다.';
        setResultBtnsDisabled(false);
    }
}

document.getElementById('btn-p1-win').addEventListener('click', () => recordResult(pendingP1Id));
document.getElementById('btn-draw').addEventListener('click',   () => recordResult(null));
document.getElementById('btn-p2-win').addEventListener('click', () => recordResult(pendingP2Id));

// ===== 데이터 로드 =====

async function refreshPoll() {
    const result = await apiFetch(`/api/groups/${groupId}/polls/active`);
    if (result?.ok) renderPollSection(result.data);
}

async function refreshPage() {
    const [membersRes, pollRes, historyRes] = await Promise.all([
        apiFetch(`/api/groups/${groupId}/members`),
        apiFetch(`/api/groups/${groupId}/polls/active`),
        apiFetch(`/api/groups/${groupId}/matches`),
    ]);

    if (!membersRes?.ok) {
        if (membersRes?.status === 403 || membersRes?.status === 404) {
            window.location.href = '../lobby/lobby.html';
        }
        return;
    }

    const { group, members, stats, current_role } = membersRes.data;

    document.title     = `${group.name} - 체스 동아리`;
    document.getElementById('group-name').textContent  = group.name;
    document.getElementById('invite-code').textContent = group.invite_code;
    document.getElementById('member-count').textContent = `${stats.member_count}명`;

    currentMembers = members;
    currentRole    = current_role;

    renderMembers(members);

    if (pollRes?.ok)    renderPollSection(pollRes.data);
    if (historyRes?.ok) renderHistory(historyRes.data);
}

// ===== 모달 닫기 =====

document.querySelectorAll('.btn-cancel').forEach(btn => {
    btn.addEventListener('click', () => {
        const id = btn.dataset.modal;
        if (id) document.getElementById(id).classList.add('hidden');
    });
});

document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', () => {
        document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
    });
});

// ===== 초대 코드 복사 =====

document.getElementById('btn-copy').addEventListener('click', async () => {
    const code = document.getElementById('invite-code').textContent;
    try {
        await navigator.clipboard.writeText(code);
        const btn = document.getElementById('btn-copy');
        btn.textContent = '복사됨!';
        setTimeout(() => { btn.textContent = '복사'; }, 1500);
    } catch { /* 미지원 환경 무시 */ }
});

// ===== 로그아웃 =====

document.getElementById('btn-logout').addEventListener('click', () => {
    localStorage.clear();
    window.location.href = '../login/login.html';
});

// ===== 실행 =====

refreshPage();
