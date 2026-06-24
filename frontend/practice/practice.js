const API_BASE = (() => {
    const { protocol, hostname, port } = window.location;
    if (protocol === 'file:') return 'http://localhost:8000';
    if ((hostname === 'localhost' || hostname === '127.0.0.1') && port !== '8000') return 'http://localhost:8000';
    return '';
})();

// ===== 체스 기물 이미지 (Wikimedia Commons) =====

function pieceTheme(piece) {
    const wiki = {
        wK: '4/42/Chess_klt45.svg', wQ: '1/15/Chess_qlt45.svg',
        wR: '7/72/Chess_rlt45.svg', wB: 'b/b1/Chess_blt45.svg',
        wN: '7/70/Chess_nlt45.svg', wP: '4/45/Chess_plt45.svg',
        bK: 'f/f0/Chess_kdt45.svg', bQ: '4/47/Chess_qdt45.svg',
        bR: 'f/ff/Chess_rdt45.svg', bB: '9/98/Chess_bdt45.svg',
        bN: 'e/ef/Chess_ndt45.svg', bP: 'c/c7/Chess_pdt45.svg',
    };
    return 'https://upload.wikimedia.org/wikipedia/commons/' + wiki[piece];
}

// ===== 게임 상태 =====

var game  = new Chess();
var board = null;

// ===== 보드 이벤트 핸들러 =====

function onDragStart(source, piece) {
    // 게임 종료 후 드래그 금지
    if (game.game_over()) return false;
}

function onDrop(source, target) {
    var move = game.move({
        from: source,
        to: target,
        promotion: 'q',  // 폰 승급은 항상 퀸으로 자동 처리
    });

    // 규칙에 어긋나는 이동 → 원위치로 되돌리기
    if (move === null) return 'snapback';

    updateStatus();
    renderHistory();
}

function onSnapEnd() {
    board.position(game.fen());
}

// ===== 보드 초기화 =====

function initBoard() {
    var boardEl = document.getElementById('practice-board');
    var size = Math.min(boardEl.parentElement.offsetWidth - 32, 480);
    boardEl.style.width = size + 'px';

    board = Chessboard('practice-board', {
        draggable:  true,
        position:   'start',
        onDragStart: onDragStart,
        onDrop:      onDrop,
        onSnapEnd:   onSnapEnd,
        pieceTheme:  pieceTheme,
    });
}

// ===== 게임 상태 표시 =====

function updateStatus() {
    var turnDot  = document.getElementById('turn-dot');
    var turnText = document.getElementById('turn-text');
    var statusEl = document.getElementById('game-status');

    statusEl.textContent = '';
    statusEl.className   = 'game-status';

    if (game.in_checkmate()) {
        var winner = game.turn() === 'w' ? '흑' : '백';
        turnText.textContent = winner + ' 승리!';
        turnDot.className    = 'turn-dot ' + (game.turn() === 'w' ? 'black' : 'white');
        statusEl.textContent = '체크메이트';
        statusEl.className   = 'game-status checkmate';
        return;
    }

    if (game.in_draw()) {
        turnText.textContent = '무승부';
        turnDot.className    = 'turn-dot draw';
        statusEl.textContent = game.in_stalemate() ? '스테일메이트'
                             : game.insufficient_material() ? '기물 부족'
                             : '50수 규칙 또는 3회 반복';
        statusEl.className   = 'game-status draw';
        return;
    }

    var isWhite = game.turn() === 'w';
    turnDot.className    = 'turn-dot ' + (isWhite ? 'white' : 'black');
    turnText.textContent = (isWhite ? '백' : '흑') + '의 차례';

    if (game.in_check()) {
        statusEl.textContent = '체크!';
        statusEl.className   = 'game-status check';
    }
}

// ===== 수순 렌더링 =====

function renderHistory() {
    var el      = document.getElementById('move-history');
    var history = game.history();

    if (!history.length) {
        el.innerHTML = '<p class="history-empty">아직 수가 없습니다.</p>';
        return;
    }

    var rows = '';
    for (var i = 0; i < history.length; i += 2) {
        var num   = Math.floor(i / 2) + 1;
        var white = history[i];
        var black = history[i + 1] || '';
        var isLastW = (i + 1 === history.length);
        var isLastB = (i + 2 === history.length);
        rows += '<div class="history-row">'
             + '<span class="h-num">' + num + '.</span>'
             + '<span class="h-move' + (isLastW && !black ? ' latest' : '') + '">' + white + '</span>'
             + '<span class="h-move' + (black && isLastB ? ' latest' : '') + '">' + (black || '') + '</span>'
             + '</div>';
    }

    el.innerHTML = rows;

    // 최신 수로 스크롤
    el.scrollTop = el.scrollHeight;
}

// ===== 컨트롤 버튼 =====

document.getElementById('btn-reset').addEventListener('click', function () {
    if (!game.history().length) return;
    if (!confirm('판을 초기화하시겠습니까?')) return;
    game.reset();
    board.position('start');
    updateStatus();
    renderHistory();
});

document.getElementById('btn-undo').addEventListener('click', function () {
    // 두 수를 취소해야 이전 내 차례로 돌아옴 (양쪽 모두 조작하므로 1수만 취소)
    if (game.history().length === 0) return;
    game.undo();
    board.position(game.fen());
    updateStatus();
    renderHistory();
});

document.getElementById('btn-flip').addEventListener('click', function () {
    board.flip();
});

// ===== 키보드 단축키 =====

document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') {
        // 무르기
        if (game.history().length > 0) {
            game.undo();
            board.position(game.fen());
            updateStatus();
            renderHistory();
        }
    }
});

// ===== 실행 =====

initBoard();
updateStatus();
