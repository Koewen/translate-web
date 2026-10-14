/* ============================================================
 * store.js —— 全局响应式状态（跨组件共享）
 * ============================================================ */
/* 注意：本工程使用 Vue 全局构建（vue.global.prod.js，挂到 window.Vue），
 * 而非 ESM 构建，因此这里从全局对象取 reactive，不要用 `import ... from 'vue'`
 *（bare specifier 在无 import map 的浏览器中无法解析，会导致整个模块图加载失败）。 */
const { reactive } = Vue;

export const store = reactive({
  /* 界面 */
  theme: document.documentElement.getAttribute('data-theme') || 'light',
  asideDrawer: false,

  /* 语言 / 通道 */
  srcLang: 'auto',
  tgtLang: 'zh',
  mode: 'auto',            // auto | fast | quality

  /* 术语（SQLite 持久化） */
  terms: [],               // [{id,src,dst,note,enabled,...}]
  termsLoaded: false,

  /* 翻译状态 */
  running: false,
  srcText: '',
  outText: '',
  meta: '',
  err: '',
  routeWhy: '',

  /* 离线词典快路径结果（命中时渲染释义列表，不调用模型） */
  dictItems: [],

  /* 模型状态（/ollama/api/ps） */
  resident: [],            // [{name, size_vram, ...}]
  version: '',

  /* 历史 */
  histCount: 0,
});

export function setTheme(t) {
  store.theme = t;
  document.documentElement.setAttribute('data-theme', t);
  document.documentElement.classList.toggle('dark', t === 'dark');
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#0c111e' : '#f5f8ff');
  try { localStorage.setItem('hy_mt_theme', t); } catch {}
}
