// 모든 페이지 공통 다크/라이트 모드 토글. `.theme-toggle-btn` 클래스를 가진
// 버튼이 있는 페이지라면 별도 설정 없이 자동으로 동작한다.
// 아이콘은 체스 말 심볼 사용: 다크 모드 = 백킹(♔, 밝은 말), 라이트 모드 = 흑킹(♚, 어두운 말).
const THEME_ICON = { dark: '♔', light: '♚' };

function getCurrentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function _setToggleButtonIcons(theme) {
    document.querySelectorAll('.theme-toggle-btn').forEach((btn) => {
        const isLight = theme === 'light';
        btn.textContent = THEME_ICON[theme];
        btn.title = isLight ? '다크 모드로 전환' : '라이트 모드로 전환';
        btn.setAttribute('aria-label', btn.title);
    });
}

function applyTheme(theme, { animate = false } = {}) {
    document.documentElement.setAttribute('data-theme', theme);
    try {
        localStorage.setItem('theme', theme);
    } catch (e) {
        // localStorage 사용 불가 환경(프라이빗 모드 등) — 현재 세션에서만 적용
    }

    if (!animate) {
        _setToggleButtonIcons(theme);
        return;
    }

    // 클릭한 순간엔 회전+페이드 애니메이션을 재생하고, 가장 흐려지는 시점에
    // 맞춰 심볼을 바꿔치기해 전환이 자연스럽게 이어지도록 한다.
    document.querySelectorAll('.theme-toggle-btn').forEach((btn) => {
        btn.classList.remove('theme-toggle-spin');
        void btn.offsetWidth; // 강제 리플로우 — 애니메이션 재시작 보장
        btn.classList.add('theme-toggle-spin');
    });
    setTimeout(() => _setToggleButtonIcons(theme), 190);
}

document.querySelectorAll('.theme-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
        applyTheme(getCurrentTheme() === 'light' ? 'dark' : 'light', { animate: true });
    });
    btn.addEventListener('animationend', () => btn.classList.remove('theme-toggle-spin'));
});

// theme-init.js가 이미 심어둔 테마에 맞춰 버튼 아이콘 초기 상태를 동기화 (애니메이션 없이)
applyTheme(getCurrentTheme());
