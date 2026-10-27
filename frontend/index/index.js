const API_BASE = (() => {
    const { protocol, hostname, port } = window.location;
    if (protocol === 'file:') return 'http://localhost:8000';
    if ((hostname === 'localhost' || hostname === '127.0.0.1') && port !== '8000') return 'http://localhost:8000';
    return '';
})();

async function checkServerStatus() {
    const el = document.getElementById('server-status');
    try {
        const res = await fetch(`${API_BASE}/health`);
        const data = await res.json();
        await window.i18nReady;
        el.textContent = `${t('index.serverOk')} — ${data.message}`;
        el.className = 'ok';
    } catch {
        await window.i18nReady;
        el.textContent = t('index.serverFail');
        el.className = 'fail';
    }
}

checkServerStatus();
