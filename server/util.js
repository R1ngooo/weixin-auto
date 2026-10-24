import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const nowIso = () => new Date().toISOString();

export function uid(prefix = '') {
  return `${prefix}${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function md5File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

export function safeParseJson(raw, fallback = null) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function deepMerge(base, extra) {
  if (extra === undefined || extra === null) return structuredClone(base);
  if (Array.isArray(base) || Array.isArray(extra)) return extra;
  if (typeof base !== 'object' || typeof extra !== 'object') return extra;
  const out = { ...base };
  for (const key of Object.keys(extra)) out[key] = deepMerge(base[key], extra[key]);
  return out;
}

export function toInt(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function nowMs() {
  return Date.now();
}

export function truncate(value, max = 80) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** 简易异步互斥锁，用于同一主体的浏览器操作串行化 */
export class Mutex {
  #tail = Promise.resolve();

  run(fn) {
    const next = this.#tail.then(fn, fn);
    this.#tail = next.then(() => undefined, () => undefined);
    return next;
  }
}

export class MutexMap {
  #map = new Map();

  run(key, fn) {
    let mutex = this.#map.get(key);
    if (!mutex) {
      mutex = new Mutex();
      this.#map.set(key, mutex);
    }
    return mutex.run(fn);
  }
}

export function fmtBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

export function normalizeTagsInput(input) {
  if (Array.isArray(input)) return [...new Set(input.map((v) => toInt(v)).filter((v) => v > 0))];
  if (typeof input === 'string' && input.trim()) {
    return [...new Set(input.split(/[,，\s]+/).map((v) => toInt(v)).filter((v) => v > 0))];
  }
  return [];
}

export function formatDateTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function isPathInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
