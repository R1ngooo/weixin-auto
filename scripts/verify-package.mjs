import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = { dir: null, zip: null, port: 3479 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--dir') args.dir = argv[++index];
    else if (argv[index] === '--zip') args.zip = argv[++index];
    else if (argv[index] === '--port') args.port = Number(argv[++index]);
  }
  return args;
}

async function findStaging() {
  const base = path.join(ROOT, 'dist', '.staging-weixin-auto');
  if (!fs.existsSync(base)) return null;
  const dirs = fs.readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('weixin-auto-'))
    .map((entry) => path.join(base, entry.name));
  return dirs[0] || null;
}

async function extractZip(zipPath, target) {
  await fsp.mkdir(target, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', zipPath, '-C', target], { windowsHide: true, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar 退出码 ${code}`))));
  });
  const dirs = fs.readdirSync(target, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (dirs.length === 1) return path.join(target, dirs[0].name);
  return target;
}

async function waitHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1000);
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
      clearTimeout(timer);
      if (response.ok) {
        const payload = await response.json();
        if (payload?.data?.name === 'weixin-auto') return payload.data;
      }
    } catch { /* continue */ }
    await sleep(500);
  }
  return null;
}

function killTree(pid) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGTERM');
    }
  } catch { /* ignore */ }
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'wxa-package-verify-'));
  let appDir = args.dir ? path.resolve(args.dir) : await findStaging();
  try {
    if (!appDir && args.zip) appDir = await extractZip(path.resolve(args.zip), path.join(tempRoot, 'extract'));
    if (!appDir || !fs.existsSync(path.join(appDir, 'runtime', 'node.exe'))) {
      throw new Error('找不到便携包 staging 目录；请先运行 npm run build:portable，或用 --dir/--zip 指定');
    }
    appDir = path.resolve(appDir);
    const versionMeta = JSON.parse(await fsp.readFile(path.join(appDir, 'version.json'), 'utf8'));
    const dataDir = path.join(tempRoot, 'data');
    const port = args.port;
    const nodeExe = path.join(appDir, 'runtime', 'node.exe');
    const logFile = path.join(tempRoot, 'app.log');
    const out = fs.openSync(logFile, 'w');
    const child = spawn(nodeExe, [path.join(appDir, 'launcher.mjs')], {
      cwd: appDir,
      env: {
        ...process.env,
        WXA_NO_OPEN: '1',
        WXA_PORT: String(port),
        WXA_DATA_DIR: dataDir,
        WXA_PACKAGED: '1',
        PLAYWRIGHT_BROWSERS_PATH: path.join(appDir, 'runtime', 'ms-playwright'),
      },
      stdio: ['ignore', out, out],
      windowsHide: true,
    });
    let exited = null;
    child.on('exit', (code) => { exited = code; });
    try {
      const health = await waitHealth(port, 90_000);
      if (!health) throw new Error('便携包启动后 90 秒内没有健康响应');
      if (health.version !== versionMeta.version) throw new Error(`health 版本 ${health.version} 与包内版本 ${versionMeta.version} 不一致`);
      const index = await fetch(`http://127.0.0.1:${port}/`).then((res) => res.text());
      if (!/视频号助手|weixin-auto/i.test(index)) throw new Error('首页内容异常');
      const updateStatus = await fetch(`http://127.0.0.1:${port}/api/update/status`).then((res) => res.json());
      if (!updateStatus?.data?.version) throw new Error('升级接口不可用');
      // 用便携包内 Node + Playwright 直接启动一次 Chromium
      const checkScript = path.join(appDir, '.verify-browser.mjs');
      await fsp.writeFile(checkScript, "import { chromium } from 'playwright-core';\nconst browser = await chromium.launch({ headless: true, channel: 'chromium' });\nawait browser.close();\nconsole.log('chromium-ok');\n", 'utf8');
      const browserResult = await new Promise((resolve, reject) => {
        const proc = spawn(nodeExe, [checkScript], {
          cwd: appDir,
          env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(appDir, 'runtime', 'ms-playwright') },
          windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (chunk) => { stdout += chunk; });
        proc.stderr.on('data', (chunk) => { stderr += chunk; });
        proc.on('error', reject);
        proc.on('exit', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr || `浏览器检查退出码 ${code}`))));
      });
      await fsp.rm(checkScript, { force: true });
      if (!browserResult.includes('chromium-ok')) throw new Error('内置 Chromium 启动检查失败');
      console.log(`[verify] 便携包通过：v${versionMeta.version} · Node/Chromium/升级接口/首页正常 · data=${dataDir}`);
    } finally {
      killTree(child.pid);
      fs.closeSync(out);
    }
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
})().catch((error) => {
  console.error('[verify] 失败：', error?.message || error);
  process.exit(1);
});
