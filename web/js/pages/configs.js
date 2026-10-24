import { api } from '../api.js';
import { store } from '../store.js';
import {
  badge, chipSelector, confirmDialog, emptyState, esc, fmtDate, modal, tagChips, toast,
} from '../ui.js';

const STRATEGIES = [
  { value: 'sequential', label: '顺序' },
  { value: 'random', label: '随机（可重复）' },
  { value: 'random-unique', label: '随机（不可重复）' },
  { value: 'fixed', label: '固定指定' },
];

const UPLOAD_FILTER = [
  { value: '', label: '不限' },
  { value: 'no', label: '仅未使用过' },
  { value: 'yes', label: '仅已使用过' },
];

function optionList(items, selected) {
  return items.map((item) => `<option value="${esc(item.value)}" ${String(selected) === String(item.value) ? 'selected' : ''}>${esc(item.label)}</option>`).join('');
}

function field(label, inner, hint = '') {
  return `<label class="field"><span>${label}</span>${inner}${hint ? `<span class="help-text">${esc(hint)}</div>` : ''}</label>`;
}

export const configsPage = {
  async mount(ctx) {
    const state = { configs: [], tags: [], subjects: [] };

    const actionsEl = ctx.setActions('<button class="btn primary" data-act="new">新建发布配置</button>');
    actionsEl.querySelector('[data-act="new"]').addEventListener('click', () => openEditor(null));

    async function load() {
      const [configs, tags, subjects] = await Promise.all([api.configs(), store.loadTags(true), api.subjects()]);
      state.configs = configs;
      state.tags = tags;
      state.subjects = subjects;
      render();
    }

    function subjectSummary(config) {
      const selection = config.subjectSelection || {};
      if (selection.mode === 'tags') {
        const names = (selection.tags || []).map((id) => state.tags.find((tag) => Number(tag.id) === Number(id))?.name).filter(Boolean);
        return names.length ? `按标签：${names.join('、')}` : '未选择标签';
      }
      const names = (selection.ids || []).map((id) => state.subjects.find((subject) => subject.id === id)?.name).filter(Boolean);
      return names.length ? `指定 ${names.length} 个主体：${names.slice(0, 3).join('、')}${names.length > 3 ? '…' : ''}` : '未选择主体';
    }

    function tagNames(ids) {
      const names = (ids || []).map((id) => state.tags.find((tag) => Number(tag.id) === Number(id))?.name).filter(Boolean);
      return names.length ? names.join('、') : '全部';
    }

    function render() {
      ctx.root.innerHTML = `
        ${state.configs.length ? `<div class="grid cols-2">${state.configs.map(configCard).join('')}</div>` : emptyState('⚙️', '还没有发布配置', '发布配置封装了主体、视频池、文本池与发表动态页面的选项', '<button class="btn primary" data-act="new">新建发布配置</button>')}
        <div class="card mt-16">
          <div class="card-title">说明</div>
          <div class="small muted" style="line-height:1.9">
            发布配置会把「主体 + 视频 + 文本 + 页面选项」封装成一次可重复执行的任务。<br>
            选择策略中的「顺序」按资源 ID 依次使用；「随机（不可重复）」在同配置内用尽后会自动重置（可在配置中关闭）。<br>
            建议先使用「演练模式」跑一轮，确认填写正确后再正式发表。
          </div>
        </div>`;
      bind();
    }

    function configCard(config) {
      const cfg = config.config;
      const actionBadge = cfg.action === 'publish' ? badge('直接发表', 'orange') : badge('保存草稿', 'blue');
      return `
        <div class="card" data-config="${esc(config.id)}">
          <div class="row between">
            <div class="col" style="gap:2px">
              <div style="font-weight:650;font-size:15px">${esc(config.name)}</div>
              <div class="small muted-2">更新于 ${esc(fmtDate(config.updatedAt))}</div>
            </div>
            ${actionBadge}
          </div>
          <div class="divider" style="margin:12px 0"></div>
          <div class="kv small">
            <div class="k">主体</div><div>${esc(subjectSummary(cfg))}</div>
            <div class="k">视频池</div><div>标签：${esc(tagNames(cfg.videoSelection.tags))} · ${esc(STRATEGIES.find((s) => s.value === cfg.videoSelection.strategy)?.label || cfg.videoSelection.strategy)}${cfg.videoSelection.fixedVideoId ? ' · 固定视频' : ''}</div>
            <div class="k">文本池</div><div>标签：${esc(tagNames(cfg.textSelection.tags))} · ${esc(STRATEGIES.find((s) => s.value === cfg.textSelection.strategy)?.label || cfg.textSelection.strategy)}${cfg.textSelection.fixedTextId ? ' · 固定文本' : ''}</div>
            <div class="k">页面选项</div><div class="small">${esc(pageOptionSummary(cfg))}</div>
            <div class="k">结果同步</div><div>${cfg.syncWechat ? '任务完成后推送到微信' : '未开启'}</div>
          </div>
          <div class="row mt-16" style="justify-content:flex-end">
            <button class="btn small ghost" data-act="preview">预览资源</button>
            <button class="btn small ghost" data-act="reset-pool">重置选择进度</button>
            <button class="btn small" data-act="edit">编辑</button>
            <button class="btn small danger" data-act="delete">删除</button>
            <button class="btn small primary" data-act="run">创建任务</button>
          </div>
        </div>`;
    }

    function pageOptionSummary(cfg) {
      const options = cfg.pageOptions || {};
      const parts = [];
      if (options.description?.enabled) parts.push('视频描述');
      if (options.description?.prefix) parts.push('描述前缀');
      if (options.description?.suffix) parts.push('描述后缀');
      if (options.description?.hashtags?.length) parts.push(`话题×${options.description.hashtags.length}`);
      if (options.shortTitle?.enabled) parts.push('短标题');
      if (options.location?.enabled) parts.push('位置');
      if (options.collection?.enabled) parts.push('合集');
      if (options.original?.enabled) parts.push('原创声明');
      if (options.videoMark?.enabled) parts.push(`视频标注：${options.videoMark.value || '无需标注'}`);
      if (options.scheduled?.enabled) parts.push('定时发表');
      if (options.extLink?.enabled) parts.push('扩展链接');
      return parts.length ? parts.join(' · ') : '仅上传视频 + 描述';
    }

    function bind() {
      ctx.root.querySelectorAll('[data-act="new"]').forEach((button) => button.addEventListener('click', () => openEditor(null)));
      ctx.root.querySelectorAll('[data-config] [data-act]').forEach((button) => {
        button.addEventListener('click', () => {
          const config = state.configs.find((item) => item.id === button.closest('[data-config]').dataset.config);
          if (!config) return;
          const action = button.dataset.act;
          if (action === 'edit') return openEditor(config);
          if (action === 'delete') return removeConfig(config);
          if (action === 'run') return openTaskModal(config);
          if (action === 'preview') return openPreviewModal(config);
          if (action === 'reset-pool') return resetPool(config);
        });
      });
    }

    async function removeConfig(config) {
      const ok = await confirmDialog({
        title: '删除发布配置',
        message: `确定删除「${config.name}」吗？执行记录仍会保留。`,
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.deleteConfig(config.id);
        toast('已删除', 'success');
        await load();
      } catch (error) {
        toast(error.message, 'error');
      }
    }

    async function resetPool(config) {
      const ok = await confirmDialog({
        title: '重置选择进度',
        message: '将清空该配置下视频/文本的「顺序游标」与「随机不可重复」使用记录，下次任务会从头开始选择。',
        okText: '重置',
      });
      if (!ok) return;
      try {
        await api.resetConfigPool(config.id);
        toast('已重置选择进度', 'success');
      } catch (error) {
        toast(error.message, 'error');
      }
    }

    async function openPreviewModal(config) {
      try {
        const result = await api.previewConfig(config.id);
        const dialog = modal({
          title: `资源分配预览：${config.name}`,
          wide: true,
          body: `
            <div class="small muted-2" style="margin-bottom:10px">预览不会消耗选择进度；实际创建任务时会按照策略重新分配。</div>
            ${result.items.length ? `<div class="table-wrap"><table class="table">
              <thead><tr><th>主体</th><th>状态</th><th>视频</th><th>文本</th></tr></thead>
              <tbody>${result.items.map((item) => `
                <tr>
                  <td>${esc(item.subjectName)}</td>
                  <td>${item.error ? badge('资源不足', 'red') : badge('可执行', 'green')}</td>
                  <td class="small">${item.video ? `${esc(item.video.name)}<div class="muted-2">${item.video.uploadCount ? `已用 ${item.video.uploadCount} 次` : '未使用'}</div>` : `<span class="muted-2">${esc(item.error || '-')}</span>`}</td>
                  <td class="small" style="max-width:320px">${item.text ? `<div class="truncate" title="${esc(item.text.content)}">${esc(item.text.content.slice(0, 90))}</div>` : '<span class="muted-2">-</span>'}</td>
                </tr>`).join('')}
              </tbody></table></div>` : emptyState('👥', '该配置没有关联任何主体', '请先编辑配置选择主体或按标签筛选')}`,
          footer: '<button class="btn" data-close>关闭</button>',
        });
        return dialog;
      } catch (error) {
        toast(error.message, 'error', 5000);
      }
    }

    async function openTaskModal(config) {
      let subjectCount = 0;
      try {
        const resolved = await api.configSubjects(config.id);
        subjectCount = resolved.length;
      } catch { /* ignore */ }
      const dialog = modal({
        title: `创建执行任务：${config.name}`,
        body: `
          <div class="col">
            ${subjectCount === 0 ? '<div class="badge red">该配置没有关联主体，无法创建任务</div>' : `<div class="small muted">将依次对 <b>${subjectCount}</b> 个主体执行，单个任务内串行处理，避免同一浏览器并发冲突。</div>`}
            <div class="field"><span>执行动作</span>
              <div class="col" style="gap:8px">
                <label class="check"><input type="radio" name="action" value="config" checked> 按配置动作（${config.config.action === 'publish' ? '直接发表' : '保存草稿'}）</label>
                <label class="check"><input type="radio" name="action" value="draft"> 保存草稿</label>
                <label class="check"><input type="radio" name="action" value="publish"> 直接发表</label>
              </div>
            </div>
            <label class="check"><input type="checkbox" data-dry> 演练模式：完整填写页面但不点击保存/发表（推荐首次使用）</label>
            <div class="help-text" style="margin-top:-4px">演练模式不会消耗素材、不会改变视频/文本的「已上传/已使用」状态，也不计入使用次数统计。</div>
            <div class="form-grid">
              <label class="field"><span>限制主体数量（0 = 全部）</span><input type="number" min="0" data-limit value="0"></label>
              <label class="field"><span>任务名称（可选）</span><input type="text" data-name placeholder="默认使用配置名 + 时间"></label>
            </div>
            <label class="check"><input type="checkbox" data-start checked> 创建后立即开始执行</label>
            <div class="help-text">执行过程中可在「执行记录」查看每一步日志与截图；微信结果同步取决于发布配置与「执行记录 → 微信机器人」设置。</div>
          </div>`,
        footer: '<button class="btn" data-close>取消</button><button class="btn primary" data-create>创建任务</button>',
      });
      dialog.foot.querySelector('[data-create]').addEventListener('click', async () => {
        const actionValue = dialog.body.querySelector('input[name="action"]:checked').value;
        const overrides = {
          dryRun: dialog.body.querySelector('[data-dry]').checked,
          subjectLimit: Number(dialog.body.querySelector('[data-limit]').value || 0),
          name: dialog.body.querySelector('[data-name]').value.trim() || undefined,
        };
        if (actionValue !== 'config') overrides.action = actionValue;
        try {
          const task = await api.createTask({ configId: config.id, overrides });
          if (dialog.body.querySelector('[data-start]').checked) {
            await api.startTask(task.id);
          }
          dialog.close();
          location.hash = '/tasks';
          toast(`任务已创建（${task.total} 个主体${task.skipped ? `，跳过 ${task.skipped}` : ''}）`, 'success', 4000);
        } catch (error) {
          toast(error.message, 'error', 6000);
        }
      });
    }

    async function openEditor(config) {
      const [tags, subjects, videos, texts] = await Promise.all([
        store.loadTags(true),
        api.subjects(),
        api.videos({ pageSize: 300 }),
        api.texts({ pageSize: 300 }),
      ]);
      const cfg = config ? structuredClone(config.config) : {
        name: '新的发布配置',
        action: 'draft',
        subjectSelection: { mode: 'ids', ids: [], tags: [] },
        videoSelection: { tags: [], strategy: 'sequential', fixedVideoId: null, preferUnuploaded: true, requireUploaded: '' },
        textSelection: { tags: [], strategy: 'sequential', fixedTextId: null, preferUnuploaded: true, requireUploaded: '' },
        pageOptions: {
          description: { enabled: true, prefix: '', suffix: '', hashtags: [] },
          shortTitle: { enabled: false, fromVideoName: true, value: '' },
          location: { enabled: false, value: '' },
          collection: { enabled: false, value: '' },
          original: { enabled: false },
          videoMark: { enabled: false, value: '无需标注' },
          scheduled: { enabled: false, value: null },
          extLink: { enabled: false, value: '' },
        },
        pool: { allowReset: true, scope: 'config' },
        syncWechat: false,
      };

      const dialog = modal({
        title: config ? `编辑发布配置：${config.name}` : '新建发布配置',
        xwide: true,
        body: `
          <div class="col" style="gap:18px">
            <section>
              <div class="card-title">基本信息</div>
              <div class="form-grid">
                <label class="field span-2"><span>配置名称</span><input type="text" data-name value="${esc(cfg.name)}" maxlength="60"></label>
                <label class="field"><span>执行动作</span><select data-action>
                  <option value="draft" ${cfg.action === 'draft' ? 'selected' : ''}>保存草稿</option>
                  <option value="publish" ${cfg.action === 'publish' ? 'selected' : ''}>直接发表</option>
                </select></label>
                <label class="check" style="align-self:end"><input type="checkbox" data-sync ${cfg.syncWechat ? 'checked' : ''}> 执行结果同步到微信机器人</label>
              </div>
            </section>

            <section>
              <div class="card-title">主体选择 <span class="hint">每个主体使用独立浏览器登录态</span></div>
              <div class="row" style="margin-bottom:10px">
                <label class="check"><input type="radio" name="subject-mode" value="ids" ${cfg.subjectSelection.mode !== 'tags' ? 'checked' : ''}> 指定主体</label>
                <label class="check"><input type="radio" name="subject-mode" value="tags" ${cfg.subjectSelection.mode === 'tags' ? 'checked' : ''}> 按标签筛选</label>
              </div>
              <div data-subject-ids style="display:${cfg.subjectSelection.mode === 'tags' ? 'none' : 'block'}">
                ${subjects.length ? `<div class="chip-select" style="max-height:180px">${subjects.map((subject) => `
                  <label class="check" style="min-width:180px"><input type="checkbox" data-subject-check value="${esc(subject.id)}" ${cfg.subjectSelection.ids.includes(subject.id) ? 'checked' : ''}>
                    <span>${esc(subject.displayName || subject.name)}</span>${subject.status === 'expired' ? badge('过期', 'red') : ''}
                  </label>`).join('')}</div>` : '<div class="small muted-2">还没有主体，请先在「主体管理」扫码登录</div>'}
              </div>
              <div data-subject-tags style="display:${cfg.subjectSelection.mode === 'tags' ? 'block' : 'none'}">
                <div class="chip-select" data-subject-tag-chips></div>
                <div class="help-text">选取标签下所有主体（今后新增的主体也会自动包含）。</div>
              </div>
            </section>

            <section>
              <div class="card-title">视频选择</div>
              <div class="form-grid">
                <div class="field span-2"><span>视频标签（不选 = 全部视频）</span><div class="chip-select" data-video-tag-chips></div></div>
                <label class="field"><span>选择策略</span><select data-video-strategy>${optionList(STRATEGIES, cfg.videoSelection.strategy)}</select></label>
                <label class="field"><span>使用状态过滤</span><select data-video-uploaded>${optionList(UPLOAD_FILTER, cfg.videoSelection.requireUploaded ?? '')}</select></label>
                <label class="field span-2" data-video-fixed-wrap style="display:${cfg.videoSelection.strategy === 'fixed' ? 'block' : 'none'}">
                  <span>固定视频</span>
                  <select data-video-fixed>
                    <option value="">请选择视频</option>
                    ${videos.data.map((video) => `<option value="${video.id}" ${Number(cfg.videoSelection.fixedVideoId) === Number(video.id) ? 'selected' : ''}>${esc(video.name)}（${video.uploadCount ? `已用${video.uploadCount}次` : '未使用'}）</option>`).join('')}
                  </select>
                </label>
                <label class="check span-2"><input type="checkbox" data-video-prefer ${cfg.videoSelection.preferUnuploaded ? 'checked' : ''}> 优先选择未使用过的视频</label>
              </div>
            </section>

            <section>
              <div class="card-title">文本选择 <span class="hint">文本内容会填入「视频描述」</span></div>
              <div class="form-grid">
                <div class="field span-2"><span>文本标签（不选 = 全部文本）</span><div class="chip-select" data-text-tag-chips></div></div>
                <label class="field"><span>选择策略</span><select data-text-strategy>${optionList(STRATEGIES, cfg.textSelection.strategy)}</select></label>
                <label class="field"><span>使用状态过滤</span><select data-text-uploaded>${optionList(UPLOAD_FILTER, cfg.textSelection.requireUploaded ?? '')}</select></label>
                <label class="field span-2" data-text-fixed-wrap style="display:${cfg.textSelection.strategy === 'fixed' ? 'block' : 'none'}">
                  <span>固定文本</span>
                  <select data-text-fixed>
                    <option value="">请选择文本</option>
                    ${texts.data.map((text) => `<option value="${text.id}" ${Number(cfg.textSelection.fixedTextId) === Number(text.id) ? 'selected' : ''}>#${text.id} ${esc(text.content.slice(0, 50))}</option>`).join('')}
                  </select>
                </label>
                <label class="check span-2"><input type="checkbox" data-text-prefer ${cfg.textSelection.preferUnuploaded ? 'checked' : ''}> 优先选择未使用过的文本</label>
              </div>
            </section>

            <section>
              <div class="card-title">发表动态页面选项</div>
              <div class="card" style="background:var(--bg-soft)">
                <div class="col" style="gap:14px">
                  <div>
                    <label class="check"><input type="checkbox" data-desc-enabled ${cfg.pageOptions.description.enabled ? 'checked' : ''}> 填写视频描述内容</label>
                    <div class="form-grid mt-8">
                      <label class="field"><span>描述前缀</span><input type="text" data-desc-prefix value="${esc(cfg.pageOptions.description.prefix)}" placeholder="例如：【每日分享】"></label>
                      <label class="field"><span>描述后缀</span><input type="text" data-desc-suffix value="${esc(cfg.pageOptions.description.suffix)}" placeholder="例如：欢迎点赞关注"></label>
                      <label class="field span-2"><span>附加话题（逗号分隔，自动补 #）</span><input type="text" data-desc-hashtags value="${esc((cfg.pageOptions.description.hashtags || []).join('，'))}" placeholder="例如：生活记录,原创视频"></label>
                    </div>
                  </div>
                  <div class="divider" style="margin:0"></div>
                  <div>
                    <label class="check"><input type="checkbox" data-short-enabled ${cfg.pageOptions.shortTitle.enabled ? 'checked' : ''}> 填写短标题</label>
                    <div class="row mt-8" data-short-wrap>
                      <label class="check"><input type="checkbox" data-short-from-video ${cfg.pageOptions.shortTitle.fromVideoName ? 'checked' : ''}> 使用视频文件名</label>
                      <input type="text" data-short-value value="${esc(cfg.pageOptions.shortTitle.value)}" placeholder="或自定义短标题（16 字以内）" style="max-width:320px">
                    </div>
                  </div>
                  <div class="divider" style="margin:0"></div>
                  <div class="form-grid">
                    <div>
                      <label class="check"><input type="checkbox" data-loc-enabled ${cfg.pageOptions.location.enabled ? 'checked' : ''}> 设置位置</label>
                      <input type="text" data-loc-value class="mt-8" value="${esc(cfg.pageOptions.location.value)}" placeholder="位置名称，例如：深圳市">
                    </div>
                    <div>
                      <label class="check"><input type="checkbox" data-coll-enabled ${cfg.pageOptions.collection.enabled ? 'checked' : ''}> 添加到合集</label>
                      <input type="text" data-coll-value class="mt-8" value="${esc(cfg.pageOptions.collection.value)}" placeholder="合集名称（需已存在）">
                    </div>
                    <div>
                      <label class="check"><input type="checkbox" data-original-enabled ${cfg.pageOptions.original.enabled ? 'checked' : ''}> 声明原创（旧版选项）</label>
                      <div class="help-text">新版发表页已改为「视频标注」，若页面不存在该开关会给出提示</div>
                    </div>
                    <div>
                      <label class="check"><input type="checkbox" data-mark-enabled ${cfg.pageOptions.videoMark?.enabled ? 'checked' : ''}> 设置视频标注</label>
                      <select data-mark-value class="mt-8">
                        ${['无需标注', '含AI生成内容', '内容为虚构剧情，仅供娱乐', '个人观点，仅供参考', '内容包含营销广告', '内容为自行拍摄', '内容为转载'].map((item) => `<option value="${item}" ${(cfg.pageOptions.videoMark?.value || '无需标注') === item ? 'selected' : ''}>${item}</option>`).join('')}
                      </select>
                    </div>
                    <div>
                      <label class="check"><input type="checkbox" data-schedule-enabled ${cfg.pageOptions.scheduled.enabled ? 'checked' : ''}> 定时发表</label>
                      <input type="datetime-local" data-schedule-value class="mt-8" value="${esc(toLocalInput(cfg.pageOptions.scheduled.value))}">
                    </div>
                    <div class="span-2">
                      <label class="check"><input type="checkbox" data-extlink-enabled ${cfg.pageOptions.extLink.enabled ? 'checked' : ''}> 添加扩展链接</label>
                      <input type="text" data-extlink-value class="mt-8" value="${esc(cfg.pageOptions.extLink.value)}" placeholder="https://">
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section>
              <div class="card-title">选择进度</div>
              <div class="form-grid">
                <label class="field"><span>策略生效范围</span><select data-pool-scope>
                  <option value="config" ${cfg.pool.scope !== 'subject' ? 'selected' : ''}>整个配置共用一组进度</option>
                  <option value="subject" ${cfg.pool.scope === 'subject' ? 'selected' : ''}>每个主体独立进度</option>
                </select></label>
                <label class="check" style="align-self:end"><input type="checkbox" data-pool-reset ${cfg.pool.allowReset !== false ? 'checked' : ''}> 随机不重复用尽后自动重置</label>
              </div>
            </section>
          </div>`,
        footer: '<button class="btn" data-close>取消</button><button class="btn" data-preview-save>保存并预览资源</button><button class="btn primary" data-save>保存</button>',
      });

      const body = dialog.body;
      const subjectChip = chipSelector(body.querySelector('[data-subject-tag-chips]'), tags, cfg.subjectSelection.tags);
      const videoChip = chipSelector(body.querySelector('[data-video-tag-chips]'), tags, cfg.videoSelection.tags);
      const textChip = chipSelector(body.querySelector('[data-text-tag-chips]'), tags, cfg.textSelection.tags);

      body.querySelectorAll('input[name="subject-mode"]').forEach((radio) => {
        radio.addEventListener('change', () => {
          const mode = body.querySelector('input[name="subject-mode"]:checked').value;
          body.querySelector('[data-subject-ids]').style.display = mode === 'tags' ? 'none' : 'block';
          body.querySelector('[data-subject-tags]').style.display = mode === 'tags' ? 'block' : 'none';
        });
      });
      body.querySelector('[data-video-strategy]').addEventListener('change', (event) => {
        body.querySelector('[data-video-fixed-wrap]').style.display = event.target.value === 'fixed' ? 'block' : 'none';
      });
      body.querySelector('[data-text-strategy]').addEventListener('change', (event) => {
        body.querySelector('[data-text-fixed-wrap]').style.display = event.target.value === 'fixed' ? 'block' : 'none';
      });

      function collect() {
        const subjectMode = body.querySelector('input[name="subject-mode"]:checked').value;
        const ids = [...body.querySelectorAll('[data-subject-check]:checked')].map((el) => el.value);
        const hashtags = body.querySelector('[data-desc-hashtags]').value.split(/[,，\s]+/).map((v) => v.trim()).filter(Boolean);
        const scheduledValue = body.querySelector('[data-schedule-value]').value;
        return {
          name: body.querySelector('[data-name]').value.trim() || '未命名发布配置',
          action: body.querySelector('[data-action]').value,
          syncWechat: body.querySelector('[data-sync]').checked,
          subjectSelection: { mode: subjectMode, ids, tags: subjectChip.getSelected() },
          videoSelection: {
            tags: videoChip.getSelected(),
            strategy: body.querySelector('[data-video-strategy]').value,
            fixedVideoId: toNumberOrNull(body.querySelector('[data-video-fixed]').value),
            preferUnuploaded: body.querySelector('[data-video-prefer]').checked,
            requireUploaded: body.querySelector('[data-video-uploaded]').value || null,
          },
          textSelection: {
            tags: textChip.getSelected(),
            strategy: body.querySelector('[data-text-strategy]').value,
            fixedTextId: toNumberOrNull(body.querySelector('[data-text-fixed]').value),
            preferUnuploaded: body.querySelector('[data-text-prefer]').checked,
            requireUploaded: body.querySelector('[data-text-uploaded]').value || null,
          },
          pageOptions: {
            description: {
              enabled: body.querySelector('[data-desc-enabled]').checked,
              prefix: body.querySelector('[data-desc-prefix]').value,
              suffix: body.querySelector('[data-desc-suffix]').value,
              hashtags,
            },
            shortTitle: {
              enabled: body.querySelector('[data-short-enabled]').checked,
              fromVideoName: body.querySelector('[data-short-from-video]').checked,
              value: body.querySelector('[data-short-value]').value,
            },
            location: { enabled: body.querySelector('[data-loc-enabled]').checked, value: body.querySelector('[data-loc-value]').value },
            collection: { enabled: body.querySelector('[data-coll-enabled]').checked, value: body.querySelector('[data-coll-value]').value },
            original: { enabled: body.querySelector('[data-original-enabled]').checked },
            videoMark: {
              enabled: body.querySelector('[data-mark-enabled]').checked,
              value: body.querySelector('[data-mark-value]').value || '无需标注',
            },
            scheduled: { enabled: body.querySelector('[data-schedule-enabled]').checked, value: scheduledValue ? new Date(scheduledValue).toISOString() : null },
            extLink: { enabled: body.querySelector('[data-extlink-enabled]').checked, value: body.querySelector('[data-extlink-value]').value },
          },
          pool: {
            scope: body.querySelector('[data-pool-scope]').value,
            allowReset: body.querySelector('[data-pool-reset]').checked,
          },
        };
      }

      async function save(startPreview) {
        const payload = collect();
        if (payload.subjectSelection.mode === 'ids' && !payload.subjectSelection.ids.length) {
          toast('请至少选择一个主体', 'warn');
          return null;
        }
        if (payload.subjectSelection.mode === 'tags' && !payload.subjectSelection.tags.length) {
          toast('请至少选择一个主体标签', 'warn');
          return null;
        }
        try {
          const saved = config
            ? await api.updateConfig(config.id, { name: payload.name, config: payload })
            : await api.createConfig({ name: payload.name, config: payload });
          toast('已保存', 'success');
          dialog.close();
          await load();
          if (startPreview) {
            const fresh = state.configs.find((item) => item.id === saved.id) || saved;
            openPreviewModal(fresh);
          }
          return saved;
        } catch (error) {
          toast(error.message, 'error', 5000);
          return null;
        }
      }

      dialog.foot.querySelector('[data-save]').addEventListener('click', () => save(false));
      dialog.foot.querySelector('[data-preview-save]').addEventListener('click', () => save(true));
    }

    await load();
    return undefined;
  },
};

function toNumberOrNull(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function toLocalInput(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
