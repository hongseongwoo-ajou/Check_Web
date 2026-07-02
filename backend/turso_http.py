"""
Minimal sqlite3-compatible wrapper for Turso HTTP API.
No native compilation needed — pure Python + requests.
"""
from collections.abc import Mapping
import sqlite3
import requests


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


class TursoConnection:
    """Synchronous Turso connection via HTTP pipeline API."""

    def __init__(self, url: str, token: str):
        url = url.replace("libsql://", "https://").rstrip("/")
        self._pipeline_url = f"{url}/v2/pipeline"
        self._auth = f"Bearer {token}"
        self.row_factory = None  # accepted but unused

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

    def _send(self, stmts: list) -> list:
        payload = {
            "requests": [
                {"type": "execute", "stmt": s} for s in stmts
            ] + [{"type": "close"}]
        }
        resp = requests.post(
            self._pipeline_url,
            headers={"Authorization": self._auth, "Content-Type": "application/json"},
            json=payload,
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()["results"][:-1]  # drop the "close" result

    def execute(self, sql: str, params=()):
        stmt = {"sql": sql, "args": self._encode_args(params), "want_rows": True}
        results = self._send([stmt])
        r = results[0]
        if r["type"] == "error":
            err = r["error"]
            raise _to_sqlite_error(err["message"], err.get("code", ""))
        res = r["response"]["result"]
        cols = res.get("cols", [])
        rows = [TursoRow(cols, row) for row in res.get("rows", [])]
        last_id = res.get("last_insert_rowid")
        return _Cursor(rows, int(last_id) if last_id else None)

    def executemany(self, sql: str, params_list):
        params_list = list(params_list)
        if not params_list:
            return _Cursor([], None)
        stmts = [
            {"sql": sql, "args": self._encode_args(p), "want_rows": False}
            for p in params_list
        ]
        results = self._send(stmts)
        for r in results:
            if r["type"] == "error":
                err = r["error"]
                raise _to_sqlite_error(err["message"], err.get("code", ""))
        last = results[-1]["response"]["result"]
        last_id = last.get("last_insert_rowid")
        return _Cursor([], int(last_id) if last_id else None)

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass

    def sync(self):
        pass


def connect(url: str, token: str) -> TursoConnection:
    return TursoConnection(url, token)
