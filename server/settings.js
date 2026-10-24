import { DEFAULT_SETTINGS } from './config.js';
import { getDb } from './db.js';
import { mergeSelectors } from './selectors.js';
import { deepMerge } from './util.js';

let cache = null;
let cacheSelectors = null;

export function getSettings() {
  if (!cache) {
    const stored = getDb().getSetting('app', {});
    cache = deepMerge(DEFAULT_SETTINGS, stored || {});
  }
  return cache;
}

export function getSelectors() {
  if (!cacheSelectors) {
    cacheSelectors = mergeSelectors(getSettings().selectors || {});
  }
  return cacheSelectors;
}

export function updateSettings(patch) {
  const current = getSettings();
  const next = deepMerge(current, patch || {});
  getDb().setSetting('app', next);
  cache = next;
  cacheSelectors = null;
  return next;
}

export function replaceSettings(next) {
  getDb().setSetting('app', next || {});
  cache = null;
  cacheSelectors = null;
  return getSettings();
}

export function resetSettings() {
  getDb().run('DELETE FROM settings WHERE key = ?', 'app');
  cache = null;
  cacheSelectors = null;
  return getSettings();
}

/** 供导出使用：只导出用户可迁移的配置（不含数据库与浏览器目录） */
export function exportableSettings() {
  const settings = getSettings();
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
  };
}
