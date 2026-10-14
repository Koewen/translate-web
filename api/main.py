# -*- coding: utf-8 -*-
"""
translate-api HTTP 服务（Python 标准库实现，零第三方依赖）
路由：
  GET    /api/health                 健康检查
  GET    /api/stats                  计数（术语启用数/历史条数）
  GET    /api/terms?enabled=1        术语列表
  POST   /api/terms                  新增/更新术语 {src,dst,note}   （按 src 幂等）
  PUT    /api/terms/{id}             修改术语 {src?,dst?,note?,enabled?}
  DELETE /api/terms/{id}             删除术语
  GET    /api/history?limit&offset&q 翻译历史（倒序+检索）
  POST   /api/history                写入历史 {src_text,dst_text,src_lang,dst_lang,model,chars,duration_ms}
  DELETE /api/history/{id}           删除单条
  DELETE /api/history               清空历史
  GET    /api/dict?q=&pair=         离线词典查询（pair 如 zh-en/ja-en；单词/短语快路径）
说明：与前端同源（nginx /api/ 反代），无需 CORS；请求体上限 1MB。
"""
import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import db

HOST = os.environ.get("TRANSLATE_BIND", "0.0.0.0")
PORT = int(os.environ.get("TRANSLATE_PORT", "8000"))
MAX_BODY = 1 * 1024 * 1024
RE_ID = re.compile(r"^/api/(terms|history)/(\d+)$")


class Handler(BaseHTTPRequestHandler):
    server_version = "translate-api/1.0"
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------- helpers --
    def _json(self, code: int, payload) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _fail(self, code: int, msg: str) -> None:
        self._json(code, {"error": msg})

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise ValueError("请求体过大")
        raw = self.rfile.read(length)
        if not raw.strip():
            return {}
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("请求体必须是 JSON 对象")
        return data

    def _path_query(self):
        u = urlparse(self.path)
        return u.path.rstrip("/") or "/", parse_qs(u.query)

    def log_message(self, fmt, *args):  # 精简日志
        print("[%s] %s" % (self.log_date_time_string(), fmt % args), flush=True)

    # ---------------------------------------------------------------- GET --
    def do_GET(self):
        path, qs = self._path_query()
        try:
            if path == "/api/health":
                return self._json(200, {"ok": True, "service": "translate-api"})
            if path == "/api/stats":
                return self._json(200, db.stats())
            if path == "/api/terms":
                enabled_only = qs.get("enabled", [""])[0] in ("1", "true")
                return self._json(200, {"items": db.list_terms(enabled_only)})
            if path == "/api/history":
                items, total = db.list_history(
                    limit=qs.get("limit", ["50"])[0],
                    offset=qs.get("offset", ["0"])[0],
                    q=(qs.get("q", [""])[0] or "").strip(),
                )
                return self._json(200, {"items": items, "total": total})
            if path == "/api/dict":
                q = (qs.get("q", [""])[0] or "").strip()
                pair = (qs.get("pair", [""])[0] or "").strip()
                if not q or not pair:
                    return self._fail(400, "q 与 pair 不能为空")
                return self._json(200, {"items": db.query_dict(q, pair), "pair": pair})
            return self._fail(404, "not found: %s" % path)
        except Exception as e:  # noqa: BLE001
            return self._fail(500, str(e))

    # ---------------------------------------------------------------- POST --
    def do_POST(self):
        path, _ = self._path_query()
        try:
            data = self._body()
            if path == "/api/terms":
                src = (data.get("src") or "").strip()
                dst = (data.get("dst") or "").strip()
                if not src or not dst:
                    return self._fail(400, "src 与 dst 均不能为空")
                if len(src) > 500 or len(dst) > 2000:
                    return self._fail(400, "术语过长")
                return self._json(201, {"item": db.upsert_term(
                    src, dst, (data.get("note") or "").strip()[:500])})
            if path == "/api/history":
                src_text = data.get("src_text") or ""
                dst_text = data.get("dst_text") or ""
                if not dst_text.strip():
                    return self._fail(400, "dst_text 不能为空")
                return self._json(201, {"item": db.add_history(
                    src_text, dst_text,
                    str(data.get("src_lang") or "")[:24],
                    str(data.get("dst_lang") or "")[:24],
                    str(data.get("model") or "")[:64],
                    int(data.get("chars") or len(dst_text)),
                    int(data.get("duration_ms") or 0),
                )})
            return self._fail(404, "not found: %s" % path)
        except ValueError as e:
            return self._fail(400, str(e))
        except Exception as e:  # noqa: BLE001
            return self._fail(500, str(e))

    # ------------------------------------------------- PUT / DELETE---------
    def do_PUT(self):
        path, _ = self._path_query()
        m = RE_ID.match(path)
        if not m or m.group(1) != "terms":
            return self._fail(404, "not found: %s" % path)
        try:
            data = self._body()
            item = db.update_term(int(m.group(2)), data)
            if item is None:
                return self._fail(404, "术语不存在")
            return self._json(200, {"item": item})
        except ValueError as e:
            return self._fail(400, str(e))
        except Exception as e:  # noqa: BLE001
            return self._fail(500, str(e))

    def do_DELETE(self):
        path, _ = self._path_query()
        try:
            if path == "/api/history":  # 清空
                return self._json(200, {"deleted": db.clear_history()})
            m = RE_ID.match(path)
            if not m:
                return self._fail(404, "not found: %s" % path)
            ok = (db.delete_term(int(m.group(2))) if m.group(1) == "terms"
                  else db.delete_history(int(m.group(2))))
            return self._json(200, {"deleted": ok})
        except Exception as e:  # noqa: BLE001
            return self._fail(500, str(e))


def main():
    db.init_db()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    print("translate-api listening on %s:%s, db=%s" % (HOST, PORT, db.DB_PATH), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
