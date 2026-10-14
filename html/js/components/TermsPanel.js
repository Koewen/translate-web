/* ============================================================
 * TermsPanel.js —— 术语干预面板（SQLite 持久化）
 * 同名 src 再次提交即更新（幂等 upsert）
 * ============================================================ */
import { store } from '../store.js';
import { apiTerms } from '../api.js';

export default {
  name: 'TermsPanel',
  template: `
  <div style="height:100%;display:flex;flex-direction:column">
    <div class="term-add">
      <div class="row">
        <el-input v-model="form.src" size="small" placeholder="原文术语，如 image"
                  @keydown.enter="submit" />
        <el-input v-model="form.dst" size="small" placeholder="指定译名，如 镜像"
                  @keydown.enter="submit" />
      </div>
      <div class="row">
        <el-input v-model="form.note" size="small" placeholder="备注（可选）" />
        <el-button type="primary" size="small" :loading="saving" @click="submit" style="flex:none">
          {{ form.id ? '保存' : '添加' }}
        </el-button>
      </div>
      <div style="font-size:11px;color:var(--text-3)">同名原文重复提交会更新译名；启用的术语将注入翻译提示词。</div>
    </div>

    <div class="panel-toolbar" style="margin-top:8px">
      <el-input v-model="q" size="small" :prefix-icon="Search" placeholder="筛选术语" clearable />
      <span style="font-size:11.5px;color:var(--text-3);white-space:nowrap">
        {{ enabledCount }}/{{ store.terms.length }} 启用
      </span>
    </div>

    <el-scrollbar class="panel-scroll">
      <div v-if="!filtered.length" class="panel-empty">
        暂无术语。添加后翻译时将强制采用指定译法。
      </div>
      <div v-for="t in filtered" :key="t.id" class="term-item" :class="{ disabled: !t.enabled }">
        <el-switch v-model="t.enabled" size="small" @change="v => toggle(t, v)" />
        <div class="pair">
          <div><span class="s">{{ t.src }}</span><span class="arrow">→</span><span class="d">{{ t.dst }}</span></div>
          <div class="note" v-if="t.note">{{ t.note }}</div>
        </div>
        <el-button :icon="Edit" circle size="small" text title="编辑" @click="edit(t)" />
        <el-button :icon="Delete" circle size="small" text type="danger" title="删除" @click="del(t)" />
      </div>
    </el-scrollbar>
  </div>
  `,
  setup() {
    const { ref, computed, onMounted, watch } = Vue;
    const { ElMessage, ElMessageBox } = ElementPlus;
    const form = ref({ id: null, src: '', dst: '', note: '' });
    const q = ref('');
    const saving = ref(false);

    const enabledCount = computed(() => store.terms.filter(t => t.enabled).length);
    const filtered = computed(() => {
      const k = q.value.trim().toLowerCase();
      if (!k) return store.terms;
      return store.terms.filter(t =>
        t.src.toLowerCase().includes(k) || t.dst.toLowerCase().includes(k) ||
        (t.note || '').toLowerCase().includes(k));
    });

    async function load() {
      try {
        const r = await apiTerms.list();
        store.terms = r.items;
        store.termsLoaded = true;
      } catch (e) { ElMessage.error('术语加载失败：' + e.message); }
    }

    async function submit() {
      const src = form.value.src.trim(), dst = form.value.dst.trim();
      if (!src || !dst) return ElMessage.warning('原文术语与指定译名都要填');
      saving.value = true;
      try {
        await apiTerms.upsert(src, dst, form.value.note.trim());
        ElMessage.success(form.value.id ? '术语已更新' : '术语已添加');
        form.value = { id: null, src: '', dst: '', note: '' };
        await load();
      } catch (e) { ElMessage.error('保存失败：' + e.message); }
      finally { saving.value = false; }
    }

    function edit(t) { form.value = { id: t.id, src: t.src, dst: t.dst, note: t.note || '' }; }

    async function toggle(t, v) {
      try { await apiTerms.update(t.id, { enabled: v ? 1 : 0 }); }
      catch (e) { t.enabled = v ? 0 : 1; ElMessage.error('更新失败：' + e.message); }
    }

    async function del(t) {
      try {
        await ElMessageBox.confirm('删除术语「' + t.src + '」？', '确认', { type: 'warning' });
      } catch { return; }
      try {
        await apiTerms.remove(t.id);
        store.terms = store.terms.filter(x => x.id !== t.id);
        ElMessage.success('已删除');
      } catch (e) { ElMessage.error('删除失败：' + e.message); }
    }

    onMounted(load);
    return {
      store, form, q, saving, filtered, enabledCount,
      Search: ElementPlusIconsVue.Search, Edit: ElementPlusIconsVue.Edit,
      Delete: ElementPlusIconsVue.Delete, submit, edit, toggle, del,
    };
  },
};
