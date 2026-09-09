// <head> 최상단에서 렌더링 전에 실행 — 저장된 테마(없으면 다크가 기본값)를 즉시 적용해
// 페이지가 다크로 그려졌다가 라이트로 바뀌는 깜빡임(FOUC)을 방지한다.
(function () {
    try {
        var saved = localStorage.getItem('theme');
        var theme = (saved === 'light' || saved === 'dark') ? saved : 'dark';
        document.documentElement.setAttribute('data-theme', theme);
    } catch (e) {
        document.documentElement.setAttribute('data-theme', 'dark');
    }
})();
