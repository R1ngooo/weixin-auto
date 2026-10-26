import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const APP_NAME = 'weixin-auto';
const APP_FILES = ['launcher.mjs', 'start.cmd', 'version.json', 'package.json', 'package-lock.json', 'README.md'];
const APP_DIRS = ['server', 'web'];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true, ...options });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`))));
  });
}

async function copyDir(source, target, { skip = [], skipFile = () => false } = {}) {
  await fsp.mkdir(target, { recursive: true });
  for (const entry of await fsp.readdir(source, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue;
    if (entry.isFile() && skipFile(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) await copyDir(from, to, { skip, skipFile });
    else if (entry.isFile()) await fsp.copyFile(from, to);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function sha256(file) {
  const crypto = await import('node:crypto');
  return crypto.createHash('sha256').update(await fsp.readFile(file)).digest('hex');
}

function findChromiumDir() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) candidates.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'ms-playwright'));
  candidates.push(path.join(os.homedir(), '.cache', 'ms-playwright'));
  for (const root of candidates) {
    if (!root || !fs.existsSync(root)) continue;
    const dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
      .map((entry) => path.join(root, entry.name));
    if (dirs.length) {
      dirs.sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()));
      return { root, dir: dirs[0], name: path.basename(dirs[0]) };
    }
  }
  return null;
}

async function main() {
  const packageJson = readJson(path.join(ROOT, 'package.json'));
  const version = String(packageJson.version || '0.0.0');
  const stagingRoot = path.join(DIST, '.staging-weixin-auto');
  const stageDir = path.join(stagingRoot, `${APP_NAME}-${version}-win-x64`);
  const zipPath = path.join(DIST, `${APP_NAME}-${version}-win-x64.zip`);

  console.log(`[build] version=${version}`);
  await fsp.rm(stagingRoot, { recursive: true, force: true });
  await fsp.rm(zipPath, { force: true });
  await fsp.mkdir(stageDir, { recursive: true });

  for (const file of APP_FILES) {
    if (!fs.existsSync(path.join(ROOT, file))) continue;
    await fsp.copyFile(path.join(ROOT, file), path.join(stageDir, file));
  }
  for (const dir of APP_DIRS) await copyDir(path.join(ROOT, dir), path.join(stageDir, dir));

  // 生产依赖：优先在 staging 内 npm ci --omit=dev；失败时回退复制当前 node_modules
  console.log('[build] 安装生产依赖…');
  try {
    await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: stageDir, shell: process.platform === 'win32' });
  } catch (error) {
    console.warn('[build] npm ci 失败，回退复制本机 node_modules：', error.message);
    await copyDir(path.join(ROOT, 'node_modules'), path.join(stageDir, 'node_modules'), { skip: ['.cache'] });
  }

  // 内置 Node 运行时
  const runtimeDir = path.join(stageDir, 'runtime');
  await fsp.mkdir(runtimeDir, { recursive: true });
  const nodeExe = process.platform === 'win32' ? process.execPath : process.execPath;
  await fsp.copyFile(nodeExe, path.join(runtimeDir, 'node.exe'));
  console.log(`[build] 已内置 Node：${path.basename(nodeExe)} (${Math.round(fs.statSync(nodeExe).size / 1024 / 1024)}MB)`);

  // 内置 Playwright Chromium
  const chromium = findChromiumDir();
  if (!chromium) throw new Error('未找到 Playwright Chromium 缓存，请先运行 npx playwright install chromium');
  console.log(`[build] 复制 Chromium：${chromium.name}`);
  // 缓存目录可能残留 Playwright 下载的安装包/安装器，不应进入便携包
  await copyDir(chromium.dir, path.join(runtimeDir, 'ms-playwright', chromium.name), {
    skipFile: (name) => /\.zip$/i.test(name) || /^setup\.exe$/i.test(name),
  });

  // 写入构建版本
  const versionMeta = {
    version,
    build: (await runGit(['rev-parse', '--short', 'HEAD'])).trim(),
    builtAt: new Date().toISOString(),
    channel: 'stable',
  };
  await fsp.writeFile(path.join(stageDir, 'version.json'), JSON.stringify(versionMeta, null, 2), 'utf8');

  // 生成 zip
  await fsp.mkdir(DIST, { recursive: true });
  console.log(`[build] 打包 ${path.basename(zipPath)}…`);
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(stageDir, path.basename(stageDir));
    archive.finalize();
  });
  const hash = await sha256(zipPath);
  await fsp.writeFile(path.join(DIST, `${path.basename(zipPath)}.sha256`), `${hash}  ${path.basename(zipPath)}\n`, 'utf8');
  const sizeMb = Math.round(fs.statSync(zipPath).size / 1024 / 1024);
  console.log(`[build] 完成：${zipPath} (${sizeMb}MB) sha256=${hash.slice(0, 16)}…`);
  console.log(`[build] staging：${stageDir}`);
}

function runGit(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: ROOT, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(out || err))));
  });
}

main().catch((error) => {
  console.error('[build] 失败：', error?.message || error);
  process.exit(1);
});
