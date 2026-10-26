import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const RUNTIME_NODE = path.join(ROOT, 'runtime', 'node.exe');
const PACKAGED = fs.existsSync(RUNTIME_NODE) || process.env.WXA_PACKAGED === '1';
const DEFAULT_PORT = Number(process.env.WXA_PORT || 3210);
const OPEN_BROWSER = process.env.WXA_NO_OPEN !== '1';

function packagedEnv() {
  const env = { ...process.env, WXA_PACKAGED: PACKAGED ? '1' : '0' };
  const browserRoot = path.join(ROOT, 'runtime', 'ms-playwright');
  if (fs.existsSync(browserRoot)) env.PLAYWRIGHT_BROWSERS_PATH = browserRoot;
  return env;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1200);
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
      clearTimeout(timer);
      if (response.ok) {
        const payload = await response.json();
        if (payload?.data?.name === 'weixin-auto') return payload.data;
      }
    } catch { /* 继续等待 */ }
    await sleep(500);
  }
  return null;
}

function openBrowser(port) {
  if (!OPEN_BROWSER) return;
  const url = `http://127.0.0.1:${port}`;
  try {
    const child = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Process '${url}'`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch { /* 打不开浏览器不影响服务 */ }
}

let restarted = false;
let child = null;

function startServer() {
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: packagedEnv(),
    stdio: 'inherit',
    windowsHide: false,
  });
  child.on('error', (error) => {
    console.error('[launcher] 启动服务失败：', error);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (code === 75) {
      restarted = true;
      console.log('\n[launcher] 补丁已应用，正在自动重启…\n');
      setTimeout(startServer, 800);
      return;
    }
    process.exit(Number.isFinite(code) ? code : (signal ? 1 : 0));
  });
}

(async () => {
  await fspEnsureDataDir();
  startServer();
  if (!restarted) {
    const health = await waitForServer(DEFAULT_PORT);
    if (health) {
      console.log(`[launcher] 面板地址：http://127.0.0.1:${DEFAULT_PORT}  版本：${health.version || '-'}`);
      openBrowser(DEFAULT_PORT);
    } else {
      console.warn('[launcher] 未在 30 秒内检测到服务就绪，请手动打开 http://127.0.0.1:' + DEFAULT_PORT);
    }
  }
})();

async function fspEnsureDataDir() {
  try {
    const dataDir = process.env.WXA_DATA_DIR || path.join(ROOT, 'data');
    await import('node:fs/promises').then((fsp) => fsp.mkdir(dataDir, { recursive: true }));
  } catch { /* 服务启动时会再创建 */ }
}
