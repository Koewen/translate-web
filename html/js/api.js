/* ============================================================
 * api.js —— 与本地持久化服务 (/api/*) 与 Ollama (/ollama/*) 的全部通信
 * ============================================================ */

async function jfetch(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (!res.ok) {
    const msg = (data && data.error) ? data.error : ('HTTP ' + res.status);
    throw new Error(msg);
  }
  return data;
}

/* ---------------- 术语 CRUD ---------------- */
export const apiTerms = {
  list:    (enabledOnly) => jfetch('/api/terms' + (enabledOnly ? '?enabled=1' : '')),
  upsert:  (src, dst, note = '') =>
             jfetch('/api/terms', { method: 'POST',
               headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify({ src, dst, note }) }),
  update:  (id, fields) =>
             jfetch('/api/terms/' + id, { method: 'PUT',
               headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify(fields) }),
  remove:  (id) => jfetch('/api/terms/' + id, { method: 'DELETE' }),
};

/* ---------------- 历史 CRUD ---------------- */
export const apiHistory = {
  list:   (limit = 50, offset = 0, q = '') =>
            jfetch('/api/history?limit=' + limit + '&offset=' + offset
                   + '&q=' + encodeURIComponent(q)),
  add:    (rec) => jfetch('/api/history', { method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify(rec) }),
  remove: (id) => jfetch('/api/history/' + id, { method: 'DELETE' }),
  clear:  ()    => jfetch('/api/history', { method: 'DELETE' }),
};

export const apiStats = () => jfetch('/api/stats');

/* ---------------- 离线词典查询 ---------------- */
export const apiDict = {
  query: (q, pair) =>
    jfetch('/api/dict?q=' + encodeURIComponent(q) + '&pair=' + encodeURIComponent(pair)),
};

/* ---------------- Ollama 状态 ---------------- */
const OLLAMA = {
  chat:    '/ollama/api/chat',
  ps:      '/ollama/api/ps',
  version: '/ollama/api/version',
  unload:  '/ollama/api/generate',
};

export async function ollamaPs() {
  try { return await jfetch(OLLAMA.ps); } catch { return { models: [] }; }
}
export async function ollamaVersion() {
  try { return await jfetch(OLLAMA.version); } catch { return {}; }
}
/* 释放显存：对每个驻留模型发 keep_alive=0 */
export async function ollamaUnloadAll(models) {
  for (const m of models) {
    try {
      await jfetch(OLLAMA.unload, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m.name, keep_alive: 0 }) });
    } catch { /* 单个失败继续 */ }
  }
}

/**
 * 流式翻译（NDJSON）。onDelta(全文, 增量) 每块回调一次。
 * 返回 { text, model, loadSec, evalTps, totalSec }
 */
export async function ollamaChatStream(payload, signal, onDelta) {
  const res = await fetch(OLLAMA.chat, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 160));

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', acc = '', fin = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const ln of lines) {
      if (!ln.trim()) continue;
      let j; try { j = JSON.parse(ln); } catch { continue; }
      if (j.error) throw new Error(j.error);
      if (j.done) fin = j;
      const piece = (j.message && j.message.content) || '';
      if (piece) { acc += piece; onDelta && onDelta(acc, piece); }
    }
  }
  return {
    text: acc,
    model: payload.model,
    loadSec: (fin && fin.load_duration) ? fin.load_duration / 1e9 : 0,
    evalTps: (fin && fin.eval_duration) ? fin.eval_count / (fin.eval_duration / 1e9) : 0,
  };
}
