const API_BASE = (() => {
    const { protocol, hostname, port } = window.location;
    if (protocol === 'file:') return 'http://localhost:8000';
    if ((hostname === 'localhost' || hostname === '127.0.0.1') && port !== '8000') return 'http://localhost:8000';
    return '';
})();

// ===== 인증 가드 =====

const token = localStorage.getItem('token');
if (!token) window.location.href = '../login/login.html';

const params  = new URLSearchParams(window.location.search);
const groupId = params.get('group_id');
if (!groupId) window.location.href = '../lobby/lobby.html';

// ===== 상태 =====

let currentMembers   = [];
let currentRole      = '회원';
let cachedSettings   = { pts_win: 3, pts_draw: 2, pts_loss: 1, is_color_automatic: true };
let historyPage      = 1;
let openPollId       = null;
let pollMatchCache   = {};
let currentUserId    = null;
let pendingMatchId   = null;
let pendingP1Id      = null;
let pendingP2Id      = null;
let pendingPgnMatchId = null;

// 매치 PGN/선수 캐시 (matchId → {pgn_data, p1, p2})
const matchDataCache = {};

// ===== PGN 뷰어 상태 =====

let pgnPositions  = [];   // FEN strings: [0]=초기, [n]=n번째 수 후
let pgnSans       = [];   // SAN 수 목록
let pgnMoveIndex  = 0;
let pgnBoardInst  = null; // chessboard.js 인스턴스

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

// ===== PGN 유효성 검사 (chess.js) =====

function isValidPgn(pgn) {
    try {
        const chess = new Chess();
        return chess.load_pgn(pgn.trim());
    } catch {
        return false;
    }
}

// ===== 멤버 목록 렌더링 =====

function renderMembers(members) {
    const listEl  = document.getElementById('member-list');
    listEl.innerHTML = '';

    if (!members.length) {
        listEl.innerHTML = '<li class="loading-msg">멤버가 없습니다.</li>';
        return;
    }

    const isOwner = currentRole === '방장';

    members.forEach((m) => {
        const hasRating = m.rating_rapid != null;
        const isSelf    = m.id === currentUserId;

        const roleBadge = m.role === '방장' ? '<span class="role-badge admin">방장</span>'
                        : m.role === '임원' ? '<span class="role-badge officer">임원</span>'
                        : '';

        // 방장만: 역할 변경 버튼
        let roleBtn = '';
        if (isOwner && !isSelf && m.role !== '방장') {
            if (m.role === '임원') {
                roleBtn = `<button class="btn-role btn-demote" data-member-id="${m.id}" data-new-role="회원" title="임원 해임">해임</button>`;
            } else {
                roleBtn = `<button class="btn-role btn-promote" data-member-id="${m.id}" data-new-role="임원" title="임원 임명">임명</button>`;
            }
        }

        // 방장·임원: 강퇴 버튼 (임원은 회원만 강퇴 가능)
        const canKick = !isSelf && (
            (currentRole === '방장' && m.role !== '방장') ||
            (currentRole === '임원' && m.role === '회원')
        );
        const kickBtn = canKick
            ? `<button class="btn-kick" data-member-id="${m.id}" data-member-name="${escapeHtml(m.nickname)}" title="강퇴">강퇴</button>`
            : '';

        const li = document.createElement('li');
        li.className = `member-item${isSelf ? ' me' : ''}${!hasRating ? ' unlinked' : ''}`;
        li.innerHTML = `
            <span class="member-name">${escapeHtml(m.nickname)}${roleBadge}</span>
            <span class="member-rating">${hasRating ? `(${m.rating_rapid})` : '(미연동)'}</span>
            ${roleBtn}${kickBtn}
        `;
        listEl.appendChild(li);
    });

    if (isOwner) {
        listEl.querySelectorAll('.btn-role').forEach(btn => {
            btn.addEventListener('click', () =>
                changeMemberRole(parseInt(btn.dataset.memberId), btn.dataset.newRole)
            );
        });
    }

    listEl.querySelectorAll('.btn-kick').forEach(btn => {
        btn.addEventListener('click', () =>
            kickMember(parseInt(btn.dataset.memberId), btn.dataset.memberName)
        );
    });
}

async function changeMemberRole(memberId, newRole) {
    const member      = currentMembers.find(m => m.id === memberId);
    const memberName  = member ? escapeHtml(member.nickname) : '해당 멤버';
    const actionLabel = newRole === '임원' ? '임원으로 임명' : '임원에서 해임';

    if (!confirm(`${member?.nickname ?? '해당 멤버'}님을 ${actionLabel}하시겠습니까?`)) return;

    const result = await apiFetch(`/api/groups/${groupId}/members/${memberId}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role: newRole }),
    });

    if (result?.ok) {
        await refreshPage();
    } else {
        alert(result?.data?.detail || '역할 변경에 실패했습니다.');
    }
}

async function kickMember(memberId, memberName) {
    if (!confirm(`${memberName}님을 그룹에서 강퇴하시겠습니까?`)) return;

    const result = await apiFetch(`/api/groups/${groupId}/members/${memberId}`, {
        method: 'DELETE',
    });

    if (result?.ok) {
        await refreshPage();
    } else {
        alert(result?.data?.detail || '강퇴에 실패했습니다.');
    }
}

// ===== 공지사항 =====

let allAnnouncements = [];

async function loadLatestAnnouncement() {
    const result = await apiFetch(`/api/groups/${groupId}/announcements/latest`);
    renderLatestAnnouncement(result?.ok ? result.data : null);
}

function renderLatestAnnouncement(ann) {
    const el = document.getElementById('announcement-latest');

    if (!ann) {
        el.innerHTML = `
            <div class="announcement-row">
                <h3 class="announcement-title announcement-empty">등록된 공지사항이 없습니다.</h3>
                <button id="btn-view-all-announcements" class="btn-view-all-announcements">전체보기</button>
            </div>`;
    } else {
        el.innerHTML = `
            <div class="announcement-row">
                <h3 class="announcement-title">${escapeHtml(ann.title)}</h3>
                <button id="btn-view-all-announcements" class="btn-view-all-announcements">전체보기</button>
            </div>
            <p class="announcement-content">${escapeHtml(ann.content)}</p>`;
    }

    document.getElementById('btn-view-all-announcements').addEventListener('click', openAnnouncementListModal);
}

document.getElementById('btn-write-announcement').addEventListener('click', () => {
    document.getElementById('input-announcement-title').value = '';
    document.getElementById('input-announcement-content').value = '';
    document.getElementById('create-announcement-error').textContent = '';
    document.getElementById('modal-create-announcement').classList.remove('hidden');
    setTimeout(() => document.getElementById('input-announcement-title').focus(), 50);
});

document.getElementById('btn-confirm-create-announcement').addEventListener('click', async () => {
    const title   = document.getElementById('input-announcement-title').value.trim();
    const content = document.getElementById('input-announcement-content').value.trim();
    const errorEl = document.getElementById('create-announcement-error');
    errorEl.textContent = '';

    if (!title) {
        errorEl.textContent = '제목을 입력해주세요.';
        return;
    }
    if (!content) {
        errorEl.textContent = '내용을 입력해주세요.';
        return;
    }

    const btn = document.getElementById('btn-confirm-create-announcement');
    btn.disabled = true;
    btn.textContent = '등록 중...';

    try {
        const result = await apiFetch(`/api/groups/${groupId}/announcements`, {
            method: 'POST',
            body: JSON.stringify({ title, content }),
        });
        if (result?.ok) {
            document.getElementById('modal-create-announcement').classList.add('hidden');
            await loadLatestAnnouncement();
        } else {
            errorEl.textContent = result?.data?.detail || '등록에 실패했습니다.';
        }
    } finally {
        btn.disabled = false;
        btn.textContent = '등록';
    }
});

async function openAnnouncementListModal() {
    document.getElementById('modal-announcement-list').classList.remove('hidden');
    const el = document.getElementById('announcement-list-content');
    el.innerHTML = '<p class="loading-msg" style="text-align:center">불러오는 중...</p>';

    const result = await apiFetch(`/api/groups/${groupId}/announcements`);
    if (!result?.ok) {
        el.innerHTML = `
            <p class="empty-msg-sm" style="color:#e07070">
                공지사항을 불러오지 못했습니다.<br>
                <span style="font-size:0.78rem">${escapeHtml(result?.data?.detail || '서버 오류')}</span>
             </p>`;
        return;
    }

    allAnnouncements = result.data;
    renderAnnouncementList();
}

function renderAnnouncementList() {
    const el = document.getElementById('announcement-list-content');

    if (!allAnnouncements.length) {
        el.innerHTML = '<p class="empty-msg-sm">등록된 공지사항이 없습니다.</p>';
        return;
    }

    el.innerHTML = allAnnouncements.map(a => `
        <div class="announcement-item">
            <div class="announcement-item-head">
                <h4 class="announcement-item-title">${escapeHtml(a.title)}</h4>
                <span class="announcement-item-date">${formatDate(a.created_at)}</span>
                ${isAdmin() ? `<button class="btn-delete-announcement" data-id="${a.id}">삭제</button>` : ''}
            </div>
            <p class="announcement-item-content">${escapeHtml(a.content)}</p>
            <p class="announcement-item-author">작성자: ${escapeHtml(a.author_nickname)}</p>
        </div>
    `).join('');

    el.querySelectorAll('.btn-delete-announcement').forEach(btn => {
        btn.addEventListener('click', () => deleteAnnouncement(parseInt(btn.dataset.id)));
    });
}

async function deleteAnnouncement(announcementId) {
    if (!confirm('이 공지사항을 삭제하시겠습니까?')) return;

    const result = await apiFetch(`/api/announcements/${announcementId}`, { method: 'DELETE' });
    if (result?.ok) {
        allAnnouncements = allAnnouncements.filter(a => a.id !== announcementId);
        renderAnnouncementList();
        await loadLatestAnnouncement();
    } else {
        alert(result?.data?.detail || '삭제에 실패했습니다.');
    }
}

// ===== 그룹 설정 모달 =====

document.getElementById('btn-group-settings').addEventListener('click', openGroupSettings);

async function openGroupSettings() {
    const result = await apiFetch(`/api/groups/${groupId}/settings`);
    if (result?.ok) {
        cachedSettings = { ...cachedSettings, ...result.data };
        document.getElementById('gs-input-color-auto').checked = cachedSettings.is_color_automatic !== false;
    }
    document.getElementById('gs-danger-zone').classList.toggle('hidden', currentRole !== '방장');
    document.getElementById('gs-msg').textContent = '';
    document.getElementById('modal-group-settings').classList.remove('hidden');
}

document.getElementById('gs-input-color-auto').addEventListener('change', async (e) => {
    const isColorAuto = e.target.checked;
    const msgEl = document.getElementById('gs-msg');
    e.target.disabled = true;
    msgEl.className  = 'settings-msg';
    msgEl.textContent = '';

    const result = await apiFetch(`/api/groups/${groupId}/settings`, {
        method: 'PUT',
        body: JSON.stringify({
            pts_win:            cachedSettings.pts_win,
            pts_draw:           cachedSettings.pts_draw,
            pts_loss:           cachedSettings.pts_loss,
            is_color_automatic: isColorAuto,
        }),
    });

    e.target.disabled = false;
    if (result?.ok) {
        cachedSettings.is_color_automatic = isColorAuto;
        msgEl.textContent = '저장됨';
        setTimeout(() => { msgEl.textContent = ''; }, 1500);
    } else {
        e.target.checked = !isColorAuto;  // 실패 시 원상복구
        msgEl.className  = 'settings-msg error';
        msgEl.textContent = result?.data?.detail || '저장에 실패했습니다.';
    }
});

async function deleteGroup() {
    const errorEl = document.getElementById('delete-group-error');
    const btn     = document.getElementById('btn-confirm-delete-group');
    errorEl.textContent = '';
    btn.disabled = true;
    btn.textContent = '삭제 중...';

    try {
        const result = await apiFetch(`/api/groups/${groupId}`, { method: 'DELETE' });
        if (result?.ok) {
            window.location.href = '../lobby/lobby.html';
        } else {
            errorEl.textContent = result?.data?.detail || '삭제에 실패했습니다.';
        }
    } finally {
        btn.disabled = false;
        btn.textContent = '삭제 확인';
    }
}

document.getElementById('btn-open-delete-group').addEventListener('click', () => {
    document.getElementById('delete-group-error').textContent = '';
    document.getElementById('modal-delete-group').classList.remove('hidden');
});

document.getElementById('btn-confirm-delete-group').addEventListener('click', deleteGroup);

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
            body: JSON.stringify({ pts_win: ptsWin, pts_draw: ptsDraw, pts_loss: ptsLoss, is_color_automatic: cachedSettings.is_color_automatic }),
        });
        if (result?.ok) {
            cachedSettings = { ...cachedSettings, pts_win: ptsWin, pts_draw: ptsDraw, pts_loss: ptsLoss };
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
        cachedSettings = { ...cachedSettings, ...settings };
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
        const ratingStr = s.rating_rapid
            ? `<span class="lb-rating">(${s.rating_rapid})</span>`
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

// ===== 투표 섹션 렌더링 (다중 투표) =====

function renderPollSection(pollDataArray) {
    const section = document.getElementById('poll-section');

    const headHtml = `
        <div class="poll-section-head card-head-row">
            <h2 class="card-heading">매치 관리</h2>
            ${isAdmin() ? '<button class="btn-create-poll">+ 매치 투표 생성</button>' : ''}
        </div>`;

    const cardsHtml = pollDataArray.length
        ? pollDataArray.map(({ poll, votes, my_vote, matches }) =>
            poll.status === 'voting'  ? buildVotingCard(poll, votes, my_vote) :
            poll.status === 'playing' ? buildPlayingCard(poll, matches) : ''
          ).join('')
        : '<p class="empty-msg-sm">현재 진행 중인 투표나 매치가 없습니다.</p>';

    section.innerHTML = headHtml + cardsHtml;

    // 투표 생성 모달
    section.querySelector('.btn-create-poll')?.addEventListener('click', () => {
        document.getElementById('input-poll-title').value = '';
        document.getElementById('create-poll-error').textContent = '';
        document.getElementById('modal-create-poll').classList.remove('hidden');
        setTimeout(() => document.getElementById('input-poll-title').focus(), 50);
    });

    // 참여/취소 (투표별)
    section.querySelectorAll('.btn-vote-toggle').forEach(btn => {
        btn.addEventListener('click', () => toggleVote(parseInt(btn.dataset.pollId)));
    });

    // 관리자: 투표 종료 / 삭제
    section.querySelectorAll('.btn-close-poll').forEach(btn => {
        btn.addEventListener('click', () =>
            closePoll(parseInt(btn.dataset.pollId), parseInt(btn.dataset.voteCount))
        );
    });
    section.querySelectorAll('.btn-delete-poll').forEach(btn => {
        btn.addEventListener('click', () => deletePoll(parseInt(btn.dataset.pollId)));
    });

    // 경기 결과 기록 / 수정
    section.querySelectorAll('.btn-record-result, .btn-modify-result').forEach(btn => {
        btn.addEventListener('click', () => openResultModal(
            parseInt(btn.dataset.matchId),
            parseInt(btn.dataset.p1Id), btn.dataset.p1Name,
            parseInt(btn.dataset.p2Id), btn.dataset.p2Name,
        ));
    });

    // PGN
    section.querySelectorAll('.btn-pgn-edit').forEach(btn => {
        const mid = parseInt(btn.dataset.matchId);
        btn.addEventListener('click', () => openPgnModal(mid, matchDataCache[mid]?.pgn_data || ''));
    });
    section.querySelectorAll('.btn-pgn-view').forEach(btn => {
        const mid = parseInt(btn.dataset.matchId);
        btn.addEventListener('click', () => {
            const d = matchDataCache[mid];
            if (d?.pgn_data) openPgnViewer(d.pgn_data, d.p1, d.p2);
        });
    });
}

function buildVotingCard(poll, votes, myVote) {
    const titleStr  = poll.title ? escapeHtml(poll.title) : '참여 투표';
    const voterRows = votes.length
        ? votes.map((v, i) => `
            <div class="voter-item">
                <span class="voter-num">${i + 1}</span>
                <span class="voter-name">${escapeHtml(v.nickname)}</span>
            </div>`).join('')
        : '<p class="empty-msg-sm">아직 참여자가 없습니다.</p>';
    const adminBtns = isAdmin() ? `
        <button class="btn-close-poll" data-poll-id="${poll.id}" data-vote-count="${votes.length}">
            종료 (${votes.length}명)
        </button>
        <button class="btn-delete-poll" data-poll-id="${poll.id}">삭제</button>` : '';

    return `
        <div class="poll-card">
            <div class="card-head-row">
                <div class="head-left">
                    <h3 class="poll-card-title">${titleStr}</h3>
                    <span class="status-badge voting">투표 중</span>
                </div>
                <div class="head-buttons">
                    <button class="btn-vote${myVote ? ' voted' : ''} btn-vote-toggle" data-poll-id="${poll.id}">
                        ${myVote ? '참여 취소' : '참여'}
                    </button>
                    ${adminBtns}
                </div>
            </div>
            <p class="vote-summary">참여자 <strong>${votes.length}</strong>명</p>
            <div class="voter-list">${voterRows}</div>
        </div>`;
}

function buildPlayingCard(poll, matches) {
    matches.forEach(m => {
        matchDataCache[m.id] = { pgn_data: m.pgn_data || null, p1: m.player1_nickname, p2: m.player2_nickname };
    });

    const cards = matches.map(m => {
        if (m.status === 'finished') {
            const isDraw  = !m.winner_id;
            const p1Win   = m.winner_id === m.player1_id;
            const p2Win   = m.winner_id === m.player2_id;
            const hasPgn  = !!m.pgn_data;
            const canEdit = currentUserId === m.player1_id || currentUserId === m.player2_id || isAdmin();
            return `
                <div class="match-card finished">
                    <div class="match-vs">
                        <span class="match-player${p1Win ? ' winner' : ''}"><span class="color-chip white">백</span>${escapeHtml(m.player1_nickname)}</span>
                        <span class="vs-label">vs</span>
                        <span class="match-player${p2Win ? ' winner' : ''}"><span class="color-chip black">흑</span>${escapeHtml(m.player2_nickname)}</span>
                    </div>
                    <span class="match-result-badge ${isDraw ? 'draw' : 'win'}">
                        ${isDraw ? '무승부' : `${escapeHtml(m.winner_nickname)} 승`}
                    </span>
                    ${isAdmin() ? `<button class="btn-modify-result"
                        data-match-id="${m.id}"
                        data-p1-id="${m.player1_id}" data-p1-name="${escapeHtml(m.player1_nickname)}"
                        data-p2-id="${m.player2_id}" data-p2-name="${escapeHtml(m.player2_nickname)}">결과 수정</button>` : ''}
                    <div class="match-pgn-actions">
                        ${canEdit ? `<button class="btn-pgn-edit" data-match-id="${m.id}">${hasPgn ? '기보 수정' : '기보 추가'}</button>` : ''}
                        ${hasPgn ? `<button class="btn-pgn-view" data-match-id="${m.id}">기보 보기</button>` : ''}
                    </div>
                </div>`;
        }
        return `
            <div class="match-card">
                <div class="match-vs">
                    <span class="match-player"><span class="color-chip white">백</span>${escapeHtml(m.player1_nickname)}</span>
                    <span class="vs-label">vs</span>
                    <span class="match-player"><span class="color-chip black">흑</span>${escapeHtml(m.player2_nickname)}</span>
                </div>
                ${isAdmin() ? `<button class="btn-record-result"
                        data-match-id="${m.id}"
                        data-p1-id="${m.player1_id}" data-p1-name="${escapeHtml(m.player1_nickname)}"
                        data-p2-id="${m.player2_id}" data-p2-name="${escapeHtml(m.player2_nickname)}">경기 종료</button>` : ''}
            </div>`;
    }).join('');

    const allDone  = matches.every(m => m.status === 'finished');
    const titleStr = poll.title ? escapeHtml(poll.title) : '대진표';
    return `
        <div class="poll-card">
            <div class="card-head-row">
                <div class="head-left">
                    <h3 class="poll-card-title">${titleStr}</h3>
                    <span class="status-badge playing">${allDone ? '완료' : '진행 중'}</span>
                </div>
            </div>
            <div class="match-list-area">${cards}</div>
        </div>`;
}

// ===== 지난 경기 결과 (아코디언 + 페이징) =====

async function loadHistory(page = 1) {
    historyPage = page;
    const el = document.getElementById('match-history');
    el.innerHTML = '<p class="loading-msg">불러오는 중...</p>';

    const result = await apiFetch(`/api/groups/${groupId}/history?page=${page}`);
    if (!result?.ok) {
        el.innerHTML = '<p class="empty-msg-sm">불러오지 못했습니다.</p>';
        return;
    }
    renderHistoryAccordion(result.data);
}

function renderHistoryAccordion({ polls, page, pages }) {
    const el = document.getElementById('match-history');

    if (!polls.length) {
        el.innerHTML = '<p class="empty-msg-sm">아직 완료된 대전이 없습니다.</p>';
        return;
    }

    const paginationHtml = pages > 1 ? buildHistoryPagination(page, pages) : '';

    const accordionHtml = polls.map(p => {
        const title   = p.title || '(이름 없음)';
        const dateStr = formatDate(p.created_at);
        return `
            <div class="history-accordion">
                <button class="accordion-header" data-poll-id="${p.id}">
                    <span class="accordion-icon">►</span>
                    <span class="accordion-title">${escapeHtml(title)}</span>
                    <span class="accordion-meta">${p.match_count}경기 · ${dateStr}</span>
                </button>
                <div class="accordion-body hidden" id="accordion-body-${p.id}"></div>
            </div>`;
    }).join('');

    el.innerHTML = paginationHtml + accordionHtml;

    el.querySelectorAll('.accordion-header').forEach(btn => {
        btn.addEventListener('click', () => toggleAccordion(parseInt(btn.dataset.pollId)));
    });

    el.querySelectorAll('.page-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            openPollId = null;
            loadHistory(parseInt(btn.dataset.page));
        });
    });
}

function buildHistoryPagination(current, total) {
    const btns = [];
    for (let i = 1; i <= total; i++) {
        btns.push(`<button class="page-btn${i === current ? ' active' : ''}" data-page="${i}">${i}</button>`);
    }
    return `<div class="history-pagination">${btns.join('')}</div>`;
}

async function toggleAccordion(pollId) {
    const body = document.getElementById(`accordion-body-${pollId}`);
    const icon = document.querySelector(`.accordion-header[data-poll-id="${pollId}"] .accordion-icon`);
    if (!body) return;

    const isOpen = !body.classList.contains('hidden');

    // 다른 아코디언 닫기
    if (openPollId && openPollId !== pollId) {
        const prevBody = document.getElementById(`accordion-body-${openPollId}`);
        const prevIcon = document.querySelector(`.accordion-header[data-poll-id="${openPollId}"] .accordion-icon`);
        if (prevBody) prevBody.classList.add('hidden');
        if (prevIcon) prevIcon.textContent = '►';
    }

    if (isOpen) {
        body.classList.add('hidden');
        icon.textContent = '►';
        openPollId = null;
    } else {
        body.classList.remove('hidden');
        icon.textContent = '▼';
        openPollId = pollId;
        if (!pollMatchCache[pollId]) {
            await fetchPollMatches(pollId);
        } else {
            renderPollMatches(pollId);
        }
    }
}

async function fetchPollMatches(pollId) {
    const body = document.getElementById(`accordion-body-${pollId}`);
    if (!body) return;
    body.innerHTML = '<p class="accordion-loading">불러오는 중...</p>';

    const result = await apiFetch(`/api/polls/${pollId}/matches`);
    if (!result?.ok) {
        body.innerHTML = '<p class="empty-msg-sm">불러오지 못했습니다.</p>';
        return;
    }

    pollMatchCache[pollId] = result.data;
    result.data.forEach(m => {
        matchDataCache[m.id] = { pgn_data: m.pgn_data || null, p1: m.player1_nickname, p2: m.player2_nickname };
    });
    renderPollMatches(pollId);
}

function renderPollMatches(pollId) {
    const body    = document.getElementById(`accordion-body-${pollId}`);
    const matches = pollMatchCache[pollId];

    if (!matches?.length) {
        body.innerHTML = '<p class="empty-msg-sm">경기 기록이 없습니다.</p>';
        return;
    }

    body.innerHTML = matches.map(m => {
        const isDraw  = !m.winner_id;
        const p1Win   = m.winner_id === m.player1_id;
        const p2Win   = m.winner_id === m.player2_id;
        const hasPgn  = !!m.pgn_data;
        const canEdit = currentUserId === m.player1_id || currentUserId === m.player2_id || isAdmin();

        return `
            <div class="accordion-match-item">
                <span class="match-players">
                    <span class="${p1Win ? 'match-winner-name' : ''}"><span class="color-chip white">백</span>${escapeHtml(m.player1_nickname)}</span>
                    <span class="match-vs-sm">vs</span>
                    <span class="${p2Win ? 'match-winner-name' : ''}"><span class="color-chip black">흑</span>${escapeHtml(m.player2_nickname)}</span>
                </span>
                <span class="match-result ${isDraw ? 'draw' : ''}">${isDraw ? '무승부' : `${escapeHtml(m.winner_nickname)} 승`}</span>
                ${isAdmin() ? `<button class="btn-modify-result acc-modify"
                    data-match-id="${m.id}"
                    data-p1-id="${m.player1_id}" data-p1-name="${escapeHtml(m.player1_nickname)}"
                    data-p2-id="${m.player2_id}" data-p2-name="${escapeHtml(m.player2_nickname)}">
                    수정
                </button>` : ''}
                <span class="match-pgn-actions">
                    ${canEdit ? `<button class="btn-pgn-edit" data-match-id="${m.id}">${hasPgn ? '기보 수정' : '기보 추가'}</button>` : ''}
                    ${hasPgn ? `<button class="btn-pgn-view" data-match-id="${m.id}">기보 보기</button>` : ''}
                </span>
            </div>`;
    }).join('');

    if (isAdmin()) {
        body.querySelectorAll('.btn-modify-result').forEach(btn => {
            btn.addEventListener('click', () => openResultModal(
                parseInt(btn.dataset.matchId),
                parseInt(btn.dataset.p1Id), btn.dataset.p1Name,
                parseInt(btn.dataset.p2Id), btn.dataset.p2Name,
            ));
        });
    }

    body.querySelectorAll('.btn-pgn-edit').forEach(btn => {
        btn.addEventListener('click', () => {
            const mid = parseInt(btn.dataset.matchId);
            openPgnModal(mid, matchDataCache[mid]?.pgn_data || '');
        });
    });
    body.querySelectorAll('.btn-pgn-view').forEach(btn => {
        btn.addEventListener('click', () => {
            const mid = parseInt(btn.dataset.matchId);
            const d   = matchDataCache[mid];
            if (d?.pgn_data) openPgnViewer(d.pgn_data, d.p1, d.p2);
        });
    });
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

async function toggleVote(pollId) {
    const result = await apiFetch(`/api/polls/${pollId}/vote`, { method: 'POST' });
    if (result?.ok) {
        await refreshPoll();
    } else {
        alert(result?.data?.detail || '오류가 발생했습니다.');
    }
}

async function closePoll(pollId, voteCount) {
    if (voteCount < 2) {
        alert('매치 생성에는 최소 2명의 참여자가 필요합니다.');
        return;
    }
    if (!confirm(`${voteCount}명의 참여자로 대진을 생성하고 투표를 종료하시겠습니까?`)) return;

    const result = await apiFetch(`/api/polls/${pollId}/close`, { method: 'POST' });
    if (result?.ok) {
        await refreshPage();
    } else {
        alert(result?.data?.detail || '오류가 발생했습니다.');
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

// ===== 기보 추가/수정 모달 =====

function openPgnModal(matchId, existingPgn) {
    pendingPgnMatchId = matchId;
    document.getElementById('input-pgn').value = existingPgn;
    document.getElementById('pgn-edit-error').textContent = '';
    document.getElementById('modal-pgn-edit').classList.remove('hidden');
    setTimeout(() => document.getElementById('input-pgn').focus(), 50);
}

document.getElementById('btn-confirm-pgn').addEventListener('click', async () => {
    const pgn     = document.getElementById('input-pgn').value.trim();
    const errorEl = document.getElementById('pgn-edit-error');
    errorEl.textContent = '';

    if (!pgn) {
        errorEl.textContent = '기보를 입력해주세요.';
        return;
    }

    // chess.js로 프론트엔드 유효성 검사
    if (!isValidPgn(pgn)) {
        errorEl.textContent = '유효하지 않은 기보 형식입니다.';
        return;
    }

    const btn = document.getElementById('btn-confirm-pgn');
    btn.disabled = true;
    btn.textContent = '저장 중...';

    try {
        const result = await apiFetch(`/api/matches/${pendingPgnMatchId}/pgn`, {
            method: 'PATCH',
            body: JSON.stringify({ pgn_data: pgn }),
        });
        if (result?.ok) {
            document.getElementById('modal-pgn-edit').classList.add('hidden');
            await refreshPage();
        } else {
            errorEl.textContent = result?.data?.detail || '저장에 실패했습니다.';
        }
    } finally {
        btn.disabled = false;
        btn.textContent = '저장';
    }
});

// ===== 기보 뷰어 =====

function openPgnViewer(pgn, p1Name, p2Name) {
    // PGN 파싱하여 포지션 목록 생성
    try {
        const chess = new Chess();
        if (!chess.load_pgn(pgn)) {
            alert('기보를 불러올 수 없습니다.');
            return;
        }
        const history = chess.history();

        const temp = new Chess();
        pgnPositions = [temp.fen()];
        pgnSans = history;
        history.forEach(san => {
            temp.move(san);
            pgnPositions.push(temp.fen());
        });
    } catch {
        alert('기보를 불러올 수 없습니다.');
        return;
    }

    pgnMoveIndex = 0;

    document.getElementById('pgn-viewer-title').textContent = `${p1Name} vs ${p2Name}`;
    document.getElementById('pgn-player-white').textContent = `⬜ 백 (White): ${p1Name}`;
    document.getElementById('pgn-player-black').textContent = `⬛ 흑 (Black): ${p2Name}`;
    document.getElementById('modal-pgn-viewer').classList.remove('hidden');

    // 보드 크기 계산 (모달 내부 너비 기준)
    const modalContent = document.querySelector('#modal-pgn-viewer .modal-content');
    const availableWidth = modalContent ? modalContent.clientWidth - 48 : 340;
    const boardSize = Math.min(380, availableWidth);

    const boardEl = document.getElementById('pgn-board');
    boardEl.style.width = boardSize + 'px';

    // 기존 보드 제거 후 재생성
    if (pgnBoardInst) {
        pgnBoardInst.destroy();
        pgnBoardInst = null;
    }

    // DOM 렌더링 후 보드 초기화
    requestAnimationFrame(() => {
        pgnBoardInst = Chessboard('pgn-board', {
            position: pgnPositions[0],
            pieceTheme: function(piece) {
                const wiki = {
                    wK: '4/42/Chess_klt45.svg', wQ: '1/15/Chess_qlt45.svg',
                    wR: '7/72/Chess_rlt45.svg', wB: 'b/b1/Chess_blt45.svg',
                    wN: '7/70/Chess_nlt45.svg', wP: '4/45/Chess_plt45.svg',
                    bK: 'f/f0/Chess_kdt45.svg', bQ: '4/47/Chess_qdt45.svg',
                    bR: 'f/ff/Chess_rdt45.svg', bB: '9/98/Chess_bdt45.svg',
                    bN: 'e/ef/Chess_ndt45.svg', bP: 'c/c7/Chess_pdt45.svg',
                };
                return 'https://upload.wikimedia.org/wikipedia/commons/' + wiki[piece];
            },
        });
        renderMoveList();
        updateViewerControls();
    });
}

function renderMoveList() {
    const el = document.getElementById('pgn-move-list');
    if (!pgnSans.length) {
        el.innerHTML = '<span class="pgn-no-moves">수가 없습니다.</span>';
        return;
    }

    const pairs = [];
    for (let i = 0; i < pgnSans.length; i += 2) {
        pairs.push({
            num: Math.floor(i / 2) + 1,
            white: { san: pgnSans[i],     idx: i + 1 },
            black: pgnSans[i + 1] ? { san: pgnSans[i + 1], idx: i + 2 } : null,
        });
    }

    el.innerHTML = pairs.map(p => `
        <span class="pgn-move-num">${p.num}.</span>
        <span class="pgn-move-san${pgnMoveIndex === p.white.idx ? ' active' : ''}"
              data-idx="${p.white.idx}">${escapeHtml(p.white.san)}</span>
        ${p.black
            ? `<span class="pgn-move-san${pgnMoveIndex === p.black.idx ? ' active' : ''}"
                     data-idx="${p.black.idx}">${escapeHtml(p.black.san)}</span>`
            : ''}
    `).join('');

    el.querySelectorAll('.pgn-move-san').forEach(span => {
        span.addEventListener('click', () => pgnGoTo(parseInt(span.dataset.idx)));
    });

    // 현재 활성 수가 보이도록 스크롤
    const active = el.querySelector('.pgn-move-san.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
}

function updateViewerControls() {
    const total = pgnPositions.length - 1;
    document.getElementById('pgn-move-counter').textContent = `${pgnMoveIndex} / ${total}`;
    document.getElementById('pgn-btn-first').disabled = pgnMoveIndex === 0;
    document.getElementById('pgn-btn-prev').disabled  = pgnMoveIndex === 0;
    document.getElementById('pgn-btn-next').disabled  = pgnMoveIndex >= total;
    document.getElementById('pgn-btn-last').disabled  = pgnMoveIndex >= total;
}

function pgnGoTo(index) {
    pgnMoveIndex = Math.max(0, Math.min(index, pgnPositions.length - 1));
    if (pgnBoardInst) pgnBoardInst.position(pgnPositions[pgnMoveIndex], false);
    renderMoveList();
    updateViewerControls();
}

document.getElementById('pgn-btn-first').addEventListener('click', () => pgnGoTo(0));
document.getElementById('pgn-btn-prev').addEventListener('click',  () => pgnGoTo(pgnMoveIndex - 1));
document.getElementById('pgn-btn-next').addEventListener('click',  () => pgnGoTo(pgnMoveIndex + 1));
document.getElementById('pgn-btn-last').addEventListener('click',  () => pgnGoTo(pgnPositions.length - 1));
document.getElementById('pgn-btn-flip').addEventListener('click', () => {
    if (pgnBoardInst) pgnBoardInst.orientation('flip');
    const topEl = document.getElementById('pgn-player-black');
    const botEl = document.getElementById('pgn-player-white');
    const tmp = topEl.textContent;
    topEl.textContent = botEl.textContent;
    botEl.textContent = tmp;
    topEl.classList.toggle('pgn-player-black');
    topEl.classList.toggle('pgn-player-white');
    botEl.classList.toggle('pgn-player-white');
    botEl.classList.toggle('pgn-player-black');
});

// 뷰어 키보드 단축키
document.addEventListener('keydown', e => {
    if (document.getElementById('modal-pgn-viewer').classList.contains('hidden')) return;
    if (e.key === 'ArrowLeft')  pgnGoTo(pgnMoveIndex - 1);
    if (e.key === 'ArrowRight') pgnGoTo(pgnMoveIndex + 1);
    if (e.key === 'Home')       pgnGoTo(0);
    if (e.key === 'End')        pgnGoTo(pgnPositions.length - 1);
});

// ===== 데이터 로드 =====

async function refreshPoll() {
    const result = await apiFetch(`/api/groups/${groupId}/polls/active`);
    if (result?.ok) renderPollSection(result.data);
}

async function refreshPage() {
    historyPage    = 1;
    openPollId     = null;
    pollMatchCache = {};

    const [membersRes, pollRes, historyRes, meRes] = await Promise.all([
        apiFetch(`/api/groups/${groupId}/members`),
        apiFetch(`/api/groups/${groupId}/polls/active`),
        apiFetch(`/api/groups/${groupId}/history?page=1`),
        apiFetch('/api/me'),
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
    if (meRes?.ok) currentUserId = meRes.data.id;

    document.getElementById('btn-group-settings').classList.toggle('hidden', currentRole === '회원');
    document.getElementById('btn-write-announcement').classList.toggle('hidden', !isAdmin());

    renderMembers(members);

    if (pollRes?.ok)    renderPollSection(pollRes.data);
    if (historyRes?.ok) renderHistoryAccordion(historyRes.data);

    await loadLatestAnnouncement();
}

// ===== 모달 닫기 =====

document.querySelectorAll('.btn-cancel').forEach(btn => {
    btn.addEventListener('click', () => {
        const id = btn.dataset.modal;
        if (id) {
            document.getElementById(id).classList.add('hidden');
            // 뷰어 닫을 때 보드 정리
            if (id === 'modal-pgn-viewer' && pgnBoardInst) {
                pgnBoardInst.destroy();
                pgnBoardInst = null;
            }
        }
    });
});

document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', () => {
        document.querySelectorAll('.modal').forEach(m => {
            m.classList.add('hidden');
        });
        if (pgnBoardInst) {
            pgnBoardInst.destroy();
            pgnBoardInst = null;
        }
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
