import { api } from '../api.js';
import { store } from '../store.js';
import { badge, confirmDialog, emptyState, esc, modal, toast } from '../ui.js';

export const tagsPage = {
  async mount(ctx) {
    const actionsEl = ctx.setActions('<button class="btn primary" data-act="add">新建标签</button>');
    actionsEl.querySelector('[data-act="add"]').addEventListener('click', () => openTagModal(null));

    async function load() {
      let tags = [];
      try {
        tags = await api.tags(true);
      } catch (error) {
        toast(error.message, 'error');
      }
      render(tags);
    }

    function render(tags) {
      const totalLinks = tags.reduce((sum, tag) => sum + (tag.counts?.subjects || 0) + (tag.counts?.videos || 0) + (tag.counts?.texts || 0), 0);
      ctx.root.innerHTML = `
        <div class="card">
          <div class="row between">
            <div class="col" style="gap:2px">
              <div class="card-title" style="margin:0">标签总览 <span class="hint">标签用于主体、视频、文本的分组筛选，也是发布配置选择素材的依据</span></div>
              <div class="small muted-2">共 ${tags.length} 个标签 · 已建立 ${totalLinks} 条标签关联</div>
            </div>
            <div class="row">
              <span class="badge blue">主体标签 ${tags.reduce((s, t) => s + (t.counts?.subjects || 0), 0)}</span>
              <span class="badge orange">视频标签 ${tags.reduce((s, t) => s + (t.counts?.videos || 0), 0)}</span>
              <span class="badge green">文本标签 ${tags.reduce((s, t) => s + (t.counts?.texts || 0), 0)}</span>
            </div>
          </div>
        </div>
        <div class="card mt-16">
          <div class="card-title">标签列表</div>
          ${tags.length ? `
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th style="width:220px">标签</th><th style="width:240px">关联数量</th><th>备注</th><th style="width:90px">创建时间</th><th style="width:150px"></th></tr></thead>
                <tbody>${tags.map((tag) => `
                  <tr>
                    <td><span class="tag"><span class="dot" style="background:${esc(tag.color)}"></span>${esc(tag.name)}</span></td>
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
            </div>` : emptyState('🏷️', '还没有标签', '先创建标签，再到主体 / 视频池 / 文本池中批量赋予', '<button class="btn primary" data-act="add-empty">新建标签</button>')}
        </div>
        <div class="card mt-16">
          <div class="card-title">批量赋予标签</div>
          <div class="small muted" style="line-height:1.9">
            进入「主体管理 / 视频池 / 文本池」后点击右上角「批量编辑」，勾选多个卡片或行，再点「批量打标签」，即可一次性追加、覆盖或移除标签。
          </div>
        </div>
      `;
      bind(tags);
    }

    function bind(tags) {
      ctx.root.querySelectorAll('[data-act="add"], [data-act="add-empty"]').forEach((button) => {
        button.addEventListener('click', () => openTagModal(null));
      });
      ctx.root.querySelectorAll('[data-edit]').forEach((button) => {
        const tag = tags.find((item) => String(item.id) === button.dataset.edit);
        button.addEventListener('click', () => openTagModal(tag));
      });
      ctx.root.querySelectorAll('[data-del]').forEach((button) => {
        const tag = tags.find((item) => String(item.id) === button.dataset.del);
        button.addEventListener('click', async () => {
          if (!tag) return;
          const ok = await confirmDialog({
            title: '删除标签',
            message: `确定删除标签「${tag.name}」吗？\n\n主体/视频/文本与它的关联会一并移除（不会删除对象本身）。`,
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
            toast(error.message, 'error');
          }
        });
      });
    }

    function openTagModal(tag) {
      const dialog = modal({
        title: tag ? `编辑标签：${tag.name}` : '新建标签',
        body: `
          <div class="col">
            <label class="field"><span>标签名称</span><input type="text" data-name value="${esc(tag?.name || '')}" maxlength="20" placeholder="例如：6688 保暖裤"></label>
            <label class="field"><span>标签颜色</span>
              <div class="row">
                <input type="color" data-color value="${esc(tag?.color || '#6c5ce7')}" style="width:64px;height:38px;padding:3px">
                <input type="text" data-color-text value="${esc(tag?.color || '#6c5ce7')}" style="width:120px" maxlength="7">
              </div>
            </label>
            <label class="field"><span>备注（可选）</span><input type="text" data-note value="${esc(tag?.note || '')}" maxlength="100"></label>
          </div>`,
        footer: '<button class="btn" data-close>取消</button><button class="btn primary" data-save>保存</button>',
      });
      const colorEl = dialog.body.querySelector('[data-color]');
      const colorTextEl = dialog.body.querySelector('[data-color-text]');
      colorEl.addEventListener('input', () => { colorTextEl.value = colorEl.value; });
      colorTextEl.addEventListener('input', () => {
        if (/^#[0-9a-fA-F]{6}$/.test(colorTextEl.value)) colorEl.value = colorTextEl.value;
      });
      dialog.foot.querySelector('[data-save]').addEventListener('click', async () => {
        const name = dialog.body.querySelector('[data-name]').value.trim();
        if (!name) return toast('请输入标签名称', 'warn');
        const payload = {
          name,
          color: colorTextEl.value || colorEl.value,
          note: dialog.body.querySelector('[data-note]').value.trim(),
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
