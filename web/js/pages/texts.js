import { api } from '../api.js';
import { store } from '../store.js';
import {
  bindTagBar, chipSelector, confirmDialog, emptyState, esc, fmtDate, modal, readFileAsText, tagBarHtml, tagChips, toast,
} from '../ui.js';
import { batchBarHtml, openBatchTagModal } from './batch-tags.js';

const MAX_DESC = 1000;

export const textsPage = {
  async mount(ctx) {
    const state = {
      tagIds: [], query: '', uploaded: '', page: 1, pageSize: 100, data: [], total: 0,
      batchMode: false, selected: new Set(),
    };

    const actionsEl = ctx.setActions(`
      <button class="btn" data-act="batch">批量编辑</button>
      <button class="btn" data-act="import">导入文本</button>
      <button class="btn primary" data-act="add">新增文本</button>
    `);
    actionsEl.querySelector('[data-act="batch"]').addEventListener('click', () => {
      state.batchMode = !state.batchMode;
      state.selected.clear();
      actionsEl.querySelector('[data-act="batch"]').textContent = state.batchMode ? '退出批量' : '批量编辑';
      render(state.tagsCache || []);
    });
    actionsEl.querySelector('[data-act="import"]').addEventListener('click', () => openImportModal());
    actionsEl.querySelector('[data-act="add"]').addEventListener('click', () => openEditModal(null));

    async function load() {
      const tags = await store.loadTags(true);
      state.tagsCache = tags;
      const result = await api.texts({
        tagIds: state.tagIds, q: state.query, uploaded: state.uploaded, page: state.page, pageSize: state.pageSize,
      });
      state.data = result.data;
      state.total = result.total;
      render(tags);
    }

    function render(tags) {
      state.tagsCache = tags;
      const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
      ctx.root.innerHTML = `
        <div class="toolbar">
          <input type="search" placeholder="搜索文本内容 / 备注 / 标签" value="${esc(state.query)}" data-search>
          <select data-uploaded>
            <option value="" ${state.uploaded === '' ? 'selected' : ''}>全部上传状态</option>
            <option value="no" ${state.uploaded === 'no' ? 'selected' : ''}>未使用</option>
            <option value="yes" ${state.uploaded === 'yes' ? 'selected' : ''}>已使用</option>
          </select>
          <div class="spacer"></div>
          <button class="btn small ghost" data-act="refresh">刷新</button>
        </div>
        ${tagBarHtml(tags, state.tagIds)}
        ${state.batchMode ? batchBarHtml({ selected: state.selected.size, total: state.data.length }) : ''}
        ${state.data.length ? `
          <div class="table-wrap">
            <table class="table">
              <thead><tr>
                ${state.batchMode ? '<th style="width:40px"><input type="checkbox" data-select-all></th>' : ''}
                <th style="width:52px">ID</th><th>文本内容</th><th style="width:150px">标签</th><th style="width:90px">使用情况</th><th style="width:130px">更新时间</th><th style="width:150px"></th>
              </tr></thead>
              <tbody>${state.data.map((text) => {
                const checked = state.selected.has(String(text.id));
                return `
                <tr data-text="${text.id}" class="${state.batchMode && checked ? 'selected-row' : ''}" style="${state.batchMode ? 'cursor:pointer' : ''};${state.batchMode && checked ? 'background:var(--accent-soft)' : ''}">
                  ${state.batchMode ? `<td><input type="checkbox" data-select="${text.id}" ${checked ? 'checked' : ''}></td>` : ''}
                  <td class="mono muted-2">${text.id}</td>
                  <td>
                    <div class="text-preview" style="cursor:pointer;white-space:pre-wrap;max-height:70px;overflow:hidden" data-act="view" title="点击查看完整内容">${esc(text.content)}</div>
                    <div class="small muted-2">${text.content.length} 字${text.note ? ` · ${esc(text.note)}` : ''}</div>
                  </td>
                  <td>${text.tags.length ? `<div class="filter-tags">${tagChips(text.tags, { max: 3 })}</div>` : '<span class="muted-2 small">-</span>'}</td>
                  <td>${text.uploadCount ? `<span class="badge green">已用 ${text.uploadCount} 次</span>` : '<span class="badge gray">未使用</span>'}</td>
                  <td class="small muted-2">${esc(fmtDate(text.updatedAt))}</td>
                  <td><div class="actions">
                    <button class="btn small ghost" data-act="view">查看</button>
                    <button class="btn small ghost" data-act="edit">编辑</button>
                    <button class="btn small ghost" data-act="tags">标签</button>
                    <button class="btn small danger" data-act="delete">删除</button>
                  </div></td>
                </tr>`;
              }).join('')}
              </tbody>
            </table>
          </div>` : emptyState('📝', '文本池还是空的', '可以新增单条文本，或从 txt / JSON 批量导入（内容需全局唯一）', '<button class="btn primary" data-act="import-empty">导入文本</button>')}
        <div class="row between mt-16">
          <div class="small muted-2">共 ${state.total} 条文本 · 第 ${state.page}/${pages} 页</div>
          <div class="row">
            <button class="btn small" data-act="prev" ${state.page <= 1 ? 'disabled' : ''}>上一页</button>
            <button class="btn small" data-act="next" ${state.page >= pages ? 'disabled' : ''}>下一页</button>
          </div>
        </div>
      `;
      bind(tags);
    }

    function bind(tags) {
      // 批量选择
      ctx.root.querySelector('[data-batch="all"]')?.addEventListener('click', () => {
        state.data.forEach((text) => state.selected.add(String(text.id)));
        render(tags);
      });
      ctx.root.querySelector('[data-batch="clear"]')?.addEventListener('click', () => {
        state.selected.clear();
        render(tags);
      });
      ctx.root.querySelector('[data-batch="apply"]')?.addEventListener('click', async () => {
        await openBatchTagModal({
          kind: 'text',
          ids: [...state.selected],
          onApplied: async () => { state.selected.clear(); await load(); },
        });
      });
      ctx.root.querySelector('[data-batch="exit"]')?.addEventListener('click', () => {
        state.batchMode = false;
        state.selected.clear();
        const batchButton = actionsEl.querySelector('[data-act="batch"]');
        if (batchButton) batchButton.textContent = '批量编辑';
        render(tags);
      });
      ctx.root.querySelector('[data-select-all]')?.addEventListener('change', (event) => {
        if (event.target.checked) state.data.forEach((text) => state.selected.add(String(text.id)));
        else state.selected.clear();
        render(tags);
      });
      ctx.root.querySelectorAll('[data-select]').forEach((checkbox) => {
        checkbox.addEventListener('click', (event) => event.stopPropagation());
        checkbox.addEventListener('change', () => {
          const id = String(checkbox.dataset.select);
          if (checkbox.checked) state.selected.add(id);
          else state.selected.delete(id);
          render(tags);
        });
      });
      ctx.root.querySelectorAll('tr[data-text]').forEach((row) => {
        if (!state.batchMode) return;
        row.addEventListener('click', (event) => {
          if (event.target.closest('button, a, input, label')) return;
          const id = String(row.dataset.text);
          if (state.selected.has(id)) state.selected.delete(id);
          else state.selected.add(id);
          render(tags);
        });
      });

      ctx.root.querySelector('[data-search]')?.addEventListener('input', (event) => {
        state.query = event.target.value.trim();
        state.page = 1;
        load();
      });
      ctx.root.querySelector('[data-uploaded]')?.addEventListener('change', (event) => {
        state.uploaded = event.target.value;
        state.page = 1;
        load();
      });
      bindTagBar(ctx.root, tags, state.tagIds, (ids) => {
        state.tagIds = ids;
        state.page = 1;
        load();
      });
      ctx.root.querySelector('[data-act="refresh"]')?.addEventListener('click', () => load().then(() => toast('已刷新', 'success')));
      ctx.root.querySelector('[data-act="import-empty"]')?.addEventListener('click', () => openImportModal());
      ctx.root.querySelector('[data-act="prev"]')?.addEventListener('click', () => { state.page -= 1; load(); });
      ctx.root.querySelector('[data-act="next"]')?.addEventListener('click', () => { state.page += 1; load(); });
      ctx.root.querySelectorAll('[data-text] [data-act]').forEach((button) => {
        button.addEventListener('click', () => {
          const text = state.data.find((item) => String(item.id) === button.closest('[data-text]').dataset.text);
          if (!text) return;
          const action = button.dataset.act;
          if (action === 'view') return viewText(text);
          if (action === 'edit') return openEditModal(text);
          if (action === 'tags') return editTags(text);
          if (action === 'delete') return removeText(text);
        });
      });
    }

    function viewText(text) {
      modal({
        title: `文本 #${text.id}`,
        wide: true,
        body: `
          <div style="white-space:pre-wrap;line-height:1.8;background:var(--bg-soft);padding:16px;border-radius:10px;border:1px solid var(--border)">${esc(text.content)}</div>
          <div class="kv mt-16">
            <div class="k">字数</div><div>${text.content.length} / ${MAX_DESC}</div>
            <div class="k">标签</div><div class="filter-tags">${text.tags.length ? tagChips(text.tags) : '<span class="muted-2">未打标签</span>'}</div>
            <div class="k">使用情况</div><div>${text.uploadCount ? `已使用 ${text.uploadCount} 次，最近 ${esc(fmtDate(text.lastUploadedAt))}` : '未使用'}</div>
            <div class="k">内容哈希</div><div class="mono small">${esc(text.hash)}</div>
          </div>`,
        footer: '<button class="btn" data-close>关闭</button>',
      });
    }

    async function openEditModal(text) {
      const tags = await store.loadTags(true);
      const dialog = modal({
        title: text ? `编辑文本 #${text.id}` : '新增文本',
        wide: true,
        body: `
          <div class="col">
            <label class="field">
              <span>文本内容（用于视频描述，建议 ${MAX_DESC} 字以内） <span class="muted-2" data-count>0 字</span></span>
              <textarea data-content style="min-height:180px" maxlength="${MAX_DESC + 200}" placeholder="输入视频描述文本">${esc(text?.content || '')}</textarea>
            </label>
            <label class="field"><span>备注（可选）</span><input type="text" data-note value="${esc(text?.note || '')}" placeholder="仅在列表中展示，方便管理"></label>
            <div class="field"><span>标签</span><div class="chip-select" data-tags></div></div>
            <div class="help-text">文本内容全局唯一：重复内容不会重复入库。</div>
          </div>`,
        footer: `<button class="btn" data-close>取消</button><button class="btn primary" data-save>${text ? '保存' : '新增'}</button>`,
      });
      const contentEl = dialog.body.querySelector('[data-content]');
      const countEl = dialog.body.querySelector('[data-count]');
      const updateCount = () => {
        const count = contentEl.value.length;
        countEl.textContent = `${count} 字`;
        countEl.style.color = count > MAX_DESC ? 'var(--red)' : '';
      };
      contentEl.addEventListener('input', updateCount);
      updateCount();
      const chip = chipSelector(dialog.body.querySelector('[data-tags]'), tags, text?.tags.map((tag) => tag.id) || []);
      dialog.foot.querySelector('[data-save]').addEventListener('click', async () => {
        const content = contentEl.value.trim();
        if (!content) return toast('文本内容不能为空', 'warn');
        try {
          if (text) {
            await api.updateText(text.id, { content, note: dialog.body.querySelector('[data-note]').value.trim(), tagIds: chip.getSelected() });
          } else {
            await api.createText({ content, note: dialog.body.querySelector('[data-note]').value.trim(), tagIds: chip.getSelected() });
          }
          dialog.close();
          toast('已保存', 'success');
          await load();
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    }

    async function openImportModal() {
      const tags = await store.loadTags(true);
      const dialog = modal({
        title: '导入文本',
        wide: true,
        body: `
          <div class="col">
            <div class="row">
              <label class="check"><input type="radio" name="sep" value="line" checked> 每行一条</label>
              <label class="check"><input type="radio" name="sep" value="blank-line"> 空行分隔</label>
              <label class="check"><input type="radio" name="sep" value="json"> JSON 字符串数组</label>
              <div class="spacer"></div>
              <label class="btn small ghost" style="cursor:pointer">选择文件<input type="file" accept=".txt,.json,text/plain,application/json" data-file style="display:none"></label>
            </div>
            <label class="field"><span>文本内容 <span class="muted-2" data-count>0 条</span></span>
              <textarea data-content style="min-height:200px" placeholder="粘贴文本内容；选择 JSON 时格式为 [&quot;文本1&quot;,&quot;文本2&quot;]"></textarea>
            </label>
            <div class="field"><span>统一标签（可选）</span><div class="chip-select" data-tags></div></div>
            <label class="field"><span>备注（可选）</span><input type="text" data-note placeholder="例如：活动素材 / 2026 新品"></label>
          </div>`,
        footer: '<button class="btn" data-close>取消</button><button class="btn primary" data-import>开始导入</button>',
      });
      const contentEl = dialog.body.querySelector('[data-content]');
      const countEl = dialog.body.querySelector('[data-count]');
      const separator = () => dialog.body.querySelector('input[name="sep"]:checked')?.value || 'line';
      const updateCount = () => {
        const raw = contentEl.value.replace(/\r\n/g, '\n');
        let count = 0;
        if (!raw.trim()) count = 0;
        else if (separator() === 'blank-line') count = raw.split(/\n\s*\n/).filter((item) => item.trim()).length;
        else count = raw.split('\n').filter((item) => item.trim()).length;
        countEl.textContent = `${count} 条`;
      };
      contentEl.addEventListener('input', updateCount);
      dialog.body.querySelectorAll('input[name="sep"]').forEach((radio) => radio.addEventListener('change', updateCount));
      updateCount();
      const chip = chipSelector(dialog.body.querySelector('[data-tags]'), tags, []);
      dialog.body.querySelector('[data-file]').addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
          const text = await readFileAsText(file);
          contentEl.value = text;
          if (file.name.endsWith('.json')) {
            dialog.body.querySelector('input[name="sep"][value="json"]').checked = true;
          }
          updateCount();
          toast(`已读取文件：${file.name}`, 'success');
        } catch (error) {
          toast(`读取文件失败：${error.message}`, 'error');
        }
      });
      dialog.foot.querySelector('[data-import]').addEventListener('click', async () => {
        const raw = contentEl.value.trim();
        if (!raw) return toast('请粘贴或选择文本内容', 'warn');
        try {
          const result = await api.importTexts({
            text: contentEl.value,
            separator: separator(),
            note: dialog.body.querySelector('[data-note]').value.trim(),
            tagIds: chip.getSelected(),
          });
          dialog.close();
          toast(`导入完成：新增 ${result.created} 条，重复 ${result.duplicated} 条，跳过 ${result.skipped} 条`, 'success', 5000);
          await load();
        } catch (error) {
          toast(error.message, 'error', 6000);
        }
      });
    }

    async function editTags(text) {
      const tags = await store.loadTags(true);
      const dialog = modal({
        title: `编辑标签：文本 #${text.id}`,
        body: '<div class="chip-select" data-tags></div>',
        footer: '<button class="btn" data-close>取消</button><button class="btn primary" data-save>保存</button>',
      });
      const chip = chipSelector(dialog.body.querySelector('[data-tags]'), tags, text.tags.map((tag) => tag.id));
      dialog.foot.querySelector('[data-save]').addEventListener('click', async () => {
        try {
          await api.updateText(text.id, { tagIds: chip.getSelected() });
          dialog.close();
          toast('已保存', 'success');
          await load();
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    }

    async function removeText(text) {
      const ok = await confirmDialog({
        title: '删除文本',
        message: `确定删除文本 #${text.id} 吗？\n\n${text.content.slice(0, 80)}${text.content.length > 80 ? '…' : ''}`,
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.deleteText(text.id);
        toast('已删除', 'success');
        await load();
      } catch (error) {
        toast(error.message, 'error');
      }
    }

    await load();
    return undefined;
  },
};
