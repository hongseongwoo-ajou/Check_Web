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
const groupId = parseInt(params.get('group_id'), 10);
if (!groupId || isNaN(groupId)) window.location.href = '../lobby/lobby.html';

// ===== 상태 =====

let currentMembers   = [];
let currentRole      = '회원';
let cachedSettings   = { pts_win: 3, pts_draw: 2, pts_loss: 1, is_color_automatic: true };
let currentGroup     = null;   // { id, name, invite_code, ... } — refreshPage에서 채움
let historyPage      = 1;
let openPollId       = null;
let pollMatchCache   = {};
let currentUserId    = null;
let pendingMatchId    = null;
let pendingP1Id       = null;
let pendingP2Id       = null;
let pendingPgnMatchId = null;
let pendingEditMatchId = null;
let pendingEditPollId  = null;
let selectedEditResult = 'none';
let editMatchMode      = 'edit';    // 'edit' | 'add'
let editMatchContext   = 'history'; // 'history' | 'active'

// 친선 경기 폴더 상태
let allFolders           = [];
let openFolderId         = null;
let folderMatchCache     = {};
let manageMatches        = [];
let selectedManageIds    = new Set();
let renamingFolderId     = null;

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
                ...langHeader(),
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
        await window.i18nReady;   // 연결 실패가 번역 로드보다 빠르면 키 문자열이 그대로 찍히므로
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

// ===== 확인창·알림(토스트) — 브라우저 기본 confirm()/alert() 대체 =====

let confirmModalEl = null;

// 사이트 스타일 확인창. 확인 → true, 취소/바깥 클릭/Esc → false.
// danger: 삭제·강퇴처럼 되돌리기 어려운 동작이면 빨간 확인 버튼 + 기본 포커스는 '취소'.
function showConfirm(message, { danger = false, okText } = {}) {
    if (!confirmModalEl) {
        confirmModalEl = document.createElement('div');
        confirmModalEl.className = 'modal confirm-modal hidden';
        confirmModalEl.setAttribute('role', 'alertdialog');
        confirmModalEl.setAttribute('aria-modal', 'true');
        confirmModalEl.setAttribute('aria-describedby', 'confirm-modal-message');
        confirmModalEl.innerHTML = `
            <div class="modal-backdrop"></div>
            <div class="modal-content confirm-dialog">
                <p class="confirm-message" id="confirm-modal-message"></p>
                <div class="modal-buttons">
                    <button type="button" class="btn-cancel confirm-cancel"></button>
                    <button type="button" class="confirm-ok"></button>
                </div>
            </div>`;
        document.body.appendChild(confirmModalEl);
    }
    const el        = confirmModalEl;
    const okBtn     = el.querySelector('.confirm-ok');
    const cancelBtn = el.querySelector('.confirm-cancel');
    el.querySelector('.confirm-message').textContent = message;
    cancelBtn.textContent = t('common.cancel');
    okBtn.textContent     = okText || t('common.confirm');
    okBtn.className       = `confirm-ok ${danger ? 'btn-danger' : 'btn-primary'}`;

    const prevFocus = document.activeElement;
    el.classList.remove('hidden');
    (danger ? cancelBtn : okBtn).focus();

    return new Promise(resolve => {
        const finish = (value) => {
            el.classList.add('hidden');
            el.removeEventListener('click', onClick);
            document.removeEventListener('keydown', onKey, true);
            if (prevFocus?.isConnected) prevFocus.focus();
            resolve(value);
        };
        const onClick = (e) => {
            if (e.target === okBtn) finish(true);
            else if (e.target === cancelBtn || e.target.classList.contains('modal-backdrop')) finish(false);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
            if (e.key === 'Tab') {   // 포커스를 두 버튼 안에 가둠
                e.preventDefault();
                (document.activeElement === okBtn ? cancelBtn : okBtn).focus();
            }
        };
        el.addEventListener('click', onClick);
        document.addEventListener('keydown', onKey, true);
    });
}

// 화면 아래에 잠깐 떴다 사라지는 알림. type: 'error' | 'info'
function showToast(message, type = 'error') {
    let box = document.getElementById('toast-container');
    if (!box) {
        box = document.createElement('div');
        box.id = 'toast-container';
        box.className = 'toast-container';
        box.setAttribute('aria-live', 'polite');
        document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => {
        el.classList.add('toast-hide');
        setTimeout(() => el.remove(), 300);
    }, type === 'error' ? 4500 : 3000);
}

// 로딩 자리표시(스켈레톤). kind: 'lines'(목록) | 'cards'(카드형)
function skeletonHtml(count = 3, kind = 'lines') {
    const widths = ['w-90', 'w-75', 'w-90', 'w-60', 'w-75'];
    const items = Array.from({ length: count }, (_, i) =>
        kind === 'cards' ? '<div class="skeleton-card"></div>' : `<div class="skeleton-line ${widths[i % widths.length]}"></div>`
    ).join('');
    return `<div class="skeleton" role="status" aria-label="${t('common.loading')}">${items}</div>`;
}

function nameWithRating(nickname, rating) {
    return (rating === null || rating === undefined) ? nickname : `${nickname} (${rating})`;
}

function playerLink(id, nickname, rating) {
    const label = nameWithRating(nickname, rating);
    if (!id) return escapeHtml(label);
    return `<button type="button" class="player-link" data-user-id="${id}">${escapeHtml(label)}</button>`;
}

function formatDate(dateStr) {
    if (!dateStr) return '-';
    try {
        // 서버는 KST 기준 시간을 타임존 표기 없이 저장하므로 +09:00으로 해석하고, 표시도 KST로 고정
        const d = new Date(dateStr.replace(' ', 'T') + '+09:00');
        const locale = (typeof i18next !== 'undefined' && i18next.resolvedLanguage === 'en') ? 'en-US' : 'ko-KR';
        return d.toLocaleDateString(locale, { timeZone: 'Asia/Seoul', month: 'short', day: 'numeric' });
    } catch {
        return dateStr.slice(0, 10);
    }
}

// 경기 기록 줄의 결과 문구. 승자는 이름 강조(winner/match-winner-name)로 보여주므로 무승부일 때만 문구를 표시
function resultLabel(isDraw) {
    return isDraw ? t('common.draw') : '';
}

const isAdmin = () => currentRole === '방장' || currentRole === '임원';

function roleBadge(role) {
    if (role === '방장') return `<span class="role-badge admin">${t('groupDetail.roleOwner')}</span>`;
    if (role === '임원') return `<span class="role-badge officer">${t('groupDetail.roleOfficer')}</span>`;
    return '';
}

// ===== 경기 줄 '⋯' 메뉴 =====
// 기보·수정·삭제 버튼을 메뉴 하나로 묶어 경기 줄에서 글씨와 겹치지 않게 한다.
// 버튼 클래스(btn-pgn-edit 등)는 그대로라 각 목록의 querySelectorAll 이벤트 연결이 그대로 동작한다.

function menuItem(cls, matchId, label) {
    return `<button type="button" class="match-menu-item ${cls}" role="menuitem" data-match-id="${matchId}">${label}</button>`;
}

function pgnMenuItems(m) {
    return [
        menuItem('btn-pgn-edit', m.id, m.pgn_data ? t('groupDetail.pgnEditLabel') : t('groupDetail.pgnAddLabel')),
        m.pgn_data ? menuItem('btn-pgn-view', m.id, t('groupDetail.pgnViewLabel')) : '',
    ];
}

function matchMenu(items) {
    const html = items.filter(Boolean).join('');
    if (!html) return '';
    const label = t('groupDetail.moreActions');
    return `
        <div class="match-menu">
            <button type="button" class="btn-match-menu" aria-haspopup="menu" aria-expanded="false" title="${label}" aria-label="${label}">⋯</button>
            <div class="match-menu-list hidden" role="menu">${html}</div>
        </div>`;
}

// 열린 메뉴는 body로 옮겨 띄운다. 반투명(opacity) 카드처럼 쌓임 맥락을 만드는 조상 안에 있으면
// 뒤따르는 요소가 메뉴 위에 그려져 클릭을 가로채기 때문. 닫을 때 원래 자리로 되돌린다.
function closeMatchMenus() {
    document.querySelectorAll('.match-menu-list:not(.hidden)').forEach(list => {
        list.classList.add('hidden');
        const home = list._home;
        if (home?.isConnected) home.appendChild(list);
        else list.remove();               // 그사이 목록이 다시 그려져 원래 자리가 사라진 경우
        home?.querySelector('.btn-match-menu')?.setAttribute('aria-expanded', 'false');
    });
}

// 메뉴는 모달·아코디언의 overflow에 잘리지 않도록 화면 기준(fixed)으로 띄운다
function positionMatchMenu(toggle, list) {
    const r = toggle.getBoundingClientRect();
    list.style.top  = '0px';
    list.style.left = '0px';
    const w = list.offsetWidth;
    const h = list.offsetHeight;
    const top = (r.bottom + 4 + h > window.innerHeight) ? r.top - 4 - h : r.bottom + 4;
    list.style.top  = `${Math.max(4, top)}px`;
    list.style.left = `${Math.max(4, Math.min(r.right - w, window.innerWidth - w - 4))}px`;
}

// 캡처 단계에서 처리: 메뉴 항목 버튼의 기존 리스너는 그대로 실행되고, 메뉴는 항상 닫힌다
document.addEventListener('click', (e) => {
    const toggle = e.target.closest('.btn-match-menu');
    if (!toggle) {
        closeMatchMenus();
        return;
    }
    const wasOpen = toggle.getAttribute('aria-expanded') === 'true';
    closeMatchMenus();
    if (!wasOpen) {
        const home = toggle.closest('.match-menu');
        const list = home.querySelector('.match-menu-list');
        list._home = home;
        document.body.appendChild(list);
        list.classList.remove('hidden');
        toggle.setAttribute('aria-expanded', 'true');
        positionMatchMenu(toggle, list);
    }
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMatchMenus(); });
document.addEventListener('scroll', closeMatchMenus, true);
window.addEventListener('resize', closeMatchMenus);

function matchTypeBadge(isOfficial) {
    return isOfficial
        ? `<span class="official-badge official">${t('common.official')}</span>`
        : `<span class="official-badge friendly">${t('common.friendly')}</span>`;
}

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
        listEl.innerHTML = `<li class="loading-msg">${t('groupDetail.noMembers')}</li>`;
        return;
    }

    const isOwner = currentRole === '방장';

    members.forEach((m) => {
        const hasRating = m.rating_rapid != null;
        const isSelf    = m.id === currentUserId;

        const badge = roleBadge(m.role);

        // 관리 동작은 경기 목록처럼 '⋯' 메뉴로 묶는다 (가능한 동작이 없으면 메뉴도 없음)
        // 방장만: 역할 변경
        let roleItem = '';
        if (isOwner && !isSelf && m.role !== '방장') {
            const toOfficer = m.role !== '임원';
            roleItem = `<button type="button" class="match-menu-item btn-role" role="menuitem" data-member-id="${m.id}" data-new-role="${toOfficer ? '임원' : '회원'}">${t(toOfficer ? 'groupDetail.promoteOfficer' : 'groupDetail.demoteOfficer')}</button>`;
        }

        // 방장·임원: 강퇴 (임원은 회원만 강퇴 가능)
        const canKick = !isSelf && (
            (currentRole === '방장' && m.role !== '방장') ||
            (currentRole === '임원' && m.role === '회원')
        );
        const kickItem = canKick
            ? `<button type="button" class="match-menu-item btn-kick" role="menuitem" data-member-id="${m.id}" data-member-name="${escapeHtml(m.nickname)}">${t('groupDetail.kick')}</button>`
            : '';

        // 방장만: 방장 넘기기
        const transferItem = (isOwner && !isSelf)
            ? `<button type="button" class="match-menu-item btn-transfer-owner" role="menuitem" data-member-id="${m.id}" data-member-name="${escapeHtml(m.nickname)}">${t('groupDetail.transferOwner')}</button>`
            : '';

        const li = document.createElement('li');
        li.className = `member-item${isSelf ? ' me' : ''}${!hasRating ? ' unlinked' : ''}`;
        li.innerHTML = `
            <span class="member-name">${playerLink(m.id, m.nickname)}${badge}</span>
            <span class="member-rating">${hasRating ? `(${m.rating_rapid})` : `(${t('groupDetail.notLinked')})`}</span>
            ${matchMenu([roleItem, transferItem, kickItem])}
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

    listEl.querySelectorAll('.btn-transfer-owner').forEach(btn => {
        btn.addEventListener('click', () =>
            transferOwner(parseInt(btn.dataset.memberId), btn.dataset.memberName)
        );
    });
}

async function transferOwner(memberId, memberName) {
    if (!await showConfirm(t('groupDetail.confirmTransferOwner', { name: memberName }), { danger: true, okText: t('groupDetail.transferOwner') })) return;
    const result = await apiFetch(`/api/groups/${groupId}/transfer-owner`, {
        method: 'POST',
        body: JSON.stringify({ member_id: memberId }),
    });
    if (result?.ok) {
        await refreshPage();
        showToast(t('groupDetail.ownerTransferred', { name: memberName }), 'info');
    } else {
        showToast(result?.data?.detail || t('groupDetail.errorOccurred'));
    }
}

// 좁은 화면에서 멤버 목록 접기/펼치기 (기본 접힘, 선택은 기기에 기억). 넓은 화면에서는 버튼이 숨겨져 동작하지 않음
(function initMembersToggle() {
    const card = document.getElementById('members-card');
    const btn  = document.getElementById('btn-toggle-members');
    let expanded = false;
    try { expanded = localStorage.getItem('membersExpanded') === '1'; } catch { /* 저장소 사용 불가 */ }
    const apply = () => {
        card.classList.toggle('collapsed', !expanded);
        btn.setAttribute('aria-expanded', String(expanded));
    };
    apply();
    card.querySelector('.card-heading').addEventListener('click', (e) => {
        if (getComputedStyle(btn).display === 'none') return;
        if (e.target.closest('.player-link')) return;
        expanded = !expanded;
        apply();
        try { localStorage.setItem('membersExpanded', expanded ? '1' : '0'); } catch { /* 무시 */ }
    });
})();

async function changeMemberRole(memberId, newRole) {
    const member      = currentMembers.find(m => m.id === memberId);
    const displayName = member?.nickname ?? t('groupDetail.thatMember');
    const confirmMsg  = newRole === '임원'
        ? t('groupDetail.confirmPromote', { name: displayName })
        : t('groupDetail.confirmDemote', { name: displayName });

    if (!await showConfirm(confirmMsg, { danger: newRole !== '임원' })) return;

    const result = await apiFetch(`/api/groups/${groupId}/members/${memberId}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role: newRole }),
    });

    if (result?.ok) {
        await refreshPage();
    } else {
        showToast(result?.data?.detail || t('groupDetail.roleChangeFailed'));
    }
}

async function kickMember(memberId, memberName) {
    if (!await showConfirm(t('groupDetail.confirmKick', { name: memberName }), { danger: true, okText: t('groupDetail.kick') })) return;

    const result = await apiFetch(`/api/groups/${groupId}/members/${memberId}`, {
        method: 'DELETE',
    });

    if (result?.ok) {
        await refreshPage();
    } else {
        showToast(result?.data?.detail || t('groupDetail.kickFailed'));
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
                <h3 class="announcement-title announcement-empty">${t('groupDetail.noAnnouncements')}</h3>
                <button id="btn-view-all-announcements" class="btn-view-all-announcements">${t('groupDetail.viewAll')}</button>
            </div>`;
    } else {
        el.innerHTML = `
            <div class="announcement-row">
                <h3 class="announcement-title">${escapeHtml(ann.title)}</h3>
                <button id="btn-view-all-announcements" class="btn-view-all-announcements">${t('groupDetail.viewAll')}</button>
            </div>
            <p class="announcement-content">${escapeHtml(ann.content)}</p>`;
    }

    document.getElementById('btn-view-all-announcements').addEventListener('click', openAnnouncementListModal);
}

// 공지 작성/수정 겸용 창. ann을 넘기면 수정 모드 (제목·버튼 문구가 바뀌고 저장 시 PUT)
let editingAnnouncementId = null;

function openAnnouncementEditor(ann = null) {
    editingAnnouncementId = ann ? ann.id : null;
    document.getElementById('announcement-modal-title').textContent =
        t(ann ? 'groupDetail.editAnnouncementTitle' : 'groupDetail.writeAnnouncementTitle');
    document.getElementById('btn-confirm-create-announcement').textContent =
        t(ann ? 'common.save' : 'groupDetail.register');
    document.getElementById('input-announcement-title').value   = ann ? ann.title : '';
    document.getElementById('input-announcement-content').value = ann ? ann.content : '';
    document.getElementById('create-announcement-error').textContent = '';
    document.getElementById('modal-create-announcement').classList.remove('hidden');
    setTimeout(() => document.getElementById('input-announcement-title').focus(), 50);
}

document.getElementById('btn-write-announcement').addEventListener('click', () => openAnnouncementEditor());

document.getElementById('btn-confirm-create-announcement').addEventListener('click', async () => {
    const title   = document.getElementById('input-announcement-title').value.trim();
    const content = document.getElementById('input-announcement-content').value.trim();
    const errorEl = document.getElementById('create-announcement-error');
    errorEl.textContent = '';

    if (!title) {
        errorEl.textContent = t('groupDetail.titleRequired');
        return;
    }
    if (!content) {
        errorEl.textContent = t('groupDetail.contentRequired');
        return;
    }

    const btn       = document.getElementById('btn-confirm-create-announcement');
    const editingId = editingAnnouncementId;
    btn.disabled = true;
    btn.textContent = t('groupDetail.registering');

    try {
        const result = editingId
            ? await apiFetch(`/api/announcements/${editingId}`, { method: 'PUT', body: JSON.stringify({ title, content }) })
            : await apiFetch(`/api/groups/${groupId}/announcements`, { method: 'POST', body: JSON.stringify({ title, content }) });
        if (result?.ok) {
            document.getElementById('modal-create-announcement').classList.add('hidden');
            if (editingId) {
                const a = allAnnouncements.find(x => x.id === editingId);
                if (a) { a.title = result.data.title; a.content = result.data.content; }
                renderAnnouncementList();
            }
            await loadLatestAnnouncement();
        } else {
            errorEl.textContent = result?.data?.detail || t(editingId ? 'groupDetail.saveFailed' : 'groupDetail.registerFailed');
        }
    } finally {
        btn.disabled = false;
        btn.textContent = t(editingId ? 'common.save' : 'groupDetail.register');
    }
});

async function openAnnouncementListModal() {
    document.getElementById('modal-announcement-list').classList.remove('hidden');
    const el = document.getElementById('announcement-list-content');
    el.innerHTML = skeletonHtml(2, 'cards');

    const result = await apiFetch(`/api/groups/${groupId}/announcements`);
    if (!result?.ok) {
        el.innerHTML = `
            <p class="empty-msg-sm" style="color:#e07070">
                ${t('groupDetail.announcementsLoadFailed')}<br>
                <span style="font-size:0.78rem">${escapeHtml(result?.data?.detail || t('groupDetail.serverError'))}</span>
             </p>`;
        return;
    }

    allAnnouncements = result.data;
    renderAnnouncementList();
}

function renderAnnouncementList() {
    const el = document.getElementById('announcement-list-content');

    if (!allAnnouncements.length) {
        el.innerHTML = `<p class="empty-msg-sm">${t('groupDetail.noAnnouncements')}</p>`;
        return;
    }

    el.innerHTML = allAnnouncements.map(a => `
        <div class="announcement-item">
            <div class="announcement-item-head">
                <h4 class="announcement-item-title">${escapeHtml(a.title)}</h4>
                <span class="announcement-item-date">${formatDate(a.created_at)}</span>
                ${isAdmin() ? `<button class="btn-edit-announcement" data-id="${a.id}">${t('common.edit')}</button>
                <button class="btn-delete-announcement" data-id="${a.id}">${t('common.delete')}</button>` : ''}
            </div>
            <p class="announcement-item-content">${escapeHtml(a.content)}</p>
            <p class="announcement-item-author">${t('groupDetail.authorLabel')} ${escapeHtml(a.author_nickname)}</p>
        </div>
    `).join('');

    el.querySelectorAll('.btn-delete-announcement').forEach(btn => {
        btn.addEventListener('click', () => deleteAnnouncement(parseInt(btn.dataset.id)));
    });
    el.querySelectorAll('.btn-edit-announcement').forEach(btn => {
        btn.addEventListener('click', () => openAnnouncementEditor(allAnnouncements.find(a => a.id === parseInt(btn.dataset.id))));
    });
}

async function deleteAnnouncement(announcementId) {
    if (!await showConfirm(t('groupDetail.confirmDeleteAnnouncement'), { danger: true, okText: t('common.delete') })) return;

    const result = await apiFetch(`/api/announcements/${announcementId}`, { method: 'DELETE' });
    if (result?.ok) {
        allAnnouncements = allAnnouncements.filter(a => a.id !== announcementId);
        renderAnnouncementList();
        await loadLatestAnnouncement();
    } else {
        showToast(result?.data?.detail || t('groupDetail.deleteFailed'));
    }
}

// ===== 그룹 설정 모달 =====

document.getElementById('btn-group-settings').addEventListener('click', openGroupSettings);

function renderGroupHeader() {
    document.title = `${currentGroup.name} - ${t('common.appName')}`;
    document.getElementById('group-name').textContent  = currentGroup.name;
    document.getElementById('invite-code').textContent = currentGroup.invite_code;
}

async function openGroupSettings() {
    const result = await apiFetch(`/api/groups/${groupId}/settings`);
    if (result?.ok) {
        cachedSettings = { ...cachedSettings, ...result.data };
        document.getElementById('gs-input-color-auto').checked = cachedSettings.is_color_automatic !== false;
    }
    document.getElementById('gs-input-name').value = currentGroup?.name || '';
    document.getElementById('gs-invite-code').textContent = currentGroup?.invite_code || '-';
    document.getElementById('gs-info-msg').textContent = '';
    document.getElementById('gs-danger-zone').classList.toggle('hidden', currentRole !== '방장');
    document.getElementById('gs-msg').textContent = '';
    document.getElementById('modal-group-settings').classList.remove('hidden');
}

function setGroupInfoMsg(text, isError = false) {
    const el = document.getElementById('gs-info-msg');
    el.className   = 'settings-msg' + (isError ? ' error' : '');
    el.textContent = text;
    if (!isError && text) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 2000);
}

document.getElementById('btn-save-group-name').addEventListener('click', async () => {
    const name = document.getElementById('gs-input-name').value.trim();
    const btn  = document.getElementById('btn-save-group-name');
    btn.disabled = true;
    try {
        const result = await apiFetch(`/api/groups/${groupId}`, { method: 'PATCH', body: JSON.stringify({ name }) });
        if (result?.ok) {
            currentGroup.name = result.data.name;
            document.getElementById('gs-input-name').value = currentGroup.name;
            renderGroupHeader();
            setGroupInfoMsg(t('groupDetail.groupRenamed'));
        } else {
            setGroupInfoMsg(result?.data?.detail || t('groupDetail.saveFailed'), true);
        }
    } finally {
        btn.disabled = false;
    }
});

document.getElementById('gs-input-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-save-group-name').click();
});

document.getElementById('btn-regenerate-invite').addEventListener('click', async () => {
    if (!await showConfirm(t('groupDetail.confirmRegenerateInvite'), { danger: true, okText: t('groupDetail.regenerateInvite') })) return;
    const result = await apiFetch(`/api/groups/${groupId}/invite-code`, { method: 'POST' });
    if (result?.ok) {
        currentGroup.invite_code = result.data.invite_code;
        document.getElementById('gs-invite-code').textContent = currentGroup.invite_code;
        renderGroupHeader();
        setGroupInfoMsg(t('groupDetail.inviteRegenerated'));
    } else {
        setGroupInfoMsg(result?.data?.detail || t('groupDetail.errorOccurred'), true);
    }
});

// ===== 그룹 나가기 (방장 제외) =====

document.getElementById('btn-leave-group').addEventListener('click', async () => {
    if (!await showConfirm(t('groupDetail.confirmLeaveGroup', { name: currentGroup?.name || '' }), { danger: true, okText: t('groupDetail.leaveGroup') })) return;
    const result = await apiFetch(`/api/groups/${groupId}/leave`, { method: 'POST' });
    if (result?.ok) {
        window.location.href = '../lobby/lobby.html';
    } else {
        showToast(result?.data?.detail || t('groupDetail.errorOccurred'));
    }
});

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
        msgEl.textContent = t('groupDetail.saved');
        setTimeout(() => { msgEl.textContent = ''; }, 1500);
    } else {
        e.target.checked = !isColorAuto;  // 실패 시 원상복구
        msgEl.className  = 'settings-msg error';
        msgEl.textContent = result?.data?.detail || t('groupDetail.saveFailed');
    }
});

async function deleteGroup() {
    const errorEl = document.getElementById('delete-group-error');
    const btn     = document.getElementById('btn-confirm-delete-group');
    errorEl.textContent = '';
    btn.disabled = true;
    btn.textContent = t('groupDetail.deleting');

    try {
        const result = await apiFetch(`/api/groups/${groupId}`, { method: 'DELETE' });
        if (result?.ok) {
            window.location.href = '../lobby/lobby.html';
        } else {
            errorEl.textContent = result?.data?.detail || t('groupDetail.deleteFailed');
        }
    } finally {
        btn.disabled = false;
        btn.textContent = t('groupDetail.deleteConfirm');
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
        msgEl.textContent = t('groupDetail.ptsRangeError');
        return;
    }

    const btn = document.getElementById('btn-save-pts');
    btn.disabled = true;
    btn.textContent = t('groupDetail.saving');

    try {
        const result = await apiFetch(`/api/groups/${groupId}/settings`, {
            method: 'PUT',
            body: JSON.stringify({ pts_win: ptsWin, pts_draw: ptsDraw, pts_loss: ptsLoss, is_color_automatic: cachedSettings.is_color_automatic }),
        });
        if (result?.ok) {
            cachedSettings = { ...cachedSettings, pts_win: ptsWin, pts_draw: ptsDraw, pts_loss: ptsLoss };
            msgEl.textContent = t('groupDetail.savedSuccess');
            setTimeout(() => { msgEl.textContent = ''; }, 2000);
            await loadLeaderboard();
        } else {
            msgEl.className   = 'settings-msg error';
            msgEl.textContent = result?.data?.detail || t('groupDetail.saveFailed');
        }
    } finally {
        btn.disabled    = false;
        btn.textContent = t('common.save');
    }
});

async function loadLeaderboard() {
    document.getElementById('lb-content').innerHTML = skeletonHtml(5);

    const result = await apiFetch(`/api/groups/${groupId}/leaderboard`);
    if (!result?.ok) {
        document.getElementById('lb-content').innerHTML =
            `<p class="empty-msg-sm" style="color:#e07070">
                ${t('groupDetail.leaderboardLoadFailed')}<br>
                <span style="font-size:0.78rem">${escapeHtml(result?.data?.detail || t('groupDetail.serverError'))}</span>
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
    document.getElementById('pts-rule-label').textContent = t('groupDetail.ptsRule', {
        win: settings.pts_win, draw: settings.pts_draw, loss: settings.pts_loss,
    });

    const el = document.getElementById('lb-content');

    if (!standings.length) {
        el.innerHTML = `<p class="empty-msg-sm">${t('groupDetail.noMatchRecords')}</p>`;
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
                <td class="lb-name">${playerLink(s.id, s.nickname)}${ratingStr}</td>
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
                    <th>${t('groupDetail.playerHeader')}</th>
                    <th class="lb-stat">${t('groupDetail.playedHeader')}</th>
                    <th class="lb-stat">${t('groupDetail.winShort')}</th>
                    <th class="lb-stat">${t('groupDetail.drawShort')}</th>
                    <th class="lb-stat">${t('groupDetail.lossShort')}</th>
                    <th class="lb-pts">${t('groupDetail.pointsHeader')}</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>`;
}

// ===== 멤버 프로필 모달 =====

let profileRequestId = 0;

async function openUserProfileModal(memberId) {
    if (!memberId || isNaN(memberId)) return;

    const requestId = ++profileRequestId;
    document.getElementById('modal-user-profile').classList.remove('hidden');
    document.getElementById('profile-modal-content').innerHTML = skeletonHtml(4);

    const result = await apiFetch(`/api/groups/${groupId}/members/${memberId}/profile`);

    // 로딩 도중 다른 멤버 프로필을 열었다면 이전 응답은 버림
    if (requestId !== profileRequestId) return;

    if (!result?.ok) {
        document.getElementById('profile-modal-content').innerHTML = `
            <p class="empty-msg-sm" style="color:#e07070">
                ${t('groupDetail.profileLoadFailed')}<br>
                <span style="font-size:0.78rem">${escapeHtml(result?.data?.detail || t('groupDetail.serverError'))}</span>
            </p>`;
        return;
    }

    renderUserProfileModal(result.data);
}

function renderProfileH2H(h2h) {
    if (!h2h) return '';
    if (!h2h.played) {
        return `
            <div class="profile-h2h-box">
                <h4 class="profile-section-title">${t('groupDetail.h2hTitle')}</h4>
                <p class="empty-msg-sm">${t('groupDetail.noH2hRecord')}</p>
            </div>`;
    }
    return `
        <div class="profile-h2h-box">
            <h4 class="profile-section-title">${t('groupDetail.h2hTitle')}</h4>
            <p class="profile-h2h-summary">
                <strong>${t('groupDetail.h2hSummary', { myWins: h2h.my_wins, draws: h2h.draws, memberWins: h2h.member_wins })}</strong>
                <span class="profile-h2h-sub">${t('groupDetail.h2hSub', { count: h2h.played })}</span>
            </p>
        </div>`;
}

function renderProfileMatchRow(m, memberId) {
    const isDraw    = !m.winner_id;
    const isWin     = m.winner_id === memberId;
    const resultCls = isDraw ? 'draw' : (isWin ? 'win' : 'loss');
    const resultTxt = isDraw ? t('common.draw') : (isWin ? t('groupDetail.winShort') : t('groupDetail.lossShort'));
    const oppId     = m.player1_id === memberId ? m.player2_id : m.player1_id;
    const oppName   = m.player1_id === memberId ? m.player2_nickname : m.player1_nickname;

    return `
        <div class="profile-match-row">
            ${matchTypeBadge(m.is_official)}
            <span class="profile-match-opponent">vs ${playerLink(oppId, oppName)}</span>
            <span class="profile-match-result ${resultCls}">${resultTxt}</span>
            <span class="profile-match-date">${formatDate(m.played_at)}</span>
        </div>`;
}

function renderUserProfileModal(p) {
    const badge = roleBadge(p.role);
    const ratingStr = p.rating_rapid != null ? p.rating_rapid : t('groupDetail.notLinked');
    const { played, wins, draws, losses, points } = p.record;

    const recentHtml = p.recent_matches.length
        ? p.recent_matches.map(m => renderProfileMatchRow(m, p.id)).join('')
        : `<p class="empty-msg-sm">${t('groupDetail.noMatchRecords')}</p>`;

    document.getElementById('profile-modal-content').innerHTML = `
        <div class="profile-header">
            <h3 class="profile-name">${escapeHtml(p.nickname)}${badge}</h3>
            <p class="profile-chess-id">${p.chess_username ? `Chess.com: ${escapeHtml(p.chess_username)}` : t('groupDetail.chessNotLinked')}</p>
        </div>
        <div class="profile-stats-grid">
            <div class="profile-stat-box">
                <span class="profile-stat-label">${t('groupDetail.ratingLabel')}</span>
                <span class="profile-stat-value">${ratingStr}</span>
            </div>
            <div class="profile-stat-box">
                <span class="profile-stat-label">${t('groupDetail.recordLabel', { count: played })}</span>
                <span class="profile-stat-value">${t('groupDetail.recordSummary', { wins, draws, losses })}</span>
            </div>
            <div class="profile-stat-box">
                <span class="profile-stat-label">${t('groupDetail.pointsHeader')}</span>
                <span class="profile-stat-value">${points}</span>
            </div>
        </div>
        ${renderProfileH2H(p.head_to_head)}
        <h4 class="profile-section-title">${t('groupDetail.recentMatchesLabel')}</h4>
        <div class="profile-recent-list">${recentHtml}</div>
    `;
}

document.addEventListener('click', (e) => {
    const link = e.target.closest('.player-link');
    if (!link) return;
    e.stopPropagation();
    openUserProfileModal(parseInt(link.dataset.userId, 10));
});

// ===== 투표 생성 모달 =====

document.getElementById('btn-confirm-create-poll').addEventListener('click', async () => {
    const title      = document.getElementById('input-poll-title').value.trim();
    const isOfficial = document.querySelector('input[name="poll-match-type"]:checked').value === 'official';
    const errorEl    = document.getElementById('create-poll-error');
    errorEl.textContent = '';

    const btn = document.getElementById('btn-confirm-create-poll');
    btn.disabled = true;
    btn.textContent = t('groupDetail.creating2');

    try {
        const result = await apiFetch(`/api/groups/${groupId}/polls`, {
            method: 'POST',
            body: JSON.stringify({ title, is_official: isOfficial }),
        });
        if (result?.ok) {
            document.getElementById('modal-create-poll').classList.add('hidden');
            await refreshPage();
        } else {
            errorEl.textContent = result?.data?.detail || t('groupDetail.pollCreateFailed');
        }
    } finally {
        btn.disabled = false;
        btn.textContent = t('groupDetail.create');
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
            <h2 class="card-heading">${t('groupDetail.matchManagementHeading')}</h2>
            ${isAdmin() ? `<button class="btn-create-poll">${t('groupDetail.createPollButton')}</button>` : ''}
        </div>`;

    const cardsHtml = pollDataArray.length
        ? pollDataArray.map(({ poll, votes, my_vote, matches }) =>
            poll.status === 'voting'  ? buildVotingCard(poll, votes, my_vote) :
            poll.status === 'playing' ? buildPlayingCard(poll, matches, votes) : ''
          ).join('')
        : `<p class="empty-msg-sm">${t('groupDetail.noActivePolls')}</p>`;

    section.innerHTML = headHtml + cardsHtml;

    // 투표 생성 모달
    section.querySelector('.btn-create-poll')?.addEventListener('click', () => {
        document.getElementById('input-poll-title').value = '';
        document.getElementById('create-poll-error').textContent = '';
        document.querySelector('input[name="poll-match-type"][value="official"]').checked = true;
        document.getElementById('modal-create-poll').classList.remove('hidden');
        setTimeout(() => document.getElementById('input-poll-title').focus(), 50);
    });

    // 참여/취소 (투표별)
    section.querySelectorAll('.btn-vote-toggle').forEach(btn => {
        btn.addEventListener('click', () => toggleVote(parseInt(btn.dataset.pollId), btn));
    });

    // 관리자: 특정 참가자 투표 강제 취소
    section.querySelectorAll('.btn-cancel-vote').forEach(btn => {
        btn.addEventListener('click', () => cancelMemberVote(
            parseInt(btn.dataset.pollId), parseInt(btn.dataset.userId), btn.dataset.userName, btn
        ));
    });

    // 관리자: 투표 종료 / 삭제
    section.querySelectorAll('.btn-close-poll').forEach(btn => {
        btn.addEventListener('click', () =>
            closePoll(parseInt(btn.dataset.pollId), parseInt(btn.dataset.voteCount), btn)
        );
    });
    section.querySelectorAll('.btn-delete-poll').forEach(btn => {
        btn.addEventListener('click', () => deletePoll(parseInt(btn.dataset.pollId)));
    });

    // 경기 종료 (결과 기록)
    section.querySelectorAll('.btn-record-result').forEach(btn => {
        btn.addEventListener('click', () => openResultModal(
            parseInt(btn.dataset.matchId),
            parseInt(btn.dataset.p1Id), btn.dataset.p1Name,
            parseInt(btn.dataset.p2Id), btn.dataset.p2Name,
        ));
    });

    // 경기 수정 (관리자 전용)
    section.querySelectorAll('.btn-edit-match').forEach(btn => {
        btn.addEventListener('click', () => openEditMatchModal(parseInt(btn.dataset.matchId)));
    });

    // 경기 기록 삭제 (관리자 전용)
    section.querySelectorAll('.btn-delete-match').forEach(btn => {
        btn.addEventListener('click', () => deleteMatch(parseInt(btn.dataset.matchId)));
    });

    // 경기 추가 (매치 관리 — 관리자 전용)
    section.querySelectorAll('.btn-add-match-active').forEach(btn => {
        btn.addEventListener('click', () => openAddMatchModal(parseInt(btn.dataset.pollId), 'active'));
    });

    // 투표 다시하기 (매치 관리 — 관리자 전용)
    section.querySelectorAll('.btn-reopen-poll').forEach(btn => {
        btn.addEventListener('click', () => reopenPoll(parseInt(btn.dataset.pollId), btn));
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
    const titleStr  = poll.title ? escapeHtml(poll.title) : t('groupDetail.participationPoll');
    const voterRows = votes.length
        ? votes.map((v, i) => `
            <div class="voter-item">
                <span class="voter-num">${i + 1}</span>
                <span class="voter-name">${escapeHtml(nameWithRating(v.nickname, v.rating_at_vote))}</span>
                ${isAdmin() ? `
                    <button class="btn-cancel-vote"
                        data-poll-id="${poll.id}" data-user-id="${v.user_id}" data-user-name="${escapeHtml(v.nickname)}"
                        title="${t('groupDetail.cancelVote')}">${t('groupDetail.cancelVote')}</button>` : ''}
            </div>`).join('')
        : `<p class="empty-msg-sm">${t('groupDetail.noParticipants')}</p>`;
    const adminBtns = isAdmin() ? `
        <button class="btn-close-poll" data-poll-id="${poll.id}" data-vote-count="${votes.length}">
            ${t('groupDetail.closePollButton', { count: votes.length })}
        </button>
        <button class="btn-delete-poll" data-poll-id="${poll.id}">${t('common.delete')}</button>` : '';

    return `
        <div class="poll-card">
            <div class="card-head-row">
                <div class="head-left">
                    <h3 class="poll-card-title">${titleStr}</h3>
                    <span class="status-badge voting">${t('groupDetail.statusVoting')}</span>
                    ${matchTypeBadge(poll.is_official)}
                </div>
                <div class="head-buttons">
                    <button class="btn-vote${myVote ? ' voted' : ''} btn-vote-toggle" data-poll-id="${poll.id}">
                        ${myVote ? t('groupDetail.cancelParticipation') : t('groupDetail.participate')}
                    </button>
                    ${adminBtns}
                </div>
            </div>
            <p class="vote-summary">${t('groupDetail.participantsCount', { count: votes.length })}</p>
            <div class="voter-list">${voterRows}</div>
        </div>`;
}

function buildPlayingCard(poll, matches, votes = []) {
    matches.forEach(m => {
        matchDataCache[m.id] = {
            pgn_data: m.pgn_data || null,
            p1: m.player1_nickname, p2: m.player2_nickname,
            p1Id: m.player1_id, p2Id: m.player2_id,
            winnerId: m.winner_id ?? null, status: m.status,
        };
    });

    const cards = matches.map(m => {
        if (m.status === 'finished') {
            const isDraw  = !m.winner_id;
            const p1Win   = m.winner_id === m.player1_id;
            const p2Win   = m.winner_id === m.player2_id;
            return `
                <div class="match-card finished">
                    <div class="match-vs">
                        <span class="match-player${p1Win ? ' winner' : ''}"><span class="color-chip white">${t('groupDetail.whiteShort')}</span>${playerLink(m.player1_id, m.player1_nickname, m.player1_rating)}</span>
                        <span class="vs-label">vs</span>
                        <span class="match-player${p2Win ? ' winner' : ''}"><span class="color-chip black">${t('groupDetail.blackShort')}</span>${playerLink(m.player2_id, m.player2_nickname, m.player2_rating)}</span>
                    </div>
                    <span class="match-result-badge ${isDraw ? 'draw' : 'win'}">
                        ${resultLabel(isDraw)}
                    </span>
                    ${matchMenu([
                        ...pgnMenuItems(m),
                        isAdmin() ? menuItem('btn-edit-match', m.id, t('groupDetail.editMatch')) : '',
                        isAdmin() ? menuItem('btn-delete-match', m.id, t('groupDetail.deleteMatch')) : '',
                    ])}
                </div>`;
        }
        const isParticipant = currentUserId === m.player1_id || currentUserId === m.player2_id;
        return `
            <div class="match-card">
                <div class="match-vs">
                    <span class="match-player"><span class="color-chip white">${t('groupDetail.whiteShort')}</span>${playerLink(m.player1_id, m.player1_nickname, m.player1_rating)}</span>
                    <span class="vs-label">vs</span>
                    <span class="match-player"><span class="color-chip black">${t('groupDetail.blackShort')}</span>${playerLink(m.player2_id, m.player2_nickname, m.player2_rating)}</span>
                </div>
                ${(isAdmin() || isParticipant) ? `
                    <button class="btn-record-result"
                        data-match-id="${m.id}"
                        data-p1-id="${m.player1_id}" data-p1-name="${escapeHtml(m.player1_nickname)}"
                        data-p2-id="${m.player2_id}" data-p2-name="${escapeHtml(m.player2_nickname)}">${t('groupDetail.finishMatch')}</button>
                ` : ''}
                ${matchMenu([isAdmin() ? menuItem('btn-edit-match', m.id, t('groupDetail.editMatch')) : ''])}
            </div>`;
    }).join('');

    const allDone  = matches.every(m => m.status === 'finished');
    const titleStr = poll.title ? escapeHtml(poll.title) : t('groupDetail.bracketTitle');

    const matchPlayerIds = new Set(matches.flatMap(m => [m.player1_id, m.player2_id]));
    const byeVoter = votes.find(v => !matchPlayerIds.has(v.user_id));
    const byeNotice = byeVoter
        ? `<p class="bye-notice">${t('groupDetail.byeNotice', { name: escapeHtml(byeVoter.nickname) })}</p>`
        : '';

    return `
        <div class="poll-card">
            <div class="card-head-row">
                <div class="head-left">
                    <h3 class="poll-card-title">${titleStr}</h3>
                    <span class="status-badge playing">${allDone ? t('groupDetail.statusDone') : t('groupDetail.statusInProgress')}</span>
                    ${matchTypeBadge(poll.is_official)}
                </div>
                <div class="head-buttons">
                    ${isAdmin() ? `<button class="btn-add-match-active" data-poll-id="${poll.id}">${t('groupDetail.addMatchButton')}</button>` : ''}
                    ${isAdmin() ? `<button class="btn-reopen-poll" data-poll-id="${poll.id}">${t('groupDetail.reopenPoll')}</button>` : ''}
                </div>
            </div>
            ${byeNotice}
            <div class="match-list-area">${cards}</div>
        </div>`;
}

// ===== 지난 경기 결과 (아코디언 + 페이징) =====

async function loadHistory(page = 1) {
    historyPage = page;
    const el = document.getElementById('match-history');
    el.innerHTML = skeletonHtml(2, 'cards');

    const result = await apiFetch(`/api/groups/${groupId}/history?page=${page}`);
    if (!result?.ok) {
        el.innerHTML = `<p class="empty-msg-sm">${t('groupDetail.loadFailed')}</p>`;
        return;
    }
    renderHistoryAccordion(result.data);
}

function renderHistoryAccordion({ polls, page, pages }) {
    const el = document.getElementById('match-history');

    if (!polls.length) {
        el.innerHTML = `<p class="empty-msg-sm">${t('groupDetail.noCompletedMatches')}</p>`;
        return;
    }

    const paginationHtml = pages > 1 ? buildHistoryPagination(page, pages) : '';

    const accordionHtml = polls.map(p => {
        const title   = p.title || t('groupDetail.unnamed');
        const dateStr = formatDate(p.created_at);
        return `
            <div class="history-accordion">
                <button class="accordion-header" data-poll-id="${p.id}">
                    <span class="accordion-icon">►</span>
                    <span class="accordion-title">${escapeHtml(title)}</span>
                    ${matchTypeBadge(p.is_official)}
                    <span class="accordion-meta">${t('groupDetail.matchCount', { count: p.match_count })} · ${dateStr}</span>
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
    body.innerHTML = skeletonHtml(2);

    const result = await apiFetch(`/api/polls/${pollId}/matches`);
    if (!result?.ok) {
        body.innerHTML = `<p class="empty-msg-sm">${t('groupDetail.loadFailed')}</p>`;
        return;
    }

    pollMatchCache[pollId] = result.data;
    result.data.forEach(m => {
        matchDataCache[m.id] = {
            pgn_data: m.pgn_data || null,
            p1: m.player1_nickname, p2: m.player2_nickname,
            p1Id: m.player1_id, p2Id: m.player2_id,
            winnerId: m.winner_id ?? null, status: 'finished',
        };
    });
    renderPollMatches(pollId);
}

function renderPollMatches(pollId) {
    const body    = document.getElementById(`accordion-body-${pollId}`);
    const matches = pollMatchCache[pollId];

    const addBtnHtml = isAdmin()
        ? `<div class="accordion-add-row">
               <button class="btn-add-match-to-poll" data-poll-id="${pollId}">${t('groupDetail.addMatchButton')}</button>
           </div>`
        : '';

    if (!matches?.length) {
        body.innerHTML = addBtnHtml + `<p class="empty-msg-sm">${t('groupDetail.noMatchRecords')}</p>`;
    } else {
        body.innerHTML = addBtnHtml + matches.map(m => {
            const isDraw  = !m.winner_id;
            const p1Win   = m.winner_id === m.player1_id;
            const p2Win   = m.winner_id === m.player2_id;
            return `
                <div class="accordion-match-item">
                    <span class="match-players">
                        <span class="${p1Win ? 'match-winner-name' : ''}"><span class="color-chip white">${t('groupDetail.whiteShort')}</span>${playerLink(m.player1_id, m.player1_nickname, m.player1_rating)}</span>
                        <span class="match-vs-sm">vs</span>
                        <span class="${p2Win ? 'match-winner-name' : ''}"><span class="color-chip black">${t('groupDetail.blackShort')}</span>${playerLink(m.player2_id, m.player2_nickname, m.player2_rating)}</span>
                    </span>
                    <span class="match-result ${isDraw ? 'draw' : ''}">${resultLabel(isDraw)}</span>
                    ${matchMenu([
                        ...pgnMenuItems(m),
                        isAdmin() ? menuItem('btn-edit-match', m.id, t('groupDetail.editMatch')) : '',
                        isAdmin() ? menuItem('btn-delete-match', m.id, t('groupDetail.deleteMatch')) : '',
                    ])}
                </div>`;
        }).join('');
    }

    if (isAdmin()) {
        body.querySelector('.btn-add-match-to-poll')?.addEventListener('click', () => {
            openAddMatchModal(pollId);
        });
        body.querySelectorAll('.btn-edit-match').forEach(btn => {
            btn.addEventListener('click', () => openEditMatchModal(parseInt(btn.dataset.matchId), pollId));
        });
        body.querySelectorAll('.btn-delete-match').forEach(btn => {
            btn.addEventListener('click', () => deleteMatch(parseInt(btn.dataset.matchId)));
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

// ===== 최근 경기 내역 (공식 + 친선) =====

// 지금까지 불러온 최근 경기 (더보기로 뒤에 이어 붙임)
const RECENT_PAGE_SIZE = 30;
let recentMatches  = [];
let recentHasMore  = false;

function setRecentMatches(page, append = false) {
    recentMatches = append ? recentMatches.concat(page) : page;
    recentHasMore = page.length === RECENT_PAGE_SIZE;
    renderRecentMatches();
}

async function loadRecentMatches() {
    const el = document.getElementById('recent-matches');
    el.innerHTML = skeletonHtml(4);

    const result = await apiFetch(`/api/groups/${groupId}/matches?limit=${RECENT_PAGE_SIZE}`);
    if (!result?.ok) {
        el.innerHTML = `<p class="empty-msg-sm">${t('groupDetail.loadFailed')}</p>`;
        return;
    }
    setRecentMatches(result.data);
}

async function loadMoreRecentMatches(btn) {
    btn.disabled = true;
    btn.textContent = t('common.loading');
    const result = await apiFetch(`/api/groups/${groupId}/matches?limit=${RECENT_PAGE_SIZE}&offset=${recentMatches.length}`);
    if (result?.ok) {
        setRecentMatches(result.data, true);
    } else {
        btn.disabled = false;
        btn.textContent = t('groupDetail.loadMore');
        showToast(result?.data?.detail || t('groupDetail.loadFailed'));
    }
}

function renderRecentMatches() {
    const matches = recentMatches;
    const el = document.getElementById('recent-matches');

    if (!matches.length) {
        el.innerHTML = `<p class="empty-msg-sm">${t('groupDetail.noMatchHistory')}</p>`;
        return;
    }

    matches.forEach(m => {
        matchDataCache[m.id] = {
            pgn_data: m.pgn_data || null,
            p1: m.player1_nickname, p2: m.player2_nickname,
            p1Id: m.player1_id, p2Id: m.player2_id,
            winnerId: m.winner_id ?? null, status: 'finished',
        };
    });

    el.innerHTML = matches.map(m => {
        const isDraw   = !m.winner_id;
        const p1Win    = m.winner_id === m.player1_id;
        const p2Win    = m.winner_id === m.player2_id;
        const noteHtml = m.note ? `<p class="recent-match-note">${escapeHtml(m.note)}</p>` : '';
        return `
            <div class="recent-match-item">
                <div class="recent-match-row">
                    ${matchTypeBadge(m.is_official)}
                    <span class="match-players">
                        <span class="${p1Win ? 'match-winner-name' : ''}"><span class="color-chip white">${t('groupDetail.whiteShort')}</span>${playerLink(m.player1_id, m.player1_nickname, m.player1_rating)}</span>
                        <span class="match-vs-sm">vs</span>
                        <span class="${p2Win ? 'match-winner-name' : ''}"><span class="color-chip black">${t('groupDetail.blackShort')}</span>${playerLink(m.player2_id, m.player2_nickname, m.player2_rating)}</span>
                    </span>
                    <span class="match-result ${isDraw ? 'draw' : ''}">${resultLabel(isDraw)}</span>
                    <span class="recent-match-date">${formatDate(m.played_at)}</span>
                    ${matchMenu([
                        ...pgnMenuItems(m),
                        isAdmin() ? menuItem('btn-delete-match', m.id, t('groupDetail.deleteMatch')) : '',
                    ])}
                </div>
                ${noteHtml}
            </div>`;
    }).join('') + (recentHasMore
        ? `<button type="button" class="btn-load-more" id="btn-more-recent">${t('groupDetail.loadMore')}</button>`
        : '');

    document.getElementById('btn-more-recent')?.addEventListener('click', (e) => loadMoreRecentMatches(e.currentTarget));

    el.querySelectorAll('.btn-pgn-edit').forEach(btn => {
        btn.addEventListener('click', () => {
            const mid = parseInt(btn.dataset.matchId);
            openPgnModal(mid, matchDataCache[mid]?.pgn_data || '');
        });
    });
    el.querySelectorAll('.btn-delete-match').forEach(btn => {
        btn.addEventListener('click', () => deleteMatch(parseInt(btn.dataset.matchId)));
    });
    el.querySelectorAll('.btn-pgn-view').forEach(btn => {
        btn.addEventListener('click', () => {
            const mid = parseInt(btn.dataset.matchId);
            const d   = matchDataCache[mid];
            if (d?.pgn_data) openPgnViewer(d.pgn_data, d.p1, d.p2);
        });
    });
}

// ===== 친선 경기 직접 기록 모달 =====

let selectedFriendlyResult = 'p1_win';

function openFriendlyMatchModal() {
    if (currentMembers.length < 2) {
        showToast(t('groupDetail.needTwoMembers'), 'info');
        return;
    }

    const options = currentMembers.map(m =>
        `<option value="${m.id}">${escapeHtml(m.nickname)}</option>`
    ).join('');

    const p1Select = document.getElementById('friendly-player1');
    const p2Select = document.getElementById('friendly-player2');
    p1Select.innerHTML = options;
    p2Select.innerHTML = options;
    p1Select.value = String(currentMembers[0].id);
    p2Select.value = String(currentMembers[1].id);

    selectedFriendlyResult = 'p1_win';
    document.getElementById('input-friendly-note').value = '';
    document.getElementById('friendly-match-error').textContent = '';
    updateFriendlyResultButtons();
    document.getElementById('modal-friendly-match').classList.remove('hidden');
}

function updateFriendlyResultButtons() {
    const p1Sel  = document.getElementById('friendly-player1');
    const p2Sel  = document.getElementById('friendly-player2');
    const p1Name = p1Sel.options[p1Sel.selectedIndex]?.text || t('groupDetail.whiteShort');
    const p2Name = p2Sel.options[p2Sel.selectedIndex]?.text || t('groupDetail.blackShort');

    document.getElementById('btn-friendly-p1-win').textContent = t('groupDetail.winParen', { name: p1Name, color: t('groupDetail.whiteShort') });
    document.getElementById('btn-friendly-p2-win').textContent = t('groupDetail.winParen', { name: p2Name, color: t('groupDetail.blackShort') });

    document.querySelectorAll('.btn-friendly-result').forEach(btn => {
        btn.classList.toggle('selected', btn.dataset.result === selectedFriendlyResult);
    });
}

document.getElementById('btn-record-friendly').addEventListener('click', openFriendlyMatchModal);

document.getElementById('btn-swap-friendly-players').addEventListener('click', () => {
    const p1Select = document.getElementById('friendly-player1');
    const p2Select = document.getElementById('friendly-player2');
    const tmp = p1Select.value;
    p1Select.value = p2Select.value;
    p2Select.value = tmp;

    if (selectedFriendlyResult === 'p1_win')      selectedFriendlyResult = 'p2_win';
    else if (selectedFriendlyResult === 'p2_win') selectedFriendlyResult = 'p1_win';

    updateFriendlyResultButtons();
});

document.getElementById('friendly-player1').addEventListener('change', updateFriendlyResultButtons);
document.getElementById('friendly-player2').addEventListener('change', updateFriendlyResultButtons);

document.querySelectorAll('.btn-friendly-result').forEach(btn => {
    btn.addEventListener('click', () => {
        selectedFriendlyResult = btn.dataset.result;
        updateFriendlyResultButtons();
    });
});

document.getElementById('btn-confirm-friendly-match').addEventListener('click', async () => {
    const p1Id    = parseInt(document.getElementById('friendly-player1').value);
    const p2Id    = parseInt(document.getElementById('friendly-player2').value);
    const note    = document.getElementById('input-friendly-note').value.trim();
    const errorEl = document.getElementById('friendly-match-error');
    errorEl.textContent = '';

    if (p1Id === p2Id) {
        errorEl.textContent = t('groupDetail.playersMustDiffer');
        return;
    }

    const btn = document.getElementById('btn-confirm-friendly-match');
    btn.disabled = true;
    btn.textContent = t('groupDetail.recording');

    try {
        const result = await apiFetch(`/api/groups/${groupId}/matches/friendly`, {
            method: 'POST',
            body: JSON.stringify({ player1_id: p1Id, player2_id: p2Id, result: selectedFriendlyResult, note }),
        });
        if (result?.ok) {
            document.getElementById('modal-friendly-match').classList.add('hidden');
            await loadRecentMatches();
        } else {
            errorEl.textContent = result?.data?.detail || t('groupDetail.recordFailed');
        }
    } finally {
        btn.disabled = false;
        btn.textContent = t('groupDetail.record');
    }
});

// ===== 친선 경기 폴더 모달 =====

document.getElementById('btn-open-folders').addEventListener('click', openFriendlyFoldersModal);

async function openFriendlyFoldersModal() {
    openFolderId     = null;
    folderMatchCache = {};
    renamingFolderId = null;
    selectedManageIds.clear();

    document.getElementById('btn-folder-manage-toggle').classList.toggle('hidden', !isAdmin());
    document.getElementById('folder-manage-panel').classList.add('hidden');
    document.getElementById('btn-folder-manage-toggle').classList.remove('active');
    document.getElementById('input-new-folder-name').value = '';
    document.getElementById('folder-manage-error').textContent = '';

    document.getElementById('modal-friendly-folders').classList.remove('hidden');

    await loadFolders();
    if (isAdmin()) await loadManageMatches();
}

document.getElementById('btn-folder-manage-toggle').addEventListener('click', () => {
    const panel = document.getElementById('folder-manage-panel');
    const btn   = document.getElementById('btn-folder-manage-toggle');
    const isOpen = !panel.classList.contains('hidden');
    panel.classList.toggle('hidden', isOpen);
    btn.classList.toggle('active', !isOpen);
});

async function loadFolders() {
    const result = await apiFetch(`/api/groups/${groupId}/friendly-folders`);
    allFolders = result?.ok ? result.data : [];
    renderFolderAccordion();
    renderFolderSelectOptions();
}

function renderFolderSelectOptions() {
    const select = document.getElementById('select-assign-folder');
    const current = select.value;
    select.innerHTML = `<option value="">${t('groupDetail.selectFolderPlaceholder')}</option>` +
        allFolders.map(f => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('');
    if (allFolders.some(f => String(f.id) === current)) select.value = current;
}

function renderFolderAccordion() {
    const el = document.getElementById('folder-view-content');

    if (!allFolders.length) {
        el.innerHTML = `<p class="empty-msg-sm">${t('groupDetail.noFolders')}</p>`;
        return;
    }

    el.innerHTML = allFolders.map(f => {
        if (renamingFolderId === f.id) {
            return `
                <div class="history-accordion">
                    <div class="folder-rename-row">
                        <input type="text" id="input-rename-folder" class="form-input" value="${escapeHtml(f.name)}" maxlength="50">
                        <button class="btn-folder-icon btn-folder-save" data-folder-id="${f.id}" title="${t('common.save')}">&#10003;</button>
                        <button class="btn-folder-icon btn-folder-cancel-rename" title="${t('common.cancel')}">&#10005;</button>
                    </div>
                </div>`;
        }
        return `
            <div class="history-accordion">
                <div class="folder-head-row">
                    <button class="accordion-header" data-folder-id="${f.id}">
                        <span class="accordion-icon">►</span>
                        <span class="accordion-title">${escapeHtml(f.name)}</span>
                        <span class="accordion-meta">${t('groupDetail.matchCount', { count: f.match_count })}</span>
                    </button>
                    ${isAdmin() ? `
                        <div class="folder-admin-actions">
                            <button class="btn-folder-icon btn-rename-folder" data-folder-id="${f.id}" title="${t('groupDetail.renameFolder')}">&#9998;</button>
                            <button class="btn-folder-icon btn-delete-folder" data-folder-id="${f.id}" data-folder-name="${escapeHtml(f.name)}" title="${t('common.delete')}">&#128465;</button>
                        </div>` : ''}
                </div>
                <div class="accordion-body hidden" id="folder-body-${f.id}"></div>
            </div>`;
    }).join('');

    el.querySelectorAll('.accordion-header').forEach(btn => {
        btn.addEventListener('click', () => toggleFolderAccordion(parseInt(btn.dataset.folderId)));
    });
    el.querySelectorAll('.btn-rename-folder').forEach(btn => {
        btn.addEventListener('click', () => {
            renamingFolderId = parseInt(btn.dataset.folderId);
            renderFolderAccordion();
            setTimeout(() => document.getElementById('input-rename-folder')?.focus(), 50);
        });
    });
    el.querySelectorAll('.btn-folder-cancel-rename').forEach(btn => {
        btn.addEventListener('click', () => { renamingFolderId = null; renderFolderAccordion(); });
    });
    el.querySelectorAll('.btn-folder-save').forEach(btn => {
        btn.addEventListener('click', () => renameFolder(parseInt(btn.dataset.folderId)));
    });
    el.querySelectorAll('.btn-delete-folder').forEach(btn => {
        btn.addEventListener('click', () => deleteFolder(parseInt(btn.dataset.folderId), btn.dataset.folderName));
    });
}

async function toggleFolderAccordion(folderId) {
    const body = document.getElementById(`folder-body-${folderId}`);
    const icon = document.querySelector(`.accordion-header[data-folder-id="${folderId}"] .accordion-icon`);
    if (!body) return;

    const isOpen = !body.classList.contains('hidden');

    if (openFolderId && openFolderId !== folderId) {
        const prevBody = document.getElementById(`folder-body-${openFolderId}`);
        const prevIcon = document.querySelector(`.accordion-header[data-folder-id="${openFolderId}"] .accordion-icon`);
        if (prevBody) prevBody.classList.add('hidden');
        if (prevIcon) prevIcon.textContent = '►';
    }

    if (isOpen) {
        body.classList.add('hidden');
        icon.textContent = '►';
        openFolderId = null;
    } else {
        body.classList.remove('hidden');
        icon.textContent = '▼';
        openFolderId = folderId;
        if (!folderMatchCache[folderId]) {
            body.innerHTML = skeletonHtml(2);
            const result = await apiFetch(`/api/friendly-folders/${folderId}/matches`);
            if (!result?.ok) {
                // 실패를 '경기 없음'으로 보이거나 빈 결과를 캐시하지 않도록
                body.innerHTML = `<p class="empty-msg-sm">${t('groupDetail.loadFailed')}</p>`;
                return;
            }
            folderMatchCache[folderId] = result.data.matches;
        }
        renderFolderMatches(folderId);
    }
}

function renderFolderMatches(folderId) {
    const body    = document.getElementById(`folder-body-${folderId}`);
    const matches = folderMatchCache[folderId];

    if (!matches?.length) {
        body.innerHTML = `<p class="empty-msg-sm">${t('groupDetail.folderEmpty')}</p>`;
        return;
    }

    body.innerHTML = matches.map(m => {
        const isDraw   = !m.winner_id;
        const p1Win    = m.winner_id === m.player1_id;
        const p2Win    = m.winner_id === m.player2_id;
        const noteHtml = m.note ? `<p class="recent-match-note">${escapeHtml(m.note)}</p>` : '';
        return `
            <div class="accordion-match-item folder-match-item">
                <span class="match-players">
                    <span class="${p1Win ? 'match-winner-name' : ''}"><span class="color-chip white">${t('groupDetail.whiteShort')}</span>${playerLink(m.player1_id, m.player1_nickname, m.player1_rating)}</span>
                    <span class="match-vs-sm">vs</span>
                    <span class="${p2Win ? 'match-winner-name' : ''}"><span class="color-chip black">${t('groupDetail.blackShort')}</span>${playerLink(m.player2_id, m.player2_nickname, m.player2_rating)}</span>
                </span>
                <span class="match-result ${isDraw ? 'draw' : ''}">${resultLabel(isDraw)}</span>
                <span class="recent-match-date">${formatDate(m.played_at)}</span>
                ${matchMenu([isAdmin() ? menuItem('btn-delete-match', m.id, t('groupDetail.deleteMatch')) : ''])}
                ${noteHtml}
            </div>`;
    }).join('');

    body.querySelectorAll('.btn-delete-match').forEach(btn => {
        btn.addEventListener('click', () => deleteMatch(parseInt(btn.dataset.matchId), folderId));
    });
}

async function renameFolder(folderId) {
    const name = document.getElementById('input-rename-folder').value.trim();
    if (!name) return;

    const result = await apiFetch(`/api/friendly-folders/${folderId}`, {
        method: 'PUT',
        body: JSON.stringify({ name }),
    });
    if (result?.ok) {
        renamingFolderId = null;
        await loadFolders();
    } else {
        showToast(result?.data?.detail || t('groupDetail.renameFailed'));
    }
}

async function deleteFolder(folderId, folderName) {
    if (!await showConfirm(t('groupDetail.confirmDeleteFolder', { name: folderName }), { danger: true, okText: t('common.delete') })) return;

    const result = await apiFetch(`/api/friendly-folders/${folderId}`, { method: 'DELETE' });
    if (result?.ok) {
        delete folderMatchCache[folderId];
        if (openFolderId === folderId) openFolderId = null;
        await loadFolders();
        if (isAdmin()) await loadManageMatches();
    } else {
        showToast(result?.data?.detail || t('groupDetail.deleteFailed'));
    }
}

document.getElementById('btn-create-folder').addEventListener('click', async () => {
    const name    = document.getElementById('input-new-folder-name').value.trim();
    const errorEl = document.getElementById('folder-manage-error');
    errorEl.textContent = '';

    if (!name) {
        errorEl.textContent = t('groupDetail.folderNameRequired');
        return;
    }

    const btn = document.getElementById('btn-create-folder');
    btn.disabled = true;
    btn.textContent = t('groupDetail.creatingFolder');

    try {
        const result = await apiFetch(`/api/groups/${groupId}/friendly-folders`, {
            method: 'POST',
            body: JSON.stringify({ name }),
        });
        if (result?.ok) {
            document.getElementById('input-new-folder-name').value = '';
            await loadFolders();
        } else {
            errorEl.textContent = result?.data?.detail || t('groupDetail.folderCreateFailed');
        }
    } finally {
        btn.disabled = false;
        btn.textContent = t('groupDetail.createFolder');
    }
});

document.getElementById('input-new-folder-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-create-folder').click();
});

async function loadManageMatches() {
    const result = await apiFetch(`/api/groups/${groupId}/matches/friendly`);
    manageMatches = result?.ok ? result.data : [];
    selectedManageIds.clear();
    renderManageMatchList();
}

function renderManageMatchList() {
    const el = document.getElementById('folder-manage-match-list');

    if (!manageMatches.length) {
        el.innerHTML = `<p class="empty-msg-sm">${t('groupDetail.noFriendlyMatches')}</p>`;
        return;
    }

    el.innerHTML = manageMatches.map(m => {
        const isDraw = !m.winner_id;
        const p1Win  = m.winner_id === m.player1_id;
        const p2Win  = m.winner_id === m.player2_id;
        const folderTag = m.folder_id
            ? `<span class="official-badge friendly">${escapeHtml(m.folder_name)}</span>`
            : `<span class="official-badge unfoldered">${t('groupDetail.unfoldered')}</span>`;
        return `
            <label class="folder-manage-row">
                <input type="checkbox" class="manage-match-checkbox" data-match-id="${m.id}" ${selectedManageIds.has(m.id) ? 'checked' : ''}>
                <span class="match-players">
                    <span class="${p1Win ? 'match-winner-name' : ''}">${escapeHtml(nameWithRating(m.player1_nickname, m.player1_rating))}</span>
                    <span class="match-vs-sm">vs</span>
                    <span class="${p2Win ? 'match-winner-name' : ''}">${escapeHtml(nameWithRating(m.player2_nickname, m.player2_rating))}</span>
                </span>
                <span class="match-result ${isDraw ? 'draw' : ''}">${resultLabel(isDraw)}</span>
                ${folderTag}
            </label>`;
    }).join('');

    el.querySelectorAll('.manage-match-checkbox').forEach(cb => {
        cb.addEventListener('change', () => {
            const id = parseInt(cb.dataset.matchId);
            if (cb.checked) selectedManageIds.add(id);
            else selectedManageIds.delete(id);
        });
    });
}

async function assignSelectedMatches(folderId) {
    const errorEl = document.getElementById('folder-manage-error');
    errorEl.textContent = '';

    if (!selectedManageIds.size) {
        errorEl.textContent = t('groupDetail.selectAtLeastOneMatch');
        return;
    }
    if (folderId !== null && !folderId) {
        errorEl.textContent = t('groupDetail.selectFolderRequired');
        return;
    }

    const result = await apiFetch(`/api/groups/${groupId}/friendly-matches/assign-folder`, {
        method: 'POST',
        body: JSON.stringify({ match_ids: [...selectedManageIds], folder_id: folderId }),
    });

    if (result?.ok) {
        await loadFolders();
        await loadManageMatches();
    } else {
        errorEl.textContent = result?.data?.detail || t('groupDetail.processingFailed');
    }
}

document.getElementById('btn-assign-to-folder').addEventListener('click', () => {
    const folderId = parseInt(document.getElementById('select-assign-folder').value);
    assignSelectedMatches(isNaN(folderId) ? undefined : folderId);
});

document.getElementById('btn-remove-from-folder').addEventListener('click', () => {
    assignSelectedMatches(null);
});

// ===== API 액션 =====

async function deletePoll(pollId) {
    if (!await showConfirm(t('groupDetail.confirmDeletePoll'), { danger: true, okText: t('common.delete') })) return;
    const result = await apiFetch(`/api/polls/${pollId}`, { method: 'DELETE' });
    if (result?.ok) {
        await refreshPage();
    } else {
        showToast(result?.data?.detail || t('groupDetail.deleteFailed'));
    }
}

async function deleteMatch(matchId, folderId = null) {
    if (!await showConfirm(t('groupDetail.confirmDeleteMatch'), { danger: true, okText: t('common.delete') })) return;
    const result = await apiFetch(`/api/matches/${matchId}`, { method: 'DELETE' });
    if (!result?.ok) {
        showToast(result?.data?.detail || t('groupDetail.deleteFailed'));
        return;
    }
    if (folderId) {
        const folderResult = await apiFetch(`/api/friendly-folders/${folderId}/matches`);
        folderMatchCache[folderId] = folderResult?.ok ? folderResult.data.matches : [];
        renderFolderMatches(folderId);
        if (isAdmin()) await loadManageMatches();
    }
    await refreshPage();
}

async function toggleVote(pollId, btn) {
    if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner-sm"></span>${t('groupDetail.processing')}`; }
    const result = await apiFetch(`/api/polls/${pollId}/vote`, { method: 'POST' });
    if (result?.ok) {
        await refreshPoll();
    } else {
        if (btn) { btn.disabled = false; btn.textContent = btn.classList.contains('voted') ? t('groupDetail.cancelParticipation') : t('groupDetail.participate'); }
        showToast(result?.data?.detail || t('groupDetail.errorOccurred'));
    }
}

async function cancelMemberVote(pollId, userId, userName, btn) {
    if (!await showConfirm(t('groupDetail.confirmCancelVote', { name: userName }), { danger: true, okText: t('groupDetail.cancelVote') })) return;

    if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner-sm"></span>${t('groupDetail.cancelling')}`; }
    const result = await apiFetch(`/api/polls/${pollId}/votes/${userId}`, { method: 'DELETE' });
    if (result?.ok) {
        await refreshPoll();
    } else {
        if (btn) { btn.disabled = false; btn.textContent = t('groupDetail.cancelVote'); }
        showToast(result?.data?.detail || t('groupDetail.cancelVoteFailed'));
    }
}

async function closePoll(pollId, voteCount, btn) {
    if (voteCount < 2) {
        showToast(t('groupDetail.needTwoParticipants'), 'info');
        return;
    }
    if (!await showConfirm(t('groupDetail.confirmClosePoll', { count: voteCount }))) return;

    if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner-sm"></span>${t('groupDetail.processing')}`; }
    const result = await apiFetch(`/api/polls/${pollId}/close`, { method: 'POST' });
    if (result?.ok) {
        await refreshPage();
    } else {
        if (btn) { btn.disabled = false; btn.textContent = t('groupDetail.closePollShort'); }
        showToast(result?.data?.detail || t('groupDetail.errorOccurred'));
    }
}

async function reopenPoll(pollId, btn) {
    if (!await showConfirm(t('groupDetail.confirmReopenPoll'), { danger: true })) return;
    if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner-sm"></span>${t('groupDetail.processing')}`; }
    const result = await apiFetch(`/api/polls/${pollId}/reopen`, { method: 'POST' });
    if (result?.ok) {
        await refreshPoll();
    } else {
        if (btn) { btn.disabled = false; btn.textContent = t('groupDetail.reopenPoll'); }
        showToast(result?.data?.detail || t('groupDetail.errorOccurred'));
    }
}

// ===== 결과 기록 모달 =====

function openResultModal(matchId, p1Id, p1Name, p2Id, p2Name) {
    pendingMatchId = matchId;
    pendingP1Id    = p1Id;
    pendingP2Id    = p2Id;
    document.getElementById('result-match-label').textContent = `${p1Name} vs ${p2Name}`;
    document.getElementById('btn-p1-win').textContent = t('groupDetail.winnerAnnounce', { name: p1Name });
    document.getElementById('btn-p2-win').textContent = t('groupDetail.winnerAnnounce', { name: p2Name });
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
            result?.data?.detail || t('groupDetail.errorOccurred');
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
        errorEl.textContent = t('groupDetail.pgnRequired');
        return;
    }

    // chess.js로 프론트엔드 유효성 검사
    if (!isValidPgn(pgn)) {
        errorEl.textContent = t('groupDetail.pgnInvalid');
        return;
    }

    const btn = document.getElementById('btn-confirm-pgn');
    btn.disabled = true;
    btn.textContent = t('groupDetail.saving');

    try {
        const result = await apiFetch(`/api/matches/${pendingPgnMatchId}/pgn`, {
            method: 'PATCH',
            body: JSON.stringify({ pgn_data: pgn }),
        });
        if (result?.ok) {
            document.getElementById('modal-pgn-edit').classList.add('hidden');
            await refreshPage();
        } else {
            errorEl.textContent = result?.data?.detail || t('groupDetail.saveFailed');
        }
    } finally {
        btn.disabled = false;
        btn.textContent = t('common.save');
    }
});

// ===== 기보 뷰어 =====

function openPgnViewer(pgn, p1Name, p2Name) {
    // PGN 파싱하여 포지션 목록 생성
    try {
        const chess = new Chess();
        if (!chess.load_pgn(pgn)) {
            showToast(t('groupDetail.pgnLoadFailed'));
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
        showToast(t('groupDetail.pgnLoadFailed'));
        return;
    }

    pgnMoveIndex = 0;

    document.getElementById('pgn-viewer-title').textContent = `${p1Name} vs ${p2Name}`;
    document.getElementById('pgn-player-white').textContent = `⬜ ${t('groupDetail.whiteLabel')}: ${p1Name}`;
    document.getElementById('pgn-player-black').textContent = `⬛ ${t('groupDetail.blackLabel')}: ${p2Name}`;
    document.getElementById('modal-pgn-viewer').classList.remove('hidden');

    // 보드 크기 계산 (모달 내부 너비 기준, 왼쪽 평가 막대 22px + 간격 6px 제외)
    const modalContent = document.querySelector('#modal-pgn-viewer .modal-content');
    const availableWidth = modalContent ? modalContent.clientWidth - 48 - 28 : 312;
    const boardSize = Math.min(380, availableWidth);
    document.getElementById('pgn-eval-bar').classList.remove('flipped');

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
        initEngine();
        updateEval();
    });
}

// ===== 형세 평가 막대 (Stockfish를 보는 사람의 브라우저 Web Worker에서 실행) =====

const EVAL_DEPTH = 16;
let sfWorker     = null;   // 처음 기보를 열 때 만든다 (엔진 파일 ≈7MB는 이때 한 번만 내려받음)
let sfReady      = false;  // uciok → isready → readyok 까지 끝남
let sfFailed     = false;  // Worker/WASM을 쓸 수 없는 환경이면 막대를 숨긴다
let sfSearching  = false;
let sfCurrentFen = null;   // 지금 탐색 중인 국면
let sfPendingFen = null;   // 지금 탐색을 멈춘 뒤 이어서 볼 국면
const evalCache  = {};     // fen → { cp | mate (백 기준), depth }

function initEngine() {
    if (sfWorker || sfFailed) return;
    try {
        if (typeof WebAssembly !== 'object') throw new Error('no wasm');
        sfWorker = new Worker('../vendor/stockfish/stockfish-18-lite-single.js');
    } catch {
        sfFailed = true;
        renderEvalBar();
        return;
    }
    sfWorker.onmessage = e => onEngineLine(String(e.data));
    sfWorker.onerror = () => {
        sfFailed = true;
        sfWorker = null;
        renderEvalBar();
    };
    sfWorker.postMessage('uci');
}

function startSearch() {
    sfCurrentFen = sfPendingFen;
    sfPendingFen = null;
    sfSearching  = true;
    sfWorker.postMessage(`position fen ${sfCurrentFen}`);
    sfWorker.postMessage(`go depth ${EVAL_DEPTH}`);
}

function onEngineLine(line) {
    if (line === 'uciok') {
        sfWorker.postMessage('setoption name Hash value 16');
        sfWorker.postMessage('isready');
    } else if (line === 'readyok') {
        sfReady = true;
        if (sfPendingFen) startSearch();
    } else if (line.startsWith('bestmove')) {
        sfSearching = false;
        if (sfPendingFen) startSearch();
    } else if (line.startsWith('info') && sfCurrentFen && !sfPendingFen) {
        // 경계값(lowerbound/upperbound)은 확정 점수가 아니므로 건너뛴다
        const m = line.match(/ depth (\d+) .*?score (cp|mate) (-?\d+)/);
        if (!m || / (lower|upper)bound/.test(line)) return;
        const sign = sfCurrentFen.split(' ')[1] === 'w' ? 1 : -1;   // 엔진 점수는 둘 차례 기준 → 백 기준으로
        const val  = sign * parseInt(m[3], 10);
        evalCache[sfCurrentFen] = { [m[2]]: val, depth: parseInt(m[1], 10) };
        if (sfCurrentFen === pgnPositions[pgnMoveIndex]) renderEvalBar();
    }
}

// 현재 국면 평가: 캐시가 충분히 깊으면 그대로, 아니면 엔진에 맡긴다(진행 중 탐색은 멈추고 교체)
function updateEval() {
    const fen = pgnPositions[pgnMoveIndex];
    renderEvalBar();
    if (!sfWorker || sfFailed || !fen || gameOverResult(fen)) return;
    if (evalCache[fen]?.depth >= EVAL_DEPTH) return;
    sfPendingFen = fen;
    if (!sfReady) return;                    // readyok 때 시작
    if (sfSearching) sfWorker.postMessage('stop');   // bestmove를 받으면 이어서 시작
    else startSearch();
}

function stopEngine() {
    sfPendingFen = null;
    if (sfWorker && sfSearching) sfWorker.postMessage('stop');
}

// 체크메이트·스테일메이트 등 끝난 국면은 엔진 없이 결과를 표시
function gameOverResult(fen) {
    const c = new Chess(fen);
    if (c.in_checkmate()) return c.turn() === 'w' ? '0-1' : '1-0';
    if (c.in_stalemate() || c.insufficient_material()) return '½';
    return null;
}

function renderEvalBar() {
    const bar = document.getElementById('pgn-eval-bar');
    bar.classList.toggle('hidden', sfFailed);
    if (sfFailed) return;

    const fen    = pgnPositions[pgnMoveIndex];
    const over   = fen ? gameOverResult(fen) : null;
    const ev     = fen ? evalCache[fen] : null;
    const fill   = bar.querySelector('.pgn-eval-fill');
    const labelEl = bar.querySelector('.pgn-eval-label');
    let whitePct = null, label = '…';

    if (over) {
        whitePct = over === '1-0' ? 100 : over === '0-1' ? 0 : 50;
        label = over;
    } else if (ev && 'mate' in ev) {
        whitePct = ev.mate > 0 ? 100 : 0;
        label = `M${Math.abs(ev.mate)}`;
    } else if (ev) {
        // Lichess와 같은 승률 곡선: 점수(센티폰) → 백 몫(%)
        whitePct = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * ev.cp)) - 1);
        const pawns = Math.abs(ev.cp) / 100;
        label = pawns >= 10 ? pawns.toFixed(0) : pawns.toFixed(1);
    }

    bar.classList.toggle('is-loading', !over && !ev);
    if (whitePct !== null) {     // 계산 중이면 막대는 직전 값 그대로 둔다
        fill.style.height = `${whitePct}%`;
        bar.classList.toggle('black-better', whitePct < 50);
    }
    labelEl.textContent = label;
}

// 기보 창을 닫으면 탐색을 멈춘다 (닫는 경로가 여러 곳이라 클래스 변화를 지켜본다)
new MutationObserver(() => {
    if (document.getElementById('modal-pgn-viewer').classList.contains('hidden')) stopEngine();
}).observe(document.getElementById('modal-pgn-viewer'), { attributes: true, attributeFilter: ['class'] });

function renderMoveList() {
    const el = document.getElementById('pgn-move-list');
    if (!pgnSans.length) {
        el.innerHTML = `<span class="pgn-no-moves">${t('groupDetail.noMoves')}</span>`;
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

    // 현재 활성 수가 보이도록 수 목록 상자 안에서만 스크롤한다.
    // scrollIntoView는 기보 창·페이지까지 함께 스크롤해 체스판이 밀려나므로 쓰지 않는다.
    const active = el.querySelector('.pgn-move-san.active');
    if (!active) {
        el.scrollTop = 0;   // 시작 국면(선택된 수 없음)이면 목록 맨 위로
    } else {
        const box = el.getBoundingClientRect();
        const r   = active.getBoundingClientRect();
        if (r.top < box.top)            el.scrollTop -= box.top - r.top + 4;
        else if (r.bottom > box.bottom) el.scrollTop += r.bottom - box.bottom + 4;
    }
}

// Lichess 분석판 주소: 수순만 넘기므로 Lichess에 경기가 저장되지 않고, #ply로 현재 수에서 열린다
function lichessAnalysisUrl() {
    const moves = pgnSans.map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}. ` : '') + san).join(' ');
    return `https://lichess.org/analysis/pgn/${encodeURIComponent(moves)}#${pgnMoveIndex}`;
}

function updateViewerControls() {
    const lichessBtn = document.getElementById('pgn-btn-lichess');
    lichessBtn.classList.toggle('hidden', !pgnSans.length);
    lichessBtn.href = pgnSans.length ? lichessAnalysisUrl() : '#';

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
    updateEval();
}

document.getElementById('pgn-btn-first').addEventListener('click', () => pgnGoTo(0));
document.getElementById('pgn-btn-prev').addEventListener('click',  () => pgnGoTo(pgnMoveIndex - 1));
document.getElementById('pgn-btn-next').addEventListener('click',  () => pgnGoTo(pgnMoveIndex + 1));
document.getElementById('pgn-btn-last').addEventListener('click',  () => pgnGoTo(pgnPositions.length - 1));
document.getElementById('pgn-btn-flip').addEventListener('click', () => {
    if (pgnBoardInst) pgnBoardInst.orientation('flip');
    document.getElementById('pgn-eval-bar').classList.toggle('flipped');
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

// ===== 경기 수정 모달 =====

function openEditMatchModal(matchId, pollId = null) {
    const d = matchDataCache[matchId];
    if (!d) return;

    editMatchMode      = 'edit';
    pendingEditPollId  = pollId;
    pendingEditMatchId = matchId;

    const options = currentMembers.map(m =>
        `<option value="${m.id}">${escapeHtml(m.nickname)}</option>`
    ).join('');

    const p1Select = document.getElementById('edit-player1');
    const p2Select = document.getElementById('edit-player2');
    p1Select.innerHTML = options;
    p2Select.innerHTML = options;
    p1Select.value = String(d.p1Id);
    p2Select.value = String(d.p2Id);

    if (d.status === 'finished') {
        if (d.winnerId === d.p1Id)      selectedEditResult = 'p1_win';
        else if (d.winnerId === d.p2Id) selectedEditResult = 'p2_win';
        else                             selectedEditResult = 'draw';
    } else {
        selectedEditResult = 'none';
    }

    document.querySelector('#modal-edit-match .modal-title').textContent = t('groupDetail.editMatchTitle');
    updateEditResultButtons();
    document.getElementById('edit-match-error').textContent = '';
    document.getElementById('modal-edit-match').classList.remove('hidden');
}

function openAddMatchModal(pollId, context = 'history') {
    editMatchMode     = 'add';
    editMatchContext  = context;
    pendingEditPollId = pollId;
    pendingEditMatchId = null;

    const options = currentMembers.map(m =>
        `<option value="${m.id}">${escapeHtml(m.nickname)}</option>`
    ).join('');

    const p1Select = document.getElementById('edit-player1');
    const p2Select = document.getElementById('edit-player2');
    p1Select.innerHTML = options;
    p2Select.innerHTML = options;
    if (currentMembers.length >= 2) {
        p1Select.value = String(currentMembers[0].id);
        p2Select.value = String(currentMembers[1].id);
    }

    selectedEditResult = 'p1_win';
    document.querySelector('#modal-edit-match .modal-title').textContent = t('groupDetail.addMatchTitle');
    updateEditResultButtons();
    document.getElementById('edit-match-error').textContent = '';
    document.getElementById('modal-edit-match').classList.remove('hidden');
}

function updateEditResultButtons() {
    const p1Sel  = document.getElementById('edit-player1');
    const p2Sel  = document.getElementById('edit-player2');
    const p1Name = p1Sel.options[p1Sel.selectedIndex]?.text || t('groupDetail.whiteShort');
    const p2Name = p2Sel.options[p2Sel.selectedIndex]?.text || t('groupDetail.blackShort');

    document.getElementById('btn-edit-p1-win').textContent = t('groupDetail.winParen', { name: p1Name, color: t('groupDetail.whiteShort') });
    document.getElementById('btn-edit-p2-win').textContent = t('groupDetail.winParen', { name: p2Name, color: t('groupDetail.blackShort') });

    document.querySelectorAll('.btn-edit-result').forEach(btn => {
        btn.classList.toggle('selected', btn.dataset.result === selectedEditResult);
        if (btn.dataset.result === 'none') {
            btn.classList.toggle('hidden', editMatchMode === 'add');
        }
    });
}

document.getElementById('btn-swap-players').addEventListener('click', () => {
    const p1Select = document.getElementById('edit-player1');
    const p2Select = document.getElementById('edit-player2');
    const tmp = p1Select.value;
    p1Select.value = p2Select.value;
    p2Select.value = tmp;

    if (selectedEditResult === 'p1_win')      selectedEditResult = 'p2_win';
    else if (selectedEditResult === 'p2_win') selectedEditResult = 'p1_win';

    updateEditResultButtons();
});

document.getElementById('edit-player1').addEventListener('change', updateEditResultButtons);
document.getElementById('edit-player2').addEventListener('change', updateEditResultButtons);

document.querySelectorAll('.btn-edit-result').forEach(btn => {
    btn.addEventListener('click', () => {
        selectedEditResult = btn.dataset.result;
        updateEditResultButtons();
    });
});

document.getElementById('btn-confirm-edit-match').addEventListener('click', async () => {
    const p1Id   = parseInt(document.getElementById('edit-player1').value);
    const p2Id   = parseInt(document.getElementById('edit-player2').value);
    const errorEl = document.getElementById('edit-match-error');
    errorEl.textContent = '';

    if (p1Id === p2Id) {
        errorEl.textContent = t('groupDetail.playersMustDiffer');
        return;
    }
    if (editMatchMode === 'add' && selectedEditResult === 'none') {
        errorEl.textContent = t('groupDetail.resultRequired');
        return;
    }

    const btn = document.getElementById('btn-confirm-edit-match');
    btn.disabled = true;
    btn.textContent = t('groupDetail.saving');

    try {
        let apiResult;
        if (editMatchMode === 'add') {
            apiResult = await apiFetch(`/api/polls/${pendingEditPollId}/matches`, {
                method: 'POST',
                body: JSON.stringify({ player1_id: p1Id, player2_id: p2Id, result: selectedEditResult }),
            });
        } else {
            apiResult = await apiFetch(`/api/matches/${pendingEditMatchId}/edit`, {
                method: 'PUT',
                body: JSON.stringify({ player1_id: p1Id, player2_id: p2Id, result: selectedEditResult }),
            });
        }

        if (apiResult?.ok) {
            document.getElementById('modal-edit-match').classList.add('hidden');
            if (pendingEditPollId !== null) {
                if (editMatchContext === 'active') {
                    await refreshPoll();
                } else {
                    pollMatchCache[pendingEditPollId] = null;
                    await fetchPollMatches(pendingEditPollId);
                }
            } else {
                await refreshPage();
            }
        } else {
            errorEl.textContent = apiResult?.data?.detail || t('groupDetail.saveFailed');
        }
    } finally {
        btn.disabled = false;
        btn.textContent = t('common.save');
    }
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

    // 모든 요청을 한 번에 보내고, 역할(currentRole)이 정해진 뒤에 렌더링한다
    const [membersRes, pollRes, historyRes, meRes, annRes, matchesRes] = await Promise.all([
        apiFetch(`/api/groups/${groupId}/members`),
        apiFetch(`/api/groups/${groupId}/polls/active`),
        apiFetch(`/api/groups/${groupId}/history?page=1`),
        apiFetch('/api/me'),
        apiFetch(`/api/groups/${groupId}/announcements/latest`),
        apiFetch(`/api/groups/${groupId}/matches?limit=${RECENT_PAGE_SIZE}`),
    ]);
    await window.i18nReady;

    if (!membersRes?.ok) {
        if (membersRes?.status === 403 || membersRes?.status === 404) {
            window.location.href = '../lobby/lobby.html';
            return;
        }
        // 서버 연결 실패 등: 스켈레톤이 계속 돌지 않도록 실패 안내로 바꿈
        const failHtml = `<p class="empty-msg-sm">${t('groupDetail.loadFailed')}</p>`;
        ['announcement-latest', 'poll-section', 'recent-matches', 'match-history'].forEach(id => {
            document.getElementById(id).innerHTML = failHtml;
        });
        document.getElementById('member-list').innerHTML = `<li class="empty-msg-sm">${t('groupDetail.loadFailed')}</li>`;
        document.getElementById('group-name').textContent = '-';
        showToast(membersRes?.data?.detail || t('groupDetail.loadFailed'));
        return;
    }

    const { group, members, stats, current_role } = membersRes.data;

    currentGroup = group;
    renderGroupHeader();
    document.getElementById('member-count').textContent = t('lobby.memberCountLabel', { count: stats.member_count });

    currentMembers = members;
    currentRole    = current_role;
    if (meRes?.ok) currentUserId = meRes.data.id;

    document.getElementById('btn-group-settings').classList.toggle('hidden', currentRole === '회원');
    document.getElementById('btn-leave-group').classList.toggle('hidden', currentRole === '방장');
    document.getElementById('btn-write-announcement').classList.toggle('hidden', !isAdmin());

    renderMembers(members);

    const failHtml = `<p class="empty-msg-sm">${t('groupDetail.loadFailed')}</p>`;
    if (pollRes?.ok)    renderPollSection(pollRes.data);
    else                document.getElementById('poll-section').innerHTML = failHtml;
    if (historyRes?.ok) renderHistoryAccordion(historyRes.data);
    else                document.getElementById('match-history').innerHTML = failHtml;

    renderLatestAnnouncement(annRes?.ok ? annRes.data : null);
    if (matchesRes?.ok) {
        setRecentMatches(matchesRes.data);
    } else {
        document.getElementById('recent-matches').innerHTML =
            `<p class="empty-msg-sm">${t('groupDetail.loadFailed')}</p>`;
    }

    document.getElementById('activity-log-btn-row')
        .classList.toggle('hidden', !isAdmin());
}

// ===== 활동 기록 =====

const ACTION_KEY_MAP = {
    '투표_종료':     'pollClose',
    '투표_재개':     'pollReopen',
    '투표_삭제':     'pollDelete',
    '투표_취소':     'voteCancel',
    '경기_결과기록': 'matchRecord',
    '경기_결과수정': 'matchResultEdit',
    '경기_수정':     'matchEdit',
    '경기_추가':     'matchAdd',
    '경기_삭제':     'matchDelete',
    '친선경기_기록': 'friendlyRecord',
    '폴더_생성':     'folderCreate',
    '폴더_수정':     'folderEdit',
    '폴더_삭제':     'folderDelete',
    '친선경기_폴더담기': 'folderAssign',
    '친선경기_폴더빼기': 'folderRemove',
    '멤버_강퇴':     'memberKick',
    '멤버_탈퇴':     'memberLeave',
    '역할_변경':     'roleChange',
    '방장_위임':     'ownerTransfer',
    '그룹_이름변경': 'groupRename',
    '초대코드_재발급': 'inviteRegen',
};

const ACTION_COLORS = {
    '투표_종료':     '#5b8dd9',
    '투표_재개':     '#7b9ed4',
    '투표_삭제':     '#e07070',
    '투표_취소':     '#9b9b9b',
    '경기_결과기록': '#4caf87',
    '경기_결과수정': '#f0a04b',
    '경기_수정':     '#f0a04b',
    '경기_추가':     '#4caf87',
    '경기_삭제':     '#e07070',
    '친선경기_기록': '#6fcf97',
    '폴더_생성':     '#7b9ed4',
    '폴더_수정':     '#f0a04b',
    '폴더_삭제':     '#e07070',
    '친선경기_폴더담기': '#6fcf97',
    '친선경기_폴더빼기': '#9b9b9b',
    '멤버_강퇴':     '#e07070',
    '멤버_탈퇴':     '#9b9b9b',
    '역할_변경':     '#9b7ed4',
    '방장_위임':     '#9b7ed4',
    '그룹_이름변경': '#7b9ed4',
    '초대코드_재발급': '#f0a04b',
};

const ACTIVITY_PAGE_SIZE = 50;
let activityLogs = [];

// append=true면 지금까지 불러온 기록 뒤에 다음 페이지를 이어 붙인다 (선택된 필터 기준)
async function loadActivityLogs(append = false) {
    const el     = document.getElementById('activity-log-list');
    const filter = document.getElementById('activity-log-filter')?.value || '';
    const params = new URLSearchParams({ limit: ACTIVITY_PAGE_SIZE, offset: append ? activityLogs.length : 0 });
    if (filter) params.set('action', filter);
    if (!append) el.innerHTML = skeletonHtml(5);

    const result = await apiFetch(`/api/groups/${groupId}/activity-logs?${params}`);
    if (!result?.ok) {
        if (append) showToast(result?.data?.detail || t('groupDetail.loadFailed'));
        else el.innerHTML = `<p class="empty-msg-sm">${t('groupDetail.loadFailed')}</p>`;
        return;
    }
    activityLogs = append ? activityLogs.concat(result.data) : result.data;
    renderActivityLogs(activityLogs, result.data.length === ACTIVITY_PAGE_SIZE);
}

function renderActivityLogs(logs, hasMore = false) {
    const el = document.getElementById('activity-log-list');
    if (!logs.length) {
        el.innerHTML = `<p class="empty-msg-sm">${t('groupDetail.noActivityLogs')}</p>`;
        return;
    }
    el.innerHTML = logs.map(log => {
        const label = ACTION_KEY_MAP[log.action] ? t('groupDetail.action.' + ACTION_KEY_MAP[log.action]) : log.action;
        const color = ACTION_COLORS[log.action] || 'var(--color-primary)';
        const time  = log.created_at.replace('T', ' ').slice(0, 16);
        return `
            <div class="activity-log-item">
                <span class="activity-badge" style="background:${color}">${label}</span>
                <div class="activity-content">
                    <span class="activity-actor">${escapeHtml(log.actor)}</span>
                    <span class="activity-detail">${escapeHtml(log.detail)}</span>
                </div>
                <span class="activity-time">${time}</span>
            </div>`;
    }).join('') + (hasMore
        ? `<button type="button" class="btn-load-more" id="btn-more-activity">${t('groupDetail.loadMore')}</button>`
        : '');

    document.getElementById('btn-more-activity')?.addEventListener('click', (e) => {
        e.currentTarget.disabled = true;
        e.currentTarget.textContent = t('common.loading');
        loadActivityLogs(true);
    });
}

document.getElementById('activity-log-filter').addEventListener('change', () => loadActivityLogs());

document.getElementById('btn-open-activity-log').addEventListener('click', async () => {
    document.getElementById('modal-activity-log').classList.remove('hidden');
    await loadActivityLogs();
});

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
        btn.textContent = t('groupDetail.copied');
        setTimeout(() => { btn.textContent = t('groupDetail.copy'); }, 1500);
    } catch { /* 미지원 환경 무시 */ }
});

// ===== 로그아웃 =====

document.getElementById('btn-logout').addEventListener('click', () => {
    localStorage.removeItem('token');
    localStorage.removeItem('username');
    localStorage.removeItem('nickname');
    window.location.href = '../login/login.html';
});

// ===== 실행 =====

// 전체 화면 로더는 번역이 적용될 때까지만(언어가 바뀌어 보이는 깜빡임 방지) 덮고,
// 데이터는 각 섹션의 스켈레톤 자리에 도착하는 대로 채운다 (서버가 깨어나는 데 오래 걸려도 화면 구조가 바로 보이게).
window.i18nReady.finally(() => document.getElementById('page-loader').classList.add('hidden'));
refreshPage();
