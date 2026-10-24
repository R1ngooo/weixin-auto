import { getDb } from '../db.js';
import { getSettings } from '../settings.js';
import { nowIso, sleep, truncate, uid } from '../util.js';

const db = () => getDb();

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

const ACTIVE = new Set(['pending', 'running']);

export class TaskService {
  constructor({ picker, subjects, configs, publisher, wechat }) {
    this.picker = picker;
    this.subjects = subjects;
    this.configs = configs;
    this.publisher = publisher;
    this.wechat = wechat;
    this.runningTaskId = null;
    this.queue = [];
    this.cancelRequested = new Set();
    this.progressBuffers = new Map();
    this.finishWaiters = new Map();
  }

  resolveScope(config, subjectId) {
    const mode = config.pool?.scope || 'config';
    return mode === 'subject' ? `${config.id || 'adhoc'}:${subjectId}` : (config.id || 'adhoc');
  }

  create({ configId, overrides = {} }) {
    const record = this.configs.get(configId);
    if (!record) throw new Error('发布配置不存在');
    const config = { ...record.config };
    if (overrides.action === 'draft' || overrides.action === 'publish') config.action = overrides.action;
    const dryRun = Boolean(overrides.dryRun);
    // 演练测试环境：开启后演练模式照常计入素材使用状态与使用次数（默认不污染）
    const dryRunCountsUsage = Boolean(getSettings().testing?.dryRunCountsUsage);
    const dryRunPeek = dryRun && !dryRunCountsUsage;
    const allSubjects = this.configs.resolveSubjects(configId, this.subjects);
    const limit = Number(overrides.subjectLimit || 0);
    const subjectList = limit > 0 ? allSubjects.slice(0, limit) : allSubjects;
    if (!subjectList.length) throw new Error('该配置未关联任何主体，请先在配置中选择主体或标签');

    const id = uid('task_');
    const now = nowIso();
    const name = String(overrides.name || '').trim() || `${record.name} · ${new Date(now).toLocaleString('zh-CN', { hour12: false })}`;
    const items = [];
    let skipped = 0;

    for (const subject of subjectList) {
      const scope = this.resolveScope({ ...config, id: configId }, subject.id);
      const item = {
        id: uid('item_'),
        subject,
        video: null,
        text: null,
        pickError: null,
      };
      // 演练模式默认不消耗/不改变资源使用状态：使用 peek（只读预览）选择资源；
      // 若开启「演练测试环境」，则按正常任务选择（记录使用状态与次数）。
      const peekOptions = dryRunPeek ? {
        peek: true,
        peekOffset: items.filter((entry) => !entry.pickError).length,
        excludeIds: [
          ...items.map((entry) => entry.video?.id).filter(Boolean),
        ],
      } : {};
      const peekTextOptions = dryRunPeek ? {
        peek: true,
        peekOffset: items.filter((entry) => !entry.pickError).length,
        excludeIds: [
          ...items.map((entry) => entry.text?.id).filter(Boolean),
        ],
      } : {};
      try {
        item.video = this.picker.pickVideo({
          scope,
          strategy: config.videoSelection.strategy,
          tagIds: config.videoSelection.tags,
          fixedId: config.videoSelection.fixedVideoId,
          preferUnuploaded: config.videoSelection.preferUnuploaded,
          requireUploaded: config.videoSelection.requireUploaded,
          allowReset: config.pool.allowReset !== false,
          ...peekOptions,
        });
      } catch (error) {
        item.pickError = `视频选择失败：${error.message}`;
      }
      if (!item.pickError) {
        try {
          item.text = this.picker.pickText({
            scope,
            strategy: config.textSelection.strategy,
            tagIds: config.textSelection.tags,
            fixedId: config.textSelection.fixedTextId,
            preferUnuploaded: config.textSelection.preferUnuploaded,
            requireUploaded: config.textSelection.requireUploaded,
            allowReset: config.pool.allowReset !== false,
            ...peekTextOptions,
          });
        } catch (error) {
          item.pickError = `文本选择失败：${error.message}`;
        }
      }
      if (item.pickError) skipped += 1;
      items.push(item);
    }

    const runnable = items.filter((item) => !item.pickError);
    if (!runnable.length) {
      throw new Error(`没有可执行的主体：${items.map((item) => item.pickError).filter(Boolean)[0] || '资源池为空'}`);
    }

    db().transaction(() => {
      db().run(
        `INSERT INTO tasks (id, name, config_id, config_json, action, dry_run, status, total, skipped, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        id, name, configId, JSON.stringify(config), config.action, dryRun ? 1 : 0,
        runnable.length, skipped, now,
      );
      items.forEach((item, index) => {
        db().run(
          `INSERT INTO task_items (id, task_id, seq, subject_id, subject_name, video_id, video_name, text_id, text_preview,
                                  status, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          item.id, id, index + 1, item.subject.id, item.subject.name,
          item.video?.id || null, item.video?.name || null,
          item.text?.id || null, item.text ? truncate(item.text.content, 120) : null,
          item.pickError ? 'skipped' : 'pending', item.pickError,
        );
      });
    });
    return this.detail(id);
  }

  list({ page = 1, pageSize = 30 } = {}) {
    const limit = Math.max(1, Math.min(100, Number(pageSize) || 30));
    const offset = (Math.max(1, Number(page) || 1) - 1) * limit;
    const total = Number(db().get('SELECT COUNT(*) AS n FROM tasks')?.n || 0);
    const rows = db().all('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ? OFFSET ?', limit, offset);
    return { data: rows.map((row) => this.decorate(row)), total, page: Number(page) || 1, pageSize: limit };
  }

  decorate(row) {
    return {
      id: row.id,
      name: row.name,
      configId: row.config_id,
      action: row.action,
      dryRun: !!row.dry_run,
      status: row.status,
      total: Number(row.total || 0),
      succeeded: Number(row.succeeded || 0),
      failed: Number(row.failed || 0),
      canceled: Number(row.canceled || 0),
      skipped: Number(row.skipped || 0),
      unknownCount: Number(row.unknown_count || 0),
      syncStatus: row.sync_status || '',
      syncError: row.sync_error || '',
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
  }

  detail(id) {
    const row = db().get('SELECT * FROM tasks WHERE id = ?', id);
    if (!row) return null;
    const items = db().all('SELECT * FROM task_items WHERE task_id = ? ORDER BY seq', id).map((item) => ({
      id: item.id,
      seq: Number(item.seq),
      subjectId: item.subject_id,
      subjectName: item.subject_name,
      videoId: item.video_id,
      videoName: item.video_name,
      textId: item.text_id,
      textPreview: item.text_preview,
      status: item.status,
      step: item.step || '',
      progress: item.progress || '',
      error: item.error || '',
      logs: parseJson(item.logs_json, []),
      screenshot: item.screenshot || '',
      postId: item.post_id || '',
      startedAt: item.started_at,
      finishedAt: item.finished_at,
    }));
    return {
      ...this.decorate(row),
      config: parseJson(row.config_json, null),
      items,
      running: this.runningTaskId === id,
      queued: this.queue.includes(id),
    };
  }

  start(id) {
    const task = this.detail(id);
    if (!task) throw new Error('任务不存在');
    if (!ACTIVE.has(task.status)) throw new Error('该任务已结束，无法重复执行');
    if (this.runningTaskId === id) return task;
    if (this.runningTaskId) {
      if (!this.queue.includes(id)) this.queue.push(id);
      return this.detail(id);
    }
    this.runningTaskId = id;
    this.run(id).catch((error) => {
      db().run('UPDATE tasks SET status = ?, finished_at = ? WHERE id = ?', 'failed', nowIso(), id);
      console.error('[task] 执行异常', error);
    }).finally(() => {
      this.runningTaskId = null;
      const next = this.queue.shift();
      if (next) {
        this.runningTaskId = next;
        this.run(next).finally(() => { this.runningTaskId = null; });
      }
    });
    return this.detail(id);
  }

  cancel(id) {
    const task = this.detail(id);
    if (!task) throw new Error('任务不存在');
    this.cancelRequested.add(id);
    this.queue = this.queue.filter((queued) => queued !== id);
    if (!task.running) {
      db().run(
        `UPDATE task_items SET status = 'cancelled', finished_at = ? WHERE task_id = ? AND status = 'pending'`,
        nowIso(), id,
      );
      this.finalize(id, 'cancelled');
    }
    return this.detail(id);
  }

  async run(taskId) {
    const task = this.detail(taskId);
    if (!task) return;
    db().run('UPDATE tasks SET status = ?, started_at = COALESCE(started_at, ?) WHERE id = ?', 'running', nowIso(), taskId);
    const items = db().all("SELECT * FROM task_items WHERE task_id = ? AND status = 'pending' ORDER BY seq", taskId);
    const configRecord = task.config;
    const config = { ...this.configs.get(task.configId)?.config, ...(configRecord || {}) };
    config.action = task.action;
    const dryRun = task.dryRun;

    for (const item of items) {
      if (this.cancelRequested.has(taskId)) {
        db().run(
          `UPDATE task_items SET status = 'cancelled', finished_at = ? WHERE id = ?`,
          nowIso(), item.id,
        );
        continue;
      }
      await this.runItem(taskId, item, config, dryRun);
    }
    this.cancelRequested.delete(taskId);
    this.finalize(taskId);
    await this.syncWechat(taskId);
  }

  async runItem(taskId, item, config, dryRun) {
    const itemId = item.id;
    const startedAt = nowIso();
    const logs = [];
    let lastPersist = 0;
    const persist = (patch = {}) => {
      db().run(
        `UPDATE task_items SET step = COALESCE(?, step), progress = COALESCE(?, progress), logs_json = ?, error = COALESCE(?, error), status = COALESCE(?, status) WHERE id = ?`,
        patch.step || null,
        patch.progress || null,
        JSON.stringify(logs.slice(-200)),
        patch.error || null,
        patch.status || null,
        itemId,
      );
    };
    db().run(
      `UPDATE task_items SET status = 'running', started_at = ?, step = 'open', progress = '正在打开浏览器…' WHERE id = ?`,
      startedAt, itemId,
    );

    const subject = this.subjects.get(item.subject_id);
    if (!subject) {
      db().run("UPDATE task_items SET status = 'failed', error = '主体已删除', finished_at = ? WHERE id = ?", nowIso(), itemId);
      return;
    }
    const video = this.dbVideo(item.video_id);
    const text = this.dbText(item.text_id);
    if (!video || !text) {
      db().run("UPDATE task_items SET status = 'failed', error = '视频或文本资源已删除', finished_at = ? WHERE id = ?", nowIso(), itemId);
      return;
    }

    const onProgress = (payload) => {
      const entry = { t: new Date().toISOString().slice(11, 19), step: payload.step || '', message: truncate(payload.message || '', 300) };
      if (logs.length && logs[logs.length - 1].message === entry.message) return;
      logs.push(entry);
      const now = Date.now();
      if (now - lastPersist > 1200 || payload.step === 'submit') {
        lastPersist = now;
        persist({ step: payload.step, progress: entry.message });
      }
    };

    let result;
    try {
      result = await this.publisher.runItem({
        subjectId: subject.id,
        video: { id: video.id, path: video.path, name: video.name },
        text: { id: text.id, content: text.content },
        config,
        taskId,
        itemId,
        dryRun,
        onProgress,
        signal: { get aborted() { return false; } },
      });
    } catch (error) {
      result = { status: 'failed', message: String(error?.message || error), warnings: [], notes: [], screenshot: null };
    }
    for (const warning of result.warnings || []) logs.push({ t: new Date().toISOString().slice(11, 19), step: 'warn', message: warning });
    for (const note of result.notes || []) logs.push({ t: new Date().toISOString().slice(11, 19), step: 'note', message: note });
    if (result.message) logs.push({ t: new Date().toISOString().slice(11, 19), step: 'result', message: result.message });

    const status = ['success', 'unknown', 'failed', 'cancelled'].includes(result.status) ? result.status : 'failed';
    db().run(
      `UPDATE task_items SET status = ?, step = 'done', progress = ?, logs_json = ?, error = ?, screenshot = ?, post_id = ?, finished_at = ? WHERE id = ?`,
      status,
      truncate(result.message || '', 300),
      JSON.stringify(logs.slice(-200)),
      status === 'failed' ? truncate(result.message || '', 600) : null,
      result.screenshot || null,
      result.postId || null,
      nowIso(),
      itemId,
    );
    // 演练模式默认不记录上传历史（避免污染「已上传/使用次数」统计）；
    // 若开启「演练测试环境」，则照常记录，便于验证前端显示效果。
    const recordHistory = !dryRun || Boolean(getSettings().testing?.dryRunCountsUsage);
    if (recordHistory && (status === 'success' || status === 'unknown')) {
      db().run(
        `INSERT INTO upload_history (subject_id, video_id, text_id, task_id, item_id, action, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        subject.id, video.id, text.id, taskId, itemId, config.action, status, nowIso(),
      );
    }
    await sleep(400);
  }

  dbVideo(id) {
    if (!id) return null;
    const row = db().get('SELECT * FROM videos WHERE id = ?', id);
    return row ? { id: Number(row.id), path: row.path, name: row.name } : null;
  }

  dbText(id) {
    if (!id) return null;
    const row = db().get('SELECT * FROM texts WHERE id = ?', id);
    return row ? { id: Number(row.id), content: row.content } : null;
  }

  finalize(taskId, forceStatus = null) {
    const items = db().all('SELECT status, COUNT(*) AS n FROM task_items WHERE task_id = ? GROUP BY status', taskId);
    const counts = Object.fromEntries(items.map((row) => [row.status, Number(row.n)]));
    const succeeded = counts.success || 0;
    const failed = counts.failed || 0;
    const unknown = counts.unknown || 0;
    const cancelled = counts.cancelled || 0;
    const runnable = succeeded + failed + unknown + cancelled;
    let status = forceStatus;
    if (!status) {
      if (runnable === 0) status = 'failed';
      else if (cancelled > 0 && succeeded === 0 && failed === 0 && unknown === 0) status = 'cancelled';
      else if (failed === 0 && unknown === 0 && cancelled === 0) status = 'success';
      else if (succeeded === 0 && unknown === 0) status = 'failed';
      else status = 'partial';
    }
    db().run(
      `UPDATE tasks SET status = ?, succeeded = ?, failed = ?, canceled = ?, unknown_count = ?, finished_at = ? WHERE id = ?`,
      status, succeeded, failed, cancelled, unknown, nowIso(), taskId,
    );
    return this.detail(taskId);
  }

  async syncWechat(taskId) {
    const task = this.detail(taskId);
    if (!task) return;
    const settings = getSettings();
    if (!task.config?.syncWechat || !settings.wechat?.enabled || !this.wechat?.isConfigured()) return;
    const lines = [
      '【视频号助手 · 执行结果】',
      `任务：${task.name}`,
      `状态：${statusText(task.status)}`,
      `成功 ${task.succeeded} / 失败 ${task.failed} / 待确认 ${task.unknownCount} / 跳过 ${task.skipped}`,
      `时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    ];
    const failures = task.items.filter((item) => item.status === 'failed').slice(0, 5);
    for (const item of failures) lines.push(`✗ ${item.subjectName}：${truncate(item.error || item.progress || '执行失败', 80)}`);
    try {
      await this.wechat.sendText(lines.join('\n'));
      db().run('UPDATE tasks SET sync_status = ?, sync_error = NULL WHERE id = ?', 'success', taskId);
    } catch (error) {
      db().run('UPDATE tasks SET sync_status = ?, sync_error = ? WHERE id = ?', 'failed', String(error?.message || error), taskId);
    }
  }

  async waitForIdle() {
    while (this.runningTaskId) await sleep(500);
  }
}

export function statusText(status) {
  return {
    pending: '待执行',
    running: '执行中',
    success: '成功',
    partial: '部分成功',
    failed: '失败',
    cancelled: '已取消',
  }[status] || status;
}
