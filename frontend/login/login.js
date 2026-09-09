const API_BASE = (() => {
    const { protocol, hostname, port } = window.location;
    if (protocol === 'file:') return 'http://localhost:8000';
    if ((hostname === 'localhost' || hostname === '127.0.0.1') && port !== '8000') return 'http://localhost:8000';
    return '';
})();

// ===== 자동 로그인: 저장된 토큰이 유효하면 로그인 폼을 건너뛰고 로비로 이동 =====

(async () => {
    const pageLoader = document.getElementById('page-loader');
    const savedToken = localStorage.getItem('token');

    if (!savedToken) {
        pageLoader.classList.add('hidden');
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/api/me`, {
            headers: { 'Authorization': `Bearer ${savedToken}` },
        });
        if (res.ok) {
            window.location.href = '../lobby/lobby.html';
            return; // 이동 중이므로 로더를 그대로 유지
        }
        // 토큰이 만료되었거나 서버에서 무효화된 경우에만 정리
        localStorage.removeItem('token');
        localStorage.removeItem('username');
        localStorage.removeItem('nickname');
    } catch {
        // 서버 연결 실패는 토큰 무효와 다르므로 지우지 않고 로그인 폼을 보여줌
    }

    pageLoader.classList.add('hidden');
})();

// 탭 전환
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        const target = tab.dataset.tab;
        document.getElementById('login-form').classList.toggle('hidden', target !== 'login');
        document.getElementById('register-form').classList.toggle('hidden', target !== 'register');
    });
});

// 아이디/비밀번호 형식 검증 (서버와 동일한 기준: 아이디 3~20자, 비밀번호 4자 이상)
function validateCredentials(username, password) {
    if (username.length < 3 || username.length > 20) {
        return t('auth.usernameLengthError');
    }
    if (password.length < 4) {
        return t('auth.passwordLengthError');
    }
    return null;
}

// 로그인
document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('login-error');
    errorEl.textContent = '';

    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;

    const validationError = validateCredentials(username, password);
    if (validationError) {
        errorEl.textContent = validationError;
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
        });
        const data = await res.json();

        if (!res.ok) {
            errorEl.textContent = data.detail || t('auth.loginFailed');
            return;
        }

        localStorage.setItem('token', data.access_token);
        localStorage.setItem('username', username);
        localStorage.setItem('nickname', data.nickname);
        window.location.href = '../lobby/lobby.html';
    } catch {
        errorEl.textContent = t('auth.serverUnreachable');
    }
});

// 회원가입
document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('register-error');
    const successEl = document.getElementById('register-success');
    errorEl.textContent = '';
    successEl.textContent = '';

    const username = document.getElementById('reg-username').value.trim();
    const nickname = document.getElementById('reg-nickname').value.trim();
    const password = document.getElementById('reg-password').value;

    const validationError = validateCredentials(username, password);
    if (validationError) {
        errorEl.textContent = validationError;
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, nickname, password }),
        });
        const data = await res.json();

        if (!res.ok) {
            errorEl.textContent = data.detail || t('auth.registerFailed');
            return;
        }

        successEl.textContent = t('auth.registerSuccess');
        document.getElementById('register-form').reset();
    } catch {
        errorEl.textContent = t('auth.serverUnreachable');
    }
});
