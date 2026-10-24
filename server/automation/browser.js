import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { PATHS } from '../config.js';
import { MutexMap, ensureDir } from '../util.js';

/**
 * 每个主体 = 独立的浏览器用户目录（持久化 Cookie / 登录态）。
 * 同一主体的操作通过互斥锁串行，避免多个任务同时操作同一浏览器。
 */
export function createBrowserManager({ getSettings, getSubject }) {
  const mutex = new MutexMap();
  const sessions = new Map(); // subjectId -> { context, lastUsedAt, launching }
  const idleTimer = setInterval(() => {
    const minutes = Number(getSettings()?.browser?.idleCloseMinutes ?? 0);
    if (!minutes || minutes <= 0) return;
    const deadline = Date.now() - minutes * 60_000;
    for (const [subjectId, entry] of sessions) {
      if (!entry.busy && entry.lastUsedAt < deadline) {
        close(subjectId).catch(() => undefined);
      }
    }
  }, 60_000);
  idleTimer.unref?.();

  function profileDir(subjectId) {
    return path.join(PATHS.profiles, subjectId);
  }

  function launchOptions(headlessOverride) {
    const browser = getSettings()?.browser || {};
    const headless = headlessOverride === undefined ? browser.headless === true : Boolean(headlessOverride);
    const options = {
      headless,
      viewport: browser.viewport || { width: 1440, height: 900 },
      locale: browser.locale || 'zh-CN',
      slowMo: Number(browser.slowMoMs || 0),
      acceptDownloads: true,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-default-browser-check',
        '--no-first-run',
        '--disable-features=Translate,BackForwardCache',
      ],
      timeout: 60_000,
    };
    if (browser.executablePath) options.executablePath = browser.executablePath;
    else if (browser.channel) options.channel = browser.channel;
    // Playwright 的无头模式默认使用 chrome-headless-shell（需额外下载）；
    // 使用 channel=chromium 可直接复用已安装的完整 Chromium 的新无头模式。
    else if (options.headless) options.channel = 'chromium';
    return options;
  }

  async function launch(subjectId, { headless } = {}) {
    const dir = profileDir(subjectId);
    await ensureDir(dir);
    const options = launchOptions(headless);
    let context;
    try {
      context = await chromium.launchPersistentContext(dir, options);
    } catch (error) {
      const hint = /Executable doesn't exist|browserType\.launch/.test(String(error?.message))
        ? '未找到可用的浏览器内核。请执行 `npx playwright install chromium`，或在「系统设置 → 浏览器与运行」中填写本机 Chrome/Edge 的 executablePath。'
        : String(error?.message || error);
      throw new Error(`启动浏览器失败：${hint}`);
    }
    context.setDefaultTimeout(Number(getSettings()?.browser?.defaultTimeoutMs || 30_000));
    context.setDefaultNavigationTimeout(Number(getSettings()?.browser?.navigationTimeoutMs || 60_000));
    // 新窗口一律转成普通 page 管理
    const initialPages = context.pages();
    const entry = {
      context,
      lastUsedAt: Date.now(),
      busy: false,
      pages: initialPages,
      headless: options.headless === true,
    };
    context.on('page', (page) => {
      entry.lastUsedAt = Date.now();
      entry.pages.push(page);
    });
    context.on('close', () => {
      sessions.delete(subjectId);
    });
    sessions.set(subjectId, entry);
    return entry;
  }

  async function getSession(subjectId, { headless } = {}) {
    let entry = sessions.get(subjectId);
    if (entry?.context) {
      // 现有会话的显示模式与请求不一致时，先关闭再按新模式重启（同一 profile 目录）
      if (headless !== undefined && entry.headless !== Boolean(headless)) {
        await close(subjectId);
        entry = null;
      } else {
        return entry;
      }
    }
    if (entry?.launching) return entry.launching;
    const launching = launch(subjectId, { headless }).finally(() => {
      const current = sessions.get(subjectId);
      if (current && !current.context) sessions.delete(subjectId);
    });
    sessions.set(subjectId, { launching, lastUsedAt: Date.now(), busy: false });
    return launching;
  }

  async function getPage(subjectId, options = {}) {
    const entry = await getSession(subjectId, options);
    const pages = entry.context.pages().filter((p) => !p.isClosed());
    const page = pages[0] || await entry.context.newPage();
    entry.lastUsedAt = Date.now();
    return page;
  }

  async function run(subjectId, fn) {
    return mutex.run(subjectId, async () => {
      const entry = await getSession(subjectId);
      entry.busy = true;
      entry.lastUsedAt = Date.now();
      try {
        const page = await getPage(subjectId);
        return await fn({ context: entry.context, page, entry });
      } finally {
        entry.busy = false;
        entry.lastUsedAt = Date.now();
      }
    });
  }

  async function close(subjectId, { timeoutMs = 8000 } = {}) {
    const entry = sessions.get(subjectId);
    sessions.delete(subjectId);
    let context = entry?.context || null;
    if (!context && entry?.launching) {
      // 正在启动中的会话：等待启动完成后再关闭，避免遗留孤儿浏览器
      const launched = await entry.launching.catch(() => null);
      context = launched?.context || null;
    }
    if (!context) return;
    await Promise.race([
      context.close().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
    ]);
  }

  /** 删除主体浏览器登录态目录；backupDir 存在时先移动到备份目录而不是直接删除 */
  async function removeProfile(subjectId, { backupDir = null } = {}) {
    await close(subjectId).catch(() => undefined);
    const dir = profileDir(subjectId);
    if (!fs.existsSync(dir)) return { removed: true, backupPath: null };
    if (backupDir) {
      try {
        await ensureDir(backupDir);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const target = path.join(backupDir, `${subjectId}-${stamp}`);
        await fsp.rename(dir, target);
        return { removed: true, backupPath: target };
      } catch { /* 占用/跨盘时回退复制后删除 */ }
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const target = path.join(backupDir, `${subjectId}-copy-${stamp}`);
        await fsp.cp(dir, target, { recursive: true, force: true });
      } catch { /* 复制失败则直接删除 */ }
    }
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return { removed: true, backupPath: null };
  }

  async function closeAll() {
    clearInterval(idleTimer);
    await Promise.allSettled([...sessions.keys()].map((id) => close(id)));
  }

  function isOpen(subjectId) {
    return Boolean(sessions.get(subjectId)?.context);
  }

  /** 登录成功后，把临时 profile 目录迁移到已存在主体名下（覆盖旧会话） */
  async function adoptProfile(fromDir, targetId) {
    const target = profileDir(targetId);
    if (path.resolve(fromDir) === path.resolve(target)) return;
    await fsp.rm(target, { recursive: true, force: true }).catch(() => undefined);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    try {
      await fsp.rename(fromDir, target);
    } catch {
      await fsp.cp(fromDir, target, { recursive: true, force: true });
      await fsp.rm(fromDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  function profileExists(subjectId) {
    return fs.existsSync(profileDir(subjectId));
  }

  return {
    getSession,
    getPage,
    run,
    close,
    closeAll,
    isOpen,
    adoptProfile,
    removeProfile,
    profileExists,
    profileDir,
  };
}
