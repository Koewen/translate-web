# -*- coding: utf-8 -*-
"""
translate-api 数据层（SQLite，零第三方依赖）
表结构（schema 见 init_db）：
  terms   术语干预词典：src(原文词,唯一) -> dst(指定译名)，enabled 控制是否参与翻译干预
  history 翻译历史：源文/译文/语对/模型/字数/耗时，按时间倒序查询
并发模型：单进程 ThreadingHTTPServer，用一把可重入锁串行化写事务；
WAL 模式保证读写不互斥，断电/重启由 SQLite 自身回滚保证一致性。
"""
import os
import sqlite3
import threading
import time

DB_PATH = os.environ.get("TRANSLATE_DB", "/data/translate.db")

_init_lock = threading.Lock()
_initialized = False
_write_lock = threading.RLock()


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


_SCHEMA = """
CREATE TABLE IF NOT EXISTS terms (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    src        TEXT NOT NULL,                 -- 原文术语/词（唯一）
    dst        TEXT NOT NULL,                 -- 指定译名
    note       TEXT NOT NULL DEFAULT '',      -- 备注（可选）
    enabled    INTEGER NOT NULL DEFAULT 1,    -- 1=参与翻译干预 0=停用
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_terms_src ON terms(src);

CREATE TABLE IF NOT EXISTS history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    src_text    TEXT NOT NULL,                -- 源文（截断存储）
    dst_text    TEXT NOT NULL,                -- 译文（截断存储）
    src_lang    TEXT NOT NULL DEFAULT '',     -- 源语言代码
    dst_lang    TEXT NOT NULL DEFAULT '',     -- 目标语言代码
    model       TEXT NOT NULL DEFAULT '',     -- 使用的模型/通道
    chars       INTEGER NOT NULL DEFAULT 0,   -- 译文字符数
    duration_ms INTEGER NOT NULL DEFAULT 0,   -- 翻译耗时（毫秒）
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_history_created ON history(created_at DESC);
"""


def init_db() -> None:
    global _initialized
    with _init_lock:
        if _initialized:
            return
        os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
        conn = _connect()
        try:
            with _write_lock:
                conn.executescript(_SCHEMA)
                conn.commit()
        finally:
            conn.close()
        _initialized = True


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


# ---------------------------------------------------------------- terms ----

def list_terms(enabled_only: bool = False) -> list:
    init_db()
    sql = "SELECT * FROM terms"
    if enabled_only:
        sql += " WHERE enabled = 1"
    sql += " ORDER BY updated_at DESC, id DESC"
    conn = _connect()
    try:
        return [dict(r) for r in conn.execute(sql).fetchall()]
    finally:
        conn.close()


def upsert_term(src: str, dst: str, note: str = "") -> dict:
    """按 src 幂等插入/更新，返回最新行。"""
    init_db()
    conn = _connect()
    try:
        with _write_lock:
            conn.execute(
                "INSERT INTO terms(src,dst,note) VALUES(?,?,?) "
                "ON CONFLICT(src) DO UPDATE SET dst=excluded.dst, note=excluded.note, "
                "enabled=1, updated_at=?",
                (src, dst, note, _now()),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM terms WHERE src=?", (src,)).fetchone()
            return dict(row)
    finally:
        conn.close()


def update_term(term_id: int, fields: dict) -> dict | None:
    init_db()
    allowed = {"src", "dst", "note", "enabled"}
    sets, vals = [], []
    for k, v in fields.items():
        if k in allowed:
            sets.append("%s=?" % k)
            vals.append(int(v) if k == "enabled" else v)
    if not sets:
        return get_term(term_id)
    sets.append("updated_at=?")
    vals.append(_now())
    vals.append(term_id)
    conn = _connect()
    try:
        with _write_lock:
            cur = conn.execute("UPDATE terms SET %s WHERE id=?" % ",".join(sets), vals)
            conn.commit()
            if cur.rowcount == 0:
                return None
            row = conn.execute("SELECT * FROM terms WHERE id=?", (term_id,)).fetchone()
            return dict(row) if row else None
    finally:
        conn.close()


def get_term(term_id: int) -> dict | None:
    init_db()
    conn = _connect()
    try:
        row = conn.execute("SELECT * FROM terms WHERE id=?", (term_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def delete_term(term_id: int) -> bool:
    init_db()
    conn = _connect()
    try:
        with _write_lock:
            cur = conn.execute("DELETE FROM terms WHERE id=?", (term_id,))
            conn.commit()
            return cur.rowcount > 0
    finally:
        conn.close()


# -------------------------------------------------------------- history ----

HIST_SNIPPET = 4000  # 单边截断存储上限（字符），防止大文本撑库


def add_history(src_text: str, dst_text: str, src_lang: str = "",
                dst_lang: str = "", model: str = "",
                chars: int = 0, duration_ms: int = 0) -> dict:
    init_db()
    conn = _connect()
    try:
        with _write_lock:
            cur = conn.execute(
                "INSERT INTO history(src_text,dst_text,src_lang,dst_lang,model,"
                "chars,duration_ms) VALUES(?,?,?,?,?,?,?)",
                (src_text[:HIST_SNIPPET], dst_text[:HIST_SNIPPET],
                 src_lang, dst_lang, model, int(chars), int(duration_ms)),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM history WHERE id=?", (cur.lastrowid,)).fetchone()
            return dict(row)
    finally:
        conn.close()


def list_history(limit: int = 50, offset: int = 0, q: str = "") -> tuple:
    """返回 (items, total)；q 对源文/译文做 LIKE 检索。"""
    init_db()
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    conn = _connect()
    try:
        where, vals = "", []
        if q:
            where = "WHERE src_text LIKE ? OR dst_text LIKE ?"
            like = "%" + q.replace("%", r"\%").replace("_", r"\_") + "%"
            vals = [like, like]
            total = conn.execute(
                "SELECT COUNT(*) FROM history " + where, vals).fetchone()[0]
            rows = conn.execute(
                "SELECT * FROM history " + where +
                " ORDER BY id DESC LIMIT ? OFFSET ?", vals + [limit, offset]).fetchall()
        else:
            total = conn.execute("SELECT COUNT(*) FROM history").fetchone()[0]
            rows = conn.execute(
                "SELECT * FROM history ORDER BY id DESC LIMIT ? OFFSET ?",
                [limit, offset]).fetchall()
        return [dict(r) for r in rows], total
    finally:
        conn.close()


def get_history(item_id: int) -> dict | None:
    init_db()
    conn = _connect()
    try:
        row = conn.execute("SELECT * FROM history WHERE id=?", (item_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def delete_history(item_id: int) -> bool:
    init_db()
    conn = _connect()
    try:
        with _write_lock:
            cur = conn.execute("DELETE FROM history WHERE id=?", (item_id,))
            conn.commit()
            return cur.rowcount > 0
    finally:
        conn.close()


def clear_history() -> int:
    init_db()
    conn = _connect()
    try:
        with _write_lock:
            cur = conn.execute("DELETE FROM history")
            conn.commit()
            return cur.rowcount
    finally:
        conn.close()


def stats() -> dict:
    init_db()
    conn = _connect()
    try:
        t = conn.execute("SELECT COUNT(*) FROM terms WHERE enabled=1").fetchone()[0]
        h = conn.execute("SELECT COUNT(*) FROM history").fetchone()[0]
        return {"terms": t, "history": h}
    finally:
        conn.close()
