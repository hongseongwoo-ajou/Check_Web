const API_BASE = 'http://localhost:8000';

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
