const API_BASE = 'http://localhost:8000';

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

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ===== 초기화 =====

async function init() {
    await loadCurrentUser();
    await loadGroups();
}

// ===== 유저 정보 =====

async function loadCurrentUser() {
    const result = await apiFetch('/api/me');
    if (!result || !result.ok) return;
    document.getElementById('user-nickname').textContent = result.data.nickname;
}

// ===== 그룹 목록 =====

async function loadGroups() {
    const result = await apiFetch('/api/groups');
    if (!result) return;

    const list     = document.getElementById('groups-list');
    const emptyMsg = document.getElementById('groups-empty');

    if (!result.ok) {
        emptyMsg.textContent = '그룹 목록을 불러오지 못했습니다.';
        return;
    }

    list.querySelectorAll('.group-card').forEach(el => el.remove());

    if (result.data.length === 0) {
        emptyMsg.style.display = '';
        return;
    }

    emptyMsg.style.display = 'none';
    result.data.forEach(group => list.appendChild(createGroupCard(group)));
}

function createGroupCard(group) {
    const card = document.createElement('div');
    card.className  = 'group-card';
    card.dataset.id = group.id;
    card.innerHTML  = `
        <div class="group-info">
            <span class="group-name">${escapeHtml(group.name)}</span>
            <div class="group-meta">
                <span>방장: ${escapeHtml(group.owner_nickname)}</span>
                <span>멤버 ${group.member_count}명</span>
                <span>초대 코드: <code class="invite-code">${escapeHtml(group.invite_code)}</code></span>
            </div>
        </div>
        <span class="group-arrow">&#8594;</span>
    `;
    card.addEventListener('click', () => {
        window.location.href = `../group_detail/group_detail.html?group_id=${group.id}`;
    });
    return card;
}

// ===== 그룹 생성 =====

document.getElementById('btn-create-group').addEventListener('click', () => {
    document.getElementById('input-group-name').value = '';
    document.getElementById('create-error').textContent = '';
    openModal('modal-create');
    document.getElementById('input-group-name').focus();
});

document.getElementById('btn-confirm-create').addEventListener('click', async () => {
    const name    = document.getElementById('input-group-name').value.trim();
    const errorEl = document.getElementById('create-error');
    errorEl.textContent = '';

    if (!name) {
        errorEl.textContent = '그룹 이름을 입력해주세요.';
        return;
    }

    const btn = document.getElementById('btn-confirm-create');
    btn.disabled    = true;
    btn.textContent = '생성 중...';

    try {
        const result = await apiFetch('/api/groups', {
            method: 'POST',
            body: JSON.stringify({ name }),
        });
        if (!result) return;

        if (!result.ok) {
            errorEl.textContent = result.data.detail || '그룹 생성에 실패했습니다.';
            return;
        }

        closeModal('modal-create');
        await loadGroups();
    } finally {
        btn.disabled    = false;
        btn.textContent = '만들기';
    }
});

document.getElementById('input-group-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-confirm-create').click();
});

// ===== 그룹 참가 =====

document.getElementById('btn-join-group').addEventListener('click', () => {
    document.getElementById('input-invite-code').value = '';
    document.getElementById('join-error').textContent = '';
    openModal('modal-join');
    document.getElementById('input-invite-code').focus();
});

document.getElementById('btn-confirm-join').addEventListener('click', async () => {
    const inviteCode = document.getElementById('input-invite-code').value.trim();
    const errorEl    = document.getElementById('join-error');
    errorEl.textContent = '';

    if (!inviteCode) {
        errorEl.textContent = '초대 코드를 입력해주세요.';
        return;
    }

    const btn = document.getElementById('btn-confirm-join');
    btn.disabled    = true;
    btn.textContent = '참가 중...';

    try {
        const result = await apiFetch('/api/groups/join', {
            method: 'POST',
            body: JSON.stringify({ invite_code: inviteCode }),
        });
        if (!result) return;

        if (!result.ok) {
            errorEl.textContent = result.data.detail || '그룹 참가에 실패했습니다.';
            return;
        }

        closeModal('modal-join');
        await loadGroups();
    } finally {
        btn.disabled    = false;
        btn.textContent = '참가';
    }
});

document.getElementById('input-invite-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-confirm-join').click();
});

// ===== 로그아웃 =====

document.getElementById('btn-logout').addEventListener('click', () => {
    localStorage.clear();
    window.location.href = '../login/login.html';
});

// ===== 모달 유틸 =====

function openModal(id) {
    document.getElementById(id).classList.remove('hidden');
}

function closeModal(id) {
    document.getElementById(id).classList.add('hidden');
}

document.querySelectorAll('.btn-cancel').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.modal));
});

document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', () => {
        document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
    });
});

// ===== 실행 =====

init();
