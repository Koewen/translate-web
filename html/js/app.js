/* ============================================================
 * app.js —— 应用入口：主题 / 布局（顶栏 + 主面板 + 右侧面板）/ 旧数据迁移
 * ============================================================ */
import { store, setTheme } from './store.js';
import { apiHistory, ollamaVersion, ollamaUnloadAll, ollamaPs } from './api.js';
import TranslatePane from './components/TranslatePane.js';
import TermsPanel from './components/TermsPanel.js';
import HistoryPanel from './components/HistoryPanel.js';

const { createApp, computed, onMounted } = Vue;

const RootApp = {
  name: 'RootApp',
  components: { TranslatePane, TermsPanel, HistoryPanel },
  template: `
  <el-config-provider :locale="zhCn">
    <!-- 顶栏 -->
    <header class="tl-header">
      <div class="tl-logo">译</div>
      <div>
        <div class="tl-title">本地翻译工作台</div>
        <div class="tl-subtitle">Qwen3.5 9B · 文本不出内网</div>
      </div>
      <div class="tl-spacer"></div>

      <!-- 模型状态：驻留模型 + 释放显存 -->
      <el-popover placement="bottom-end" :width="300" trigger="click" @show="store.refreshStatus && store.refreshStatus()">
        <template #reference>
          <div class="tl-status" :class="{ idle: !store.resident.length }">
            <span class="dot"></span>
            <span>{{ statusLabel }}</span>
          </div>
        </template>
        <div style="font-size:12.5px">
          <div style="font-weight:700;margin-bottom:6px">模型驻留状态 <span style="color:var(--text-3);font-weight:400">v{{ store.version }}</span></div>
          <div v-if="!store.resident.length" style="color:var(--text-3);padding:6px 0">
            当前无驻留模型（首次翻译会自动加载，约需冷启动时间）
          </div>
          <div v-for="m in store.resident" :key="m.name"
               style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border)">
            <span>{{ m.name }}</span>
            <span style="color:var(--text-3)">{{ m.vram }}</span>
          </div>
          <el-button size="small" style="margin-top:10px;width:100%"
                     :loading="unloading" @click="unloadAll">
            释放显存（卸载全部驻留模型）
          </el-button>
        </div>
      </el-popover>

      <!-- 窄屏：打开右侧抽屉 -->
      <el-button class="tl-aside-toggle" :icon="Menu" circle @click="store.asideDrawer = true" title="术语与历史" />

      <!-- 主题切换 -->
      <el-button :icon="isDark ? Sunny : Moon" circle @click="toggleTheme" title="切换主题" />
    </header>

    <!-- 主体：左翻译 + 右术语/历史 -->
    <div class="tl-main">
      <div class="tl-center">
        <translate-pane />
      </div>
      <aside class="tl-aside">
        <el-tabs v-model="tab">
          <el-tab-pane name="terms">
            <template #label>
              术语干预
              <el-badge v-if="store.terms.length" :value="store.terms.length" type="primary" style="margin-left:4px" />
            </template>
            <terms-panel />
          </el-tab-pane>
          <el-tab-pane name="history">
            <template #label>
              翻译历史
              <el-badge v-if="store.histCount" :value="histBadge" :max="999" type="info" style="margin-left:4px" />
            </template>
            <history-panel />
          </el-tab-pane>
        </el-tabs>
      </aside>
    </div>

    <!-- 窄屏抽屉（与右栏同一套面板） -->
    <el-drawer v-model="store.asideDrawer" title="术语干预 / 翻译历史" size="86%" direction="rtl">
      <el-tabs v-model="drawerTab">
        <el-tab-pane label="术语干预" name="terms"><terms-panel /></el-tab-pane>
        <el-tab-pane label="翻译历史" name="history"><history-panel /></el-tab-pane>
      </el-tabs>
    </el-drawer>
  </el-config-provider>
  `,
  setup() {
    const tab = Vue.ref('terms');
    const drawerTab = Vue.ref('terms');
    const unloading = Vue.ref(false);

    const isDark = computed(() => store.theme === 'dark');
    const statusLabel = computed(() => store.resident.length
      ? '模型驻留 ' + store.resident.length
      : '模型空闲');
    const histBadge = computed(() => Math.min(store.histCount, 999));

    function toggleTheme() {
      setTheme(store.theme === 'dark' ? 'light' : 'dark');
      ElementPlus.ElMessage.success(store.theme === 'dark' ? '已切换为深色主题' : '已切换为浅色主题');
    }

    async function unloadAll() {
      unloading.value = true;
      try {
        await ollamaUnloadAll(store.resident);
        ElementPlus.ElMessage.success('已释放显存');
        setTimeout(() => store.refreshStatus && store.refreshStatus(), 800);
      } catch { ElementPlus.ElMessage.error('释放失败'); }
      finally { unloading.value = false; }
    }

    /* 旧版 localStorage 历史 → SQLite 一次性迁移（仅当服务端为空且本地有数据） */
    async function migrateLegacyHistory() {
      try {
        const raw = localStorage.getItem('hy_mt_history');
        if (!raw) return;
        const list = JSON.parse(raw) || [];
        if (!list.length) return;
        const cur = await apiHistory.list(1, 0, '');
        if (cur.total > 0) { localStorage.removeItem('hy_mt_history'); return; }
        for (const h of list.slice(0, 20)) {
          await apiHistory.add({
            src_text: h.in || '', dst_text: h.out || '',
            src_lang: h.s || 'auto', dst_lang: h.t || 'zh',
            model: h.m === 'quality' ? 'Qwen3.5 9B 长文' : 'Qwen3.5 9B 标准',
            chars: (h.out || '').length, duration_ms: 0,
          });
        }
        localStorage.removeItem('hy_mt_history');
        console.info('[migrate] 已迁移 %d 条本地历史到 SQLite', list.length);
      } catch (e) { console.warn('[migrate] 旧历史迁移失败（不影响使用）', e); }
    }

    onMounted(async () => {
      const v = await ollamaVersion();
      store.version = (v && v.version) || '';
      await migrateLegacyHistory();
      /* 窄屏默认不展开右栏（在抽屉里）；宽屏无操作 */
      const ps = await ollamaPs();
      store.resident = (ps.models || []).map(m => ({
        name: m.name,
        vram: m.size_vram ? (m.size_vram / 1073741824).toFixed(2) + ' GB' : '—',
      }));
      store.refreshStatus = async () => {
        const p = await ollamaPs();
        store.resident = (p.models || []).map(m => ({
          name: m.name,
          vram: m.size_vram ? (m.size_vram / 1073741824).toFixed(2) + ' GB' : '—',
        }));
      };
    });

    return {
      store, tab, drawerTab, unloading, isDark, statusLabel, histBadge,
      zhCn: ElementPlusLocaleZhCn,
      Menu: ElementPlusIconsVue.Menu,
      Sunny: ElementPlusIconsVue.Sunny, Moon: ElementPlusIconsVue.Moon,
      toggleTheme, unloadAll,
    };
  },
};

const app = createApp(RootApp);
app.use(ElementPlus, { locale: ElementPlusLocaleZhCn });
for (const [name, comp] of Object.entries(ElementPlusIconsVue)) app.component(name, comp);
app.mount('#app');
