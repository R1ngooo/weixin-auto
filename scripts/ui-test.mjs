/**
 * UI 集成测试：启动隔离服务，用 Playwright 驱动面板完成关键交互。
 * 运行：node scripts/ui-test.mjs
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, '.ui-data');
const PORT = Number(process.env.UI_TEST_PORT || 3398);
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child = null;
let browser = null;
const consoleErrors = [];
let failed = 0;

function step(name) { console.log(`\n▶ ${name}`); }
function ok(info = '') { console.log(`  ✓ ${info}`); }
function fail(message) { failed += 1; console.log(`  ✗ ${message}`); }

async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + '/api' + pathname, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error);
  return data.data;
}

async function waitFor(fn, { timeout = 30_000, interval = 400, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch { /* retry */ }
    await sleep(interval);
  }
  throw new Error(`等待超时：${label}`);
}

async function startServer() {
  await fsp.rm(DATA_DIR, { recursive: true, force: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      WXA_DATA_DIR: DATA_DIR,
      WXA_PORT: String(PORT),
      WXA_DIALOG_TEST_PATH: path.join(DATA_DIR, 'media'),
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  await waitFor(async () => {
    try { return (await api('/health')).ok; } catch { return false; }
  }, { timeout: 40_000, label: '服务启动' });
}

async function seed() {
  await api('/settings', { method: 'PUT', body: { browser: { headless: true }, timing: { stepDelayMs: 300, typeDelayMs: 5 } } });
  const videoTag = await api('/tags', { method: 'POST', body: { name: '视频标签' } });
  const textTag = await api('/tags', { method: 'POST', body: { name: '文本标签' } });
  const mediaDir = path.join(DATA_DIR, 'media');
  await fsp.mkdir(mediaDir, { recursive: true });
  for (const name of ['测试视频A.mp4', '测试视频B.mp4']) {
    await fsp.writeFile(path.join(mediaDir, name), Buffer.from(`video-${name}`.repeat(50)));
  }
  await api('/videos/folders', { method: 'POST', body: { path: mediaDir, recursive: true } });
  const scan = await api('/videos/scan', { method: 'POST', body: {} });
  await waitFor(async () => (await api(`/jobs/${scan.id}`)).status === 'success', { timeout: 30_000, label: '视频扫描' });
  const videos = await api('/videos?pageSize=10');
  for (const video of videos.data) await api(`/videos/${video.id}`, { method: 'PUT', body: { tagIds: [videoTag.id] } });
  const texts = await api('/texts/import', { method: 'POST', body: { text: '第一条 UI 测试文本\n第二条 UI 测试文本', separator: 'line' } });
  for (const text of (await api('/texts?pageSize=50')).data) await api(`/texts/${text.id}`, { method: 'PUT', body: { tagIds: [textTag.id] } });
  const subject = await api('/subjects', { method: 'POST', body: { name: 'UI测试主体' } });
  return { videoTag, textTag, subject, videos: videos.data, texts: texts };
}

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push('CONSOLE: ' + msg.text()); });
  page.on('pageerror', (error) => consoleErrors.push('PAGEERROR: ' + error.message));
  return page;
}

async function go(page, route) {
  await page.goto(`${BASE}/#${route}`, { waitUntil: 'networkidle' }).catch(() => undefined);
  await page.waitForTimeout(700);
}

async function main() {
  console.log('视频号助手自动化工具 · UI 集成测试');
  await startServer();
  const seeded = await seed();
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const page = await newPage();

  try {
    step('概览页加载');
    await go(page, '/dashboard');
    if (await page.locator('.stat-card').count() >= 4) ok('统计卡片渲染'); else fail('统计卡片缺失');
    const navOrder = (await page.locator('#nav .nav-item span').allInnerTexts()).map((text) => text.trim());
    const expectedNav = ['概览', '标签管理', '主体管理', '视频池', '文本池', '发布页面配置', '执行记录', '系统设置'];
    if (JSON.stringify(navOrder) === JSON.stringify(expectedNav)) ok('左侧导航顺序与名称正确');
    else fail(`导航顺序异常：${navOrder.join(' → ')}`);

    step('主体管理：扫码登录弹窗（默认无头 + 快速刷新）');
    await go(page, '/subjects');
    if (await page.locator('.tag-bar').count() > 0) ok('主体页标签筛选条独占一行'); else fail('主体页缺少标签筛选条');
    // 卡片统一布局：状态徽标在右上角，与头像/名称同一水平行
    const cardLayout = await page.locator('.subject-card').first().evaluate((card) => {
      const head = card.querySelector('.subject-head');
      const avatar = card.querySelector('.avatar');
      const name = card.querySelector('.subject-name');
      const status = card.querySelector('.subject-status');
      const body = card.querySelector('.subject-body');
      if (!head || !avatar || !name || !status || !body) return { ok: false };
      const cardRect = card.getBoundingClientRect();
      const statusRect = status.getBoundingClientRect();
      const nameRect = name.getBoundingClientRect();
      const avatarRect = avatar.getBoundingClientRect();
      return {
        ok: true,
        statusInHead: head.contains(status),
        rightAligned: cardRect.right - statusRect.right < 24,
        sameRow: Math.abs(statusRect.top - nameRect.top) < 30 && Math.abs(statusRect.top - avatarRect.top) < 30,
        hasBodyRows: Boolean(body.querySelector('.subject-tags') && body.querySelector('.subject-note-row') && body.querySelector('.subject-meta-row')),
        displayName: name.innerText.trim(),
      };
    });
    if (cardLayout.ok && cardLayout.statusInHead && cardLayout.rightAligned && cardLayout.sameRow && cardLayout.hasBodyRows) ok('主体卡片统一样式：状态右上角、与头像/名称同排');
    else fail(`主体卡片布局异常：${JSON.stringify(cardLayout)}`);
    const qrStart = Date.now();
    await page.locator('button:has-text("扫码登录新主体")').first().click();
    await page.waitForSelector('.modal-overlay', { timeout: 5000 });
    await waitFor(async () => (await page.locator('.modal-overlay .qr-box').count()) > 0, { timeout: 5000, label: '登录弹窗' });
    ok('登录弹窗打开');
    const footerButtons = await page.locator('.modal-foot button').allInnerTexts();
    if (footerButtons.some((text) => text.includes('浏览器扫码'))) ok('弹窗提供「浏览器扫码」兜底按钮'); else fail('缺少浏览器扫码按钮');
    // 等待二维码出现（外部网络，最多 45 秒；超时只警告）
    let qrShown = false;
    try {
      await waitFor(async () => (await page.locator('#qr-image img').count()) > 0, { timeout: 45_000, label: '二维码' });
      qrShown = true;
      const elapsed = Date.now() - qrStart;
      console.log(`  · 二维码出现耗时：${elapsed}ms`);
      if (elapsed < 30_000) ok(`二维码已获取并展示（${elapsed}ms）`);
      else fail(`二维码获取过慢：${elapsed}ms`);
    } catch {
      console.log('  ! 未在 45 秒内获取二维码（可能是网络原因，继续）');
    }
    if (qrShown) {
      // 手动刷新：等待二维码图片变化
      const firstSrc = await page.locator('#qr-image img').getAttribute('src');
      const refreshStart = Date.now();
      await page.locator('.modal-foot button:has-text("刷新二维码")').click();
      try {
        await waitFor(async () => {
          const src = await page.locator('#qr-image img').getAttribute('src').catch(() => null);
          return src && src !== firstSrc;
        }, { timeout: 30_000, interval: 400, label: '二维码刷新' });
        console.log(`  · 二维码刷新耗时：${Date.now() - refreshStart}ms`);
        ok('刷新二维码成功');
      } catch {
        console.log('  ! 二维码刷新超时（网络原因，继续）');
      }
    }
    await page.locator('.modal-foot button:has-text("取消")').click();
    await page.waitForTimeout(800);
    if (await page.locator('.modal-overlay').count() === 0) ok('登录弹窗已关闭'); else fail('登录弹窗未关闭');

    step('文本池：新增文本');
    await go(page, '/texts');
    if (await page.locator('.tag-bar').count() > 0) ok('文本页标签筛选条独占一行'); else fail('文本页缺少标签筛选条');
    await page.locator('button:has-text("新增文本")').first().click();
    await page.waitForSelector('.modal-overlay');
    await page.locator('.modal-body [data-content]').fill('这是通过 UI 新增的一条测试文本内容');
    await page.locator('.modal-foot button:has-text("新增")').click();
    await waitFor(async () => (await page.locator('td .text-preview:has-text("通过 UI 新增")').count()) > 0, { timeout: 8000, label: '新增文本显示' });
    ok('新增文本出现在列表');

    step('文本池：导入文本');
    await page.locator('button:has-text("导入文本")').first().click();
    await page.waitForSelector('.modal-overlay');
    await page.locator('.modal-body [data-content]').fill('导入文本一\n导入文本二');
    await page.locator('.modal-foot button:has-text("开始导入")').click();
    await waitFor(async () => (await page.locator('td .text-preview:has-text("导入文本一")').count()) > 0, { timeout: 8000, label: '导入结果' });
    ok('导入文本成功');

    step('发布配置：新建配置（基本配置 + 资源标签 + 排版校验）');
    await go(page, '/configs');
    await page.locator('button:has-text("新建发布配置")').first().click();
    await page.waitForSelector('.modal-overlay .modal.xwide', { timeout: 5000 });
    ok('配置编辑器打开');
    if (await page.locator('.modal-body [data-short-from-video]').count() === 0 && await page.locator('.modal-body [data-original-enabled]').count() === 0) {
      ok('已移除「使用视频文件名」「声明原创（旧版选项）」');
    } else {
      fail('仍存在已废弃的短标题/原创选项');
    }
    if (await page.locator('.modal-body [data-preupload-enabled]').count() === 1) ok('页面选项顶部提供「先传输完素材，再逐一搭建」'); else fail('缺少先传后搭选项');
    if (await page.locator('.modal-body [data-schedule-interval]').count() === 1 && await page.locator('.modal-body [data-schedule-scope]').count() === 1) ok('定时发表提供间隔与作用范围'); else fail('缺少定时间隔/作用范围');
    const optionTexts = (await page.locator('.modal-body .page-option').allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim());
    const optionIndex = (keyword) => optionTexts.findIndex((text) => text.includes(keyword));
    const ordered = ['视频描述', '短标题', '设置位置', '添加到合集', '链接', '定时发表', '视频标注'];
    const indexes = ordered.map(optionIndex);
    if (indexes.every((index, position) => index >= 0 && (position === 0 || index > indexes[position - 1]))) {
      ok('发表选项按「描述→短标题→位置→合集→链接→定时→视频标注」自上而下排列');
    } else {
      fail(`发表选项顺序异常：${JSON.stringify(indexes)}`);
    }
    if (await page.locator('.modal-body label.check:has-text("链接")').count() === 1) ok('「扩展链接」已改名为「链接」'); else fail('缺少「链接」选项');
    if (await page.locator('.modal-body input[name="schedule-mode"]').count() === 2) ok('定时发表为「不定时 / 定时」两个选项'); else fail('定时发表选项异常');
    await page.locator('.modal-body input[name="schedule-mode"][value="on"]').check();
    if (await page.locator('.modal-body [data-schedule-value]').isVisible()) ok('选择定时后才显示日期选择框'); else fail('日期选择框未按条件显示');
    if ((await page.locator('.modal-body [data-schedule-value]').getAttribute('step')) === '60') ok('定时时间颗粒度为分钟'); else fail('定时时间颗粒度不是分钟');
    await page.locator('.modal-body input[name="schedule-mode"][value="off"]').check();
    await page.locator('.modal-body [data-name]').fill('UI 测试配置');
    // 资源标签统一筛选 + 指定主体
    await page.locator('.modal-body [data-resource-tags] .tag:has-text("视频标签")').click();
    await page.locator('.modal-body [data-resource-tags] .tag:has-text("文本标签")').click();
    await page.locator('.modal-body input[name="subject-mode"][value="ids"]').check();
    await waitFor(async () => (await page.locator('.modal-body [data-subject-check]').count()) > 0, { timeout: 5000, label: '指定主体列表' });
    await page.locator('.modal-body [data-subject-check]').first().check();
    await page.locator('.modal-body [data-desc-hashtags]').fill('测试话题,自动化');
    // 短标题必填 + 6-16 字前端校验
    await page.locator('.modal-body [data-short-enabled]').check();
    await page.locator('.modal-foot button[data-save]').click();
    await waitFor(async () => (await page.locator('.toast:has-text("短标题")').count()) > 0, { timeout: 5000, label: '短标题提示' });
    ok('勾选短标题但为空时提示必填');
    await page.locator('.modal-body [data-short-value]').fill('太短');
    await page.locator('.modal-foot button[data-save]').click();
    await waitFor(async () => (await page.locator('.toast:has-text("6-16")').count()) > 0, { timeout: 5000, label: '短标题长度提示' });
    ok('短标题少于 6 字时提示长度限制');
    await page.locator('.modal-body [data-short-value]').fill('这是一个合格短标题');
    // 链接必填 + 商品ID
    await page.locator('.modal-body [data-extlink-enabled]').check();
    await page.locator('.modal-foot button[data-save]').click();
    await waitFor(async () => (await page.locator('.toast:has-text("商品链接或商品ID")').count()) > 0, { timeout: 5000, label: '链接必填提示' });
    ok('勾选「链接」但为空时提示必填');
    await page.locator('.modal-body [data-extlink-value]').fill('10001727125779');
    await page.locator('.modal-foot button[data-save]').click();
    await waitFor(async () => (await page.locator('.card:has-text("UI 测试配置")').count()) > 0, { timeout: 10_000, label: '配置保存' });
    ok('发布配置保存成功');
    const cardCountBeforeCopy = await page.locator('.card[data-config]').count();
    await page.locator('.card:has-text("UI 测试配置")').first().locator('button:has-text("复制")').click();
    await waitFor(async () => (await page.locator('.card[data-config]').count()) === cardCountBeforeCopy + 1, { timeout: 8000, label: '复制配置' });
    ok('配置复制按钮可用（复制全部配置内容）');
    // 配置启用定时发表后：任务级定时执行应灰置并提示原因
    const configsNow = await api('/configs');
    const uiConfig = configsNow.find((item) => item.name === 'UI 测试配置');
    await api(`/configs/${uiConfig.id}`, {
      method: 'PUT',
      body: {
        name: uiConfig.name,
        config: {
          ...uiConfig.config,
          pageOptions: {
            ...uiConfig.config.pageOptions,
            scheduled: { enabled: true, value: new Date(Date.now() + 3600_000).toISOString(), intervalMinutes: 10, intervalScope: 'subject' },
          },
        },
      },
    });
    await go(page, '/configs');
    const scheduledAgain = (await api('/configs')).find((item) => item.id === uiConfig.id);
    if (scheduledAgain?.config?.pageOptions?.scheduled?.enabled) ok('配置定时发表已启用'); else fail('配置定时发表未保存');
    await page.reload({ waitUntil: 'networkidle' }).catch(() => undefined);
    await page.waitForTimeout(900);
    await page.locator(`.card[data-config="${uiConfig.id}"]`).locator('button:has-text("创建任务")').click();
    await page.waitForSelector('.modal-overlay');
    if (await page.locator('.modal-body [data-task-schedule]').isDisabled()) ok('配置已启用定时发表时任务定时执行灰置'); else fail('任务定时执行未灰置');
    if ((await page.locator('.modal-body').innerText()).includes('已启用定时发表')) ok('灰置时提示原因'); else fail('灰置时缺少原因提示');
    await page.locator('.modal-close').click();
    await page.waitForTimeout(400);
    await api(`/configs/${uiConfig.id}`, {
      method: 'PUT',
      body: {
        name: uiConfig.name,
        config: {
          ...uiConfig.config,
          pageOptions: {
            ...uiConfig.config.pageOptions,
            scheduled: { enabled: false, value: null, intervalMinutes: 10, intervalScope: 'subject' },
          },
        },
      },
    });
    await page.reload({ waitUntil: 'networkidle' }).catch(() => undefined);
    await page.waitForTimeout(900);

    step('发布配置：创建任务');
    const configCard = page.locator('.card:has-text("UI 测试配置")').first();
    await configCard.locator('button:has-text("创建任务")').click();
    await page.waitForSelector('.modal-overlay');
    await page.locator('.modal-body [data-dry]').check();
    if (await page.locator('.modal-body [data-start]').isChecked()) ok('创建任务默认「创建后立即开始执行」'); else fail('未默认立即开始执行');
    await page.locator('.modal-body [data-task-schedule]').check();
    if (await page.locator('.modal-body [data-task-schedule-fields]').isVisible()) ok('勾选定时执行后显示起点/间隔'); else fail('定时执行字段未显示');
    if (await page.locator('.modal-body [data-start]').isDisabled()) ok('定时执行时立即开始执行被禁用'); else fail('定时执行与立即开始未互斥');
    await page.locator('.modal-body [data-task-schedule]').uncheck();
    await page.locator('.modal-body [data-start]').uncheck();
    await page.locator('.modal-foot button:has-text("创建任务")').click();
    await page.waitForTimeout(1500);
    if (page.url().includes('/tasks')) ok('创建后跳转到执行记录'); else fail(`未跳转到执行记录：${page.url()}`);

    step('执行记录：微信机器人面板与任务详情');
    await waitFor(async () => (await page.locator('#tasks-wechat-panel [data-wechat-enabled]').count()) > 0, { timeout: 8000, label: '微信机器人面板' });
    ok('微信机器人面板位于执行记录页顶部');
    await waitFor(async () => (await page.locator('table.table tbody tr').count()) > 0, { timeout: 8000, label: '任务列表' });
    await page.locator('table.table tbody tr').first().locator('button:has-text("详情")').click();
    await waitFor(async () => (await page.locator('.item-card').count()) > 0, { timeout: 8000, label: '任务详情' });
    ok('任务详情展示明细');

    step('标签管理：标签组 + 标签列表');
    await go(page, '/tags');
    await waitFor(async () => (await page.locator('.tag-group-list').count()) > 0, { timeout: 8000, label: '标签组区域' });
    const groupRowCount = await page.locator('.tag-group-row').count();
    if (groupRowCount >= 2) ok('标签组区域渲染（全部标签 + 系统默认分组）'); else fail(`标签组区域异常：${groupRowCount}`);
    if (await page.locator('table.table tbody tr').count() >= 2) ok('标签列表默认显示全部标签'); else fail('标签列表缺失');
    // 新增单选标签组
    await page.locator('[data-act="add-group"]').click();
    await page.waitForSelector('.modal-overlay');
    await page.locator('.modal-body [data-name]').fill('UI 单选组');
    await page.locator('.modal-body input[name="group-mode"][value="single"]').check();
    await page.locator('.modal-foot button:has-text("保存")').click();
    await waitFor(async () => (await page.locator('.tag-group-row:has-text("UI 单选组")').count()) > 0, { timeout: 8000, label: '新建标签组' });
    ok('新增单选标签组成功');
    // 点击标签组 → 标签列表仅显示该组标签（此时为空）
    await page.locator('.tag-group-row:has-text("UI 单选组")').click();
    await sleep(500);
    if (await page.locator('.empty').count() > 0) ok('点击标签组后按组筛选标签列表'); else fail('标签组筛选未生效');
    // 在该组下新增两个标签
    for (const name of ['UI 组内标签1', 'UI 组内标签2']) {
      await page.locator('[data-act="add-tag"]').first().click();
      await page.waitForSelector('.modal-overlay');
      await page.locator('.modal-body [data-name]').fill(name);
      await page.locator('.modal-foot button:has-text("保存")').click();
      await waitFor(async () => (await page.locator(`table.table:has-text("${name}")`).count()) > 0, { timeout: 8000, label: `新增标签 ${name}` });
    }
    ok('标签组内新增两个标签');
    // 切换单选/多选
    const modeToggle = page.locator('.tag-group-row:has-text("UI 单选组") [data-mode-toggle]');
    await modeToggle.click();
    await sleep(700);
    const modeText = await page.locator('.tag-group-row:has-text("UI 单选组") [data-mode-toggle]').innerText();
    if (modeText.includes('多选')) ok('标签组单选/多选切换生效'); else fail(`模式切换异常：${modeText}`);
    await page.locator('.tag-group-row:has-text("UI 单选组") [data-mode-toggle]').click();
    await sleep(700);
    // 回到全部标签
    await page.locator('.tag-group-row:has-text("全部标签")').click();
    await sleep(500);
    if (await page.locator('table.table tbody tr').count() >= 4) ok('切回全部标签列表'); else fail('全部标签列表异常');

    step('主体管理：单选标签组互斥选择');
    await go(page, '/subjects');
    await page.locator('.subject-card').first().locator('button:has-text("编辑")').click();
    await page.waitForSelector('.modal-overlay');
    await sleep(400);
    const modalTags = page.locator('.modal-body [data-tags]');
    if (await modalTags.locator('.chip-group').count() >= 2) ok('标签选择组件按标签组分组展示'); else fail('标签选择组件未按组展示');
    await modalTags.locator('[data-tag]').filter({ hasText: 'UI 组内标签1' }).click();
    await sleep(200);
    await modalTags.locator('[data-tag]').filter({ hasText: 'UI 组内标签2' }).click();
    await sleep(300);
    const singleSelected = await modalTags.locator('.tag.on').count();
    if (singleSelected === 1) ok('单选组内只能选中一个标签'); else fail(`单选组互斥失效，选中 ${singleSelected} 个`);
    await page.locator('.modal-close').click();
    await page.waitForTimeout(300);

    step('视频池：抖音竖卡 + 标签筛选条');
    await go(page, '/videos');
    await waitFor(async () => (await page.locator('.video-card').count()) > 0, { timeout: 8000, label: '视频卡片' });
    const cardRatio = await page.locator('.video-media').first().evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width / rect.height;
    });
    if (Math.abs(cardRatio - 9 / 16) < 0.03) ok(`封面为 9:16 竖版（比例 ${cardRatio.toFixed(3)}）`);
    else fail(`封面比例不是 9:16（${cardRatio.toFixed(3)}）`);
    // 信息栏下沉到卡片底部，卡片上不再有标签/移除按钮
    if (await page.locator('.video-info').count() > 0) ok('视频信息位于卡片底部信息栏');
    else fail('缺少卡片底部信息栏');
    if (await page.locator('.video-card [data-act="tags"], .video-card [data-act="delete"]').count() === 0) ok('卡片已移除“标签/移除”按钮');
    else fail('卡片仍有标签/移除按钮');
    const tagBarBox = await page.locator('.tag-bar').first().boundingBox().catch(() => null);
    const toolbarBox = await page.locator('.toolbar').first().boundingBox().catch(() => null);
    if (tagBarBox && toolbarBox && tagBarBox.y >= toolbarBox.y + toolbarBox.height - 1) ok('标签筛选条独占一行');
    else fail('标签筛选条未与工具栏分行');
    await page.locator('[data-search]').fill('视频标签');
    await sleep(900);
    const byTagCount = await page.locator('.video-card').count();
    if (byTagCount === 2) ok('搜索框检索范围包含标签'); else fail(`按标签搜索视频数量异常：${byTagCount}`);
    // 分页默认 20 条/页，可选到 120
    const pageSizeValue = await page.locator('[data-pagesize]').inputValue();
    const pageSizeOptions = await page.locator('[data-pagesize] option').allTextContents();
    if (pageSizeValue === '20' && pageSizeOptions.length === 6 && pageSizeOptions[5].includes('120')) ok('分页默认 20 条/页，可选至 120');
    else fail(`分页配置异常：${pageSizeValue} / ${pageSizeOptions.join(',')}`);
    // 卡片上不再有冗余的“预览”按钮，点击卡片直接预览
    if (await page.locator('.video-card [data-act="preview"]').count() === 0) ok('卡片已移除“预览”按钮');
    else fail('卡片仍有“预览”按钮');
    await page.locator('.video-card').first().click();
    await page.waitForSelector('.modal-overlay');
    if (await page.locator('.modal-overlay .preview').count() > 0) ok('点击卡片直接打开预览');
    else fail('点击卡片未打开预览');
    await page.locator('.modal-close').click();
    await page.waitForTimeout(300);

    // 卡片已缩小到约 1/3 面积（宽约 120-160px）
    const compactSize = await page.locator('.video-card').first().boundingBox();
    if (compactSize && compactSize.width < 165 && compactSize.width >= 100) ok(`卡片已缩小（宽约 ${Math.round(compactSize.width)}px，面积约 1/3）`);
    else fail(`卡片尺寸异常：${compactSize ? Math.round(compactSize.width) : 'null'}px`);
    // 三种显示模式：卡片 / 列表 / 文件夹
    const viewButtonCount = await page.locator('.view-switch-item').count();
    if (viewButtonCount === 3) ok('提供卡片/列表/文件夹三种显示模式'); else fail(`显示模式数量异常：${viewButtonCount}`);
    await page.locator('[data-view="list"]').click();
    await sleep(600);
    if (await page.locator('.video-list').count() === 1 && await page.locator('.video-row').count() === 2) ok('列表模式渲染文字行');
    else fail('列表模式渲染异常');
    await page.locator('.video-row').first().click();
    await page.waitForSelector('.modal-overlay');
    if (await page.locator('.modal-overlay .preview').count() > 0) ok('列表行点击可预览');
    else fail('列表行点击未预览');
    await page.locator('.modal-close').click();
    await page.waitForTimeout(300);
    await page.locator('[data-view="folder"]').click();
    await sleep(600);
    if (await page.locator('.folder-group').count() >= 1) ok('文件夹模式按本地路径分组');
    else fail('文件夹模式未渲染分组');
    await page.locator('[data-view="card"]').click();
    await sleep(500);
    if (await page.locator('.video-grid').count() > 0) ok('可切换回卡片模式');
    else fail('无法切回卡片模式');

    step('视频池：批量移除逻辑（软移除）');
    await page.locator('#topbar-right button:has-text("批量编辑")').click();
    await waitFor(async () => (await page.locator('[data-batch-bar]').count()) > 0, { timeout: 5000, label: '批量操作条' });
    await page.locator('.video-card').first().click();
    await waitFor(async () => (await page.locator('.video-card.selected').count()) > 0, { timeout: 5000, label: '选择视频' });
    await page.locator('[data-batch="remove"]').click();
    await page.waitForSelector('.modal-overlay');
    const deleteChecked = await page.locator('.modal-body [data-delete-file]').isChecked();
    const removeText = await page.locator('.modal-body').innerText();
    if (!deleteChecked && /不会删除数据库记录/.test(removeText) && /MD5/.test(removeText)) ok('批量移除弹窗默认不勾选删除文件，并说明保留记录/按 MD5 恢复');
    else fail('批量移除弹窗文案或默认勾选不符合预期');
    await page.locator('.modal-foot button:has-text("取消")').click();
    await page.waitForTimeout(300);
    await page.locator('[data-batch="exit"]').click();
    await page.waitForTimeout(300);

    step('视频池：系统文件夹选择 + 面板内浏览');
    await page.locator('#topbar-right button:has-text("文件夹管理")').click();
    await page.waitForSelector('.modal-overlay');
    await page.locator('[data-pick]').click();
    await waitFor(async () => (await page.locator('[data-folder-input]').inputValue()).length > 0, { timeout: 8000, label: '系统选择文件夹' });
    ok('系统文件夹选择返回路径');
    await page.locator('[data-browse]').click();
    await waitFor(async () => (await page.locator('.dir-list').count()) > 0, { timeout: 8000, label: '目录浏览' });
    ok('面板内文件夹浏览可用');
    await page.locator('.modal-close').last().click();
    await page.waitForTimeout(300);
    await page.locator('.modal-close').last().click();
    await page.waitForTimeout(300);

    step('批量打标签：视频池');
    await go(page, '/videos');
    await waitFor(async () => (await page.locator('.video-card').count()) > 0, { timeout: 8000, label: '视频卡片' });
    await page.locator('#topbar-right button:has-text("批量编辑")').click();
    await waitFor(async () => (await page.locator('[data-batch-bar]').count()) > 0, { timeout: 5000, label: '批量操作条' });
    ok('进入批量模式');
    await page.locator('[data-batch="all"]').click();
    await waitFor(async () => (await page.locator('.video-card.selected').count()) > 0, { timeout: 5000, label: '全选视频' });
    ok('已全选视频卡片');
    await page.locator('[data-batch="apply"]').click();
    await page.waitForSelector('.modal-overlay');
    await page.locator('.modal-body [data-batch-tags] .tag:has-text("视频标签")').click();
    await page.locator('.modal-foot button:has-text("应用到所选")').click();
    await waitFor(async () => (await page.locator('.toast:has-text("已更新")').count()) > 0, { timeout: 8000, label: '批量打标签' });
    ok('批量打标签成功');

    step('弹窗：点击遮罩不关闭');
    await page.locator('#topbar-right button:has-text("文件夹管理")').click();
    await page.waitForSelector('.modal-overlay');
    await page.mouse.click(20, 20);
    await page.waitForTimeout(400);
    if (await page.locator('.modal-overlay').count() > 0) ok('点击遮罩弹窗保持打开');
    else fail('点击遮罩弹窗被关闭');
    await page.locator('.modal-close').click();
    await page.waitForTimeout(300);
    if (await page.locator('.modal-overlay').count() === 0) ok('右上角 × 可关闭弹窗'); else fail('右上角 × 未关闭弹窗');

    step('主体管理：删除确认（confirmDialog 修复）');
    const tempSubject = await api('/subjects', { method: 'POST', body: { name: 'UI删除测试主体' } });
    await go(page, '/subjects');
    await waitFor(async () => (await page.locator(`.subject-card:has-text("UI删除测试主体")`).count()) > 0, { timeout: 8000, label: '待删除主体卡片' });
    const beforeCount = await page.locator('.subject-card').count();
    // 先取消：卡片必须保留
    await page.locator('.subject-card:has-text("UI删除测试主体") button:has-text("删除")').click();
    await page.waitForSelector('.modal-overlay');
    await page.locator('.modal-foot button:has-text("取消")').click();
    await page.waitForTimeout(500);
    if (await page.locator('.subject-card').count() === beforeCount) ok('取消删除时卡片保留'); else fail('取消删除时卡片消失');
    // 再确认：卡片立即消失且 API 不再返回
    await page.locator('.subject-card:has-text("UI删除测试主体") button:has-text("删除")').click();
    await page.waitForSelector('.modal-overlay');
    await page.locator('.modal-foot button:has-text("删除")').click();
    await waitFor(async () => (await page.locator('.subject-card').count()) === beforeCount - 1, { timeout: 8000, label: '卡片消失' });
    ok('确认删除后卡片立即消失');
    const listAfter = await api('/subjects');
    if (!listAfter.some((item) => item.id === tempSubject.id)) ok('删除后 API 不再返回该主体'); else fail('删除后 API 仍返回该主体');

    step('系统设置：单列瀑布 + 左侧子导航 + 演练测试环境');
    await go(page, '/settings');
    await waitFor(async () => (await page.locator('.settings-layout').count()) > 0, { timeout: 8000, label: '设置页' });
    const settingsTitle = await page.locator('#page-title').innerText();
    if (settingsTitle.trim() === '系统设置') ok('页面标题为「系统设置」'); else fail(`设置页标题异常：${settingsTitle}`);
    const sectionCount = await page.locator('.settings-section').count();
    const navCount = await page.locator('.settings-nav-item').count();
    if (sectionCount === 7 && navCount === 7) ok('设置页为单列 7 个模块 + 左侧子导航');
    else fail(`设置模块数量异常：section=${sectionCount} nav=${navCount}`);
    const firstTitle = await page.locator('.settings-section').first().innerText();
    if (/演练测试环境/.test(firstTitle)) ok('演练测试环境位于最上方'); else fail('演练测试环境不在最上方');
    if (await page.locator('[data-dry-run-usage]').count() === 1) ok('演练测试环境开关存在'); else fail('缺少演练测试环境开关');
    // 点击子导航跳转到对应模块（滚动到顶部）
    await page.locator('.settings-nav-item:has-text("浏览器与运行")').click();
    await page.waitForTimeout(900);
    const browserSectionTop = await page.locator('#settings-browser').evaluate((el) => el.getBoundingClientRect().top);
    if (browserSectionTop >= 0 && browserSectionTop < 260) ok(`子导航跳转生效（模块顶部 ${Math.round(browserSectionTop)}px）`);
    else fail(`子导航跳转后模块位置异常：${Math.round(browserSectionTop)}px`);
    // 打开演练测试环境并保存，接口应持久化
    await page.locator('[data-dry-run-usage]').check();
    await page.locator('#topbar-right button:has-text("保存设置")').click();
    await page.waitForTimeout(1200);
    const settingsAfter = await api('/settings');
    if (settingsAfter.settings.testing?.dryRunCountsUsage === true) ok('演练测试环境开关已保存');
    else fail('演练测试环境开关未保存');
    await page.locator('[data-dry-run-usage]').uncheck();
    await page.locator('#topbar-right button:has-text("保存设置")').click();
    await page.waitForTimeout(900);
    ok('设置保存请求已发送');
    const aboutText = await page.locator('#settings-about').innerText();
    if (/软件升级/.test(aboutText) && /v0\.2\.0|版本/.test(aboutText)) ok('关于页展示版本与软件升级'); else fail('关于页缺少版本/软件升级');
    if (await page.locator('[data-update-file]').count() === 1) ok('提供补丁包导入入口'); else fail('缺少补丁包导入入口');
    // 导入缺失视频路径：应提示并跳过
    const missingPayload = {
      app: 'weixin-auto',
      videos: [{ id: 9999, path: 'Z:\\__wxa_ui_missing__\\missing.mp4', name: 'missing.mp4', ext: '.mp4', size: 1, md5: 'x', folder: 'Z:\\__wxa_ui_missing__' }],
      videoFolders: [{ path: 'Z:\\__wxa_ui_missing__', recursive: 1, enabled: 1 }],
    };
    await page.locator('[data-import-text]').fill(JSON.stringify(missingPayload));
    await page.locator('[data-act="import"]').click();
    await page.waitForSelector('.modal-overlay');
    await page.locator('.modal-foot button:has-text("开始导入")').click();
    await waitFor(async () => (await page.locator('.modal-title:has-text("跳过")').count()) > 0, { timeout: 8000, label: '缺失路径提示' });
    ok('导入缺失路径时显示跳过提示');
    await page.locator('.modal-close').click();
    await page.waitForTimeout(400);
  } finally {
    await page.screenshot({ path: path.join(DATA_DIR, 'ui-final.png') }).catch(() => undefined);
    await browser.close().catch(() => undefined);
    try { child?.kill(); } catch { /* ignore */ }
    await sleep(600);
  }

  const realErrors = consoleErrors.filter((line) => !line.includes('favicon'));
  console.log(`\n浏览器控制台错误：${realErrors.length}`);
  for (const line of realErrors.slice(0, 20)) console.log('  ' + line);
  if (realErrors.length) failed += 1;

  console.log(`\n结果：${failed === 0 ? '全部通过 ✅' : `${failed} 项失败 ❌`}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('UI 测试异常：', error);
  try { child?.kill(); } catch { /* ignore */ }
  process.exit(1);
});
