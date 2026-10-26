import { api } from '../api.js';
import { store } from '../store.js';
import {
  badge, chipSelector, confirmDialog, emptyState, esc, fmtDate, modal, toast,
} from '../ui.js';

const STRATEGIES = [
  { value: 'random', label: '随机（可重复）' },
  { value: 'random-unique', label: '随机（不重复）' },
  { value: 'fixed', label: '固定指定' },
];

const UPLOAD_FILTER = [
  { value: 'no', label: '仅未使用过' },
  { value: 'yes', label: '仅已使用过' },
  { value: '', label: '不限' },
];

const VIDEO_MARKS = ['无需标注', '含AI生成内容', '内容为虚构剧情，仅供娱乐', '个人观点，仅供参考', '内容包含营销广告', '内容为自行拍摄', '内容为转载'];

function optionList(items, selected) {
  return items.map((item) => `<option value="${esc(item.value)}" ${String(selected) === String(item.value) ? 'selected' : ''}>${esc(item.label)}</option>`).join('');
}

function strategyLabel(value) {
  return STRATEGIES.find((item) => item.value === value)?.label || '随机（不重复）';
}

function uploadLabel(value) {
  return UPLOAD_FILTER.find((item) => item.value === (value || ''))?.label || '仅未使用过';
}

function tagNames(tags, ids) {
  const names = (ids || []).map((id) => tags.find((tag) => Number(tag.id) === Number(id))?.name).filter(Boolean);
  return names.length ? names.join('、') : '全部';
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
        const names = (config.resourceTags || []).map((id) => state.tags.find((tag) => Number(tag.id) === Number(id))?.name).filter(Boolean);
        return names.length ? `按标签自动匹配：${names.join('、')}` : '未选择资源标签';
      }
      const names = (selection.ids || []).map((id) => state.subjects.find((subject) => subject.id === id)?.displayName || state.subjects.find((subject) => subject.id === id)?.name).filter(Boolean);
      return names.length ? `指定 ${names.length} 个主体：${names.slice(0, 3).join('、')}${names.length > 3 ? '…' : ''}` : '未选择主体';
    }

    function render() {
      ctx.root.innerHTML = `
        ${state.configs.length ? `<div class="grid cols-2">${state.configs.map(configCard).join('')}</div>` : emptyState('⚙️', '还没有发布配置', '发布配置封装了主体、视频池、文本池与发表动态页面的选项', '<button class="btn primary" data-act="new">新建发布配置</button>')}
        <div class="card mt-16">
          <div class="card-title">说明</div>
          <div class="small muted" style="line-height:1.9">
            发布配置会把「主体 + 视频 + 文本 + 页面选项」封装成一次可重复执行的任务。<br>
            资源默认围绕<b>标签组筛选</b>：同一组资源标签会同时作用于主体、视频和文本；点击资源卡片上的「固定指定」时，也只能从标签 + 使用状态筛选结果中选择。<br>
            已取消「顺序」策略，可选「随机（可重复）」「随机（不重复）」「固定指定」；随机不重复用尽后是否自动重置由「选择进度」控制（默认关闭）。<br>
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
            <div class="k">资源标签</div><div>${esc(tagNames(state.tags, cfg.resourceTags))}</div>
            <div class="k">视频池</div><div>${esc(videoSummary(cfg))}</div>
            <div class="k">文本池</div><div>${esc(textSummary(cfg))}</div>
            <div class="k">页面选项</div><div class="small">${esc(pageOptionSummary(cfg))}</div>
            <div class="k">结果同步</div><div>${cfg.syncWechat ? '任务完成后推送到微信' : '未开启'}</div>
          </div>
          <div class="row mt-16" style="justify-content:flex-end;flex-wrap:wrap">
            <button class="btn small ghost" data-act="preview">预览资源</button>
            <button class="btn small ghost" data-act="copy">复制</button>
            <button class="btn small" data-act="edit">编辑</button>
            <button class="btn small danger" data-act="delete">删除</button>
            <button class="btn small primary" data-act="run">创建任务</button>
          </div>
        </div>`;
    }

    function videoSummary(cfg) {
      const selection = cfg.videoSelection || {};
      const fixed = selection.strategy === 'fixed' ? ` · 固定 ${(selection.fixedVideoIds || []).length} 个` : '';
      return `标签：${tagNames(state.tags, cfg.resourceTags)} · ${strategyLabel(selection.strategy)} · 每主体 ${selection.perSubjectCount || 1} 个 · ${uploadLabel(selection.requireUploaded)}${fixed}`;
    }

    function textSummary(cfg) {
      const selection = cfg.textSelection || {};
      const fixed = selection.strategy === 'fixed' ? ` · 固定 ${(selection.fixedTextIds || []).length} 个` : '';
      return `标签：${tagNames(state.tags, cfg.resourceTags)} · ${strategyLabel(selection.strategy)} · ${uploadLabel(selection.requireUploaded)}${fixed}`;
    }

    function pageOptionSummary(cfg) {
      const options = cfg.pageOptions || {};
      const parts = [];
      if (options.preUploadAll?.enabled) parts.push('先传后搭');
      if (options.description?.enabled) {
        parts.push('视频描述');
        if (options.description?.prefix) parts.push('描述前缀');
        if (options.description?.suffix) parts.push('描述后缀');
        if (options.description?.hashtags?.length) parts.push(`话题×${options.description.hashtags.length}`);
      }
      if (options.shortTitle?.enabled) parts.push(`短标题「${String(options.shortTitle.value || '').slice(0, 20)}」`);
      if (options.location?.enabled) parts.push('位置');
      if (options.collection?.enabled) parts.push('合集');
      if (options.extLink?.enabled) parts.push(`链接${options.extLink.value ? `：${String(options.extLink.value).slice(0, 24)}` : ''}`);
      if (options.scheduled?.enabled) {
        const scopeText = options.scheduled.intervalScope === 'task' ? '整个任务连续' : '按主体分别';
        parts.push(`定时发表（间隔 ${options.scheduled.intervalMinutes || 10} 分钟，${scopeText}）`);
      }
      if (options.videoMark?.enabled) parts.push(`视频标注：${options.videoMark.value || '无需标注'}`);
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
          if (action === 'copy') return copyConfig(config);
          if (action === 'run') return openTaskModal(config);
          if (action === 'preview') return openPreviewModal(config);
        });
      });
    }

    async function copyConfig(config) {
      try {
        let name = `${config.name}（副本）`;
        if (state.configs.some((item) => item.name === name)) {
          let index = 2;
          while (state.configs.some((item) => item.name === `${config.name}（副本${index}）`)) index += 1;
          name = `${config.name}（副本${index}）`;
        }
        await api.createConfig({ name, config: structuredClone(config.config) });
        toast('已复制发布配置（包含全部页面选项）', 'success');
        await load();
      } catch (error) {
        toast(`复制失败：${error.message}`, 'error', 6000);
      }
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

    async function openPreviewModal(config) {
      try {
        const result = await api.previewConfig(config.id);
        const dialog = modal({
          title: `资源分配预览：${config.name}`,
          wide: true,
          body: `
            <div class="small muted-2" style="margin-bottom:10px">预览不会消耗选择进度；实际创建任务时会按照策略重新分配。多个主体/每主体多个视频时按顺序展示。</div>
            ${result.items.length ? `<div class="table-wrap"><table class="table">
              <thead><tr><th>主体</th><th>序号</th><th>状态</th><th>视频</th><th>文本</th></tr></thead>
              <tbody>${result.items.map((item) => `
                <tr>
                  <td>${esc(item.subjectName)}</td>
                  <td class="small muted-2">${item.totalRounds > 1 ? `${item.round}/${item.totalRounds}` : '-'}</td>
                  <td>${item.error ? badge('资源不足', 'red') : badge('可执行', 'green')}</td>
                  <td class="small">${item.video ? `${esc(item.video.name)}<div class="muted-2">${item.video.uploadCount ? `已用 ${item.video.uploadCount} 次` : '未使用'}</div>` : `<span class="muted-2">${esc(item.error || '-')}</span>`}</td>
                  <td class="small" style="max-width:320px">${item.text ? `<div class="truncate" title="${esc(item.text.content)}">${esc(item.text.content.slice(0, 90))}</div>` : '<span class="muted-2">-</span>'}</td>
                </tr>`).join('')}
              </tbody></table></div>` : emptyState('👥', '该配置没有关联任何主体', '请先编辑配置选择主体或资源标签')}`,
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
      const defaultCount = Math.max(1, Math.min(5, Number(config.config.videoSelection?.perSubjectCount || 1)));
      const configScheduleEnabled = Boolean(config.config.pageOptions?.scheduled?.enabled);
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
              <label class="field"><span>每个主体发表数量（1-5，默认 1）</span><input type="number" min="1" max="5" data-per-subject value="${defaultCount}"></label>
              <label class="field"><span>限制主体数量（0 = 全部）</span><input type="number" min="0" data-limit value="0"></label>
              <label class="field span-2"><span>任务名称（可选）</span><input type="text" data-name placeholder="默认使用配置名 + 时间"></label>
            </div>
            <div class="help-text" data-total-hint></div>
            <div class="divider" style="margin:4px 0"></div>
            <div class="page-option">
              <div class="small" style="font-weight:600;margin-bottom:8px">开始方式</div>
              <label class="check"><input type="checkbox" data-start checked> 创建后立即开始执行（默认）</label>
              <label class="check" ${configScheduleEnabled ? 'title="发布配置已启用定时发表，任务内不能再设置定时执行"' : ''}><input type="checkbox" data-task-schedule ${configScheduleEnabled ? 'disabled' : ''}> 定时执行</label>
              <div class="mt-8" data-task-schedule-fields style="display:none;margin-left:22px">
                <div class="form-grid">
                  <label class="field"><span>定时执行起点</span><input type="datetime-local" data-task-schedule-value step="60"></label>
                  <label class="field"><span>执行间隔（分钟）</span><input type="number" min="1" max="1440" step="1" data-task-schedule-interval value="10"></label>
                </div>
                <div class="help-text">任务将在定时起点自动开始，各计划按间隔依次执行；起点需晚于当前时间至少 10 分钟（容错）。</div>
              </div>
              ${configScheduleEnabled ? '<div class="help-text">发布配置已启用定时发表，任务内「定时执行」不可用（避免重复定时）。</div>' : ''}
            </div>
            <div class="help-text">执行过程中可在「执行记录」查看每一步日志与截图；微信结果同步取决于发布配置与「执行记录 → 微信机器人」设置。</div>
          </div>`,
        footer: '<button class="btn" data-close>取消</button><button class="btn primary" data-create>创建任务</button>',
      });
      const perSubjectInput = dialog.body.querySelector('[data-per-subject]');
      const limitInput = dialog.body.querySelector('[data-limit]');
      const totalHint = dialog.body.querySelector('[data-total-hint]');
      const startInput = dialog.body.querySelector('[data-start]');
      const scheduleInput = dialog.body.querySelector('[data-task-schedule]');
      const scheduleFields = dialog.body.querySelector('[data-task-schedule-fields]');
      const scheduleValueInput = dialog.body.querySelector('[data-task-schedule-value]');
      const scheduleIntervalInput = dialog.body.querySelector('[data-task-schedule-interval]');
      scheduleValueInput.min = toLocalInput(new Date(Date.now() + 10 * 60_000).toISOString());
      const updateScheduleVisibility = () => {
        const enabled = scheduleInput.checked && !scheduleInput.disabled;
        scheduleFields.style.display = enabled ? 'block' : 'none';
        startInput.disabled = enabled;
        if (enabled) startInput.checked = false;
        else if (!configScheduleEnabled) startInput.checked = true;
      };
      scheduleInput.addEventListener('change', updateScheduleVisibility);
      const updateTotalHint = () => {
        const perSubject = Math.max(1, Math.min(5, Number(perSubjectInput.value) || 1));
        const limit = Number(limitInput.value || 0);
        const actualSubjects = limit > 0 ? Math.min(limit, subjectCount) : subjectCount;
        totalHint.textContent = `预计任务项：${actualSubjects} 个主体 × ${perSubject} 个视频 = ${actualSubjects * perSubject} 项（每主体最多 5 个视频）`;
      };
      perSubjectInput.addEventListener('input', updateTotalHint);
      limitInput.addEventListener('input', updateTotalHint);
      updateTotalHint();
      dialog.foot.querySelector('[data-create]').addEventListener('click', async () => {
        const actionValue = dialog.body.querySelector('input[name="action"]:checked').value;
        const perSubjectCount = Number(perSubjectInput.value);
        if (!Number.isFinite(perSubjectCount) || perSubjectCount < 1 || perSubjectCount > 5) {
          toast('每个主体发表数量需为 1-5 个', 'warn');
          return;
        }
        const scheduleEnabled = scheduleInput.checked && !scheduleInput.disabled;
        let schedule = null;
        if (scheduleEnabled) {
          const raw = scheduleValueInput.value;
          const target = raw ? new Date(raw) : null;
          if (!target || Number.isNaN(target.getTime())) {
            toast('请选择定时执行起点', 'warn');
            return;
          }
          if (target.getTime() < Date.now() + 10 * 60_000 - 30_000) {
            toast('定时执行起点需晚于当前时间至少 10 分钟（容错）', 'warn');
            return;
          }
          const interval = Number(scheduleIntervalInput.value);
          if (!Number.isInteger(interval) || interval < 1) {
            toast('执行间隔需为不少于 1 分钟的整数', 'warn');
            return;
          }
          schedule = { enabled: true, value: target.toISOString(), intervalMinutes: interval };
        }
        const overrides = {
          dryRun: dialog.body.querySelector('[data-dry]').checked,
          subjectLimit: Number(dialog.body.querySelector('[data-limit]').value || 0),
          perSubjectCount,
          name: dialog.body.querySelector('[data-name]').value.trim() || undefined,
          schedule: schedule || { enabled: false },
        };
        if (actionValue !== 'config') overrides.action = actionValue;
        try {
          const task = await api.createTask({ configId: config.id, overrides });
          if (!schedule && startInput.checked) {
            await api.startTask(task.id);
          }
          dialog.close();
          location.hash = '/tasks';
          const suffix = schedule ? `，将于 ${fmtDate(schedule.value, true)} 自动开始` : '';
          toast(`任务已创建（${task.total} 项${task.skipped ? `，跳过 ${task.skipped}` : ''}）${suffix}`, 'success', 5000);
        } catch (error) {
          toast(error.message, 'error', 6000);
        }
      });
    }

    async function openEditor(config) {
      const [tags, subjects, videos, texts] = await Promise.all([
        store.loadTags(true),
        api.subjects(),
        api.videos({ pageSize: 500 }),
        api.texts({ pageSize: 500 }),
      ]);
      const cfg = config ? structuredClone(config.config) : {
        name: '新的发布配置',
        action: 'draft',
        resourceTags: [],
        subjectSelection: { mode: 'tags', ids: [], tags: [] },
        videoSelection: { tags: [], strategy: 'random-unique', fixedVideoIds: [], requireUploaded: 'no', perSubjectCount: 1 },
        textSelection: { tags: [], strategy: 'random-unique', fixedTextIds: [], requireUploaded: 'no' },
        pageOptions: {
          preUploadAll: { enabled: false },
          description: { enabled: true, prefix: '', suffix: '', hashtags: [] },
          shortTitle: { enabled: false, value: '' },
          location: { enabled: false, value: '' },
          collection: { enabled: false, value: '' },
          videoMark: { enabled: false, value: '无需标注' },
          scheduled: { enabled: false, value: null, intervalMinutes: 10, intervalScope: 'subject' },
          extLink: { enabled: false, value: '' },
        },
        pool: { allowReset: false, scope: 'config' },
        syncWechat: false,
      };
      cfg.resourceTags = cfg.resourceTags || [];

      const dialog = modal({
        title: config ? `编辑发布配置：${config.name}` : '新建发布配置',
        xwide: true,
        body: `
          <div class="col" style="gap:18px">
            <section>
              <div class="card-title">基本配置</div>
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
              <div class="card-title">资源选择 <span class="hint">标签组统一筛选主体 / 视频 / 文本</span></div>
              <div class="card" style="background:var(--bg-soft)">
                <div class="col" style="gap:14px">
                  <div>
                    <div class="small" style="font-weight:600;margin-bottom:6px">资源标签（同时筛选主体、视频、文本）</div>
                    <div class="chip-select" data-resource-tags></div>
                    <div class="help-text">选中标签后，主体自动匹配；固定视频/文本也只能从这些标签关联的资源中选择。不选标签表示全部资源。</div>
                  </div>
                  <div class="divider" style="margin:0"></div>

                  <div>
                    <div class="row between" style="margin-bottom:8px">
                      <div class="small" style="font-weight:600">主体 <span class="hint">每个主体使用独立浏览器登录态</span></div>
                      <div class="row" style="gap:12px">
                        <label class="check"><input type="radio" name="subject-mode" value="tags" ${cfg.subjectSelection.mode !== 'ids' ? 'checked' : ''}> 按标签自动匹配</label>
                        <label class="check"><input type="radio" name="subject-mode" value="ids" ${cfg.subjectSelection.mode === 'ids' ? 'checked' : ''}> 指定主体</label>
                      </div>
                    </div>
                    <div data-subject-auto class="small muted"></div>
                    <div data-subject-ids-wrap style="display:${cfg.subjectSelection.mode === 'ids' ? 'block' : 'none'}">
                      <div class="chip-select" data-subject-ids></div>
                    </div>
                  </div>
                  <div class="divider" style="margin:0"></div>

                  <div>
                    <div class="small" style="font-weight:600;margin-bottom:8px">视频</div>
                    <div class="form-grid">
                      <label class="field"><span>选择策略</span><select data-video-strategy>${optionList(STRATEGIES, cfg.videoSelection.strategy)}</select></label>
                      <label class="field"><span>使用状态过滤</span><select data-video-uploaded>${optionList(UPLOAD_FILTER, cfg.videoSelection.requireUploaded)}</select></label>
                      <label class="field"><span>每个主体发表数量（1-5）</span><input type="number" min="1" max="5" data-video-count value="${esc(cfg.videoSelection.perSubjectCount || 1)}"></label>
                    </div>
                    <div data-video-fixed-wrap style="display:${cfg.videoSelection.strategy === 'fixed' ? 'block' : 'none'}">
                      <div class="help-text">固定视频（多选，候选范围 = 资源标签 + 使用状态过滤；任务按顺序循环分配，每主体最多 5 个）</div>
                      <div class="chip-select" data-video-fixed-list></div>
                    </div>
                  </div>
                  <div class="divider" style="margin:0"></div>

                  <div>
                    <div class="small" style="font-weight:600;margin-bottom:8px">文本</div>
                    <div class="form-grid">
                      <label class="field"><span>选择策略</span><select data-text-strategy>${optionList(STRATEGIES, cfg.textSelection.strategy)}</select></label>
                      <label class="field"><span>使用状态过滤</span><select data-text-uploaded>${optionList(UPLOAD_FILTER, cfg.textSelection.requireUploaded)}</select></label>
                    </div>
                    <div data-text-fixed-wrap style="display:${cfg.textSelection.strategy === 'fixed' ? 'block' : 'none'}">
                      <div class="help-text">固定文本（多选，候选范围 = 资源标签 + 使用状态过滤；任务按顺序循环分配）</div>
                      <div class="chip-select" data-text-fixed-list></div>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section>
              <div class="card-title">发表动态页面选项 <span class="hint">选项自上而下排列</span></div>
              <div class="card" style="background:var(--bg-soft)">
                <div class="col" style="gap:14px">
                  <div class="page-option" style="border:1px solid var(--border-soft);border-radius:10px;padding:10px 12px;background:var(--panel)">
                    <label class="check"><input type="checkbox" data-preupload-enabled ${cfg.pageOptions.preUploadAll?.enabled ? 'checked' : ''}> 先传输完素材，再逐一搭建</label>
                    <div class="help-text">勾选后执行顺序改为：对每个视频先「上传 → 删除」，全部素材都上传循环一遍后，再逐个重新上传（命中秒传缓存）并搭建发布信息。可减少短时间重复上传触发的人脸认证等繁琐操作。</div>
                  </div>
                  <div class="divider" style="margin:0"></div>
                  <div class="page-option">
                    <label class="check"><input type="checkbox" data-desc-enabled ${cfg.pageOptions.description.enabled ? 'checked' : ''}> 填写视频描述内容</label>
                    <div class="form-grid mt-8" data-desc-fields style="display:${cfg.pageOptions.description.enabled ? 'grid' : 'none'}">
                      <label class="field"><span>描述前缀</span><input type="text" data-desc-prefix value="${esc(cfg.pageOptions.description.prefix)}" placeholder="例如：【每日分享】"></label>
                      <label class="field"><span>描述后缀</span><input type="text" data-desc-suffix value="${esc(cfg.pageOptions.description.suffix)}" placeholder="例如：欢迎点赞关注"></label>
                      <label class="field span-2"><span>附加话题（逗号分隔，自动补 #）</span><input type="text" data-desc-hashtags value="${esc((cfg.pageOptions.description.hashtags || []).join('，'))}" placeholder="例如：生活记录,原创视频"></label>
                    </div>
                  </div>
                  <div class="divider" style="margin:0"></div>
                  <div class="page-option">
                    <label class="check"><input type="checkbox" data-short-enabled ${cfg.pageOptions.shortTitle.enabled ? 'checked' : ''}> 填写短标题</label>
                    <div class="mt-8" data-short-fields style="display:${cfg.pageOptions.shortTitle.enabled ? 'block' : 'none'}">
                      <input type="text" data-short-value value="${esc(cfg.pageOptions.shortTitle.value)}" maxlength="16" placeholder="请输入 6-16 个字的短标题（必填）" style="max-width:420px">
                      <div class="help-text">勾选后必填：不少于 6 个字、不超过 16 个字。</div>
                    </div>
                  </div>
                  <div class="divider" style="margin:0"></div>
                  <div class="page-option">
                    <label class="check"><input type="checkbox" data-loc-enabled ${cfg.pageOptions.location.enabled ? 'checked' : ''}> 设置位置</label>
                    <div class="mt-8" data-loc-fields style="display:${cfg.pageOptions.location.enabled ? 'block' : 'none'}">
                      <input type="text" data-loc-value value="${esc(cfg.pageOptions.location.value)}" placeholder="位置名称，例如：深圳市" style="max-width:420px">
                    </div>
                  </div>
                  <div class="divider" style="margin:0"></div>
                  <div class="page-option">
                    <label class="check"><input type="checkbox" data-coll-enabled ${cfg.pageOptions.collection.enabled ? 'checked' : ''}> 添加到合集</label>
                    <div class="mt-8" data-coll-fields style="display:${cfg.pageOptions.collection.enabled ? 'block' : 'none'}">
                      <input type="text" data-coll-value value="${esc(cfg.pageOptions.collection.value)}" placeholder="合集名称（需已存在）" style="max-width:420px">
                    </div>
                  </div>
                  <div class="divider" style="margin:0"></div>
                  <div class="page-option">
                    <label class="check"><input type="checkbox" data-extlink-enabled ${cfg.pageOptions.extLink.enabled ? 'checked' : ''}> 链接</label>
                    <div class="mt-8" data-extlink-fields style="display:${cfg.pageOptions.extLink.enabled ? 'block' : 'none'}">
                      <input type="text" data-extlink-value value="${esc(cfg.pageOptions.extLink.value)}" placeholder="填写商品链接或商品ID，例如：https://... 或 10001727125779" style="max-width:520px">
                      <div class="help-text">执行时会点击「链接 → 商品 → 选择需要添加的商品」，按这里填写的商品ID自动搜索、选中并完成添加；填整条商品链接时也会自动解析出ID。</div>
                    </div>
                  </div>
                  <div class="divider" style="margin:0"></div>
                  <div class="page-option">
                    <div class="small" style="font-weight:600;margin-bottom:8px">定时发表</div>
                    <div class="row" style="gap:14px">
                      <label class="check"><input type="radio" name="schedule-mode" value="off" ${cfg.pageOptions.scheduled.enabled ? '' : 'checked'}> 不定时</label>
                      <label class="check"><input type="radio" name="schedule-mode" value="on" ${cfg.pageOptions.scheduled.enabled ? 'checked' : ''}> 定时</label>
                    </div>
                    <div class="mt-8" data-schedule-fields style="display:${cfg.pageOptions.scheduled.enabled ? 'block' : 'none'}">
                      <div class="form-grid">
                        <label class="field"><span>定时起点</span><input type="datetime-local" data-schedule-value step="60" value="${esc(toLocalInput(cfg.pageOptions.scheduled.value))}"></label>
                        <label class="field"><span>定时间隔（分钟）</span><input type="number" min="1" max="1440" step="1" data-schedule-interval value="${esc(cfg.pageOptions.scheduled.intervalMinutes || 10)}"></label>
                        <label class="field span-2"><span>间隔作用范围</span><select data-schedule-scope>
                          <option value="subject" ${cfg.pageOptions.scheduled.intervalScope !== 'task' ? 'selected' : ''}>按每个主体分别递增（默认）</option>
                          <option value="task" ${cfg.pageOptions.scheduled.intervalScope === 'task' ? 'selected' : ''}>整个任务所有计划连续递增</option>
                        </select></label>
                      </div>
                      <div class="help-text">定时起点需晚于当前时间至少 10 分钟（容错）；第 N 条计划时间 = 起点 + 间隔 ×（N-1），精确到分钟。</div>
                    </div>
                  </div>
                  <div class="divider" style="margin:0"></div>
                  <div class="page-option">
                    <label class="check"><input type="checkbox" data-mark-enabled ${cfg.pageOptions.videoMark?.enabled ? 'checked' : ''}> 设置视频标注</label>
                    <div class="mt-8" data-mark-fields style="display:${cfg.pageOptions.videoMark?.enabled ? 'block' : 'none'}">
                      <select data-mark-value style="max-width:420px">
                        ${VIDEO_MARKS.map((item) => `<option value="${item}" ${(cfg.pageOptions.videoMark?.value || '无需标注') === item ? 'selected' : ''}>${item}</option>`).join('')}
                      </select>
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
                <label class="check" style="align-self:end"><input type="checkbox" data-pool-reset ${cfg.pool.allowReset === true ? 'checked' : ''}> 随机不重复用尽后自动重置</label>
              </div>
              <div class="help-text">默认不勾选：随机（不重复）策略用尽后会提示资源不足；勾选后会自动清空该范围的使用记录并继续分配。</div>
            </section>
          </div>`,
        footer: '<button class="btn" data-close>取消</button><button class="btn" data-preview-save>保存并预览资源</button><button class="btn primary" data-save>保存</button>',
      });

      const body = dialog.body;
      const resourceChip = chipSelector(body.querySelector('[data-resource-tags]'), tags, cfg.resourceTags, () => refreshResources());
      const subjectChipContainer = body.querySelector('[data-subject-ids]');
      const selectedSubjects = new Set(cfg.subjectSelection.ids || []);
      const selectedFixedVideos = new Set(cfg.videoSelection.fixedVideoIds || []);
      const selectedFixedTexts = new Set(cfg.textSelection.fixedTextIds || []);
      const resourceTags = () => resourceChip.getSelected();
      const tagMatch = (row) => {
        const ids = resourceTags();
        if (!ids.length) return true;
        return (row.tags || []).some((tag) => ids.includes(Number(tag.id)));
      };
      const uploadMatch = (row, filter) => {
        const count = Number(row.uploadCount || 0);
        if (filter === 'no') return count === 0;
        if (filter === 'yes') return count > 0;
        return true;
      };
      const subjectCandidates = () => subjects.filter(tagMatch);
      const videoCandidates = () => videos.data.filter((video) => tagMatch(video) && uploadMatch(video, body.querySelector('[data-video-uploaded]').value));
      const textCandidates = () => texts.data.filter((text) => tagMatch(text) && uploadMatch(text, body.querySelector('[data-text-uploaded]').value));

      function renderSubjects() {
        const mode = body.querySelector('input[name="subject-mode"]:checked')?.value || 'tags';
        // 按标签自动匹配时用标签过滤；「指定主体」允许直接勾选任意主体（固定视频/文本仍受标签约束）
        const candidates = mode === 'ids' ? subjects : subjectCandidates();
        const candidateIds = new Set(candidates.map((subject) => subject.id));
        for (const id of [...selectedSubjects]) if (!candidateIds.has(id)) selectedSubjects.delete(id);
        const autoBox = body.querySelector('[data-subject-auto]');
        if (mode === 'ids') {
          autoBox.textContent = '从下方直接勾选需要执行的主体（不受资源标签限制）';
        } else {
          autoBox.innerHTML = candidates.length
            ? `已匹配 ${candidates.length} 个主体：${candidates.map((subject) => esc(subject.displayName || subject.name)).join('、')}`
            : '<span style="color:var(--yellow)">当前标签没有匹配到主体，请调整资源标签或改用「指定主体」</span>';
        }
        subjectChipContainer.innerHTML = candidates.length
          ? candidates.map((subject) => `
            <label class="check" style="min-width:200px"><input type="checkbox" data-subject-check value="${esc(subject.id)}" ${selectedSubjects.has(subject.id) ? 'checked' : ''}>
              <span>${esc(subject.displayName || subject.name)}</span>${subject.status === 'expired' ? badge('过期', 'red') : ''}
            </label>`).join('')
          : '<div class="help-text">没有符合标签的主体</div>';
      }

      function renderFixedList(kind, container, selectedSet, items, renderLabel) {
        const candidateIds = new Set(items.map((item) => String(item.id)));
        for (const id of [...selectedSet]) if (!candidateIds.has(String(id))) selectedSet.delete(String(id));
        container.innerHTML = items.length
          ? items.map((item) => `
            <label class="check" style="min-width:220px">
              <input type="checkbox" data-fixed-${kind} value="${esc(item.id)}" ${selectedSet.has(String(item.id)) ? 'checked' : ''}>
              <span>${renderLabel(item)}</span>
            </label>`).join('')
          : '<div class="help-text">当前标签/使用状态过滤下没有可选资源</div>';
      }

      function refreshResources() {
        renderSubjects();
        const videoContainer = body.querySelector('[data-video-fixed-list]');
        renderFixedList('video', videoContainer, selectedFixedVideos, videoCandidates(),
          (video) => `${esc(video.name)}（${video.uploadCount ? `已用${video.uploadCount}次` : '未使用'}）`);
        const textContainer = body.querySelector('[data-text-fixed-list]');
        renderFixedList('text', textContainer, selectedFixedTexts, textCandidates(),
          (text) => `#${text.id} ${esc(String(text.content).slice(0, 40))}（${text.uploadCount ? `已用${text.uploadCount}次` : '未使用'}）`);
      }

      resourceChip.setSelected(cfg.resourceTags || []);
      refreshResources();

      body.querySelectorAll('input[name="subject-mode"]').forEach((radio) => {
        radio.addEventListener('change', () => {
          const mode = body.querySelector('input[name="subject-mode"]:checked').value;
          body.querySelector('[data-subject-ids-wrap]').style.display = mode === 'ids' ? 'block' : 'none';
          renderSubjects();
        });
      });
      body.querySelector('[data-video-strategy]').addEventListener('change', (event) => {
        body.querySelector('[data-video-fixed-wrap]').style.display = event.target.value === 'fixed' ? 'block' : 'none';
      });
      body.querySelector('[data-text-strategy]').addEventListener('change', (event) => {
        body.querySelector('[data-text-fixed-wrap]').style.display = event.target.value === 'fixed' ? 'block' : 'none';
      });
      body.querySelector('[data-video-uploaded]').addEventListener('change', refreshResources);
      body.querySelector('[data-text-uploaded]').addEventListener('change', refreshResources);
      body.addEventListener('change', (event) => {
        if (event.target.matches('[data-subject-check]')) {
          if (event.target.checked) selectedSubjects.add(event.target.value);
          else selectedSubjects.delete(event.target.value);
        }
        if (event.target.matches('[data-fixed-video]')) {
          if (event.target.checked) selectedFixedVideos.add(event.target.value);
          else selectedFixedVideos.delete(event.target.value);
        }
        if (event.target.matches('[data-fixed-text]')) {
          if (event.target.checked) selectedFixedTexts.add(event.target.value);
          else selectedFixedTexts.delete(event.target.value);
        }
        if (event.target.matches('[data-desc-enabled]')) body.querySelector('[data-desc-fields]').style.display = event.target.checked ? 'grid' : 'none';
        if (event.target.matches('[data-short-enabled]')) body.querySelector('[data-short-fields]').style.display = event.target.checked ? 'block' : 'none';
        if (event.target.matches('[data-loc-enabled]')) body.querySelector('[data-loc-fields]').style.display = event.target.checked ? 'block' : 'none';
        if (event.target.matches('[data-coll-enabled]')) body.querySelector('[data-coll-fields]').style.display = event.target.checked ? 'block' : 'none';
        if (event.target.matches('[data-extlink-enabled]')) body.querySelector('[data-extlink-fields]').style.display = event.target.checked ? 'block' : 'none';
        if (event.target.matches('[data-mark-enabled]')) body.querySelector('[data-mark-fields]').style.display = event.target.checked ? 'block' : 'none';
        if (event.target.matches('input[name="schedule-mode"]')) {
          body.querySelector('[data-schedule-fields]').style.display = event.target.value === 'on' ? 'block' : 'none';
        }
      });
      const scheduleInput = body.querySelector('[data-schedule-value]');
      const now = new Date();
      scheduleInput.min = toLocalInput(new Date(now.getTime() + 10 * 60_000).toISOString());

      function collect() {
        const subjectMode = body.querySelector('input[name="subject-mode"]:checked').value;
        const subjectIds = subjectMode === 'ids' ? [...selectedSubjects] : [];
        const tagsSelected = resourceChip.getSelected();
        const hashtags = body.querySelector('[data-desc-hashtags]').value.split(/[,，\s]+/).map((value) => value.trim()).filter(Boolean);
        const scheduleMode = body.querySelector('input[name="schedule-mode"]:checked').value;
        const scheduledValue = scheduleInput.value;
        const videoStrategy = body.querySelector('[data-video-strategy]').value;
        const textStrategy = body.querySelector('[data-text-strategy]').value;
        return {
          name: body.querySelector('[data-name]').value.trim() || '未命名发布配置',
          action: body.querySelector('[data-action]').value,
          syncWechat: body.querySelector('[data-sync]').checked,
          resourceTags: tagsSelected,
          subjectSelection: { mode: subjectMode, ids: subjectIds, tags: tagsSelected },
          videoSelection: {
            tags: tagsSelected,
            strategy: videoStrategy,
            fixedVideoIds: videoStrategy === 'fixed' ? [...selectedFixedVideos].map(Number) : [],
            requireUploaded: body.querySelector('[data-video-uploaded]').value,
            perSubjectCount: Math.max(1, Math.min(5, Number(body.querySelector('[data-video-count]').value) || 1)),
          },
          textSelection: {
            tags: tagsSelected,
            strategy: textStrategy,
            fixedTextIds: textStrategy === 'fixed' ? [...selectedFixedTexts].map(Number) : [],
            requireUploaded: body.querySelector('[data-text-uploaded]').value,
          },
          pageOptions: {
            preUploadAll: { enabled: body.querySelector('[data-preupload-enabled]').checked },
            description: {
              enabled: body.querySelector('[data-desc-enabled]').checked,
              prefix: body.querySelector('[data-desc-prefix]').value,
              suffix: body.querySelector('[data-desc-suffix]').value,
              hashtags,
            },
            shortTitle: {
              enabled: body.querySelector('[data-short-enabled]').checked,
              value: body.querySelector('[data-short-value]').value.trim(),
            },
            location: { enabled: body.querySelector('[data-loc-enabled]').checked, value: body.querySelector('[data-loc-value]').value },
            collection: { enabled: body.querySelector('[data-coll-enabled]').checked, value: body.querySelector('[data-coll-value]').value },
            extLink: { enabled: body.querySelector('[data-extlink-enabled]').checked, value: body.querySelector('[data-extlink-value]').value },
            scheduled: {
              enabled: scheduleMode === 'on',
              value: scheduleMode === 'on' && scheduledValue ? new Date(scheduledValue).toISOString() : null,
              intervalMinutes: Math.max(1, Number(body.querySelector('[data-schedule-interval]').value) || 10),
              intervalScope: body.querySelector('[data-schedule-scope]').value,
            },
            videoMark: {
              enabled: body.querySelector('[data-mark-enabled]').checked,
              value: body.querySelector('[data-mark-value]').value || '无需标注',
            },
          },
          pool: {
            scope: body.querySelector('[data-pool-scope]').value,
            allowReset: body.querySelector('[data-pool-reset]').checked,
          },
        };
      }

      function validate(payload) {
        if (payload.subjectSelection.mode === 'ids' && !payload.subjectSelection.ids.length) {
          toast('请至少选择一个主体', 'warn');
          return false;
        }
        if (payload.subjectSelection.mode === 'tags' && !payload.resourceTags.length) {
          toast('请至少选择一个资源标签（用于筛选主体/视频/文本）', 'warn');
          return false;
        }
        if (payload.videoSelection.strategy === 'fixed' && !payload.videoSelection.fixedVideoIds.length) {
          toast('固定指定视频时，请至少选择一个固定视频', 'warn');
          return false;
        }
        if (payload.textSelection.strategy === 'fixed' && !payload.textSelection.fixedTextIds.length) {
          toast('固定指定文本时，请至少选择一个固定文本', 'warn');
          return false;
        }
        if (payload.pageOptions.shortTitle.enabled) {
          const value = payload.pageOptions.shortTitle.value;
          if (!value) {
            toast('勾选「填写短标题」后，短标题不能为空', 'warn');
            return false;
          }
          const length = [...value].length;
          if (length < 6 || length > 16) {
            toast(`短标题需为 6-16 个字（当前 ${length} 个字）`, 'warn');
            return false;
          }
        }
        if (payload.pageOptions.scheduled.enabled) {
          const scheduled = new Date(payload.pageOptions.scheduled.value);
          if (Number.isNaN(scheduled.getTime())) {
            toast('请选择定时发表时间', 'warn');
            return false;
          }
          if (scheduled.getTime() < Date.now() + 10 * 60_000 - 30_000) {
            toast('定时发表起点需晚于当前时间至少 10 分钟（容错）', 'warn');
            return false;
          }
          const interval = Number(payload.pageOptions.scheduled.intervalMinutes);
          if (!Number.isInteger(interval) || interval < 1) {
            toast('定时间隔需为不少于 1 分钟的整数', 'warn');
            return false;
          }
        }
        if (payload.pageOptions.extLink.enabled && !String(payload.pageOptions.extLink.value || '').trim()) {
          toast('勾选「链接」后，请填写商品链接或商品ID', 'warn');
          return false;
        }
        return true;
      }

      async function save(startPreview) {
        const payload = collect();
        if (!validate(payload)) return null;
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

function toLocalInput(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
