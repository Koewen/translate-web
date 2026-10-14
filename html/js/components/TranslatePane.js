/* ============================================================
 * TranslatePane.js —— 主翻译面板（原文/译文/工具栏/流式渲染）
 * ============================================================ */
import { store, setTheme } from '../store.js';
import { apiTerms, apiHistory, ollamaChatStream, ollamaPs, apiDict } from '../api.js';
import {
  LANGS, CHANNELS, OPTS, LONG_THRESHOLD,
  nameOf, resolveLangs, buildPrompt, pickChannel,
  dictPairFor, isSingleToken,
} from '../translator.js';

let ctrl = null;

/* 词典义项拆分：CC-CEDICT / FreeDict 用 " / " 连接多个义项，逐行展示 */
function splitSenses(dst) {
  return String(dst || '').split(' / ').map(s => s.trim()).filter(Boolean);
}
/* 去掉 "(machinery etc)/(computing)" 等限定括注，得到更通用的说法 */
function stripQualifiers(s) {
  return String(s || '').replace(/\s*\([^)]*\)/g, '').replace(/\s{2,}/g, ' ').trim();
}

export default {
  name: 'TranslatePane',
  template: `
  <div class="pane">
    <div class="pane-toolbar">
      <el-select v-model="store.srcLang" size="default" style="width:132px">
        <el-option label="自动识别" value="auto" />
        <el-option v-for="l in LANGS" :key="l[0]" :label="l[1]" :value="l[0]" />
      </el-select>
      <el-select v-model="store.tgtLang" size="default" style="width:132px">
        <el-option v-for="l in LANGS" :key="l[0]" :label="l[1]" :value="l[0]" />
      </el-select>
      <el-segmented v-model="store.mode" :options="modeOpts" size="default" />
      <div class="tl-spacer"></div>
      <el-button round @click="doTranslate" :type="store.running ? 'warning' : 'primary'"
                 style="min-width:116px">
        {{ store.running ? '停止' : '翻 译' }}
      </el-button>
      <el-tooltip content="清空原文与译文" placement="top">
        <el-button :icon="Delete" circle @click="clearAll" />
      </el-tooltip>
    </div>

    <div class="route-line">
      <span>{{ pairLabel }}</span>
      <span class="route-chip"><span class="dot"></span>{{ channel.label }}</span>
      <span>{{ routeWhy }}</span>
      <span v-if="slow">· 9B CPU 推理，约 3–15 秒/句</span>
    </div>

    <div class="duo">
      <div class="duo-half">
        <div class="duo-label">原文 <span class="cnt">{{ srcLen }} 字</span></div>
        <el-input
          v-model="store.srcText" type="textarea" class="src-area"
          :autosize="false" resize="none" spellcheck="false"
          placeholder="输入要翻译的内容…（Ctrl+Enter 翻译）"
          @keydown.ctrl.enter.prevent="doTranslate" />
      </div>
      <el-button class="duo-swap" :icon="Swap" circle title="交换语言" @click="swap" />
      <div class="duo-half">
        <div class="duo-label">译文 <span class="cnt">{{ outLen }} 字</span></div>
        <div class="out-box" :class="{ empty: !store.outText && !store.dictItems.length }" ref="outBox">
          <el-button class="out-copy" :icon="CopyDocument" circle size="small"
                     title="复制译文" @click="copyOut" />
          <template v-if="store.dictItems.length">
            <div class="dict-entry">
              <div class="dict-head">
                <span class="dict-word">{{ dictHead.word }}</span>
                <span class="dict-tag" v-if="dictHead.reading">{{ dictHead.reading }}</span>
                <span class="dict-tag" v-if="dictHead.pos">{{ dictHead.pos }}</span>
              </div>
              <div class="dict-exp" v-for="(e, i) in dictExplanations" :key="i" :class="{ primary: i === 0 }">
                <div class="dict-exp-summary">
                  <span class="dict-idx">{{ i + 1 }}</span>
                  <span class="dict-exp-text">{{ e.summary }}</span>
                </div>
                <div class="dict-exp-detail" v-if="e.detail">
                  <span class="dict-detail-label">细节</span>
                  <span class="dict-detail-text">{{ e.detail }}</span>
                </div>
              </div>
            </div>
          </template>
          <template v-else-if="store.outText">{{ store.outText }}<span class="caret" v-if="store.running"></span></template>
          <template v-else>译文将在这里流式输出…</template>
        </div>
      </div>
    </div>

    <div class="pane-bottom">
      <span class="meta">{{ store.meta }}</span>
      <span class="err-line">{{ store.err }}</span>
    </div>
  </div>
  `,
  setup() {
    const { ref, computed, watch, onMounted } = Vue;
    const { ElMessage } = ElementPlus;
    const outBox = ref(null);

    const modeOpts = [
      { label: '自动', value: 'auto' },
      { label: '快速', value: 'fast' },
      { label: '长文', value: 'quality' },
    ];

    const srcLen = computed(() => store.srcText.length);
    const outLen = computed(() => store.outText.length);
    const enabledTerms = computed(() => store.terms.filter(t => t.enabled));

    const channel = computed(() =>
      CHANNELS[pickChannel(store.srcText, store.mode, enabledTerms.value.length).key]);
    const slow = computed(() => channel.value.key === 'quality');
    const pairLabel = computed(() =>
      nameOf(store.srcLang) + ' → ' + nameOf(store.tgtLang));

    /* 离线词典结果：词头 + 逐条义项（概要 + 细节，分区呈现） */
    const dictHead = computed(() => {
      const it = store.dictItems[0];
      if (!it) return { word: '', reading: '', pos: '' };
      return { word: it.src, reading: it.reading || '', pos: it.pos || '' };
    });
    const dictExplanations = computed(() => {
      const exps = [];
      for (const it of store.dictItems) {
        for (const s of splitSenses(it.dst)) {
          const parens = s.match(/\([^)]*\)/g) || [];      // 括注 = 细节/限定
          exps.push({
            summary: stripQualifiers(s) || s,               // 概要：去括注的核心说法
            detail: parens.map(x => x.slice(1, -1)).join(' · '),
          });
        }
      }
      return exps;
    });

    /* 路由说明行：随输入/模式/术语实时联动 */
    const routeWhy = computed(() => {
      if (store.routeWhy) return store.routeWhy;
      const t = store.srcText.trim();
      if (!t) return '输入文本后自动选择通道';
      const r = pickChannel(t, store.mode, enabledTerms.value.length);
      return r.why;
    });

    /* 流式输出自动滚动（rAF 节流） */
    let scrollRAF = 0;
    watch(() => store.outText, () => {
      if (scrollRAF) return;
      scrollRAF = requestAnimationFrame(() => {
        scrollRAF = 0;
        if (outBox.value) outBox.value.scrollTop = outBox.value.scrollHeight;
      });
    });

    /* 历史回填请求（来自 HistoryPanel） */
    watch(() => store.fillRequest, (req) => {
      if (!req) return;
      store.srcLang = req.s; store.tgtLang = req.t;
      store.srcText = req.in;
    });

    function swap() {
      const s = store.srcLang;
      store.srcLang = store.tgtLang;
      store.tgtLang = (s === 'auto') ? 'en' : s;   // 目标不允许「自动识别」
      if (store.dictItems.length) {
        const ex = dictExplanations.value[0];         // 用通用解释回填，便于反向再查
        store.srcText = (ex && ex.summary) || store.dictItems[0].dst;
        store.dictItems = []; store.meta = ''; store.err = '';
      } else if (store.outText.trim()) {
        store.srcText = store.outText;
        store.outText = ''; store.meta = ''; store.err = '';
      }
      store.routeWhy = '';
      ElMessage.success('已交换语言');
    }

    function clearAll() {
      store.srcText = ''; store.outText = '';
      store.dictItems = [];
      store.meta = ''; store.err = ''; store.routeWhy = '';
    }

    async function copyOut() {
      const txt = store.dictItems.length
        ? store.dictItems.flatMap(x => splitSenses(x.dst)).join('\n')
        : store.outText;
      if (!txt.trim()) return ElMessage.warning('还没有译文');
      try {
        await navigator.clipboard.writeText(txt);
        ElMessage.success('译文已复制到剪贴板');
      } catch { ElMessage.error('复制失败'); }
    }

    async function doTranslate() {
      if (store.running) { if (ctrl) ctrl.abort(); return; }
      const text = store.srcText.trim();
      if (!text) { ElMessage.warning('请先输入要翻译的内容'); return; }

      store.err = '';
      store.dictItems = [];            // 每次翻译先清空上一次词典结果
      const langs = resolveLangs(text, store.srcLang, store.tgtLang);
      const terms = enabledTerms.value;

      /* ---- 离线词典快路径：单词/短词先查本地词典，命中即秒回，不调用模型 ---- */
      const pair = dictPairFor(langs.src, langs.tgt);
      if (pair && isSingleToken(text)) {
        try {
          const d = await apiDict.query(text, pair);
          if (d.items && d.items.length) {
            store.dictItems = d.items;
            store.outText = '';
            const senseCount = d.items.reduce((n, x) => n + splitSenses(x.dst).length, 0);
            store.meta = '离线词典 · ' + senseCount + ' 个义项';
            store.routeWhy = '命中离线词典「' + nameOf(langs.src) + '→' + nameOf(langs.tgt)
              + '」，秒回未走模型';
            // 写入历史（标记为词典来源，便于回看查词记录）
            try {
              await apiHistory.add({
                src_text: text, dst_text: d.items.map(x => x.dst).join(' / '),
                src_lang: langs.src, dst_lang: langs.tgt, model: '离线词典',
                chars: d.items.reduce((n, x) => n + (x.dst || '').length, 0),
                duration_ms: 0,
              });
              store.histCount += 1;
              store.histReloadTick = (store.histReloadTick || 0) + 1;
            } catch (e) { console.warn('词典历史写入失败', e); }
            return;
          }
        } catch (e) { console.warn('离线词典查询失败，回退模型', e); }
      }

      const ch = pickChannel(text, store.mode, terms.length);
      const cfg = CHANNELS[ch.key];
      store.routeWhy = langs.note;

      const prompt = buildPrompt(text, langs.src, langs.tgt, terms);
      const t0 = performance.now();
      store.running = true;
      store.outText = '';
      store.meta = cfg.label + ' · 模型加载中…';
      ctrl = new AbortController();

      try {
        const r = await ollamaChatStream({
          model: cfg.model,
          messages: [{ role: 'user', content: prompt }],
          stream: true, keep_alive: cfg.keep, think: false,
          options: { ...OPTS },
        }, ctrl.signal, (acc) => { store.outText = acc; });

        const dt = ((performance.now() - t0) / 1000).toFixed(2);
        store.outText = r.text || '（未返回内容）';
        store.meta = cfg.label + ' · ' + r.text.length + ' 字'
          + (r.loadSec > 1 ? ' · 冷启动 ' + r.loadSec.toFixed(1) + 's' : '')
          + ' · ' + dt + 's';

        /* 历史落库（SQLite） */
        if (r.text) {
          try {
            await apiHistory.add({
              src_text: text, dst_text: r.text,
              src_lang: langs.src, dst_lang: langs.tgt,
              model: cfg.label, chars: r.text.length,
              duration_ms: Math.round(dt * 1000),
            });
            store.histCount += 1;
            store.histReloadTick = (store.histReloadTick || 0) + 1;
          } catch (e) { console.warn('历史写入失败', e); }
        }
        refreshStatus();   // 翻译后模型驻留，同步状态
      } catch (e) {
        if (e.name === 'AbortError') {
          store.meta = '已停止';
        } else {
          store.err = String(e.message || e).slice(0, 200);
          store.outText = '';
          ElMessage.error('翻译失败，请查看错误提示');
        }
      } finally {
        store.running = false;
        ctrl = null;
      }
    }

    async function refreshStatus() {
      const ps = await ollamaPs();
      store.resident = (ps.models || []).map(m => ({
        name: m.name,
        vram: m.size_vram ? (m.size_vram / 1073741824).toFixed(2) + ' GB' : '—',
      }));
    }
    onMounted(refreshStatus);

    /* 跨组件：Header 也会触发刷新/释放，挂到 store 上 */
    store.refreshStatus = refreshStatus;

    return {
      store, setTheme, LANGS, Swap: ElementPlusIconsVue.Swap,
      Delete: ElementPlusIconsVue.Delete, CopyDocument: ElementPlusIconsVue.CopyDocument,
      modeOpts, srcLen, outLen, channel, slow, pairLabel, routeWhy,
      dictHead, dictExplanations,
      outBox, swap, clearAll, copyOut, doTranslate,
    };
  },
};
