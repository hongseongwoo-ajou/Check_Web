// 모든 페이지 공통 다국어(i18n) 부트스트랩.
// i18next + i18next-http-backend(번역 JSON 로드) + i18next-browser-languagedetector
// (localStorage에 저장된 언어 → 없으면 브라우저 언어 순으로 감지) 조합으로 동작한다.
//
// 사용법: 정적 텍스트는 `data-i18n="키"` (textContent), `data-i18n-html="키"` (innerHTML, 문구에
// <strong> 등 마크업이 포함된 경우), `data-i18n-placeholder="키"` / `data-i18n-title="키"` 속성을
// 엘리먼트에 붙여두면 초기 로드와 언어 변경 시 자동으로 채워진다.
// JS 코드에서 동적으로 문자열이 필요하면 전역 `window.t('키')`를 사용한다.
// 번역 파일은 비동기로 로드되므로, t()로 화면을 그리는 코드는 먼저 `await window.i18nReady`를 거친다
// (그 전에 t()를 부르면 번역 대신 키 문자열이 그대로 찍힌다).
//
// 언어 전환 시 JS로 그린 동적 콘텐츠까지 바꾸기 위해 페이지를 새로고침한다.
// 정적 문구만 있는 페이지는 <body data-i18n-static>을 달아 새로고침 없이 data-i18n만 갱신한다.
(function () {
    let resolveReady;
    window.i18nReady = new Promise((resolve) => { resolveReady = resolve; });

    if (typeof i18next === 'undefined') {
        console.error('[i18n] i18next 라이브러리를 불러오지 못했습니다.');
        window.t = (key) => key;
        resolveReady();
        return;
    }

    function applyTranslations(root) {
        const scope = root || document;

        scope.querySelectorAll('[data-i18n]').forEach((el) => {
            el.textContent = i18next.t(el.getAttribute('data-i18n'));
        });
        scope.querySelectorAll('[data-i18n-html]').forEach((el) => {
            el.innerHTML = i18next.t(el.getAttribute('data-i18n-html'));
        });
        scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
            el.setAttribute('placeholder', i18next.t(el.getAttribute('data-i18n-placeholder')));
        });
        scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
            const text = i18next.t(el.getAttribute('data-i18n-title'));
            el.setAttribute('title', text);
            if (el.hasAttribute('aria-label')) el.setAttribute('aria-label', text);
        });

        document.querySelectorAll('.lang-btn').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.lang === (i18next.resolvedLanguage || i18next.language));
        });
        document.documentElement.lang = i18next.resolvedLanguage || i18next.language || 'ko';
    }

    i18next
        .use(i18nextHttpBackend)
        .use(i18nextBrowserLanguageDetector)
        .init({
            fallbackLng: 'ko',
            supportedLngs: ['ko', 'en'],
            nonExplicitSupportedLngs: true,
            load: 'languageOnly',
            debug: false,
            backend: {
                // 모든 페이지가 frontend/<page>/<page>.html 형태라 항상 한 단계 위가 루트
                loadPath: '../locales/{{lng}}/translation.json',
            },
            detection: {
                order: ['localStorage', 'navigator'],
                lookupLocalStorage: 'i18nextLng',
                caches: ['localStorage'],
            },
            interpolation: { escapeValue: false },
        }, (err) => {
            if (err) console.error('[i18n] 초기화 실패:', err);
            applyTranslations();
            resolveReady();
        });

    i18next.on('languageChanged', () => applyTranslations());

    document.addEventListener('click', async (e) => {
        const btn = e.target.closest('.lang-btn');
        if (!btn) return;
        const lang = btn.dataset.lang;
        if (lang === (i18next.resolvedLanguage || i18next.language)) return;

        // changeLanguage가 끝나야 새 언어가 localStorage에 저장되어 새로고침 후에도 유지된다
        await i18next.changeLanguage(lang);
        if (!document.body.hasAttribute('data-i18n-static')) window.location.reload();
    });

    window.applyTranslations = applyTranslations;
    window.t = (key, opts) => i18next.t(key, opts);
})();
