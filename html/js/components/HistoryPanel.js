/* ============================================================
 * HistoryPanel.js —— 翻译历史面板（SQLite 持久化，可检索/回填）
 * ============================================================ */
import { store } from '../store.js';
import { apiHistory, apiStats } from '../api.js';
import { nameOf } from '../translator.js';

const PAGE = 50;

export default {
  name: 'HistoryPanel',
  template: `
  <div style="height:100%;display:flex;flex-direction:column">
    <div class="panel-toolbar">
      <el-input v-model="q" size="small" :prefix-icon="Search" placeholder="搜索原文/译文" clearable />
      <el-button size="small" text type="danger" @click="clearAll" style="flex:none">清空</el-button>
    </div>

    <el-scrollbar class="panel-scroll" v-loading="loading">
      <div v-if="!items.length" class="panel-empty">
        暂无记录，翻译一次后会自动保存到本地数据库。
      </div>
      <div v-for="h in items" :key="h.id" class="hist-item" @click="fill(h)">
        <div class="hist-top">
          <span class="pair">{{ langName(h.src_lang) }} → {{ langName(h.dst_lang) }}</span>
          <span class="model">{{ h.model || '翻译' }}</span>
          <span>{{ shortTime(h.created_at) }}</span>
          <span class="hist-ops" @click.stop>
            <el-button :icon="CopyDocument" circle size="small" text title="复制译文" @click="copy(h)" />
            <el-button :icon="Delete" circle size="small" text type="danger" title="删除" @click="del(h)" />
          </span>
        </div>
        <div class="hist-src" v-if="h.src_text">{{ h.src_text }}</div>
        <div class="hist-dst">{{ h.dst_text }}</div>
      </div>
      <div v-if="hasMore" style="text-align:center;padding:6px 0 2px">
        <el-button size="small" text :loading="loading" @click="loadMore">加载更早记录</el-button>
      </div>
    </el-scrollbar>
  </div>
  `,
  setup() {
    const { ref, computed, onMounted, watch } = Vue;
    const { ElMessage, ElMessageBox } = ElementPlus;
    const items = ref([]);
    const total = ref(0);
    const q = ref('');
    const loading = ref(false);
    const offset = ref(0);

    const hasMore = computed(() => items.value.length < total.value);

    async function load(reset = false) {
      loading.value = true;
      try {
        const off = reset ? 0 : offset.value;
        const r = await apiHistory.list(PAGE, off, q.value.trim());
        items.value = reset ? r.items : items.value.concat(r.items);
        total.value = r.total;
        offset.value = off + r.items.length;
        store.histCount = r.total;
      } catch (e) { ElMessage.error('历史加载失败：' + e.message); }
      finally { loading.value = false; }
    }
    const loadMore = () => load(false);

    let qTimer = 0;
    watch(q, () => {
      clearTimeout(qTimer);
      qTimer = setTimeout(() => load(true), 250);
    });

    /* 翻译完成后由 store.histReloadTick 触发刷新（置顶新记录） */
    watch(() => store.histReloadTick, () => load(true));

    function langName(code) { return nameOf(code || 'auto'); }
    function shortTime(ts) {
      return (ts || '').replace('T', ' ').slice(5, 16);
    }

    function fill(h) {
      store.fillRequest = {
        s: h.src_lang || 'auto', t: h.dst_lang || 'zh',
        in: h.src_text || '', ts: Date.now(),
      };
      store.asideDrawer = false;
      ElMessage.success('已回填到原文');
    }

    async function copy(h) {
      try { await navigator.clipboard.writeText(h.dst_text); ElMessage.success('已复制'); }
      catch { ElMessage.error('复制失败'); }
    }

    async function del(h) {
      try { await apiHistory.remove(h.id); } catch (e) { return ElMessage.error('删除失败'); }
      items.value = items.value.filter(x => x.id !== h.id);
      total.value = Math.max(0, total.value - 1);
      store.histCount = total.value;
      ElMessage.success('已删除');
    }

    async function clearAll() {
      try { await ElMessageBox.confirm('确定清空全部翻译历史？该操作不可恢复。', '确认', { type: 'warning' }); }
      catch { return; }
      try { await apiHistory.clear(); } catch (e) { return ElMessage.error('清空失败'); }
      items.value = []; total.value = 0; store.histCount = 0;
      ElMessage.success('历史已清空');
    }

    onMounted(async () => {
      await load(true);
      try { await apiStats(); } catch { /* 仅预热 */ }
    });

    return {
      store, items, total, q, loading, hasMore,
      Search: ElementPlusIconsVue.Search, CopyDocument: ElementPlusIconsVue.CopyDocument,
      Delete: ElementPlusIconsVue.Delete,
      loadMore, langName, shortTime, fill, copy, del, clearAll,
    };
  },
};
