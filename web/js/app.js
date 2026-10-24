import { api } from './api.js';
import { icon } from './ui.js';
import { store } from './store.js';
import { dashboardPage } from './pages/dashboard.js';
import { subjectsPage } from './pages/subjects.js';
import { videosPage } from './pages/videos.js';
import { textsPage } from './pages/texts.js';
import { configsPage } from './pages/configs.js';
import { tasksPage } from './pages/tasks.js';
import { tagsPage } from './pages/tags.js';
import { settingsPage } from './pages/settings.js';

const PAGES = [
  { id: 'dashboard', path: '/dashboard', title: '概览', subtitle: '主体、素材与发布任务的整体情况', icon: 'dashboard', page: dashboardPage },
  { id: 'subjects', path: '/subjects', title: '主体管理', subtitle: '每个扫码登录的微信对应一个主体，独立浏览器与登录态', icon: 'subjects', page: subjectsPage },
  { id: 'videos', path: '/videos', title: '视频池', subtitle: '本地视频素材、标签分组与已上传标记', icon: 'videos', page: videosPage },
  { id: 'texts', path: '/texts', title: '文本池', subtitle: '视频描述文本，内容全局唯一，可导入与打标签', icon: 'texts', page: textsPage },
  { id: 'configs', path: '/configs', title: '发布页面配置', subtitle: '封装主体、视频、文本与发表动态页面选项', icon: 'configs', page: configsPage },
  { id: 'tasks', path: '/tasks', title: '执行记录', subtitle: '批次任务进度、日志、截图与微信结果同步', icon: 'tasks', page: tasksPage },
  { id: 'tags', path: '/tags', title: '标签管理', subtitle: '统一管理标签，用于主体、视频、文本的分组与筛选', icon: 'tags', page: tagsPage },
  { id: 'settings', path: '/settings', title: '项目设置', subtitle: '演练测试环境、浏览器、延迟、扫描、选择器与导入导出', icon: 'settings', page: settingsPage },
];

let cleanup = null;
let currentPageId = null;
let routeToken = 0;

function renderNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = PAGES.map((page) => `
    <div class="nav-item ${currentPageId === page.id ? 'active' : ''}" data-nav="${page.id}">
      ${icon(page.icon)}<span>${page.title}</span>
    </div>`).join('');
  nav.querySelectorAll('[data-nav]').forEach((item) => {
    item.addEventListener('click', () => {
      const target = PAGES.find((page) => page.id === item.dataset.nav);
      location.hash = target.path;
    });
  });
}

function route() {
  const hash = location.hash.replace(/^#/, '') || '/dashboard';
  const page = PAGES.find((item) => hash === item.path || hash.startsWith(`${item.path}/`)) || PAGES[0];
  const token = ++routeToken;
  currentPageId = page.id;
  renderNav();
  document.getElementById('page-title').textContent = page.title;
  document.getElementById('page-subtitle').textContent = page.subtitle;

  if (typeof cleanup === 'function') {
    try { cleanup(); } catch { /* ignore */ }
  }
  cleanup = null;
  const root = document.getElementById('page');
  root.innerHTML = '<div class="row" style="padding:40px 0;justify-content:center"><span class="spinner"></span><span class="muted">加载中…</span></div>';
  const context = {
    root,
    navigate: (path) => { location.hash = path; },
    isActive: () => token === routeToken,
    setActions: (html) => {
      const el = document.getElementById('topbar-right');
      // 页面切换后，旧页面的异步回调不允许再改全局顶栏
      if (token !== routeToken) return el;
      el.innerHTML = html;
      return el;
    },
    setTitle: (title, subtitle) => {
      if (token !== routeToken) return;
      document.getElementById('page-title').textContent = title;
      document.getElementById('page-subtitle').textContent = subtitle || '';
    },
    refreshNav: renderNav,
  };
  Promise.resolve()
    .then(() => page.page.mount(context))
    .then((result) => {
      if (typeof result !== 'function') return;
      // 页面已切换：立刻执行旧页面的清理函数，避免轮询继续覆盖新页面
      if (token !== routeToken) {
        try { result(); } catch { /* ignore */ }
        return;
      }
      cleanup = result;
    })
    .catch((error) => {
      if (token !== routeToken) return;
      console.error(error);
      root.innerHTML = `<div class="card"><div class="card-title">页面加载失败</div><pre class="mono small muted" style="white-space:pre-wrap">${String(error?.message || error)}</pre></div>`;
    });
}

async function updateEnvPill() {
  const pill = document.getElementById('env-pill');
  try {
    const health = await api.health();
    const settings = await store.loadSettings();
    const port = location.port || (location.protocol === 'https:' ? '443' : '80');
    pill.className = 'env-pill ok';
    pill.textContent = `服务正常 · 端口 ${port}${health.runningTaskId ? ' · 任务执行中' : ''}`;
    pill.title = `数据保存在本地。浏览器：${settings.settings?.browser?.headless ? '无头模式' : '有头模式'}`;
  } catch (error) {
    pill.className = 'env-pill err';
    pill.textContent = '后端连接失败';
    pill.title = String(error?.message || error);
  }
}

function showHelp() {
  const root = document.getElementById('modal-root');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal wide">
      <div class="modal-head"><div class="modal-title">使用说明 / 快速上手</div><button class="modal-close" data-close>×</button></div>
      <div class="modal-body">
        <ol style="line-height:2;padding-left:20px;margin:0">
          <li><b>主体</b>：进入「主体管理」→「扫码登录新主体」，用要发布的微信扫码。扫码确认后会自动识别微信/视频号信息并保存登录态。过期后可点击卡片上的「重新扫码」。</li>
          <li><b>视频池</b>：在「视频池」→「扫描文件夹」中添加本地视频目录，扫描后可为视频打标签、计算 MD5，并查看是否已上传。</li>
          <li><b>文本池</b>：在「文本池」中录入或批量导入视频描述文本（每行一条），可打标签。</li>
          <li><b>发布配置</b>：在「发布页面配置」中新建配置：选择主体、视频标签与选择策略、文本标签与策略，并按需开启视频描述前后缀、话题、短标题、位置、合集、原创声明、定时发表等页面选项。</li>
          <li><b>执行</b>：配置页点击「预览资源分配」确认每个主体使用的视频与文本，再选择「保存草稿 / 直接发表 / 演练模式」创建任务。执行记录里可以查看每步日志与截图。</li>
          <li><b>结果同步</b>：在「项目设置 → 微信机器人」中导入本机 dsh-im 已绑定的微信机器人，或扫码绑定新的机器人；在发布配置中勾选「执行结果同步到微信」即可。</li>
        </ol>
        <div class="divider"></div>
        <div class="small muted">提示：自动化基于浏览器界面操作，微信视频号助手改版后如遇选择器失效，可在「项目设置 → 选择器（高级）」中覆盖，或使用「主体管理 → 探测发表页」查看当前页面结构。</div>
      </div>
      <div class="modal-foot"><button class="btn primary" data-close>知道了</button></div>
    </div>`;
  root.appendChild(overlay);
  overlay.addEventListener('click', (event) => {
    // 只允许通过右上角 × 或明确的关闭按钮关闭，点击遮罩不关闭
    if (event.target.closest('[data-close]')) overlay.remove();
  });
}

function init() {
  document.getElementById('btn-docs').addEventListener('click', showHelp);
  updateEnvPill();
  setInterval(updateEnvPill, 30_000);
  window.addEventListener('hashchange', route);
  route();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
