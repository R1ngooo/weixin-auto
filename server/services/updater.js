import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { PATHS, ROOT_DIR } from '../config.js';
import { nowIso } from '../util.js';
import { getAppVersion } from '../version.js';

const PATCH_MAX_BYTES = 20 * 1024 * 1024;
const PATCH_APP = 'weixin-auto';
const ALLOWED_FILES = new Set(['version.json', 'start.cmd', 'launcher.mjs', 'README.md', '使用说明.md', '更新说明.md']);
const ALLOWED_PREFIXES = ['server/', 'web/'];

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((v) => Number.parseInt(v, 10) || 0);
  const pb = String(b || '0').split('.').map((v) => Number.parseInt(v, 10) || 0);
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const va = pa[index] || 0;
    const vb = pb[index] || 0;
    if (va !== vb) return va > vb ? 1 : -1;
  }
  return 0;
}

function isAllowedPath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) return false;
  if (normalized.split('/').some((part) => part === '..' || part === '' || part === '.')) return false;
  if (ALLOWED_FILES.has(normalized)) return true;
  return ALLOWED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function safeRelativePath(entryName) {
  const normalized = String(entryName || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!isAllowedPath(normalized)) throw new Error(`补丁包含非法路径：${entryName}`);
  return normalized;
}

function parseManifest(zip) {
  const entry = zip.getEntry('patch.json');
  if (!entry) throw new Error('补丁缺少 patch.json 清单');
  let manifest;
  try { manifest = JSON.parse(entry.getData().toString('utf8')); } catch { throw new Error('patch.json 格式不正确'); }
  if (manifest.app !== PATCH_APP) throw new Error('补丁不属于本应用');
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('补丁没有文件清单');
  if (!manifest.toVersion) throw new Error('补丁缺少目标版本');
  if (manifest.requiresFullPackage) throw new Error('该补丁涉及依赖/运行时变更，请使用完整便携包升级');
  return manifest;
}

export class UpdateService {
  constructor({ appRoot = ROOT_DIR, dataDir = PATHS.data, packaged = process.env.WXA_PACKAGED === '1' } = {}) {
    this.appRoot = appRoot;
    this.dataDir = dataDir;
    this.packaged = packaged;
    this.historyFile = path.join(dataDir, 'updates', 'history.json');
  }

  versionInfo() {
    // 允许测试/自定义 appRoot：优先读取目标根目录的 version.json
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(this.appRoot, 'version.json'), 'utf8'));
      if (meta?.version) return {
        version: String(meta.version),
        build: String(meta.build || 'dev'),
        builtAt: String(meta.builtAt || ''),
        channel: String(meta.channel || 'stable'),
        packaged: this.packaged,
      };
    } catch { /* 回退到当前进程版本 */ }
    return { ...getAppVersion(), packaged: this.packaged };
  }

  history() {
    try { return JSON.parse(fs.readFileSync(this.historyFile, 'utf8')); } catch { return []; }
  }

  status() {
    return {
      ...this.versionInfo(),
      packaged: this.packaged,
      appRoot: this.appRoot,
      dataDir: this.dataDir,
      history: this.history().slice(-20),
      releasesUrl: 'https://github.com/R1ngooo/weixin-auto/releases',
    };
  }

  async applyPatchBase64(dataBase64) {
    const raw = String(dataBase64 || '').trim();
    if (!raw) throw new Error('补丁内容为空');
    let buffer;
    try { buffer = Buffer.from(raw, 'base64'); } catch { throw new Error('补丁内容不是有效的 base64'); }
    return this.applyPatch(buffer);
  }

  async applyPatch(buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('补丁文件为空');
    if (buffer.length > PATCH_MAX_BYTES) throw new Error(`补丁包过大（${Math.round(buffer.length / 1024 / 1024)}MB，上限 20MB）`);
    let zip;
    try { zip = new AdmZip(buffer); } catch { throw new Error('不是有效的 zip 补丁包'); }
    const manifest = parseManifest(zip);
    const current = this.versionInfo();
    const fromVersions = Array.isArray(manifest.fromVersions) && manifest.fromVersions.length ? manifest.fromVersions.map(String) : [];
    if (fromVersions.length && !fromVersions.includes(current.version)) {
      throw new Error(`当前版本 ${current.version} 不适用该补丁（支持版本：${fromVersions.join('、')}）`);
    }
    if (compareVersions(manifest.toVersion, current.version) <= 0) {
      throw new Error(`补丁目标版本 ${manifest.toVersion} 不高于当前版本 ${current.version}，无需升级`);
    }
    // 校验清单与实际 zip 内文件一致
    const entries = new Map();
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const name = entry.entryName.replace(/\\/g, '/');
      if (name === 'patch.json') continue;
      entries.set(safeRelativePath(name), entry);
    }
    const touched = new Set();
    for (const file of manifest.files) {
      const relative = safeRelativePath(file.path);
      const entry = entries.get(relative);
      if (!entry) throw new Error(`补丁清单中的文件不存在：${relative}`);
      const data = entry.getData();
      if (file.size && data.length !== Number(file.size)) throw new Error(`文件大小校验失败：${relative}`);
      if (file.sha256 && sha256(data) !== String(file.sha256).toLowerCase()) throw new Error(`文件哈希校验失败：${relative}`);
      touched.add(relative);
      file.__data = data;
    }
    for (const del of manifest.deletes || []) {
      const relative = safeRelativePath(del);
      if (!touched.has(relative)) touched.add(relative);
    }
    // 目标版本必须与 version.json 一致
    const versionEntry = entries.get('version.json');
    if (!versionEntry) throw new Error('补丁必须包含 version.json');
    let targetVersionMeta;
    try { targetVersionMeta = JSON.parse(versionEntry.getData().toString('utf8')); } catch { throw new Error('补丁内 version.json 格式不正确'); }
    if (String(targetVersionMeta.version || '') !== String(manifest.toVersion)) {
      throw new Error('补丁内 version.json 与清单目标版本不一致');
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(this.dataDir, 'backups', 'updates', `${current.version}-to-${manifest.toVersion}-${stamp}`);
    await fsp.mkdir(backupDir, { recursive: true });
    const applied = [];
    const created = [];
    try {
      // 备份即将被覆盖/删除的文件
      for (const relative of touched) {
        const target = path.join(this.appRoot, relative);
        const exists = await fsp.access(target).then(() => true).catch(() => false);
        if (exists) {
          const backup = path.join(backupDir, relative);
          await fsp.mkdir(path.dirname(backup), { recursive: true });
          await fsp.copyFile(target, backup);
        }
      }
      // 写入新文件
      for (const file of manifest.files) {
        const relative = safeRelativePath(file.path);
        const target = path.join(this.appRoot, relative);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        const exists = await fsp.access(target).then(() => true).catch(() => false);
        const temp = `${target}.wxa-update-${crypto.randomBytes(4).toString('hex')}.tmp`;
        await fsp.writeFile(temp, file.__data);
        await fsp.rename(temp, target);
        if (!exists) created.push(relative);
        applied.push(relative);
      }
      for (const relative of manifest.deletes || []) {
        const target = path.join(this.appRoot, safeRelativePath(relative));
        await fsp.rm(target, { force: true, recursive: false }).catch(() => undefined);
        applied.push(relative);
      }
      // 写更新历史
      const history = this.history();
      history.push({
        at: nowIso(),
        fromVersion: current.version,
        toVersion: manifest.toVersion,
        backupDir,
        files: applied.length,
      });
      await fsp.mkdir(path.dirname(this.historyFile), { recursive: true });
      await fsp.writeFile(this.historyFile, JSON.stringify(history.slice(-100), null, 2), 'utf8');
      const cleanManifest = {
        ...manifest,
        files: (manifest.files || []).map((file) => ({ path: file.path, sha256: file.sha256, size: file.size })),
      };
      await fsp.writeFile(path.join(backupDir, 'patch.json'), JSON.stringify(cleanManifest, null, 2), 'utf8');
    } catch (error) {
      // 回滚：恢复备份，删除本次新建的文件
      for (const relative of created) {
        await fsp.rm(path.join(this.appRoot, relative), { force: true }).catch(() => undefined);
      }
      for (const relative of touched) {
        const backup = path.join(backupDir, relative);
        const target = path.join(this.appRoot, relative);
        if (await fsp.access(backup).then(() => true).catch(() => false)) {
          await fsp.mkdir(path.dirname(target), { recursive: true }).catch(() => undefined);
          await fsp.copyFile(backup, target).catch(() => undefined);
        }
      }
      throw new Error(`补丁应用失败，已回滚：${error?.message || error}`);
    }
    return {
      applied: true,
      fromVersion: current.version,
      toVersion: manifest.toVersion,
      files: applied.length,
      backupDir,
      restartRequired: true,
      packaged: this.packaged,
    };
  }
}

export function createUpdateService(options = {}) {
  return new UpdateService(options);
}
