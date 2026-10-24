import { api } from '../api.js';
import { badge, emptyState, esc, fmtDate, statusBadge, SUBJECT_STATUS, TASK_STATUS, timeAgo } from '../ui.js';

function statCard(label, value, extra = '') {
  return `<div class="stat-card"><div class="stat-value">${esc(value)}</div><div class="stat-label">${esc(label)}</div>${extra ? `<div class="stat-extra">${extra}</div>` : ''}</div>`;
}

const STEPS = [
  { title: '登录主体', desc: '手机微信扫码，保存独立登录态' },
  { title: '准备素材', desc: '扫描本地视频、导入描述文本' },
  { title: '配置发布', desc: '选择主体与素材策略、页面选项' },
  { title: '执行并同步', desc: '查看日志截图，结果推送微信' },
];

export const dashboardPage = {
  async mount(ctx) {
    const render = async () => {
      // 页面切换后旧的轮询回调可能仍在队列中，避免覆盖新页面
      if (location.hash && !location.hash.includes('/dashboard')) return;
      const [overview, subjects] = await Promise.all([api.overview(), api.subjects()]);
      const recentTasks = overview.tasks.recent || [];
      const recentSubjects = subjects.slice(0, 6);
      const wechatText = overview.wechat.configured ? '已连接' : overview.wechat.enabled ? '已启用未绑定' : '未启用';
      ctx.root.innerHTML = `
        <div class="card">
          <div class="card-title">开始使用 <span class="hint">四步完成一次视频号自动发布</span></div>
          <div class="steps">
            ${STEPS.map((step, index) => `
              <div class="step">
                <div class="step-index">${index + 1}</div>
                <div>
                  <div class="step-title">${esc(step.title)}</div>
                  <div class="step-desc">${esc(step.desc)}</div>
                </div>
              </div>`).join('')}
          </div>
          <div class="row mt-16">
            <button class="btn primary" data-go="/subjects" data-action="login">扫码登录新主体</button>
            <button class="btn" data-go="/videos" data-action="scan">扫描视频文件夹</button>
            <button class="btn" data-go="/texts">导入文本</button>
            <button class="btn" data-go="/configs" data-action="new">新建发布配置</button>
            <span class="spacer" style="flex:1"></span>
            <button class="btn ghost" data-go="/tasks">查看执行记录</button>
            <button class="btn ghost" data-go="/tags">标签管理</button>
          </div>
        </div>

        <div class="grid cols-4 mt-16">
          ${statCard('主体', overview.subjects.total, `在线 ${overview.subjects.active} · 过期 ${overview.subjects.expired} · 未检查 ${overview.subjects.unknown}`)}
          ${statCard('视频素材', overview.videos.total, `丢失 ${overview.videos.missing} 个文件`)}
          ${statCard('文本素材', overview.texts, `标签 ${overview.tags} 个 · 发布配置 ${overview.configs} 个`)}
          ${statCard('微信结果同步', wechatText, overview.wechat.configured ? '任务完成后可推送结果' : '可在执行记录页配置')}
        </div>

        <div class="dash-pair mt-16">
          <div class="card">
            <div class="card-title">最近执行 <span class="hint">${overview.tasks.running ? '有任务正在执行' : '暂无执行中的任务'}</span></div>
            <div class="dash-panel-body">
              ${recentTasks.length ? `
                <div class="table-wrap">
                  <table class="table">
                    <thead><tr><th>任务</th><th style="width:86px">状态</th><th>结果</th><th style="width:80px">时间</th></tr></thead>
                    <tbody>${recentTasks.map((task) => `
                      <tr data-task="${esc(task.id)}" style="cursor:pointer">
                        <td><div class="truncate" style="max-width:190px">${esc(task.name)}</div></td>
                        <td>${statusBadge(task.status, TASK_STATUS)}</td>
                        <td class="small muted">成功 ${task.succeeded} · 失败 ${task.failed} · 待确认 ${task.unknownCount}</td>
                        <td class="small muted-2">${esc(timeAgo(task.createdAt))}</td>
                      </tr>`).join('')}
                    </tbody>
                  </table>
                </div>` : emptyState('🗂️', '还没有执行记录', '在「发布页面配置」创建任务后会显示在这里')}
            </div>
          </div>
          <div class="card">
            <div class="card-title">主体状态 <span class="hint">点击卡片进入主体管理</span></div>
            <div class="dash-panel-body">
              ${recentSubjects.length ? `<div class="col" style="gap:0">${recentSubjects.map((subject) => `
                <div class="dash-list-row" data-go="/subjects" style="cursor:pointer">
                  <div class="row">
                    ${subject.avatarUrl ? `<img class="avatar" style="width:34px;height:34px" src="${esc(subject.avatarUrl)}" alt="" referrerpolicy="no-referrer">` : '<div class="avatar" style="width:34px;height:34px;font-size:13px">主</div>'}
                    <div>
                      <div>${esc(subject.name)}</div>
                      <div class="small muted-2">${esc(subject.wechatNickname || subject.finderNickname || '未识别账号')} · 检查于 ${esc(subject.lastCheckAt ? timeAgo(subject.lastCheckAt) : '未检查')}</div>
                    </div>
                  </div>
                  ${statusBadge(subject.status, SUBJECT_STATUS)}
                </div>`).join('')}</div>` : emptyState('👤', '还没有主体', '扫码登录一个微信后会自动创建主体卡片', '<button class="btn primary small" data-go="/subjects" data-action="login">扫码登录</button>')}
            </div>
          </div>
        </div>

        <div class="small muted-2 mt-16">最近刷新：${esc(fmtDate(new Date().toISOString(), true))}</div>
      `;

      ctx.root.querySelectorAll('[data-go]').forEach((el) => {
        el.addEventListener('click', () => {
          location.hash = el.dataset.go;
        });
      });
      ctx.root.querySelectorAll('[data-task]').forEach((el) => {
        el.addEventListener('click', () => { location.hash = '/tasks'; });
      });
    };

    await render();
    const timer = setInterval(() => {
      render().catch(() => undefined);
    }, 10_000);
    return () => clearInterval(timer);
  },
};
