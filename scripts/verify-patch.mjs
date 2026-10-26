import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { UpdateService } = await import(new URL('../server/services/updater.js', import.meta.url));

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

(async () => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'wxa-patch-test-'));
  const appRoot = path.join(temp, 'app');
  const dataDir = path.join(temp, 'data');
  await fsp.mkdir(path.join(appRoot, 'web'), { recursive: true });
  await fsp.mkdir(path.join(appRoot, 'server'), { recursive: true });
  await fsp.writeFile(path.join(appRoot, 'version.json'), JSON.stringify({ version: '0.2.0', build: 'test' }), 'utf8');
  await fsp.writeFile(path.join(appRoot, 'web', 'app.js'), 'old-web', 'utf8');
  await fsp.writeFile(path.join(appRoot, 'web', 'old.js'), 'delete-me', 'utf8');
  await fsp.writeFile(path.join(appRoot, 'server', 'old.js'), 'delete-server', 'utf8');

  const service = new UpdateService({ appRoot, dataDir, packaged: true });
  const buildPatch = ({ toVersion = '0.2.1', hashOverride = null, traversal = false, requiresFullPackage = false, fromVersions = ['0.2.0'] } = {}) => {
    const zip = new AdmZip();
    const web = Buffer.from('new-web', 'utf8');
    const version = Buffer.from(JSON.stringify({ version: toVersion, build: 'test' }, null, 2), 'utf8');
    const files = [
      { path: 'web/app.js', data: web, sha256: sha256(web), size: web.length },
      { path: 'version.json', data: version, sha256: sha256(version), size: version.length },
    ];
    if (traversal) files.push({ path: '../evil.txt', data: Buffer.from('evil'), sha256: sha256(Buffer.from('evil')), size: 4 });
    const manifest = {
      app: 'weixin-auto',
      format: 1,
      fromVersions,
      toVersion,
      requiresFullPackage,
      files: files.map((file) => ({ path: file.path, sha256: file.sha256, size: file.size })),
      deletes: ['web/old.js'],
    };
    zip.addFile('patch.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    for (const file of files) {
      let data = file.data;
      zip.addFile(file.path, data);
      if (hashOverride && file.path === 'web/app.js') manifest.files.find((item) => item.path === 'web/app.js').sha256 = hashOverride;
    }
    // 重新写入被哈希覆盖后的 manifest
    zip.deleteFile('patch.json');
    zip.addFile('patch.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    return zip.toBuffer();
  };

  const results = [];
  const check = (name, condition, detail = '') => {
    if (!condition) throw new Error(`${name}${detail ? `：${detail}` : ''}`);
    results.push(name);
  };

  try {
    const result = await service.applyPatch(buildPatch());
    check('补丁应用成功', result.applied && result.toVersion === '0.2.1');
    check('文件已更新', await fsp.readFile(path.join(appRoot, 'web', 'app.js'), 'utf8') === 'new-web');
    check('version.json 已更新', JSON.parse(await fsp.readFile(path.join(appRoot, 'version.json'), 'utf8')).version === '0.2.1');
    check('deletes 已删除', !fs.existsSync(path.join(appRoot, 'web', 'old.js')));
    check('旧文件已备份', fs.existsSync(path.join(result.backupDir, 'web', 'app.js')));
    check('更新历史已记录', service.history().length === 1);

    let hashError = '';
    try { await service.applyPatch(buildPatch({ toVersion: '0.2.2', hashOverride: 'deadbeef', fromVersions: ['0.2.1'] })); } catch (error) { hashError = error.message; }
    check('哈希错误被拒绝', /哈希校验失败/.test(hashError));

    let traversalError = '';
    try { await service.applyPatch(buildPatch({ toVersion: '0.2.3', traversal: true, fromVersions: ['0.2.1'] })); } catch (error) { traversalError = error.message; }
    check('路径穿越被拒绝', /非法路径/.test(traversalError));

    let depError = '';
    try { await service.applyPatch(buildPatch({ toVersion: '0.2.4', requiresFullPackage: true, fromVersions: ['0.2.1'] })); } catch (error) { depError = error.message; }
    check('依赖变更要求完整包', /完整便携包/.test(depError));

    console.log('补丁升级自检通过：');
    for (const name of results) console.log('  PASS ', name);
  } finally {
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
})().catch((error) => {
  console.error('补丁升级自检失败：', error?.message || error);
  process.exit(1);
});
