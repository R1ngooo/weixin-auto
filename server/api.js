import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { PATHS } from './config.js';
import { getSettings, getSelectors, replaceSettings, resetSettings, updateSettings, exportableSettings } from './settings.js';
import { pickFolder, listDirectories } from './services/folder-dialog.js';

const wrap = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).then((data) => {
    if (res.headersSent) return;
    res.json({ ok: true, data });
  }).catch((error) => {
    if (res.headersSent) return;
    const status = error?.code === 'NOT_FOUND' ? 404 : 400;
    res.status(status).json({ ok: false, error: String(error?.message || error), code: error?.code || 'ERROR' });
  });
};

const toInt = (value, fallback = 0) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const listParam = (value) => {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value;
  return String(value).split(',').map((v) => v.trim()).filter(Boolean);
};

export function createApiRouter(ctx) {
  const {
    db, subjects, videos, texts, tags, configs, tasks, wechat, backup, jobs, browser, login, session, publisher, picker, thumbnails,
  } = ctx;
  const router = express.Router();

  // ---------- 概览 ----------
  router.get('/health', wrap(async () => ({
    ok: true,
    name: 'weixin-auto',
    version: '0.1.0',
    time: new Date().toISOString(),
    runningTaskId: tasks.runningTaskId || null,
    queuedTasks: tasks.queue.length,
  })));

  router.get('/overview', wrap(async () => {
    const subjectRows = subjects.list();
    const statusCounts = { active: 0, expired: 0, unknown: 0 };
    for (const subject of subjectRows) statusCounts[subject.status] = (statusCounts[subject.status] || 0) + 1;
    const videoRows = db.all('SELECT COUNT(*) AS n, SUM(CASE WHEN missing = 1 THEN 1 ELSE 0 END) AS missing FROM videos WHERE removed = 0');
    const textCount = texts.count();
    const recentTasks = tasks.list({ pageSize: 5 }).data;
    return {
      subjects: { total: subjectRows.length, ...statusCounts },
      videos: { total: Number(videoRows[0]?.n || 0), missing: Number(videoRows[0]?.missing || 0) },
      texts: textCount,
      tags: tags.list().length,
      configs: configs.list().length,
      tasks: { running: tasks.runningTaskId || null, recent: recentTasks },
      wechat: { enabled: Boolean(getSettings().wechat?.enabled), configured: wechat.isConfigured() },
    };
  }));

  // ---------- 标签 ----------
  router.get('/tags', wrap(async (req) => (req.query.withCounts ? tags.usageCounts() : tags.list())));
  router.post('/tags', wrap(async (req) => tags.create(req.body || {})));
  router.post('/tags/assign', wrap(async (req) => tags.assign({
    kind: String(req.body?.kind || ''),
    ids: listParam(req.body?.ids),
    tagIds: listParam(req.body?.tagIds).map(Number),
    mode: String(req.body?.mode || 'add'),
  })));
  router.put('/tags/:id', wrap(async (req) => tags.update(toInt(req.params.id), req.body || {})));
  router.delete('/tags/:id', wrap(async (req) => tags.remove(toInt(req.params.id))));

  // ---------- 标签组 ----------
  router.get('/tag-groups', wrap(async (req) => tags.groups.list({ withCounts: req.query.withCounts === '1' })));
  router.post('/tag-groups', wrap(async (req) => tags.groups.create(req.body || {})));
  router.put('/tag-groups/:id', wrap(async (req) => tags.groups.update(toInt(req.params.id), req.body || {})));
  router.delete('/tag-groups/:id', wrap(async (req) => tags.groups.remove(toInt(req.params.id))));

  // ---------- 主体 ----------
  router.get('/subjects', wrap(async (req) => subjects.list({
    status: req.query.status || '',
    tagIds: listParam(req.query.tagIds).map(Number),
    query: req.query.q || '',
  })));

  router.post('/subjects', wrap(async (req) => subjects.create(req.body || {})));

  router.put('/subjects/:id', wrap(async (req) => {
    const { name, note, tagIds } = req.body || {};
    const patch = {};
    if (name !== undefined) patch.name = String(name).trim();
    if (note !== undefined) patch.note = note;
    if (tagIds !== undefined) patch.tagIds = listParam(tagIds).map(Number);
    return subjects.update(req.params.id, patch);
  }));

  router.get('/subjects/duplicates', wrap(async () => subjects.mergeDuplicates({ dryRun: true })));
  router.post('/subjects/dedupe', wrap(async () => {
    const result = await subjects.mergeDuplicates();
    subjects.normalizeNames();
    const repaired = subjects.repairSubjectReferences();
    const indexes = subjects.ensureUniqueIndexes();
    return { ...result, repaired, indexes };
  }));

  router.delete('/subjects/:id', wrap(async (req) => {
    const subject = subjects.get(req.params.id);
    if (!subject) throw new Error('主体不存在');
    // 先取消该主体进行中的扫码登录，避免删除后后台仍在使用
    const loginCancelled = login.cancelForSubject(req.params.id);
    // 先删数据库记录（历史执行记录保留），确保界面立即生效
    subjects.remove(req.params.id);
    // 浏览器关闭/登录态目录清理放到后台执行，避免接口被浏览器关闭阻塞
    const backupDir = path.join(PATHS.profiles, '_deleted');
    browser.removeProfile(req.params.id, { backupDir }).then((result) => {
      if (result?.backupPath) console.log(`[subjects] 已备份被删除主体的登录态：${result.backupPath}`);
    }).catch((error) => console.error('[subjects] 清理主体登录态失败：', String(error?.message || error)));
    return { removed: true, loginCancelled, profileBackup: backupDir };
  }));

  router.post('/subjects/login', wrap(async (req) => login.start(req.body || {})));
  router.get('/subjects/login/:attemptId', wrap(async (req) => {
    const attempt = await login.get(req.params.attemptId);
    if (!attempt) throw Object.assign(new Error('登录会话不存在或已过期'), { code: 'NOT_FOUND' });
    return attempt;
  }));
  router.post('/subjects/login/:attemptId/refresh', wrap(async (req) => login.requestRefresh(req.params.attemptId)));
  router.post('/subjects/login/:attemptId/open-browser', wrap(async (req) => login.openBrowser(req.params.attemptId)));
  router.post('/subjects/login/:attemptId/cancel', wrap(async (req) => login.cancel(req.params.attemptId)));

  router.post('/subjects/check-all', wrap(async (req) => session.checkAll({
    tagIds: listParam(req.body?.tagIds).map(Number),
    limit: toInt(req.body?.limit, 0),
  })));

  router.post('/subjects/:id/check', wrap(async (req) => session.check(req.params.id)));

  router.post('/subjects/:id/open', wrap(async (req) => {
    const subject = subjects.get(req.params.id);
    if (!subject) throw new Error('主体不存在');
    return browser.run(req.params.id, async ({ page }) => {
      await page.goto(getSelectors().platform.postCreateUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
      await page.waitForTimeout(2500);
      return { url: page.url(), title: await page.title().catch(() => '') };
    });
  }));

  router.post('/subjects/:id/close-browser', wrap(async (req) => {
    await browser.close(req.params.id);
    return { closed: true };
  }));

  // ---------- 页面探测 ----------
  router.post('/probe/:subjectId', wrap(async (req) => publisher.probePage(req.params.subjectId)));
  router.post('/probe/:subjectId/deep', wrap(async (req, res) => {
    const subject = subjects.get(req.params.subjectId);
    if (!subject) throw new Error('主体不存在');
    let uploadFile = req.body?.uploadFile ? path.resolve(String(req.body.uploadFile)) : null;
    // 未指定测试视频时，若存在内置测试视频则自动使用（便于面板一键深度探测）
    if (!uploadFile && req.body?.useTestVideo !== false) {
      const candidate = path.join(PATHS.data, 'test-media', 'probe-test.mp4');
      const candidateStat = await fs.promises.stat(candidate).catch(() => null);
      if (candidateStat?.isFile()) uploadFile = candidate;
    }
    if (uploadFile) {
      const stat = await fs.promises.stat(uploadFile).catch(() => null);
      if (!stat || !stat.isFile()) throw new Error(`测试视频不存在：${uploadFile}`);
      if (!/\.(mp4|mov|m4v|avi|wmv|flv|mkv|webm)$/i.test(uploadFile)) throw new Error('测试视频扩展名不受支持');
    }
    const result = await publisher.deepProbe(req.params.subjectId, {
      uploadFile,
      watchSeconds: Number(req.body?.watchSeconds || 60),
    });
    // 截图路径转成可直接访问的 URL
    result.screenshotUrls = (result.screenshots || []).filter(Boolean).map((file) => `/files/screenshots/${encodeURIComponent(path.basename(file))}`);
    return result;
  }));

  // ---------- 视频池 ----------
  router.get('/videos', wrap(async (req) => videos.list({
    tagIds: listParam(req.query.tagIds).map(Number),
    query: req.query.q || '',
    uploaded: req.query.uploaded || '',
    page: toInt(req.query.page, 1),
    pageSize: toInt(req.query.pageSize, 50),
    sort: req.query.sort || 'newest',
  })));
  router.get('/videos/folders', wrap(async () => videos.folders()));
  router.post('/videos/folders', wrap(async (req) => videos.addFolder(
    req.body?.path,
    req.body?.recursive !== false,
    listParam(req.body?.tagIds).map(Number),
  )));
  router.put('/videos/folders/:id', wrap(async (req) => videos.updateFolder(toInt(req.params.id), {
    recursive: req.body?.recursive,
    enabled: req.body?.enabled,
    tagIds: req.body?.tagIds === undefined ? undefined : listParam(req.body.tagIds).map(Number),
  })));
  router.delete('/videos/folders/:id', wrap(async (req) => videos.removeFolder(toInt(req.params.id))));
  router.post('/system/pick-folder', wrap(async (req) => pickFolder({
    title: req.body?.title || '选择视频文件夹',
  })));
  router.get('/system/dirs', wrap(async (req) => listDirectories(req.query?.path || '')));
  router.post('/videos/scan', wrap(async () => videos.startScanJob({
    onDone: (job) => {
      if (job?.status !== 'success') return;
      // 扫描完成后自动补封面 + 自动计算 MD5（后台任务，不用手动点）
      try { thumbnails.startJob(); } catch { /* 忽略 */ }
      try { videos.startMd5Job(); } catch { /* 忽略 */ }
    },
  })));
  router.post('/videos/thumbnails', wrap(async (req) => thumbnails.startJob({
    ids: listParam(req.body?.ids).map(Number).filter(Boolean),
    force: Boolean(req.body?.force),
  })));
  router.get('/videos/thumbnails/status', wrap(async () => thumbnails.status()));
  router.post('/videos/md5', wrap(async (req) => {
    const ids = listParam(req.body?.ids).map(Number);
    return videos.startMd5Job(ids.length ? ids : null);
  }));
  router.put('/videos/:id', wrap(async (req) => videos.setTags(toInt(req.params.id), listParam(req.body?.tagIds).map(Number))));
  router.delete('/videos/:id', wrap(async (req) => videos.remove(toInt(req.params.id), { deleteFile: req.query.deleteFile === '1' })));

  router.get('/videos/:id/thumbnail', (req, res) => {
    try {
      const video = videos.get(toInt(req.params.id));
      if (!video?.thumb_path) return res.status(404).json({ ok: false, error: '该视频还未生成封面' });
      const filePath = path.resolve(video.thumb_path);
      if (!filePath.startsWith(path.resolve(PATHS.thumbnails))) {
        return res.status(400).json({ ok: false, error: '非法封面路径' });
      }
      if (!fs.existsSync(filePath)) return res.status(404).json({ ok: false, error: '封面文件不存在' });
      const stat = fs.statSync(filePath);
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('ETag', `"thumb-${video.id}-${Number(stat.mtimeMs)}"`);
      fs.createReadStream(filePath).pipe(res);
    } catch {
      res.status(404).json({ ok: false, error: '封面不可读' });
    }
  });

  router.get('/videos/:id/file', (req, res) => {
    try {
      const video = videos.get(toInt(req.params.id));
      if (!video) return res.status(404).json({ ok: false, error: '视频不存在' });
      const stat = fs.statSync(video.path);
      const range = req.headers.range;
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
      if (range) {
        const match = /bytes=(\d*)-(\d*)/.exec(range);
        const start = match?.[1] ? Number(match[1]) : 0;
        const end = match?.[2] ? Number(match[2]) : stat.size - 1;
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
        res.setHeader('Content-Length', end - start + 1);
        fs.createReadStream(video.path, { start, end }).pipe(res);
      } else {
        res.setHeader('Content-Length', stat.size);
        fs.createReadStream(video.path).pipe(res);
      }
    } catch {
      res.status(404).json({ ok: false, error: '视频文件不可读' });
    }
  });

  // ---------- 文本池 ----------
  router.get('/texts', wrap(async (req) => texts.list({
    tagIds: listParam(req.query.tagIds).map(Number),
    query: req.query.q || '',
    uploaded: req.query.uploaded || '',
    page: toInt(req.query.page, 1),
    pageSize: toInt(req.query.pageSize, 100),
  })));
  router.post('/texts', wrap(async (req) => texts.create(req.body || {})));
  router.post('/texts/import', wrap(async (req) => texts.import(req.body || {})));
  router.put('/texts/:id', wrap(async (req) => texts.update(toInt(req.params.id), req.body || {})));
  router.delete('/texts/:id', wrap(async (req) => texts.remove(toInt(req.params.id))));

  // ---------- 发布配置 ----------
  router.get('/configs', wrap(async () => configs.list()));
  router.post('/configs', wrap(async (req) => configs.create(req.body || {})));
  router.get('/configs/:id', wrap(async (req) => configs.get(req.params.id)));
  router.put('/configs/:id', wrap(async (req) => configs.update(req.params.id, req.body || {})));
  router.delete('/configs/:id', wrap(async (req) => configs.remove(req.params.id)));
  router.get('/configs/:id/subjects', wrap(async (req) => configs.resolveSubjects(req.params.id, subjects)));
  router.post('/configs/:id/preview', wrap(async (req) => {
    const record = configs.get(req.params.id);
    if (!record) throw new Error('发布配置不存在');
    const subjectList = configs.resolveSubjects(req.params.id, subjects);
    const previews = subjectList.map((subject) => {
      const useSubjectScope = record.config.pool?.scope === 'subject';
      const videoScope = useSubjectScope ? `${req.params.id}:${subject.id}` : req.params.id;
      const textScope = useSubjectScope ? `${req.params.id}:${subject.id}` : req.params.id;
      const result = { subjectId: subject.id, subjectName: subject.name, subjectStatus: subject.status, video: null, text: null, error: null };
      try {
        result.video = picker.pickVideo({
          scope: videoScope,
          strategy: record.config.videoSelection.strategy,
          tagIds: record.config.videoSelection.tags,
          fixedId: record.config.videoSelection.fixedVideoId,
          preferUnuploaded: record.config.videoSelection.preferUnuploaded,
          requireUploaded: record.config.videoSelection.requireUploaded,
          allowReset: record.config.pool.allowReset !== false,
          peek: true,
        });
      } catch (error) { result.error = error.message; }
      if (!result.error) {
        try {
          result.text = picker.pickText({
            scope: textScope,
            strategy: record.config.textSelection.strategy,
            tagIds: record.config.textSelection.tags,
            fixedId: record.config.textSelection.fixedTextId,
            preferUnuploaded: record.config.textSelection.preferUnuploaded,
            requireUploaded: record.config.textSelection.requireUploaded,
            allowReset: record.config.pool.allowReset !== false,
            peek: true,
          });
        } catch (error) { result.error = error.message; }
      }
      return result;
    });
    return { config: record, items: previews };
  }));
  router.post('/configs/:id/reset-pool', wrap(async (req) => {
    picker.resetPool(req.params.id);
    return { reset: true };
  }));

  // ---------- 任务 ----------
  router.get('/tasks', wrap(async (req) => tasks.list({ page: toInt(req.query.page, 1), pageSize: toInt(req.query.pageSize, 30) })));
  router.post('/tasks', wrap(async (req) => tasks.create(req.body || {})));
  router.get('/tasks/:id', wrap(async (req) => {
    const task = tasks.detail(req.params.id);
    if (!task) throw Object.assign(new Error('任务不存在'), { code: 'NOT_FOUND' });
    return task;
  }));
  router.post('/tasks/:id/start', wrap(async (req) => tasks.start(req.params.id)));
  router.post('/tasks/:id/cancel', wrap(async (req) => tasks.cancel(req.params.id)));

  // ---------- 设置 ----------
  router.get('/settings', wrap(async () => ({
    settings: getSettings(),
    selectors: getSelectors(),
    dataDir: PATHS.data,
    dshHome: process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh'),
  })));
  router.put('/settings', wrap(async (req) => updateSettings(req.body || {})));
  router.put('/settings/selectors', wrap(async (req) => {
    updateSettings({ selectors: req.body?.selectors || req.body || {} });
    return getSelectors();
  }));
  router.post('/settings/reset', wrap(async () => resetSettings()));
  router.get('/settings/export', wrap(async (req, res) => {
    const include = {
      settings: req.query.settings !== '0',
      tags: req.query.tags !== '0',
      subjects: req.query.subjects !== '0',
      videos: req.query.videos !== '0',
      texts: req.query.texts !== '0',
      publishConfigs: req.query.configs !== '0',
    };
    const payload = await backup.exportAll({ include });
    if (req.query.save === '1') {
      const file = await backup.saveExport(payload);
      payload.savedTo = file;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="weixin-auto-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify(payload, null, 2));
  }));
  router.post('/settings/import', wrap(async (req) => backup.importAll(req.body?.payload || req.body, { mode: req.body?.mode || 'merge' })));
  router.get('/settings/browsers', wrap(async () => {
    const candidates = [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ];
    return { found: candidates.filter((file) => fs.existsSync(file)), playwrightCache: path.join(process.env.LOCALAPPDATA || '', 'ms-playwright') };
  }));
  router.get('/settings/exportable', wrap(async () => exportableSettings()));
  router.get('/settings/selectors/defaults', wrap(async () => {
    const { DEFAULT_SELECTORS } = await import('./selectors.js');
    return DEFAULT_SELECTORS;
  }));

  // ---------- 微信机器人 ----------
  router.get('/wechat/status', wrap(async () => wechat.status()));
  router.post('/wechat/enable', wrap(async (req) => wechat.setEnabled(req.body?.enabled !== false, req.body?.botId)));
  router.post('/wechat/import', wrap(async (req) => wechat.importFromDshIm(req.body?.botId || null)));
  router.post('/wechat/bind', wrap(async (req) => wechat.startBinding(req.body || {})));
  router.get('/wechat/bind/:attemptId', wrap(async (req) => {
    const attempt = wechat.getBinding(req.params.attemptId);
    if (!attempt) throw Object.assign(new Error('绑定会话不存在'), { code: 'NOT_FOUND' });
    return attempt;
  }));
  router.get('/wechat/bind/:attemptId/qr', async (req, res) => {
    try {
      const { buffer, contentType } = await wechat.qrImage(req.params.attemptId);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-store');
      res.send(buffer);
    } catch (error) {
      res.status(404).json({ ok: false, error: String(error?.message || error) });
    }
  });
  router.post('/wechat/bind/:attemptId/verify', wrap(async (req) => wechat.submitVerifyCode(req.params.attemptId, req.body?.code)));
  router.post('/wechat/bind/:attemptId/cancel', wrap(async (req) => wechat.cancelBinding(req.params.attemptId)));
  router.post('/wechat/test', wrap(async () => wechat.testSend()));
  router.post('/wechat/notify', wrap(async (req) => {
    const text = String(req.body?.text || '').trim();
    if (!text) throw new Error('推送内容不能为空');
    return wechat.sendText(text);
  }));
  router.post('/wechat/refresh-context', wrap(async (req) => wechat.refreshContextToken(req.body?.botId || null)));
  router.delete('/wechat/bots/:botId', wrap(async (req) => wechat.removeBot(req.params.botId)));

  // ---------- 后台任务 ----------
  router.get('/jobs', wrap(async () => jobs.list()));
  router.get('/jobs/:id', wrap(async (req) => jobs.get(req.params.id)));
  router.post('/jobs/:id/cancel', wrap(async (req) => ({ cancelled: jobs.cancel(req.params.id) })));

  // ---------- 执行截图 ----------
  router.get('/tasks/:id/items/:itemId/screenshot', (req, res) => {
    const task = tasks.detail(req.params.id);
    const item = task?.items.find((entry) => entry.id === req.params.itemId);
    if (!item?.screenshot) return res.status(404).json({ ok: false, error: '没有截图' });
    if (!item.screenshot.startsWith(PATHS.screenshots)) return res.status(400).json({ ok: false, error: '非法路径' });
    res.sendFile(item.screenshot);
  });

  return router;
}
