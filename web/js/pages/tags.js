import { api } from '../api.js';
import { store } from '../store.js';
import { badge, confirmDialog, emptyState, esc, modal, toast } from '../ui.js';

const MODE_LABEL = { single: '单选', multiple: '多选' };

/**
 * 标签管理：上方标签组区域，下方标签列表区域。
 * 标签组是具体标签的分类，并可设置组内单选/多选约束（单选组内只能选一个具体标签）。
 */
export const tagsPage = {
  async mount(ctx) {
    ctx.setActions('');
    const state = { groups: [], tags: [], selectedGroupId: null };

    async function load() {
      try {
        const [groups, tags] = await Promise.all([api.tagGroups(true), api.tags(true)]);
        state.groups = groups;
        state.tags = tags;
        if (state.selectedGroupId && !groups.some((group) => Number(group.id) === Number(state.selectedGroupId))) {
          state.selectedGroupId = null;
        }
      } catch (error) {
        toast(error.message, 'error');
      }
      render();
    }

    function tagsOfGroup(groupId) {
      return state.tags.filter((tag) => Number(tag.groupId) === Number(groupId));
    }

    function filteredTags() {
      return state.selectedGroupId ? tagsOfGroup(state.selectedGroupId) : state.tags;
    }

    function usageTotal(tags) {
      return tags.reduce((sum, tag) => sum + (tag.counts?.subjects || 0) + (tag.counts?.videos || 0) + (tag.counts?.texts || 0), 0);
    }

    function render() {
      const tags = filteredTags();
      const selectedGroup = state.selectedGroupId
        ? state.groups.find((group) => Number(group.id) === Number(state.selectedGroupId)) || null
        : null;
      const totalLinks = usageTotal(state.tags);
      ctx.root.innerHTML = `
        <div class="card">
          <div class="row between">
            <div class="col" style="gap:2px">
              <div class="card-title" style="margin:0">标签组 <span class="hint">标签组用于分类具体标签，并可限制组内标签的选择方式</span></div>
              <div class="small muted-2">共 ${state.groups.length} 个标签组 · 点击标签组筛选下方具体标签 · 当前共 ${state.tags.length} 个具体标签 / ${totalLinks} 条关联</div>
            </div>
            <button class="btn small primary" data-act="add-group">＋ 新增标签组</button>
          </div>
          <div class="tag-group-list">
            <div class="tag-group-row all ${state.selectedGroupId === null ? 'active' : ''}" data-group="" role="button" tabindex="0">
              <span class="dot" style="background:var(--accent)"></span>
              <span class="tag-group-name">全部标签</span>
              <span class="badge gray">${state.tags.length} 个标签</span>
            </div>
            ${state.groups.length ? state.groups.map((group) => {
              const groupTags = tagsOfGroup(group.id);
              const active = Number(state.selectedGroupId) === Number(group.id);
              return `
                <div class="tag-group-row ${active ? 'active' : ''}" data-group="${group.id}" role="button" tabindex="0">
                  <span class="dot" style="background:${esc(group.color)}"></span>
                  <span class="tag-group-name">${esc(group.name)}</span>
                  <span class="badge ${group.selectionMode === 'single' ? 'blue' : 'gray'}">${MODE_LABEL[group.selectionMode]}</span>
                  <span class="small muted-2">${group.tagCount} 个标签 · 关联 ${usageTotal(groupTags)} 条</span>
                  ${group.note ? `<span class="small muted-2 truncate">${esc(group.note)}</span>` : ''}
                  <span class="spacer" style="flex:1"></span>
                  <button class="btn small ghost" data-mode-toggle="${group.id}" title="切换组内选择方式（单选/多选）">${MODE_LABEL[group.selectionMode]}</button>
                  <button class="btn small ghost" data-group-edit="${group.id}">编辑</button>
                  <button class="btn small danger" data-group-del="${group.id}">删除</button>
                </div>`;
            }).join('') : '<div class="small muted-2" style="padding:10px 4px">还没有标签组，请先新增标签组再创建具体标签</div>'}
          </div>
        </div>

        <div class="card mt-16">
          <div class="row between">
            <div class="card-title" style="margin:0">标签列表
              <span class="hint">${selectedGroup ? `当前标签组：${esc(selectedGroup.name)}（${MODE_LABEL[selectedGroup.selectionMode]}）` : '全部标签（未选择标签组）'}</span>
            </div>
            <button class="btn small primary" data-act="add-tag">＋ 新增标签</button>
          </div>
          ${tags.length ? `
            <div class="table-wrap">
              <table class="table">
                <thead><tr>
                  <th style="width:220px">标签</th>
                  <th style="width:180px">所属标签组</th>
                  <th style="width:240px">关联数量</th>
                  <th>备注</th>
                  <th style="width:100px">创建时间</th>
                  <th style="width:150px"></th>
                </tr></thead>
                <tbody>${tags.map((tag) => `
                  <tr>
                    <td><span class="tag"><span class="dot" style="background:${esc(tag.color)}"></span>${esc(tag.name)}</span></td>
                    <td>
                      <span class="small">${esc(tag.groupName || '未分组')}</span>
                      <span class="badge ${tag.groupSelectionMode === 'single' ? 'blue' : 'gray'}">${MODE_LABEL[tag.groupSelectionMode]}</span>
                    </td>
                    <td>
                      <div class="row" style="gap:6px">
                        <span class="badge blue">主体 ${tag.counts?.subjects || 0}</span>
                        <span class="badge orange">视频 ${tag.counts?.videos || 0}</span>
                        <span class="badge green">文本 ${tag.counts?.texts || 0}</span>
                      </div>
                    </td>
                    <td class="small muted-2">${esc(tag.note || '-')}</td>
                    <td class="small muted-2">${esc((tag.created_at || '').slice(0, 10))}</td>
                    <td><div class="actions">
                      <button class="btn small ghost" data-edit="${tag.id}">编辑</button>
                      <button class="btn small danger" data-del="${tag.id}">删除</button>
                    </div></td>
                  </tr>`).join('')}
                </tbody>
              </table>
            </div>` : emptyState('🏷️', state.selectedGroupId ? '该标签组下还没有具体标签' : '还没有标签', '点击右上角「新增标签」创建；标签可归属到标签组', '<button class="btn primary" data-act="add-tag">新增标签</button>')}
        </div>

        <div class="card mt-16">
          <div class="card-title">批量赋予标签</div>
          <div class="small muted" style="line-height:1.9">
            进入「主体管理 / 视频池 / 文本池」后点击右上角「批量编辑」，勾选多个卡片或行，再点「批量打标签」，即可一次性追加、覆盖或移除标签。<br>
            标签组为<b>单选</b>时，任意位置选择标签都只能选中该组内一个具体标签；删除标签组前需先清空其下标签，删除标签前需先解除主体/视频/文本关联。
          </div>
        </div>
      `;
      bind();
    }

    function bind() {
      ctx.root.querySelector('[data-act="add-group"]').addEventListener('click', () => openGroupModal(null));
      ctx.root.querySelectorAll('[data-act="add-tag"]').forEach((button) => {
        button.addEventListener('click', () => openTagModal(null));
      });
      // 点击标签组：筛选下方标签列表
      ctx.root.querySelectorAll('.tag-group-row').forEach((row) => {
        row.addEventListener('click', (event) => {
          if (event.target.closest('button')) return;
          const raw = row.dataset.group;
          state.selectedGroupId = raw ? Number(raw) : null;
          render();
        });
      });
      ctx.root.querySelectorAll('[data-mode-toggle]').forEach((button) => {
        button.addEventListener('click', async (event) => {
          event.stopPropagation();
          const group = state.groups.find((item) => Number(item.id) === Number(button.dataset.modeToggle));
          if (!group) return;
          const next = group.selectionMode === 'single' ? 'multiple' : 'single';
          try {
            await api.updateTagGroup(group.id, { selectionMode: next });
            toast(`标签组「${group.name}」已切换为${MODE_LABEL[next]}`, 'success');
            await load();
          } catch (error) {
            toast(error.message, 'error');
          }
        });
      });
      ctx.root.querySelectorAll('[data-group-edit]').forEach((button) => {
        const group = state.groups.find((item) => Number(item.id) === Number(button.dataset.groupEdit));
        button.addEventListener('click', (event) => { event.stopPropagation(); if (group) openGroupModal(group); });
      });
      ctx.root.querySelectorAll('[data-group-del]').forEach((button) => {
        const group = state.groups.find((item) => Number(item.id) === Number(button.dataset.groupDel));
        button.addEventListener('click', async (event) => {
          event.stopPropagation();
          if (!group) return;
          const ok = await confirmDialog({
            title: '删除标签组',
            message: `确定删除标签组「${group.name}」吗？\n\n仅当该标签组下没有具体标签时才能删除。`,
            okText: '删除',
            danger: true,
          });
          if (!ok) return;
          try {
            await api.deleteTagGroup(group.id);
            store.invalidateTags();
            toast('已删除标签组', 'success');
            if (Number(state.selectedGroupId) === Number(group.id)) state.selectedGroupId = null;
            await load();
          } catch (error) {
            toast(error.message, 'error', 6000);
          }
        });
      });
      ctx.root.querySelectorAll('[data-edit]').forEach((button) => {
        const tag = state.tags.find((item) => String(item.id) === button.dataset.edit);
        button.addEventListener('click', () => { if (tag) openTagModal(tag); });
      });
      ctx.root.querySelectorAll('[data-del]').forEach((button) => {
        const tag = state.tags.find((item) => String(item.id) === button.dataset.del);
        button.addEventListener('click', async () => {
          if (!tag) return;
          const ok = await confirmDialog({
            title: '删除标签',
            message: `确定删除标签「${tag.name}」吗？\n\n仅当该标签没有关联任何主体/视频/文本时才能删除。`,
            okText: '删除',
            danger: true,
          });
          if (!ok) return;
          try {
            await api.deleteTag(tag.id);
            store.invalidateTags();
            toast('已删除', 'success');
            await load();
          } catch (error) {
            toast(error.message, 'error', 6000);
          }
        });
      });
    }

    function colorFields(initial = '#6c5ce7') {
      return `
        <label class="field"><span>颜色</span>
          <div class="row">
            <input type="color" data-color value="${esc(initial)}" style="width:64px;height:38px;padding:3px">
            <input type="text" data-color-text value="${esc(initial)}" style="width:120px" maxlength="7">
          </div>
        </label>`;
    }

    function bindColorFields(dialog) {
      const colorEl = dialog.body.querySelector('[data-color]');
      const colorTextEl = dialog.body.querySelector('[data-color-text]');
      colorEl.addEventListener('input', () => { colorTextEl.value = colorEl.value; });
      colorTextEl.addEventListener('input', () => {
        if (/^#[0-9a-fA-F]{6}$/.test(colorTextEl.value)) colorEl.value = colorTextEl.value;
      });
      return () => colorTextEl.value || colorEl.value;
    }

    function openGroupModal(group) {
      const dialog = modal({
        title: group ? `编辑标签组：${group.name}` : '新增标签组',
        body: `
          <div class="col">
            <label class="field"><span>标签组名称</span><input type="text" data-name value="${esc(group?.name || '')}" maxlength="20" placeholder="例如：产品 / 人群 / 场景"></label>
            ${colorFields(group?.color || '#6c5ce7')}
            <div class="field"><span>组内选择方式</span>
              <div class="row">
                <label class="check"><input type="radio" name="group-mode" value="multiple" ${group?.selectionMode !== 'single' ? 'checked' : ''}> 多选（组内标签可任意选择）</label>
                <label class="check"><input type="radio" name="group-mode" value="single" ${group?.selectionMode === 'single' ? 'checked' : ''}> 单选（组内只能选一个标签）</label>
              </div>
            </div>
            <label class="field"><span>备注（可选）</span><input type="text" data-note value="${esc(group?.note || '')}" maxlength="100"></label>
            <div class="help-text">标签组本身是分类层级，不直接关联主体/视频/文本；具体标签归属一个标签组。单选约束对全项目生效（筛选、批量打标签、发布配置选择标签等）。</div>
          </div>`,
        footer: '<button class="btn" data-close>取消</button><button class="btn primary" data-save>保存</button>',
      });
      const getColor = bindColorFields(dialog);
      dialog.foot.querySelector('[data-save]').addEventListener('click', async () => {
        const name = dialog.body.querySelector('[data-name]').value.trim();
        if (!name) return toast('请输入标签组名称', 'warn');
        const payload = {
          name,
          color: getColor(),
          note: dialog.body.querySelector('[data-note]').value.trim(),
          selectionMode: dialog.body.querySelector('input[name="group-mode"]:checked').value,
        };
        try {
          if (group) await api.updateTagGroup(group.id, payload);
          else {
            const created = await api.createTagGroup(payload);
            state.selectedGroupId = Number(created.id);
          }
          store.invalidateTags();
          dialog.close();
          toast(group ? '已保存标签组' : '标签组已创建', 'success');
          await load();
        } catch (error) {
          toast(error.message, 'error', 6000);
        }
      });
    }

    function openTagModal(tag) {
      if (!state.groups.length) {
        toast('请先新增标签组，再创建具体标签', 'warn');
        openGroupModal(null);
        return;
      }
      const defaultGroupId = tag?.groupId || state.selectedGroupId || state.groups[0].id;
      const dialog = modal({
        title: tag ? `编辑标签：${tag.name}` : '新增标签',
        body: `
          <div class="col">
            <label class="field"><span>标签名称</span><input type="text" data-name value="${esc(tag?.name || '')}" maxlength="20" placeholder="例如：6688 保暖裤"></label>
            <label class="field"><span>所属标签组</span>
              <select data-group>${state.groups.map((group) => `<option value="${group.id}" ${Number(defaultGroupId) === Number(group.id) ? 'selected' : ''}>${esc(group.name)}（${MODE_LABEL[group.selectionMode]}）</option>`).join('')}</select>
            </label>
            ${colorFields(tag?.color || '#6c5ce7')}
            <label class="field"><span>备注（可选）</span><input type="text" data-note value="${esc(tag?.note || '')}" maxlength="100"></label>
            <div class="help-text">每个具体标签只能归属一个标签组；标签组为单选时，内容只能选择该组内一个标签。</div>
          </div>`,
        footer: '<button class="btn" data-close>取消</button><button class="btn primary" data-save>保存</button>',
      });
      const getColor = bindColorFields(dialog);
      dialog.foot.querySelector('[data-save]').addEventListener('click', async () => {
        const name = dialog.body.querySelector('[data-name]').value.trim();
        if (!name) return toast('请输入标签名称', 'warn');
        const payload = {
          name,
          color: getColor(),
          note: dialog.body.querySelector('[data-note]').value.trim(),
          groupId: Number(dialog.body.querySelector('[data-group]').value),
        };
        try {
          if (tag) await api.updateTag(tag.id, payload);
          else await api.createTag(payload);
          store.invalidateTags();
          dialog.close();
          toast(tag ? '已保存' : '标签已创建', 'success');
          await load();
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    }

    await load();
    return undefined;
  },
};
