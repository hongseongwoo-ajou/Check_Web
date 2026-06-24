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
        el.textContent = `정상 작동 중 — ${data.message}`;
        el.className = 'ok';
    } catch {
        el.textContent = '서버에 연결할 수 없습니다.';
        el.className = 'fail';
    }
}

checkServerStatus();
