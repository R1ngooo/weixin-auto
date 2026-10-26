import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 读取 version.json（打包时由构建脚本写入 build/builtAt），缺失时回退 package.json */
export function getAppVersion() {
  const versionFile = path.join(ROOT_DIR, 'version.json');
  const pkg = readJson(path.join(ROOT_DIR, 'package.json')) || {};
  const meta = readJson(versionFile) || {};
  return {
    version: String(meta.version || pkg.version || '0.0.0'),
    build: String(meta.build || 'dev'),
    builtAt: String(meta.builtAt || ''),
    channel: String(meta.channel || 'stable'),
    packaged: process.env.WXA_PACKAGED === '1',
  };
}

export { ROOT_DIR };
