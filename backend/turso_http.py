"""
Minimal sqlite3-compatible wrapper for Turso HTTP API.
No native compilation needed — pure Python + requests.

트랜잭션: 파이썬 sqlite3처럼 첫 쓰기 문장(INSERT/UPDATE/DELETE/DDL) 직전에 암묵적으로 BEGIN 한다.
Hrana HTTP의 baton으로 스트림(= 서버 측 DB 연결 하나)을 유지해 이후 문장을 같은 트랜잭션에서
실행하고, commit()/rollback()에서 COMMIT/ROLLBACK 후 스트림을 닫는다.
트랜잭션 밖의 읽기는 지금처럼 요청마다 스트림을 열고 바로 닫는다(오래 걸리는 외부 API 호출 중
스트림이 유휴 상태로 만료되지 않도록).
"""
from collections.abc import Mapping
import re
import sqlite3
import requests
from requests.adapters import HTTPAdapter

# 프로세스 전체에서 공유하는 세션: 쿼리마다 TCP/TLS 연결을 새로 맺지 않고 keep-alive로 재사용.
# 핸들러가 스레드풀에서 동시에 실행되므로 풀 크기를 넉넉히 잡는다.
_session = requests.Session()
_session.mount("https://", HTTPAdapter(pool_connections=4, pool_maxsize=32))


def _parse_val(v):
    if v is None or v.get("type") == "null":
        return None
    t, val = v["type"], v.get("value")
    if t == "integer":
        return int(val)
    if t == "real":
        return float(val)
    return val


class TursoRow(Mapping):
    """Supports row["col"], row[0], dict(row), row.keys() — same as sqlite3.Row."""
    __slots__ = ("_cols", "_vals")

    def __init__(self, cols, row_data):
        self._cols = [c["name"] for c in cols]
        self._vals = [_parse_val(v) for v in row_data]

    def __getitem__(self, key):
        if isinstance(key, str):
            try:
                return self._vals[self._cols.index(key)]
            except ValueError:
                raise KeyError(key)
        return self._vals[key]

    def __iter__(self):
        return iter(self._cols)

    def __len__(self):
        return len(self._cols)

    def keys(self):
        return list(self._cols)


class _Cursor:
    __slots__ = ("_rows", "_pos", "lastrowid")

    def __init__(self, rows, lastrowid):
        self._rows = rows
        self._pos = 0
        self.lastrowid = lastrowid

    def fetchone(self):
        if self._pos >= len(self._rows):
            return None
        row = self._rows[self._pos]
        self._pos += 1
        return row

    def fetchall(self):
        rows = self._rows[self._pos:]
        self._pos = len(self._rows)
        return rows

    def __iter__(self):
        while self._pos < len(self._rows):
            row = self._rows[self._pos]
            self._pos += 1
            yield row


def _to_sqlite_error(msg: str, code: str = "") -> Exception:
    upper = msg.upper()
    if "CONSTRAINT" in code or "UNIQUE" in upper or "FOREIGN KEY" in upper:
        return sqlite3.IntegrityError(msg)
    return sqlite3.OperationalError(msg)


_WRITE_RE = re.compile(r"^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b", re.IGNORECASE)


def _check(result):
    if result["type"] == "error":
        err = result["error"]
        raise _to_sqlite_error(err["message"], err.get("code", ""))
    return result


class TursoConnection:
    """Synchronous Turso connection via HTTP pipeline API."""

    def __init__(self, url: str, token: str):
        url = url.replace("libsql://", "https://").rstrip("/")
        self._base_url = url
        self._auth = f"Bearer {token}"
        self._baton = None      # 열린 스트림(트랜잭션) 식별자. None이면 트랜잭션 밖
        self.row_factory = None  # accepted but unused

    @property
    def in_transaction(self) -> bool:
        return self._baton is not None

    def _encode_args(self, params):
        result = []
        for p in (params or []):
            if p is None:
                result.append({"type": "null"})
            elif isinstance(p, bool):
                result.append({"type": "integer", "value": str(int(p))})
            elif isinstance(p, int):
                result.append({"type": "integer", "value": str(p)})
            elif isinstance(p, float):
                result.append({"type": "real", "value": str(p)})
            else:
                result.append({"type": "text", "value": str(p)})
        return result

    def _send(self, stmts: list, keep_open: bool) -> list:
        """stmts를 한 파이프라인으로 보낸다. keep_open이면 스트림을 유지해 baton을 저장하고,
        아니면 close 요청을 붙여 스트림을 닫는다. execute 결과 목록을 반환."""
        requests_ = [{"type": "execute", "stmt": s} for s in stmts]
        if not keep_open:
            requests_.append({"type": "close"})
        try:
            resp = _session.post(
                f"{self._base_url}/v2/pipeline",
                headers={"Authorization": self._auth, "Content-Type": "application/json"},
                json={"baton": self._baton, "requests": requests_},
                timeout=15,
            )
            resp.raise_for_status()
        except Exception:
            # HTTP 오류면 서버 측 스트림은 무효 — 열려 있던 트랜잭션은 서버가 버린다(롤백)
            self._baton = None
            raise
        body = resp.json()
        if keep_open:
            self._baton = body.get("baton")
            if body.get("base_url"):
                self._base_url = body["base_url"].rstrip("/")
        else:
            self._baton = None
        return body["results"][:len(stmts)]

    def _stmt(self, sql: str, params=(), want_rows: bool = True) -> dict:
        return {"sql": sql, "args": self._encode_args(params), "want_rows": want_rows}

    def _run(self, stmts: list) -> list:
        """트랜잭션 상태에 맞춰 실행. 쓰기 문장이 있으면 BEGIN으로 트랜잭션을 시작한다."""
        if self._baton is None and _WRITE_RE.match(stmts[0]["sql"]):
            results = self._send([{"sql": "BEGIN", "want_rows": False}] + stmts, keep_open=True)
            _check(results[0])
            return results[1:]
        return self._send(stmts, keep_open=self._baton is not None)

    def execute(self, sql: str, params=()):
        r = _check(self._run([self._stmt(sql, params)])[0])
        res = r["response"]["result"]
        cols = res.get("cols", [])
        rows = [TursoRow(cols, row) for row in res.get("rows", [])]
        last_id = res.get("last_insert_rowid")
        return _Cursor(rows, int(last_id) if last_id else None)

    def executemany(self, sql: str, params_list):
        params_list = list(params_list)
        if not params_list:
            return _Cursor([], None)
        results = self._run([self._stmt(sql, p, want_rows=False) for p in params_list])
        for r in results:
            _check(r)
        last = results[-1]["response"]["result"]
        last_id = last.get("last_insert_rowid")
        return _Cursor([], int(last_id) if last_id else None)

    def _finish(self, sql: str):
        if self._baton is None:
            return
        results = self._send([{"sql": sql, "want_rows": False}], keep_open=False)
        _check(results[0])

    def commit(self):
        self._finish("COMMIT")

    def rollback(self):
        try:
            self._finish("ROLLBACK")
        except Exception:
            self._baton = None  # 롤백 실패 시에도 서버가 유휴 스트림을 닫으며 트랜잭션을 버린다

    def close(self):
        # 커밋되지 않은 트랜잭션이 남아 있으면 sqlite3처럼 버린다
        self.rollback()

    def sync(self):
        pass


def connect(url: str, token: str) -> TursoConnection:
    return TursoConnection(url, token)
