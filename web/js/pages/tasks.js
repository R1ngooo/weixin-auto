import { api } from '../api.js';
import {
  badge, emptyState, esc, fmtDate, ITEM_STATUS, modal, statusBadge, TASK_STATUS, toast,
} from '../ui.js';
import { renderWechatPanel } from './wechat-panel.js';

export const tasksPage = {
  async mount(ctx) {
    const state = { list: [], detail: null, timer: null, disposed: false };

    const actionsEl = ctx.setActions('<button class="btn ghost" data-act="refresh">刷新</button>');
    actionsEl.querySelector('[data-act="refresh"]').addEventListener('click', () => refresh());

    async function loadList() {
      state.detail = null;
      const result = await api.tasks({ page: 1, pageSize: 50 });
      state.list = result.data;
      renderList();
    }

    async function loadDetail(taskId) {
      if (state.disposed) return;
      try {
        state.detail = await api.task(taskId);
      } catch (error) {
        toast(error.message, 'error');
        return loadList();
      }
      renderDetail();
      if (state.detail.status === 'pending' || state.detail.status === 'running' || state.detail.running) {
        schedulePoll();
      }
    }

    function schedulePoll() {
      if (state.disposed) return;
      clearTimeout(state.timer);
      state.timer = setTimeout(async () => {
        if (state.disposed || !state.detail) return;
        if (!location.hash.includes('/tasks')) return;
        await loadDetail(state.detail.id);
      }, 2000);
    }

    async function refresh() {
      if (state.detail) await loadDetail(state.detail.id);
      else await loadList();
    }

    function renderList() {
      if (ctx.isActive && !ctx.isActive()) return;
      ctx.setTitle('执行记录', '批次任务进度、日志、截图与结果同步');
      ctx.root.innerHTML = `
        <div id="tasks-wechat-panel" class="mb-16"></div>
        ${state.list.length ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>任务</th><th style="width:110px">状态</th><th style="width:120px">动作</th><th style="width:210px">结果</th><th style="width:150px">创建时间</th><th style="width:150px"></th></tr></thead>
          <tbody>${state.list.map((task) => `
            <tr data-task="${esc(task.id)}">
              <td>
                <div style="font-weight:600">${esc(task.name)}</div>
                ${task.syncStatus ? `<div class="small muted-2">微信同步：${task.syncStatus === 'success' ? '已推送' : '失败'}</div>` : ''}
                ${task.scheduleKind ? `<div class="small muted-2">${task.scheduleKind === 'publish' ? '定时发表' : '定时执行'}：起点 ${esc(fmtDate(task.scheduledAt))} · 间隔 ${Number(task.scheduleIntervalMinutes || 0)} 分钟</div>` : ''}
              </td>
              <td>${statusBadge(task.status, TASK_STATUS)}</td>
              <td class="small">${task.dryRun ? badge('演练', 'blue') : task.action === 'publish' ? badge('发表', 'orange') : badge('草稿', 'gray')}</td>
              <td class="small muted">成功 ${task.succeeded} · 失败 ${task.failed} · 待确认 ${task.unknownCount} · 跳过 ${task.skipped}</td>
              <td class="small muted-2">${esc(fmtDate(task.createdAt))}</td>
              <td><div class="actions">
                <button class="btn small ghost" data-act="view">详情</button>
                ${['pending', 'running'].includes(task.status) ? '<button class="btn small ghost" data-act="start">开始</button><button class="btn small danger" data-act="cancel">取消</button>' : ''}
              </div></td>
            </tr>`).join('')}
          </tbody></table></div>` : emptyState('📋', '还没有执行记录', '前往「发布页面配置」创建任务，或在配置卡片上点击「创建任务」')}
        <div class="small muted-2 mt-16">共 ${state.list.length} 条记录（最近 50 条）</div>`;
      // 微信机器人（执行结果同步）置于执行记录页顶部
      renderWechatPanel(ctx.root.querySelector('#tasks-wechat-panel')).catch(() => undefined);
      ctx.root.querySelectorAll('[data-task] [data-act]').forEach((button) => {
        button.addEventListener('click', () => {
          const id = button.closest('[data-task]').dataset.task;
          const action = button.dataset.act;
          if (action === 'view') return loadDetail(id);
          if (action === 'start') return startTask(id);
          if (action === 'cancel') return cancelTask(id);
        });
      });
    }

    async function startTask(id) {
      try {
        await api.startTask(id);
        toast('任务已开始执行', 'success');
        await loadDetail(id);
      } catch (error) {
        toast(error.message, 'error');
      }
    }

    async function cancelTask(id) {
      try {
        await api.cancelTask(id);
        toast('已请求取消任务', 'warn');
        await refresh();
      } catch (error) {
        toast(error.message, 'error');
      }
    }

    function renderDetail() {
      if (ctx.isActive && !ctx.isActive()) return;
      const task = state.detail;
      if (!task) return;
      clearTimeout(state.timer);
      ctx.setTitle(`任务详情：${task.name}`, `创建于 ${fmtDate(task.createdAt)} · ${task.total} 个任务项`);
      // 只改本页自己的刷新按钮，避免页面切换后误改其它页面的顶栏按钮
      const refreshButton = actionsEl.querySelector('[data-act="refresh"]');
      if (refreshButton) refreshButton.textContent = '刷新';
      const finished = ['success', 'partial', 'failed', 'cancelled'].includes(task.status);
      const done = task.succeeded + task.failed + task.unknownCount + task.canceled;
      const percent = task.total ? Math.min(100, Math.round((done / task.total) * 100)) : 0;
      ctx.root.innerHTML = `
        <div class="row between">
          <button class="btn small ghost" data-act="back">← 返回列表</button>
          <div class="row">
            ${['pending', 'running'].includes(task.status) ? `<button class="btn small" data-act="start">开始执行</button><button class="btn small danger" data-act="cancel">取消任务</button>` : ''}
          </div>
        </div>
        <div class="card mt-16">
          <div class="row between">
            <div class="row">${statusBadge(task.status, TASK_STATUS)}
              ${task.dryRun ? badge('演练模式', 'blue') : task.action === 'publish' ? badge('直接发表', 'orange') : badge('保存草稿', 'gray')}
              ${task.syncStatus ? (task.syncStatus === 'success' ? badge('微信已推送', 'green') : badge('微信推送失败', 'red')) : ''}
            </div>
            <div class="small muted">${finished ? `完成于 ${esc(fmtDate(task.finishedAt))}` : task.running ? '执行中…' : task.scheduleKind === 'run' && task.scheduledAt ? `将于 ${esc(fmtDate(task.scheduledAt, true))} 自动开始` : '等待开始'}</div>
          </div>
          <div class="progress-bar mt-16"><span style="width:${percent}%"></span></div>
          <div class="row between mt-8">
            <div class="small muted">进度 ${done}/${task.total}（${percent}%）</div>
            <div class="small muted">成功 ${task.succeeded} · 失败 ${task.failed} · 待确认 ${task.unknownCount} · 跳过 ${task.skipped}</div>
          </div>
          ${task.syncError ? `<div class="small" style="color:var(--red);margin-top:6px">微信同步错误：${esc(task.syncError)}</div>` : ''}
        </div>
        <div class="card mt-16">
          <div class="card-title">执行明细</div>
          ${task.items.map((item) => itemCard(item, task)).join('')}
        </div>`;
      bindDetail();
      if (!finished) schedulePoll();
    }

    function itemCard(item, task) {
      const screenshotName = item.screenshot ? item.screenshot.split(/[\\/]/).pop() : null;
      return `
        <div class="item-card">
          <div class="item-head">
            <span class="mono muted-2 small">#${item.seq}</span>
            <b>${esc(item.subjectName || item.subjectId)}</b>
            ${statusBadge(item.status, ITEM_STATUS)}
            ${item.step && item.status === 'running' ? `<span class="progress-text">${esc(item.step)} · ${esc(item.progress || '')}</span>` : ''}
            ${item.error ? `<span class="small" style="color:var(--red)">${esc(item.error)}</span>` : ''}
            <div class="spacer" style="flex:1"></div>
            ${screenshotName ? `<a class="screenshot-link" href="/files/screenshots/${encodeURIComponent(screenshotName)}" target="_blank">查看截图</a>` : ''}
          </div>
          <div class="small muted-2">
            视频：${item.videoName ? esc(item.videoName) : '<span class="muted-2">-</span>'}
            · 文本：${item.textPreview ? esc(item.textPreview.slice(0, 60)) : '-'}
            ${item.postId ? ` · 作品ID：${esc(item.postId)}` : ''}
          </div>
          ${item.scheduledAt ? `<div class="small muted-2">${task.scheduleKind === 'publish' ? '定时发表' : '计划开始'}：${esc(fmtDate(item.scheduledAt, true))}</div>` : ''}
          ${item.logs?.length ? `<details><summary>执行日志（${item.logs.length} 条）</summary>
            <div class="log-list mt-8">${item.logs.map((log) => `<div class="log-line ${/warn|失败|错误/.test(log.message) ? 'warn' : /result/.test(log.step) ? 'result' : ''}"><span class="t">${esc(log.t)}</span><span>${esc(log.message)}</span></div>`).join('')}</div>
          </details>` : ''}
        </div>`;
    }

    function bindDetail() {
      ctx.root.querySelector('[data-act="back"]').addEventListener('click', () => loadList());
      ctx.root.querySelector('[data-act="start"]')?.addEventListener('click', () => startTask(state.detail.id));
      ctx.root.querySelector('[data-act="cancel"]')?.addEventListener('click', () => cancelTask(state.detail.id));
    }

    await loadList();
    return () => { state.disposed = true; clearTimeout(state.timer); };
  },
};
