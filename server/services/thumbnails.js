import fsp from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { PATHS } from '../config.js';
import { getDb } from '../db.js';
import { ensureDir, nowIso } from '../util.js';

const THUMB_WIDTH = 720;
// 顺序很重要：Playwright 内置 Chromium 支持 H.264 与 HEVC(H.265) 软解，
// 而本机 Edge/Chrome 缺少 HEVC 解码器时只能得到 0x0 画面。先试 Chromium，失败再回退本机浏览器。
const BROWSER_CANDIDATES = [
  { label: 'chromium', options: { channel: 'chromium' } },
  { label: 'chrome', options: { channel: 'chrome' } },
  { label: 'msedge', options: { channel: 'msedge' } },
];

/**
 * 视频封面（缩略图）服务：
 * 用无头浏览器加载本地视频文件，seek 到中间附近的若干时间点，画到 canvas 上导出 JPEG。
 * 只读取本地文件，不上传、不修改原视频。
 */
export function createThumbnailService({ getSettings, jobs }) {
  const browsers = new Map();
  let preferredBrowser = null;
  let activeJobId = null;
  let closed = false;

  function thumbnailPath(video) {
    return path.join(PATHS.thumbnails, `${video.id}.jpg`);
  }

  function candidates() {
    const settings = getSettings()?.browser || {};
    const list = [];
    if (settings.executablePath) list.push({ label: 'custom', options: { executablePath: settings.executablePath } });
    list.push(...BROWSER_CANDIDATES);
    if (preferredBrowser) {
      list.sort((a, b) => (b.label === preferredBrowser ? 1 : 0) - (a.label === preferredBrowser ? 1 : 0));
    }
    return list;
  }

  async function browserFor(candidate) {
    if (closed) throw new Error('封面服务已关闭');
    const existing = browsers.get(candidate.label);
    if (existing) return existing.promise;
    const promise = chromium.launch({
      headless: true,
      args: ['--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required', '--no-first-run'],
      ...candidate.options,
    }).catch((error) => {
      browsers.delete(candidate.label);
      throw error;
    });
    browsers.set(candidate.label, { promise });
    return promise;
  }

  async function closeBrowsers() {
    const pending = [...browsers.values()];
    browsers.clear();
    for (const entry of pending) {
      try {
        const browser = await entry.promise.catch(() => null);
        await browser?.close();
      } catch { /* ignore */ }
    }
  }

  let idleTimer = null;
  function scheduleIdleClose() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!activeJobId) closeBrowsers().catch(() => undefined);
    }, 120_000);
    idleTimer.unref?.();
  }

  function fileUrl(filePath) {
    const normalized = path.resolve(filePath).replace(/\\/g, '/');
    return `file:///${encodeURI(normalized).replace(/^file:\/\/\//, '')}`;
  }

  function isFresh(video) {
    if (!video.thumb_path) return false;
    // 原视频更新过（mtime 变化）则视为过期；thumb_updated_at 记录生成时视频的 mtime
    const thumbMtime = Number(video.thumb_updated_at);
    if (Number.isFinite(thumbMtime) && thumbMtime > 0 && Number(video.mtime_ms || 0) > thumbMtime) return false;
    return true;
  }

  async function fileExists(filePath) {
    return fsp.access(filePath).then(() => true).catch(() => false);
  }

  /** 快速判断文件是否像视频容器，避免把非视频/损坏文件丢给浏览器导致长时间等待 */
  async function looksLikeVideoFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    let handle;
    try {
      handle = await fsp.open(filePath, 'r');
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const head = buffer.subarray(0, bytesRead);
      if (['.mp4', '.m4v', '.mov'].includes(ext)) {
        // MP4/MOV: 前部应包含 ftyp box（允许少量 free/wide box 在前）
        return head.includes(Buffer.from('ftyp', 'ascii')) || head.includes(Buffer.from('moov', 'ascii')) || head.includes(Buffer.from('mdat', 'ascii'));
      }
      if (ext === '.mkv' || ext === '.webm') {
        // EBML 头 1A 45 DF A3
        return bytesRead >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
      }
      if (ext === '.avi') {
        return head.subarray(0, 4).toString('ascii') === 'RIFF';
      }
      return true;
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async function captureFrame(browser, video, timeSeconds) {
    const page = await browser.newPage({ viewport: { width: THUMB_WIDTH, height: Math.round(THUMB_WIDTH * 9 / 16) } });
    try {
      await page.goto(fileUrl(video.path), { waitUntil: 'domcontentloaded', timeout: 15_000 });
      const captured = await page.evaluate(async ({ seekTime, targetWidth }) => {
        const el = document.querySelector('video');
        if (!el) return { error: 'no-video-element' };
        await new Promise((resolve) => {
          if (el.readyState >= 2) return resolve();
          const done = () => resolve();
          el.addEventListener('loadeddata', done, { once: true });
          el.addEventListener('error', done, { once: true });
          setTimeout(done, 8000);
        });
        if (el.error) return { error: `video-error-${el.error.code}` };
        const duration = Number.isFinite(el.duration) ? el.duration : 0;
        const t = Math.max(0.2, Math.min(seekTime, duration > 1 ? duration - 0.5 : 0.2));
        await new Promise((resolve) => {
          const done = () => resolve();
          el.addEventListener('seeked', done, { once: true });
          el.addEventListener('error', done, { once: true });
          try { el.currentTime = t; } catch { done(); }
          setTimeout(done, 8000);
        });
        const vw = el.videoWidth || 0;
        const vh = el.videoHeight || 0;
        if (!vw || !vh) return { error: 'no-video-size' };
        const width = Math.max(2, Math.min(targetWidth, vw));
        const height = Math.round(width * vh / vw);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(el, 0, 0, width, height);
        // 计算平均亮度，太黑的帧跳过
        let brightness = 0;
        try {
          const data = ctx.getImageData(0, 0, width, height).data;
          let sum = 0;
          const step = Math.max(4, Math.floor(data.length / 4 / 4000)) * 4;
          let samples = 0;
          for (let i = 0; i < data.length; i += step) {
            sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
            samples += 1;
          }
          brightness = samples ? sum / samples : 0;
        } catch { brightness = 0; }
        return {
          dataUrl: canvas.toDataURL('image/jpeg', 0.82),
          width,
          height,
          brightness,
          seekTime: t,
          duration,
        };
      }, { seekTime: timeSeconds, targetWidth: THUMB_WIDTH });
      return captured;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async function captureBestFrame(browser, video) {
    const firstTimes = [2, 5, 8];
    let best = null;
    let duration = 0;
    for (const time of firstTimes) {
      let frame;
      try {
        frame = await captureFrame(browser, video, time);
      } catch (error) {
        frame = { error: String(error?.message || error) };
      }
      if (frame?.dataUrl) {
        if (!duration && Number(frame.duration) > 0) duration = Number(frame.duration);
        if (!best || (frame.brightness || 0) > (best.brightness || 0)) best = frame;
        if ((frame.brightness || 0) >= 28) break;
      } else if (frame?.error && /no-video-element|no-video-size|video-error/.test(frame.error)) {
        // 解码器根本无法识别该视频，继续换时间点没有意义，直接交给下一个浏览器内核
        return null;
      }
    }
    // 前几帧都偏暗时，再尝试视频中后段
    if (!best || (best.brightness || 0) < 28) {
      const laterTimes = duration > 4 ? [duration * 0.35, duration * 0.6, duration * 0.8] : [];
      for (const time of laterTimes) {
        let frame;
        try {
          frame = await captureFrame(browser, video, time);
        } catch {
          frame = null;
        }
        if (frame?.dataUrl && (!best || (frame.brightness || 0) > (best.brightness || 0))) best = frame;
        if ((best?.brightness || 0) >= 28) break;
      }
    }
    return best;
  }

  async function generateForVideo(video, { force = false } = {}) {
    if (!video || video.missing) throw new Error('视频文件不存在');
    const db = getDb();
    const target = thumbnailPath(video);
    if (!force && isFresh(video) && await fileExists(target)) {
      return { id: video.id, path: target, cached: true };
    }
    const exists = await fileExists(video.path);
    if (!exists) {
      db.run('UPDATE videos SET missing = 1, updated_at = ? WHERE id = ?', nowIso(), video.id);
      throw new Error('视频文件不存在');
    }
    if (!(await looksLikeVideoFile(video.path))) {
      throw new Error('文件不是可识别的视频容器（可能已损坏或不是视频文件）');
    }
    let best = null;
    let usedBrowser = '';
    const errors = [];
    for (const candidate of candidates()) {
      let browser;
      try {
        browser = await browserFor(candidate);
      } catch (error) {
        errors.push(`${candidate.label} 启动失败：${String(error?.message || error).split('\n')[0]}`);
        continue;
      }
      try {
        const frame = await captureBestFrame(browser, video);
        if (frame?.dataUrl) {
          best = frame;
          usedBrowser = candidate.label;
          preferredBrowser = candidate.label;
          break;
        }
        errors.push(`${candidate.label} 无法解码画面`);
      } catch (error) {
        errors.push(`${candidate.label}：${String(error?.message || error)}`);
      }
    }
    if (!best?.dataUrl) {
      throw new Error(`所有浏览器内核都无法截取画面（${errors.join('；')}）；若视频为 HEVC/H.265 编码，请确认已安装 Playwright Chromium（内置软解）`);
    }
    await ensureDir(PATHS.thumbnails);
    const buffer = Buffer.from(best.dataUrl.split(',')[1], 'base64');
    const tmp = `${target}.tmp`;
    await fsp.writeFile(tmp, buffer);
    await fsp.rename(tmp, target);
    db.run(
      'UPDATE videos SET thumb_path = ?, thumb_updated_at = ?, updated_at = ? WHERE id = ?',
      target,
      Number(video.mtime_ms || Date.now()),
      nowIso(),
      video.id,
    );
    return {
      id: video.id, path: target, width: best.width, height: best.height, size: buffer.length, cached: false, browser: usedBrowser,
    };
  }

  async function generateMany({ ids = null, force = false, signal, onProgress } = {}) {
    const db = getDb();
    const rows = ids?.length
      ? db.all(`SELECT * FROM videos WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)
      : db.all('SELECT * FROM videos WHERE missing = 0 ORDER BY id');
    const total = rows.length;
    let done = 0;
    let generated = 0;
    let skipped = 0;
    let failed = 0;
    const failures = [];
    for (const row of rows) {
      if (signal?.aborted || closed) throw new Error('已取消');
      try {
        const result = await generateForVideo(row, { force });
        if (result.cached) skipped += 1;
        else generated += 1;
      } catch (error) {
        failed += 1;
        if (failures.length < 10) failures.push({ id: row.id, name: row.name, error: String(error?.message || error) });
        onProgress?.(done / Math.max(1, total), `生成失败：${row.name}（${String(error?.message || error).slice(0, 40)}）`);
      }
      done += 1;
      onProgress?.(done / Math.max(1, total), `已处理 ${done}/${total}（新生成 ${generated}，跳过 ${skipped}，失败 ${failed}）`);
    }
    return { total, generated, skipped, failed, failures };
  }

  function startJob({ ids = null, force = false } = {}) {
    if (!jobs) throw new Error('任务系统不可用');
    // 同一时间只跑一个封面生成任务，重复触发时复用当前任务
    if (activeJobId) {
      const running = jobs.get(activeJobId);
      if (running && running.status === 'running') return { id: activeJobId, reused: true };
      activeJobId = null;
    }
    const job = jobs.start('生成视频封面', async (ctx) => {
      ctx.setMessage('准备生成视频封面…');
      const result = await generateMany({
        ids,
        force,
        signal: ctx.signal,
        onProgress: (progress, message) => ctx.progress(progress, message),
      });
      ctx.setResult(result);
      ctx.setMessage(`完成：新生成 ${result.generated}，跳过 ${result.skipped}，失败 ${result.failed}`);
      return result;
    }, {
      onDone: () => {
        if (activeJobId === job?.id) activeJobId = null;
        scheduleIdleClose();
      },
    });
    activeJobId = job.id;
    return job;
  }

  function status() {
    const db = getDb();
    const row = db.get('SELECT COUNT(*) AS total, SUM(CASE WHEN thumb_path IS NOT NULL THEN 1 ELSE 0 END) AS ready FROM videos WHERE removed = 0');
    return {
      total: Number(row?.total || 0),
      ready: Number(row?.ready ?? 0),
      activeJobId,
      browser: browsers.size ? [...browsers.keys()].join(',') : 'idle',
      preferredBrowser,
      dir: PATHS.thumbnails,
    };
  }

  async function close() {
    closed = true;
    clearTimeout(idleTimer);
    idleTimer = null;
    await closeBrowsers();
  }

  return { generateForVideo, generateMany, startJob, status, close, thumbnailPath, fileUrl };
}
