import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { PATHS } from './config.js';
import { getDb } from './db.js';
import { getSettings, getSelectors } from './settings.js';
import { ensureDir } from './util.js';
import { createApiRouter } from './api.js';
import { createJobRunner } from './jobs.js';
import { createBrowserManager } from './automation/browser.js';
import { createLoginManager } from './automation/login.js';
import { createSessionService } from './automation/session.js';
import { createPublisher } from './automation/publisher.js';
import { SubjectService, TagService } from './services/subjects.js';
import { VideoService } from './services/videos.js';
import { TextService } from './services/texts.js';
import { PublishConfigService } from './services/publish-configs.js';
import { ResourcePicker } from './services/picker.js';
import { TaskService } from './services/tasks.js';
import { WechatService } from './services/wechat.js';
import { BackupService } from './services/backup.js';
import { createThumbnailService } from './services/thumbnails.js';

async function main() {
  for (const dir of [PATHS.data, PATHS.profiles, PATHS.screenshots, PATHS.thumbnails, PATHS.logs, PATHS.backups]) {
    await ensureDir(dir);
  }

  const db = getDb();
  const jobs = createJobRunner();
  const settings = getSettings();

  const subjects = new SubjectService();
  // 启动时合并重复主体（按视频号名称/ID/identityKey），并归一显示名称、建立唯一索引
  try {
    const dedupe = await subjects.mergeDuplicates();
    const normalized = subjects.normalizeNames();
    const repaired = subjects.repairSubjectReferences();
    const indexes = subjects.ensureUniqueIndexes();
    if (dedupe.mergedGroups > 0) {
      console.log(`  已合并重复主体 ${dedupe.mergedGroups} 组（备份：${dedupe.backupFile || '无'}，profile：${dedupe.profileRoot || '无'}）`);
    }
    if (normalized > 0) console.log(`  已按视频号名称归一主体显示名称 ${normalized} 个`);
    if (repaired.fixed > 0) console.log(`  已修复 ${repaired.fixed} 处发布配置/任务中的主体引用（清理无效引用 ${repaired.removed} 个）`);
    for (const [name, result] of Object.entries(indexes)) {
      if (result !== true) console.warn(`  [subjects] 唯一索引 ${name} 创建失败：${result}`);
    }
  } catch (error) {
    console.error('[subjects] 启动重复主体合并失败：', String(error?.message || error));
  }
  const tags = new TagService();
  const videos = new VideoService({ jobs });
  const texts = new TextService();
  const configs = new PublishConfigService();
  const picker = new ResourcePicker({ videos, texts });
  const wechat = new WechatService();
  const backup = new BackupService();
  const thumbnails = createThumbnailService({ getSettings, jobs });

  videos.ensureFoldersFromSettings();

  const browser = createBrowserManager({
    getSettings,
    getSubject: (id) => subjects.get(id),
  });
  const login = createLoginManager({
    browser,
    subjects,
    getSettings,
    getSelectors,
  });
  const session = createSessionService({ browser, subjects, getSelectors });
  const publisher = createPublisher({ browser, getSettings, getSelectors, subjects });
  const tasks = new TaskService({ picker, subjects, configs, publisher, wechat });
  tasks.startScheduler();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '80mb' }));
  app.use(express.urlencoded({ extended: false, limit: '80mb' }));

  app.use('/api', createApiRouter({
    db, subjects, videos, texts, tags, configs, tasks, wechat, backup, jobs, browser, login, session, publisher, picker, thumbnails,
  }));

  app.use('/files/screenshots', express.static(PATHS.screenshots, { maxAge: '1h' }));
  app.use('/files/backups', express.static(PATHS.backups, { maxAge: '1h' }));

  app.use(express.static(PATHS.web, { extensions: ['html'] }));

  app.get(/^\/api\/.*/, (req, res) => {
    res.status(404).json({ ok: false, error: '接口不存在' });
  });

  // 前端 hash 路由，全部回落到 index.html
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(path.join(PATHS.web, 'index.html'));
  });

  app.use((error, req, res, next) => {
    console.error('[http]', error);
    if (res.headersSent) return next(error);
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  });

  const server = http.createServer(app);
  const desiredPort = Number(process.env.WXA_PORT || settings.server?.port || 3210);
  const host = process.env.WXA_HOST || settings.server?.host || '127.0.0.1';

  async function isOwnInstance(port) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const response = await fetch(`http://${host}:${port}/api/health`, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) return false;
      const data = await response.json();
      return data?.data?.name === 'weixin-auto';
    } catch {
      return false;
    }
  }

  const listenPort = await new Promise((resolve, reject) => {
    const tryListen = (port, attemptsLeft) => {
      server.once('error', async (error) => {
        if (error.code === 'EADDRINUSE') {
          server.removeAllListeners('error');
          if (await isOwnInstance(port)) {
            resolve({ existing: true, port });
            return;
          }
          if (attemptsLeft > 0) {
            tryListen(port + 1, attemptsLeft - 1);
            return;
          }
        }
        reject(error);
      });
      server.listen(port, host, () => resolve({ existing: false, port }));
    };
    tryListen(desiredPort, 20);
  });

  if (listenPort.existing) {
    console.log('');
    console.log(`  检测到工具已在运行：http://${host}:${listenPort.port}`);
    console.log('  如需重启，请先关闭正在运行的服务窗口。');
    console.log('');
    process.exit(0);
  }

  const address = server.address();
  const url = `http://${host}:${address.port}`;
  console.log('');
  console.log('  视频号助手自动化上传工具已启动');
  console.log(`  面板地址: ${url}`);
  console.log(`  数据目录: ${PATHS.data}`);
  console.log(`  浏览器内核: ${settings.browser?.executablePath || settings.browser?.channel || 'Playwright chromium（内置）'}`);
  console.log('  按 Ctrl+C 停止');
  console.log('');

  // 启动后自动为还没有封面的视频补生成（后台执行，失败不影响服务）
  const missingThumbnail = db.get('SELECT COUNT(*) AS n FROM videos WHERE missing = 0 AND (thumb_path IS NULL OR thumb_path = \'\')');
  if (Number(missingThumbnail?.n || 0) > 0) {
    setTimeout(() => {
      try {
        thumbnails.startJob();
        console.log(`  正在后台生成视频封面（${missingThumbnail.n} 个）…`);
      } catch (error) {
        console.error('[thumbnails] 启动封面任务失败：', error?.message || error);
      }
    }, 2500).unref?.();
  }

  // 启动后自动为还没有 MD5 的视频计算 MD5
  const missingMd5 = db.get('SELECT COUNT(*) AS n FROM videos WHERE missing = 0 AND (md5 IS NULL OR md5 = \'\')');
  if (Number(missingMd5?.n || 0) > 0) {
    setTimeout(() => {
      try {
        videos.startMd5Job();
        console.log(`  正在后台计算视频 MD5（${missingMd5.n} 个）…`);
      } catch (error) {
        console.error('[md5] 启动 MD5 任务失败：', error?.message || error);
      }
    }, 4000).unref?.();
  }

  const shutdown = async () => {
    console.log('\n正在关闭…');
    try { await login.closeAll(); } catch { /* ignore */ }
    try { await browser.closeAll(); } catch { /* ignore */ }
    try { await thumbnails.close(); } catch { /* ignore */ }
    try { server.close(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (error) => console.error('[uncaught]', error));
  process.on('unhandledRejection', (error) => console.error('[unhandledRejection]', error));
}

main().catch((error) => {
  console.error('启动失败：', error);
  process.exit(1);
});
