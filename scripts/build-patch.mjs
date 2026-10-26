import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'patches');
const ALLOWED_FILES = new Set(['version.json', 'start.cmd', 'launcher.mjs', 'README.md', '使用说明.md', '更新说明.md']);
const ALLOWED_PREFIXES = ['server/', 'web/'];

function parseArgs(argv) {
  const args = { from: 'HEAD~1', to: 'HEAD' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--from') args.from = argv[++index];
    else if (argv[index] === '--to') args.to = argv[++index];
  }
  return args;
}

function runGitText(args) {
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

function runGitBuffer(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: ROOT, windowsHide: true });
    const chunks = [];
    let err = '';
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(err || `git 退出码 ${code}`))));
  });
}

function allowed(relative) {
  if (ALLOWED_FILES.has(relative)) return true;
  return ALLOWED_PREFIXES.some((prefix) => relative.startsWith(prefix));
}

async function readVersion(ref) {
  try {
    const meta = JSON.parse((await runGitBuffer(['show', `${ref}:version.json`])).toString('utf8'));
    return String(meta.version || '');
  } catch {
    try {
      const pkg = JSON.parse((await runGitBuffer(['show', `${ref}:package.json`])).toString('utf8'));
      return String(pkg.version || '');
    } catch { return ''; }
  }
}

async function main() {
  const { from, to } = parseArgs(process.argv.slice(2));
  const fromVersion = await readVersion(from);
  const toVersion = await readVersion(to);
  if (!fromVersion || !toVersion) throw new Error('无法读取 from/to 的版本号');
  if (fromVersion === toVersion) throw new Error(`from/to 版本相同（${fromVersion}），请先升版本号`);
  console.log(`[patch] ${from} (v${fromVersion}) -> ${to} (v${toVersion})`);

  const diff = await runGitText(['diff', '--name-status', '-M', from, to]);
  const changed = [];
  const deleted = [];
  for (const line of diff.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0];
    if (status.startsWith('R')) {
      const oldPath = parts[1];
      const newPath = parts[2];
      if (oldPath) deleted.push(oldPath);
      if (newPath) changed.push(newPath);
      continue;
    }
    const filePath = parts[1];
    if (!filePath) continue;
    if (status === 'D') deleted.push(filePath);
    else changed.push(filePath);
  }

  const dependencyChanged = await (async () => {
    try {
      const fromPkg = JSON.parse((await runGitBuffer(['show', `${from}:package.json`])).toString('utf8'));
      const toPkg = JSON.parse((await runGitBuffer(['show', `${to}:package.json`])).toString('utf8'));
      const pick = (pkg) => JSON.stringify({ dependencies: pkg.dependencies || {}, devDependencies: pkg.devDependencies || {}, engines: pkg.engines || {} });
      return pick(fromPkg) !== pick(toPkg);
    } catch {
      return changed.concat(deleted).some((file) => file === 'package.json' || file === 'package-lock.json');
    }
  })();
  if (dependencyChanged) throw new Error('依赖/Node 引擎发生变化：请发布完整便携包，补丁只支持源码级升级');

  const files = [];
  for (const file of [...new Set(changed)]) {
    if (!allowed(file)) {
      console.warn(`[patch] 跳过非应用文件：${file}`);
      continue;
    }
    const data = await runGitBuffer(['show', `${to}:${file}`]);
    files.push({ path: file, sha256: crypto.createHash('sha256').update(data).digest('hex'), size: data.length, data });
  }
  const deletes = [...new Set(deleted)].filter((file) => allowed(file));
  if (!files.some((file) => file.path === 'version.json')) {
    const data = await runGitBuffer(['show', `${to}:version.json`]);
    files.push({ path: 'version.json', sha256: crypto.createHash('sha256').update(data).digest('hex'), size: data.length, data });
  }
  if (!files.length && !deletes.length) throw new Error('该区间没有可打包的应用文件变更');
  const manifest = {
    app: 'weixin-auto',
    format: 1,
    fromVersions: [fromVersion],
    toVersion,
    createdAt: new Date().toISOString(),
    requiresFullPackage: false,
    files: files.map(({ path: filePath, sha256, size }) => ({ path: filePath, sha256, size })),
    deletes,
  };
  const zip = new AdmZip();
  zip.addFile('patch.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  for (const file of files) zip.addFile(file.path.replace(/\\/g, '/'), file.data);
  await fsp.mkdir(DIST, { recursive: true });
  const out = path.join(DIST, `weixin-auto-patch-${fromVersion}-to-${toVersion}.zip`);
  zip.writeZip(out);
  const hash = crypto.createHash('sha256').update(await fsp.readFile(out)).digest('hex');
  await fsp.writeFile(`${out}.sha256`, `${hash}  ${path.basename(out)}\n`, 'utf8');
  console.log(`[patch] 完成：${out}（${files.length} 个文件，删除 ${deletes.length} 个）`);
  console.log(`[patch] sha256=${hash.slice(0, 16)}…`);
}

main().catch((error) => {
  console.error('[patch] 失败：', error?.message || error);
  process.exit(1);
});
