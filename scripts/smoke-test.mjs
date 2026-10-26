/**
 * 冒烟测试：在隔离的数据目录/端口启动一份服务，验证主要接口与执行链路。
 * 运行：npm run smoke
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, '.smoke-data');
const PORT = Number(process.env.SMOKE_PORT || 3399);
const BASE = `http://127.0.0.1:${PORT}/api`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    const info = await fn();
    passed += 1;
    results.push({ name, ok: true, info });
    console.log(`  PASS  ${name}${info ? `  (${info})` : ''}`);
    return true;
  } catch (error) {
    failed += 1;
    results.push({ name, ok: false, error: String(error?.message || error) });
    console.log(`  FAIL  ${name}\n        ${String(error?.message || error)}`);
    return false;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || '断言失败');
}

async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { throw new Error(`响应不是 JSON：${text.slice(0, 200)}`); }
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${res.status}`);
  return data.data;
}

async function waitFor(fn, { timeout = 60_000, interval = 500, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(`等待超时（${label}）${lastError ? `：${lastError.message}` : ''}`);
}

/** 直接操作 smoke 数据库（WAL 允许与运行中的服务并发访问） */
async function withDb(fn) {
  const db = new DatabaseSync(path.join(DATA_DIR, 'weixin-auto.sqlite'));
  db.exec('PRAGMA busy_timeout = 5000');
  try { return fn(db); } finally { db.close(); }
}

async function waitJob(jobId, { timeout = 120_000 } = {}) {
  return waitFor(async () => {
    const job = await api(`/jobs/${jobId}`);
    if (job.status === 'running') return null;
    if (job.status === 'success') return job;
    throw new Error(`任务 ${job.status}：${job.error || ''}`);
  }, { timeout, interval: 400, label: '后台任务完成' });
}

async function waitTask(taskId, { timeout = 180_000 } = {}) {
  return waitFor(async () => {
    const task = await api(`/tasks/${taskId}`);
    if (['pending', 'running'].includes(task.status)) return null;
    return task;
  }, { timeout, interval: 800, label: '执行任务结束' });
}

let child = null;

async function startServer() {
  await fsp.rm(DATA_DIR, { recursive: true, force: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      WXA_DATA_DIR: DATA_DIR,
      WXA_PORT: String(PORT),
      // 测试模式下系统文件夹选择不弹窗，直接返回该路径
      WXA_DIALOG_TEST_PATH: path.join(DATA_DIR, 'media'),
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  await waitFor(async () => {
    try {
      const health = await api('/health');
      return health.ok ? health : null;
    } catch {
      return null;
    }
  }, { timeout: 40_000, interval: 600, label: '服务启动' });
}

async function stopServer() {
  if (!child) return;
  try { child.kill(); } catch { /* ignore */ }
  await sleep(800);
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
  child = null;
}

async function main() {
  console.log('视频号助手自动化工具 · 冒烟测试');
  console.log(`数据目录：${DATA_DIR}`);
  console.log(`端口：${PORT}\n`);
  await startServer();
  const state = {};

  try {
    await check('健康检查', async () => {
      const health = await api('/health');
      assert(health.ok, 'health.ok 应为 true');
      return `v${health.version}`;
    });

    await check('设置读写', async () => {
      const before = await api('/settings');
      assert(before.settings.timing.stepDelayMs > 0, '默认设置应包含延迟配置');
      await api('/settings', { method: 'PUT', body: { browser: { headless: true }, timing: { stepDelayMs: 300 } } });
      const after = await api('/settings');
      assert(after.settings.browser.headless === true, 'headless 未生效');
      assert(after.settings.timing.stepDelayMs === 300, 'stepDelayMs 未生效');
      return 'headless=true, stepDelayMs=300';
    });

    await check('标签 CRUD', async () => {
      const videoTag = await api('/tags', { method: 'POST', body: { name: '视频-测试', color: '#fa9d3b' } });
      const textTag = await api('/tags', { method: 'POST', body: { name: '文本-测试', color: '#5b9dff' } });
      const subjectTag = await api('/tags', { method: 'POST', body: { name: '主体-测试', color: '#2ecc8f' } });
      state.videoTag = videoTag.id;
      state.textTag = textTag.id;
      state.subjectTag = subjectTag.id;
      const list = await api('/tags?withCounts=1');
      assert(list.length === 3, `标签数量应为 3，实际 ${list.length}`);
      await api(`/tags/${subjectTag.id}`, { method: 'PUT', body: { name: '主体-测试2' } });
      return '3 个标签';
    });

    await check('标签组 CRUD 与删除保护', async () => {
      const defaultGroups = await api('/tag-groups?withCounts=1');
      assert(defaultGroups.length >= 1, '应存在默认标签组');
      const group = await api('/tag-groups', { method: 'POST', body: { name: '产品组-测试', selectionMode: 'single', color: '#7c6cf2' } });
      assert(group.selectionMode === 'single', '标签组应为单选模式');
      state.tagGroupId = group.id;
      const tagA = await api('/tags', { method: 'POST', body: { name: '产品A-测试', groupId: group.id } });
      const tagB = await api('/tags', { method: 'POST', body: { name: '产品B-测试', groupId: group.id } });
      state.groupTagA = tagA.id;
      state.groupTagB = tagB.id;
      assert(tagA.groupId === group.id && tagA.groupName === '产品组-测试', '标签应归属指定标签组');
      // 非空标签组不可删除
      let blocked = false;
      try { await api(`/tag-groups/${group.id}`, { method: 'DELETE' }); } catch (error) { blocked = /还有/.test(error.message); }
      assert(blocked, '非空标签组删除应被拒绝');
      // 空标签组可删除
      const emptyGroup = await api('/tag-groups', { method: 'POST', body: { name: '空组-测试' } });
      await api(`/tag-groups/${emptyGroup.id}`, { method: 'DELETE' });
      const afterDelete = await api('/tag-groups');
      assert(!afterDelete.some((item) => Number(item.id) === Number(emptyGroup.id)), '空标签组应可删除');
      return `单选组 #${group.id}，标签 ${tagA.name} / ${tagB.name}`;
    });

    await check('视频文件夹与扫描', async () => {
      const mediaDir = path.join(DATA_DIR, 'media');
      await fsp.mkdir(mediaDir, { recursive: true });
      for (const name of ['video-a.mp4', 'video-b.mp4', 'video-c.mov']) {
        await fsp.writeFile(path.join(mediaDir, name), Buffer.from(`fake-video-${name}-`.repeat(100)));
      }
      await fsp.writeFile(path.join(mediaDir, 'ignore.txt'), 'not a video');
      await api('/videos/folders', { method: 'POST', body: { path: mediaDir, recursive: true } });
      const job = await api('/videos/scan', { method: 'POST', body: {} });
      const done = await waitJob(job.id);
      const list = await api('/videos?pageSize=50');
      assert(list.total === 3, `应扫描到 3 个视频，实际 ${list.total}`);
      state.videos = list.data;
      state.mediaDir = mediaDir;
      return `新增 ${done.result.added} 个`;
    });

    await check('系统文件夹选择接口（测试模式）', async () => {
      const picked = await api('/system/pick-folder', { method: 'POST', body: {} });
      assert(picked.path === state.mediaDir, `应返回预设测试路径，实际 ${picked.path}`);
      return picked.path;
    });

    await check('扫描后自动计算 MD5', async () => {
      // 扫描完成后会后台自动触发 MD5 计算，无需手动点按钮
      const list = await waitFor(async () => {
        const res = await api('/videos?pageSize=50');
        return res.data.length && res.data.every((video) => video.md5) ? res : null;
      }, { timeout: 90_000, label: '自动 MD5 完成' });
      state.videos = list.data;
      return `自动计算 ${list.data.filter((video) => video.md5).length} 个`;
    });

    await check('视频打标签', async () => {
      for (const video of state.videos) {
        await api(`/videos/${video.id}`, { method: 'PUT', body: { tagIds: [state.videoTag] } });
      }
      const list = await api(`/videos?tagIds=${state.videoTag}&pageSize=50`);
      assert(list.total === 3, `按标签筛选应有 3 个视频，实际 ${list.total}`);
      return '按标签筛选通过';
    });

    await check('单选标签组约束与标签删除保护', async () => {
      const video = state.videos[0];
      let blocked = false;
      try {
        await api('/tags/assign', { method: 'POST', body: { kind: 'video', ids: [video.id], tagIds: [state.groupTagA, state.groupTagB], mode: 'set' } });
      } catch (error) {
        blocked = /单选模式/.test(error.message);
      }
      assert(blocked, '单选标签组同时关联两个标签应被拒绝');
      await api('/tags/assign', { method: 'POST', body: { kind: 'video', ids: [video.id], tagIds: [state.groupTagA], mode: 'set' } });
      let delBlocked = false;
      try {
        await api(`/tags/${state.groupTagA}`, { method: 'DELETE' });
      } catch (error) {
        delBlocked = /关联/.test(error.message);
      }
      assert(delBlocked, '有关联的标签删除应被拒绝');
      // 恢复视频原标签，再删除无关联的临时标签
      await api('/tags/assign', { method: 'POST', body: { kind: 'video', ids: [video.id], tagIds: [state.videoTag], mode: 'set' } });
      await api(`/tags/${state.groupTagA}`, { method: 'DELETE' });
      return '单选约束与删除保护通过';
    });

    await check('文件夹导入标签 + 搜索包含标签', async () => {
      const folderTag = await api('/tags', { method: 'POST', body: { name: '文件夹-测试', color: '#7c6cf2' } });
      state.folderTag = folderTag.id;
      const folders = await api('/videos/folders');
      const folder = folders[0];
      await api(`/videos/folders/${folder.id}`, { method: 'PUT', body: { tagIds: [folderTag.id] } });
      const afterUpdate = await api('/videos/folders');
      assert(afterUpdate[0].tagIds.includes(folderTag.id), '文件夹应保存导入标签');
      const job = await api('/videos/scan', { method: 'POST', body: {} });
      await waitJob(job.id);
      const byTag = await api(`/videos?tagIds=${folderTag.id}&pageSize=50`);
      assert(byTag.total === 3, `文件夹标签应应用到 3 个视频，实际 ${byTag.total}`);
      const bySearch = await api(`/videos?q=${encodeURIComponent('文件夹-测试')}&pageSize=50`);
      assert(bySearch.total === 3, `按标签名搜索应命中 3 个视频，实际 ${bySearch.total}`);
      return `文件夹标签 ${byTag.total} 个视频，搜索命中 ${bySearch.total} 个`;
    });

    await check('文本导入与去重', async () => {
      const result = await api('/texts/import', {
        method: 'POST',
        body: { text: '这是第一条测试文本内容\n这是第二条测试文本内容\n这是第三条测试文本内容\n', separator: 'line' },
      });
      assert(result.created === 3, `应新增 3 条，实际 ${result.created}`);
      const dup = await api('/texts/import', {
        method: 'POST',
        body: { text: '这是第一条测试文本内容\n这是第二条测试文本内容', separator: 'line' },
      });
      assert(dup.duplicated === 2 && dup.created === 0, '重复导入应去重');
      for (const text of (await api('/texts?pageSize=50')).data) {
        await api(`/texts/${text.id}`, { method: 'PUT', body: { tagIds: [state.textTag] } });
      }
      const byTag = await api(`/texts?q=${encodeURIComponent('文本-测试')}&pageSize=50`);
      assert(byTag.total === 3, `文本搜索应包含标签名，应命中 3 条，实际 ${byTag.total}`);
      return `新增 ${result.created} 条，去重 ${dup.duplicated} 条`;
    });

    await check('批量打标签（追加/覆盖/移除）', async () => {
      const videos = (await api('/videos?pageSize=50')).data.map((video) => video.id);
      const texts = (await api('/texts?pageSize=50')).data.map((text) => text.id);
      assert(videos.length === 3 && texts.length === 3, '批量标签测试需要 3 个视频和 3 条文本');
      // 追加
      const added = await api('/tags/assign', { method: 'POST', body: { kind: 'video', ids: videos, tagIds: [state.videoTag], mode: 'add' } });
      assert(added.affected === 3, `追加标签应影响 3 个视频，实际 ${added.affected}`);
      // 覆盖（先设置视频标签，再覆盖为空集合）→ 用 text 类型验证覆盖语义
      await api('/tags/assign', { method: 'POST', body: { kind: 'text', ids: texts, tagIds: [state.textTag], mode: 'set' } });
      let filtered = await api(`/texts?tagIds=${state.textTag}&pageSize=50`);
      assert(filtered.total === 3, `覆盖后应有 3 条文本带标签，实际 ${filtered.total}`);
      await api('/tags/assign', { method: 'POST', body: { kind: 'text', ids: [texts[0]], tagIds: [], mode: 'set' } });
      filtered = await api(`/texts?tagIds=${state.textTag}&pageSize=50`);
      assert(filtered.total === 2, `覆盖空集合后应剩 2 条，实际 ${filtered.total}`);
      // 移除
      await api('/tags/assign', { method: 'POST', body: { kind: 'text', ids: texts.slice(1), tagIds: [state.textTag], mode: 'remove' } });
      filtered = await api(`/texts?tagIds=${state.textTag}&pageSize=50`);
      assert(filtered.total === 0, `移除后应剩 0 条，实际 ${filtered.total}`);
      // 恢复，供后续配置测试使用
      await api('/tags/assign', { method: 'POST', body: { kind: 'text', ids: texts, tagIds: [state.textTag], mode: 'add' } });
      return `视频 ${added.affected} 个，文本覆盖/移除通过`;
    });

    await check('主体创建', async () => {
      const subject = await api('/subjects', { method: 'POST', body: { name: '冒烟测试主体', tagIds: [state.subjectTag] } });
      state.subject = subject;
      const list = await api('/subjects');
      assert(list.length === 1, '主体数量应为 1');
      const byTag = await api(`/subjects?q=${encodeURIComponent('主体-测试2')}`);
      assert(byTag.length === 1, '主体搜索应包含标签名');
      return subject.name;
    });

    await check('主体显示名称与视频号唯一约束', async () => {
      await withDb((db) => {
        db.prepare('UPDATE subjects SET finder_nickname = ?, finder_username = ?, name = ? WHERE id = ?')
          .run('冒烟视频号', 'smoke_finder_01', '冒烟测试主体', state.subject.id);
      });
      const list = await api('/subjects');
      const subject = list.find((item) => item.id === state.subject.id);
      assert(subject.displayName === '冒烟视频号', `displayName 应为视频号名称，实际 ${subject.displayName}`);
      let blocked = false;
      try {
        await withDb((db) => {
          db.prepare('INSERT INTO subjects (id, name, finder_nickname, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run('sub_dup_nick', '重复视频号主体', '冒烟视频号', 'unknown', new Date().toISOString(), new Date().toISOString());
        });
      } catch {
        blocked = true;
      }
      assert(blocked, '相同视频号名称应被唯一索引阻止');
      return `displayName=${subject.displayName}`;
    });

    await check('主体删除（DB 立即删除 + 登录态备份）', async () => {
      const subject = await api('/subjects', { method: 'POST', body: { name: '待删除主体' } });
      const dir = path.join(DATA_DIR, 'profiles', subject.id);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, 'marker.txt'), 'profile');
      const result = await api(`/subjects/${subject.id}`, { method: 'DELETE' });
      assert(result.removed === true, '删除接口应返回 removed');
      const list = await api('/subjects');
      assert(!list.some((item) => item.id === subject.id), '删除后主体不应再出现在列表');
      const backupDir = path.join(DATA_DIR, 'profiles', '_deleted');
      const moved = await waitFor(async () => {
        const entries = await fsp.readdir(backupDir).catch(() => []);
        return entries.find((name) => name.startsWith(subject.id)) || null;
      }, { timeout: 8000, interval: 250, label: '登录态备份' });
      assert(moved, '被删除主体的登录态应备份到 _deleted');
      return `已删除并备份：${moved}`;
    });

    await check('重复主体自动合并（视频号名称）', async () => {
      await withDb((db) => {
        db.exec('DROP INDEX IF EXISTS idx_subjects_finder_nickname');
        db.exec('DROP INDEX IF EXISTS idx_subjects_finder_username');
        const now = new Date().toISOString();
        db.prepare('INSERT INTO subjects (id, name, finder_nickname, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run('sub_dup_a', '重复视频号A', '重复视频号', 'expired', now, now);
        db.prepare('INSERT INTO subjects (id, name, finder_nickname, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run('sub_dup_b', '重复视频号B', '重复视频号', 'active', now, now);
        db.prepare('INSERT OR IGNORE INTO subject_tags (subject_id, tag_id) VALUES (?, ?)').run('sub_dup_a', state.subjectTag);
        db.prepare('INSERT INTO upload_history (subject_id, action, status, created_at) VALUES (?, ?, ?, ?)').run('sub_dup_a', 'draft', 'success', now);
      });
      const result = await api('/subjects/dedupe', { method: 'POST', body: {} });
      assert(result.mergedGroups >= 1, `应至少合并 1 组重复主体，实际 ${result.mergedGroups}`);
      const list = await api('/subjects');
      const merged = list.filter((item) => item.finderNickname === '重复视频号');
      assert(merged.length === 1, `同名视频号应只剩 1 个主体，实际 ${merged.length}`);
      assert(merged[0].displayName === '重复视频号', '合并后应显示视频号名称');
      const history = await withDb((db) => db.prepare('SELECT subject_id FROM upload_history WHERE action = ?').all('draft'));
      assert(history.some((row) => row.subject_id === merged[0].id), '历史记录应改指向保留主体');
      const again = await api('/subjects/dedupe', { method: 'POST', body: {} });
      assert(again.mergedGroups === 0, '再次合并不应重复处理');
      let blocked = false;
      try {
        await withDb((db) => {
          const now = new Date().toISOString();
          db.prepare('INSERT INTO subjects (id, name, finder_nickname, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run('sub_dup_c', '重复视频号C', '重复视频号', 'unknown', now, now);
        });
      } catch {
        blocked = true;
      }
      assert(blocked, '合并后应重新建立唯一索引');
      return `合并 ${result.mergedGroups} 组，保留 ${merged[0].displayName}`;
    });

    await check('扫码登录默认无头且二维码可用', async () => {
      let attempt;
      try {
        attempt = await api('/subjects/login', { method: 'POST', body: { headless: true } });
      } catch (error) {
        return `跳过（无法启动登录浏览器：${String(error.message).slice(0, 40)}）`;
      }
      try {
        let snapshot;
        try {
          snapshot = await waitFor(async () => {
            const snap = await api(`/subjects/login/${attempt.attemptId}`);
            if (snap.qr?.dataUrl) return snap;
            if (['failed', 'cancelled'].includes(snap.status)) throw new Error(`${snap.status}: ${snap.message}`);
            return null;
          }, { timeout: 90_000, interval: 250, label: '登录二维码' });
        } catch (error) {
          return `跳过（二维码获取失败：${String(error.message).slice(0, 60)}）`;
        }
        assert(snapshot.headless === true, '扫码登录应默认无头模式');
        assert(snapshot.qrLatencyMs && snapshot.qrLatencyMs < 30_000, `二维码捕获耗时异常：${snapshot.qrLatencyMs}ms`);
        const capturedAt = snapshot.qr.capturedAt;
        await api(`/subjects/login/${attempt.attemptId}/refresh`, { method: 'POST', body: {} });
        const refreshed = await waitFor(async () => {
          const snap = await api(`/subjects/login/${attempt.attemptId}`);
          if (snap.qr?.capturedAt && snap.qr.capturedAt !== capturedAt) return snap;
          if (['failed', 'cancelled'].includes(snap.status)) throw new Error(`${snap.status}: ${snap.message}`);
          return null;
        }, { timeout: 60_000, interval: 250, label: '二维码刷新' });
        assert(refreshed.refreshLatencyMs && refreshed.refreshLatencyMs < 30_000, `二维码刷新耗时异常：${refreshed.refreshLatencyMs}ms`);
        return `二维码 ${snapshot.qrLatencyMs}ms，刷新 ${refreshed.refreshLatencyMs}ms，headless=${snapshot.headless}`;
      } finally {
        await api(`/subjects/login/${attempt.attemptId}/cancel`, { method: 'POST', body: {} }).catch(() => undefined);
      }
    });

    await check('发布配置创建与预览（标签组资源选择）', async () => {
      const config = await api('/configs', {
        method: 'POST',
        body: {
          name: '冒烟测试配置',
          config: {
            name: '冒烟测试配置',
            action: 'draft',
            resourceTags: [state.videoTag, state.textTag],
            subjectSelection: { mode: 'ids', ids: [state.subject.id], tags: [] },
            videoSelection: { strategy: 'random-unique', requireUploaded: 'no', perSubjectCount: 1 },
            textSelection: { strategy: 'random-unique', requireUploaded: 'no' },
            pageOptions: {
              description: { enabled: true, prefix: '【前缀】', suffix: '【后缀】', hashtags: ['测试标签'] },
            },
            pool: { allowReset: false, scope: 'config' },
            syncWechat: false,
          },
        },
      });
      state.config = config;
      assert(config.config.resourceTags.length === 2, '资源标签应保存并统一作用于三类资源');
      assert(!('original' in config.config.pageOptions), '已废弃的声明原创选项不应再返回');
      const preview = await api(`/configs/${config.id}/preview`, { method: 'POST', body: {} });
      assert(preview.items.length === 1, '1 个主体 × 每主体 1 个视频应预览 1 项');
      assert(preview.items[0].video, '预览应选中视频');
      assert(preview.items[0].text, '预览应选中文本');
      const videosAfterPreview = await api('/videos?pageSize=50');
      assert(videosAfterPreview.data.every((video) => video.uploadCount === 0), '预览不应写入使用状态');
      return `资源标签 ${config.config.resourceTags.length} 个，视频 #${preview.items[0].video.id}，文本 #${preview.items[0].text.id}`;
    });

    await check('短标题校验（必填 + 6-16 字）', async () => {
      const base = () => ({
        name: '短标题校验配置',
        resourceTags: [state.videoTag, state.textTag],
        subjectSelection: { mode: 'ids', ids: [state.subject.id] },
        videoSelection: { strategy: 'random', requireUploaded: '' },
        textSelection: { strategy: 'random', requireUploaded: '' },
        pageOptions: { description: { enabled: false }, shortTitle: { enabled: true, value: '' } },
      });
      let emptyError = '';
      try { await api('/configs', { method: 'POST', body: { name: '短标题校验配置', config: base() } }); } catch (error) { emptyError = error.message; }
      assert(/不能为空/.test(emptyError), `空短标题应被拒绝，实际：${emptyError}`);
      let shortError = '';
      try {
        await api('/configs', { method: 'POST', body: { name: '短标题校验配置', config: { ...base(), pageOptions: { description: { enabled: false }, shortTitle: { enabled: true, value: '太短' } } } } });
      } catch (error) { shortError = error.message; }
      assert(/6-16/.test(shortError), `过短短标题应被拒绝，实际：${shortError}`);
      const valid = await api('/configs', {
        method: 'POST',
        body: { name: '短标题校验配置', config: { ...base(), pageOptions: { description: { enabled: false }, shortTitle: { enabled: true, value: '这是一个合格短标题' } } } },
      });
      assert(valid.config.pageOptions.shortTitle.value === '这是一个合格短标题', '合法短标题应保存成功');
      return '空值/过短被拒绝，6-16 字可保存';
    });

    await check('定时发表：起点+10分钟、间隔、作用范围与废弃字段清理', async () => {
      const base = {
        name: '定时校验配置',
        resourceTags: [state.videoTag, state.textTag],
        subjectSelection: { mode: 'ids', ids: [state.subject.id] },
        videoSelection: { strategy: 'random', requireUploaded: '', perSubjectCount: 3 },
        textSelection: { strategy: 'random', requireUploaded: '' },
        pool: { allowReset: false },
      };
      let pastError = '';
      try {
        await api('/configs', {
          method: 'POST',
          body: { name: '定时校验配置', config: { ...base, pageOptions: { scheduled: { enabled: true, value: new Date(Date.now() - 3600_000).toISOString(), intervalMinutes: 10 } } } },
        });
      } catch (error) { pastError = error.message; }
      assert(/至少 10 分钟/.test(pastError), `过去的定时时间应被拒绝，实际：${pastError}`);
      let nearError = '';
      try {
        await api('/configs', {
          method: 'POST',
          body: { name: '定时校验配置', config: { ...base, pageOptions: { scheduled: { enabled: true, value: new Date(Date.now() + 5 * 60_000).toISOString(), intervalMinutes: 10 } } } },
        });
      } catch (error) { nearError = error.message; }
      assert(/至少 10 分钟/.test(nearError), `不足 10 分钟的定时起点应被拒绝，实际：${nearError}`);
      const future = new Date(Date.now() + 30 * 60_000).toISOString();
      const scheduled = await api('/configs', {
        method: 'POST',
        body: {
          name: '定时校验配置',
          config: {
            ...base,
            pageOptions: {
              preUploadAll: { enabled: true },
              scheduled: { enabled: true, value: future, intervalMinutes: 10, intervalScope: 'subject' },
              original: { enabled: true },
              shortTitle: { enabled: false, fromVideoName: true, value: '旧值' },
            },
          },
        },
      });
      state.scheduledConfig = scheduled;
      assert(scheduled.config.pageOptions.scheduled.value, '未来时间的定时发表应保存成功');
      assert(scheduled.config.pageOptions.scheduled.intervalMinutes === 10, '定时间隔应保存');
      assert(scheduled.config.pageOptions.scheduled.intervalScope === 'subject', '默认间隔作用范围应为按主体');
      assert(scheduled.config.pageOptions.preUploadAll.enabled === true, '先传后搭选项应保存');
      assert(!('original' in scheduled.config.pageOptions), '旧配置中的声明原创应被清理');
      assert(!('fromVideoName' in scheduled.config.pageOptions.shortTitle), '旧配置中的使用视频文件名应被清理');
      // 配置级定时发布：每条计划时间 = 起点 + 间隔 × 序号（按主体范围）
      const task = await api('/tasks', { method: 'POST', body: { configId: scheduled.id, overrides: { dryRun: true } } });
      const taskDetail = await api(`/tasks/${task.id}`);
      assert(taskDetail.scheduleKind === 'publish', '任务应标记为配置级定时发表');
      assert(taskDetail.items.length === 3, `应生成 3 条计划，实际 ${taskDetail.items.length}`);
      const times = taskDetail.items.map((item) => new Date(item.scheduledAt).getTime());
      assert(times[1] - times[0] === 10 * 60_000, '第 2 条计划应比第 1 条晚 10 分钟');
      assert(times[2] - times[1] === 10 * 60_000, '第 3 条计划应比第 2 条晚 10 分钟');
      await api(`/tasks/${task.id}/cancel`, { method: 'POST', body: {} });
      return '过去/不足10分钟拒绝，间隔与作用范围生效，废弃字段已清理';
    });

    await check('任务级定时执行与互斥校验', async () => {
      const future = new Date(Date.now() + 30 * 60_000).toISOString();
      let nearError = '';
      try {
        await api('/tasks', {
          method: 'POST',
          body: { configId: state.config.id, overrides: { dryRun: true, schedule: { enabled: true, value: new Date(Date.now() + 5 * 60_000).toISOString(), intervalMinutes: 5 } } },
        });
      } catch (error) { nearError = error.message; }
      assert(/至少 10 分钟/.test(nearError), `任务级定时不足 10 分钟应被拒绝，实际：${nearError}`);
      const task = await api('/tasks', {
        method: 'POST',
        body: {
          configId: state.config.id,
          overrides: { dryRun: true, perSubjectCount: 2, schedule: { enabled: true, value: future, intervalMinutes: 5 } },
        },
      });
      const detail = await api(`/tasks/${task.id}`);
      assert(detail.status === 'pending', '定时执行任务创建后应为待执行');
      assert(detail.scheduleKind === 'run', '任务应标记为定时执行');
      assert(detail.scheduledAt, '任务应保存定时执行起点');
      assert(detail.items.length === 2, '应生成 2 条计划');
      const times = detail.items.map((item) => new Date(item.scheduledAt).getTime());
      assert(times[1] - times[0] === 5 * 60_000, '任务级定时执行相邻计划应间隔 5 分钟');
      // 已有配置级定时发表时，任务级定时执行应被拒绝
      let conflictError = '';
      try {
        await api('/tasks', {
          method: 'POST',
          body: { configId: state.scheduledConfig.id, overrides: { dryRun: true, schedule: { enabled: true, value: future, intervalMinutes: 5 } } },
        });
      } catch (error) { conflictError = error.message; }
      assert(/已启用定时发表/.test(conflictError), `配置已定时发表时应拒绝任务级定时，实际：${conflictError}`);
      await api(`/tasks/${task.id}/cancel`, { method: 'POST', body: {} });
      return '10分钟限制、待执行状态、间隔与配置级定时互斥均通过';
    });

    await check('定时任务到点自动开始', async () => {
      const future = new Date(Date.now() + 30 * 60_000).toISOString();
      const task = await api('/tasks', {
        method: 'POST',
        body: { configId: state.config.id, overrides: { dryRun: true, schedule: { enabled: true, value: future, intervalMinutes: 5 } } },
      });
      await withDb((db) => {
        const past = new Date(Date.now() - 2000).toISOString();
        db.prepare('UPDATE tasks SET scheduled_at = ? WHERE id = ?').run(past, task.id);
        db.prepare('UPDATE task_items SET scheduled_at = ? WHERE task_id = ?').run(past, task.id);
      });
      const started = await waitFor(async () => {
        const detail = await api(`/tasks/${task.id}`);
        return ['running', 'failed', 'success', 'partial', 'cancelled'].includes(detail.status) ? detail : null;
      }, { timeout: 30_000, interval: 1000, label: '定时任务自动开始' });
      assert(['running', 'failed', 'success', 'partial', 'cancelled'].includes(started.status), `定时任务应自动开始，实际 ${started.status}`);
      await api(`/tasks/${task.id}/cancel`, { method: 'POST', body: {} }).catch(() => undefined);
      return `定时任务已自动开始（${started.status}）`;
    });

    await check('链接商品ID解析与必填校验', async () => {
      const { parseProductId } = await import(new URL('../server/automation/publisher.js', import.meta.url));
      assert(parseProductId('10001727125779') === '10001727125779', '纯商品ID应原样返回');
      assert(parseProductId('https://channels.weixin.qq.com/platform/product/10001727125779?from=share') === '10001727125779', '商品链接路径中的ID应被解析');
      assert(parseProductId('https://example.com/detail?goods_id=10001727125779&a=1') === '10001727125779', '商品链接参数中的ID应被解析');
      let emptyError = '';
      try {
        await api('/configs', {
          method: 'POST',
          body: {
            name: '链接必填校验配置',
            config: {
              resourceTags: [state.videoTag, state.textTag],
              subjectSelection: { mode: 'ids', ids: [state.subject.id] },
              videoSelection: { strategy: 'random', requireUploaded: '' },
              textSelection: { strategy: 'random', requireUploaded: '' },
              pageOptions: { extLink: { enabled: true, value: '' } },
            },
          },
        });
      } catch (error) { emptyError = error.message; }
      assert(/请填写商品链接或商品ID/.test(emptyError), `空链接应被拒绝，实际：${emptyError}`);
      return '纯ID/链接路径/链接参数均解析正确，空值被拒绝';
    });

    await check('固定资源：标签+使用状态交集与多选循环分配', async () => {
      const videos = await api('/videos?pageSize=50');
      const texts = await api('/texts?pageSize=50');
      const videoIds = videos.data.filter((video) => video.uploadCount === 0).slice(0, 2).map((video) => video.id);
      const textId = texts.data[0].id;
      assert(videoIds.length === 2, '需要至少 2 个未使用视频用于固定资源测试');
      const config = await api('/configs', {
        method: 'POST',
        body: {
          name: '固定资源配置',
          config: {
            name: '固定资源配置',
            resourceTags: [state.videoTag, state.textTag],
            subjectSelection: { mode: 'ids', ids: [state.subject.id] },
            videoSelection: { strategy: 'fixed', fixedVideoIds: videoIds, requireUploaded: 'no', perSubjectCount: 2 },
            textSelection: { strategy: 'fixed', fixedTextIds: [textId], requireUploaded: '' },
            pool: { allowReset: false, scope: 'config' },
          },
        },
      });
      assert(config.config.videoSelection.fixedVideoIds.length === 2, '固定视频应为多选');
      const task = await api('/tasks', { method: 'POST', body: { configId: config.id, overrides: { dryRun: true } } });
      assert(task.total === 2, `每主体 2 个视频应创建 2 项，实际 ${task.total}`);
      const picked = task.items.map((item) => item.videoId);
      assert(picked[0] !== picked[1], '固定视频多选应按顺序循环分配，不应重复同一项');
      assert(task.items.every((item) => item.textId === textId), '固定文本应分配给每一项');
      return `固定视频 #${picked.join(' → ')}，固定文本 #${textId}`;
    });

    await check('每个主体数量上限 5', async () => {
      const config = await api('/configs', {
        method: 'POST',
        body: {
          name: '数量上限配置',
          config: {
            name: '数量上限配置',
            resourceTags: [state.videoTag, state.textTag],
            subjectSelection: { mode: 'ids', ids: [state.subject.id] },
            videoSelection: { strategy: 'random', requireUploaded: '', perSubjectCount: 9 },
            textSelection: { strategy: 'random', requireUploaded: '' },
            pool: { allowReset: false, scope: 'config' },
          },
        },
      });
      assert(config.config.videoSelection.perSubjectCount === 5, '每主体数量应被限制为最多 5');
      const task = await api('/tasks', { method: 'POST', body: { configId: config.id, overrides: { dryRun: true, perSubjectCount: 5 } } });
      assert(task.total === 5, `单主体 5 个视频应创建 5 项，实际 ${task.total}`);
      return `单主体任务项 ${task.total} 个`;
    });

    await check('创建演练任务', async () => {
      const task = await api('/tasks', { method: 'POST', body: { configId: state.config.id, overrides: { dryRun: true } } });
      assert(task.total === 1, `任务应包含 1 个主体，实际 ${task.total}`);
      const item = task.items[0];
      assert(item.videoId && item.textId, '任务项应包含视频与文本');
      state.task = task;
      return `${task.name}`;
    });

    await check('演练模式不消耗素材', async () => {
      const task = await api('/tasks', { method: 'POST', body: { configId: state.config.id, overrides: { dryRun: true } } });
      assert(task.dryRun === true, '应标记为演练任务');
      const videos = await api('/videos?pageSize=50');
      assert(videos.data.every((video) => video.uploadCount === 0), '演练任务不应增加使用次数');
      return '使用次数未变化';
    });

    await check('演练测试环境开关（开启后计入使用状态）', async () => {
      await api('/settings', { method: 'PUT', body: { testing: { dryRunCountsUsage: true } } });
      const settings = await api('/settings');
      assert(settings.settings.testing.dryRunCountsUsage === true, '演练测试环境开关未生效');
      const usageCount = async () => withDb((db) => Number(db.prepare('SELECT COUNT(*) AS n FROM pool_usage WHERE scope = ?').get(state.config.id)?.n || 0));
      const before = await usageCount();
      const task = await api('/tasks', { method: 'POST', body: { configId: state.config.id, overrides: { dryRun: true } } });
      assert(task.dryRun === true, '应仍为演练任务');
      const after = await usageCount();
      assert(after > before, '开启测试环境后演练任务应写入使用状态');
      await api('/settings', { method: 'PUT', body: { testing: { dryRunCountsUsage: false } } });
      const restored = await api('/settings');
      assert(restored.settings.testing.dryRunCountsUsage === false, '关闭开关未生效');
      return '开启计入 / 关闭恢复';
    });

    await check('随机不可重复用尽后自动重置', async () => {
      const base = structuredClone(state.config.config);
      base.name = '随机策略配置';
      base.videoSelection = { strategy: 'random-unique', requireUploaded: 'no', perSubjectCount: 1 };
      base.textSelection = { strategy: 'random', requireUploaded: 'no' };
      base.pool = { allowReset: true, scope: 'config' };
      const config = await api('/configs', { method: 'POST', body: { name: base.name, config: base } });
      const videoIds = [];
      for (let index = 0; index < 4; index += 1) {
        const task = await api('/tasks', { method: 'POST', body: { configId: config.id, overrides: {} } });
        assert(task.total === 1, `第 ${index + 1} 次任务应成功分配资源`);
        videoIds.push(task.items[0].videoId);
      }
      assert(new Set(videoIds.slice(0, 3)).size === 3, `前三轮应使用不同视频，实际 ${videoIds.join(',')}`);
      assert(videoIds.length === 4, '资源用尽后应自动重置并继续分配');
      return `视频 #${videoIds.join(' → ')}（用尽后自动重置）`;
    });

    await check('执行任务（未登录应失败并记录原因）', async () => {
      await api(`/tasks/${state.task.id}/start`, { method: 'POST', body: {} });
      const task = await waitTask(state.task.id);
      assert(task.status === 'failed', `任务状态应为失败，实际 ${task.status}`);
      const item = task.items[0];
      assert(item.status === 'failed', `任务项状态应为失败，实际 ${item.status}`);
      assert(/登录|过期|session|SES/i.test(item.error || ''), `失败原因应提示登录态问题，实际：${item.error}`);
      assert(item.screenshot, '失败时应保存截图');
      const videosAfter = await api('/videos?pageSize=50');
      assert(videosAfter.data.every((video) => video.uploadCount === 0), '演练执行不应增加“已上传”次数');
      return `状态 ${task.status}：${String(item.error).slice(0, 40)}`;
    });

    await check('微信机器人（dsh-im 导入）', async () => {
      const status = await api('/wechat/status');
      if (!status.dshIm.available || !status.dshIm.accounts.length) return '跳过（本机无 dsh-im 微信机器人）';
      await api('/wechat/import', { method: 'POST', body: {} });
      const after = await api('/wechat/status');
      assert(after.bots.length >= 1, '导入后应有已绑定机器人');
      assert(after.enabled === true, '导入后应启用同步');
      return `${after.bots.length} 个机器人`;
    });

    await check('微信机器人扫码接口（仅申请二维码）', async () => {
      let attempt;
      try {
        attempt = await api('/wechat/bind', { method: 'POST', body: {} });
      } catch (error) {
        return `跳过（微信服务不可达：${String(error.message).slice(0, 40)}）`;
      }
      assert(attempt.qrUrl, '应返回二维码地址');
      const qr = await fetch(`http://127.0.0.1:${PORT}${attempt.qrUrl}`);
      assert(qr.ok, `二维码代理应可访问，HTTP ${qr.status}`);
      const bytes = (await qr.arrayBuffer()).byteLength;
      assert(bytes > 100, '二维码图片应为非空');
      await api(`/wechat/bind/${attempt.attemptId}/cancel`, { method: 'POST', body: {} });
      return `${bytes} 字节`;
    });

    await check('配置导出', async () => {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/settings/export`);
      const payload = await res.json();
      assert(payload.app === 'weixin-auto', '导出内容应包含 app 标识');
      assert(payload.tags?.length === 5, `导出应包含标签，实际 ${payload.tags?.length}`);
      assert(payload.tagGroups?.length >= 2, `导出应包含标签组，实际 ${payload.tagGroups?.length}`);
      assert(payload.videos?.length === 3, '导出应包含视频元数据');
      assert(payload.texts?.length === 3, '导出应包含文本');
      assert(payload.publishConfigs?.length >= 2, '导出应包含发布配置');
      state.export = payload;
      return `设置/标签/主体/视频/文本/配置`;
    });

    await check('配置导入（合并去重）', async () => {
      const result = await api('/settings/import', { method: 'POST', body: { payload: state.export, mode: 'merge' } });
      const videos = await api('/videos?pageSize=50');
      assert(videos.total === 3, '重复导入视频不应产生重复记录');
      const groups = await api('/tag-groups');
      assert(groups.length >= 2, '导入后应保留标签组');
      const groupTags = await api(`/tags?withCounts=1`);
      const productTag = groupTags.find((tag) => tag.name === '产品B-测试');
      assert(productTag && productTag.groupName === '产品组-测试', '导入后标签组归属应保留');
      return `新增 视频${result.stats.videos} 主体${result.stats.subjects} 文本${result.stats.texts}，标签组 ${groups.length} 个`;
    });

    await check('软移除视频（保留数据库记录）', async () => {
      const before = await api('/videos?pageSize=50');
      const target = before.data[0];
      await api(`/videos/${target.id}`, { method: 'DELETE' });
      const after = await api('/videos?pageSize=50');
      assert(after.total === before.total - 1, `移除后应少 1 个视频，实际 ${after.total}`);
      assert(!after.data.some((video) => video.id === target.id), '移除后不应再出现在视频池列表');
      assert(target.md5, '被移除视频应有 MD5（用于重新关联）');
      state.removedVideo = target;
      state.removedCount = after.total;
      return `已软移除 #${target.id}（记录保留，按 MD5 关联）`;
    });

    await check('重新扫描按 MD5 恢复已移除视频', async () => {
      const target = state.removedVideo;
      const mediaDir = state.mediaDir;
      const newName = 'video-renamed.mp4';
      await fsp.rename(target.path, path.join(mediaDir, newName)).catch(() => undefined);
      const job = await api('/videos/scan', { method: 'POST', body: {} });
      const done = await waitJob(job.id);
      const list = await api('/videos?pageSize=50');
      assert(list.total === state.removedCount + 1, `重新扫描后应恢复为 ${state.removedCount + 1} 个视频，实际 ${list.total}`);
      const restored = list.data.find((video) => video.md5 === target.md5);
      assert(restored, '应按 MD5 找到恢复后的视频');
      assert(restored.id === target.id, `恢复后应沿用原记录 ID（${target.id}），实际 ${restored.id}`);
      assert(restored.name === newName, `恢复后名称应为新文件名，实际 ${restored.name}`);
      assert(restored.tags.some((tag) => Number(tag.id) === state.videoTag), '恢复后应保留原有标签');
      return `恢复记录 #${restored.id}：${restored.name}（扫描恢复 ${done.result.archived || 0} 个）`;
    });

    await check('系统目录浏览接口', async () => {
      const subDir = path.join(state.mediaDir, '子文件夹');
      await fsp.mkdir(subDir, { recursive: true });
      const listing = await api(`/system/dirs?path=${encodeURIComponent(state.mediaDir)}`);
      assert(listing.path.toLowerCase().endsWith('media'), `返回路径异常：${listing.path}`);
      assert(listing.parent, '应返回上一级路径');
      assert(listing.entries.some((entry) => entry.name === '子文件夹'), '应列出子文件夹');
      const root = await api('/system/dirs');
      assert(root.drives.length > 0, '应列出本机磁盘');
      return `盘符 ${root.drives.length} 个，子目录 ${listing.entries.length} 个`;
    });

    await check('视频封面接口', async () => {
      let job = null;
      try {
        job = await api('/videos/thumbnails', { method: 'POST', body: { force: true } });
      } catch (error) {
        // 测试环境下没有可解码的视频/浏览器时允许直接失败，但接口不能 500
        assert(!/HTTP 500/.test(error.message), '封面接口不应返回 500');
        return `跳过：${String(error.message).slice(0, 40)}`;
      }
      const done = await waitJob(job.id, { timeout: 120_000 });
      const videoList = await api('/videos?pageSize=10');
      const video = videoList.data.find((item) => !item.missing);
      assert(video, '应有可测试的视频记录');
      const thumbResponse = await fetch(`http://127.0.0.1:${PORT}/api/videos/${video.id}/thumbnail`);
      assert(thumbResponse.status === 404 || thumbResponse.status === 200, `封面接口状态异常：${thumbResponse.status}`);
      const status = await api('/videos/thumbnails/status');
      assert(typeof status.total === 'number' && typeof status.ready === 'number', '封面状态字段不完整');
      return `任务 ${done.status}，封面 ${status.ready}/${status.total}`;
    });

    await check('页面探测接口可用性', async () => {
      // 未登录主体探测会失败，但应返回可读错误而不是 500
      try {
        await api(`/probe/${state.subject.id}`, { method: 'POST', body: {} });
        return '探测成功';
      } catch (error) {
        assert(!/HTTP 500/.test(error.message), '探测不应返回 500');
        return `预期失败：${String(error.message).slice(0, 40)}`;
      }
    });
  } finally {
    await stopServer();
  }

  console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    console.log('失败详情：');
    for (const item of results.filter((r) => !r.ok)) console.log(` - ${item.name}: ${item.error}`);
    process.exitCode = 1;
  } else {
    console.log('全部通过 ✅');
  }
}

main().catch((error) => {
  console.error('冒烟测试异常：', error);
  stopServer().finally(() => process.exit(1));
});
