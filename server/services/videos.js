import fsp from 'node:fs/promises';
import path from 'node:path';
import { getDb } from '../db.js';
import { getSettings } from '../settings.js';
import { md5File, nowIso, toInt } from '../util.js';
import { attachTags, hydrateTags } from './subjects.js';

const db = () => getDb();

const VIDEO_STATS_SQL = `
  SELECT h.video_id AS id, COUNT(*) AS upload_count, MAX(h.created_at) AS last_uploaded_at
    FROM upload_history h
   WHERE h.video_id IS NOT NULL AND h.status IN ('success', 'unknown')
   GROUP BY h.video_id
`;

export class VideoService {
  constructor({ jobs } = {}) {
    this.jobs = jobs;
  }

  ensureFoldersFromSettings() {
    const folders = getSettings().video?.folders || [];
    const count = db().get('SELECT COUNT(*) AS n FROM video_folders');
    if (Number(count?.n || 0) > 0) return;
    const now = nowIso();
    for (const folder of folders) {
      if (!folder?.trim()) continue;
      try {
        db().run('INSERT OR IGNORE INTO video_folders (path, recursive, enabled, created_at) VALUES (?, 1, 1, ?)', folder.trim(), now);
      } catch { /* ignore */ }
    }
  }

  folders() {
    return db().all('SELECT * FROM video_folders ORDER BY id').map((row) => {
      let tagIds = [];
      try { tagIds = row.tag_ids ? JSON.parse(row.tag_ids) : []; } catch { tagIds = []; }
      const tags = tagIds.length
        ? db().all(
          `SELECT id, name, color FROM tags WHERE id IN (${tagIds.map(() => '?').join(',')}) ORDER BY name`,
          ...tagIds,
        )
        : [];
      return {
        id: Number(row.id),
        path: row.path,
        recursive: Boolean(row.recursive),
        enabled: Boolean(row.enabled),
        createdAt: row.created_at,
        tagIds: tags.map((tag) => Number(tag.id)),
        tags,
      };
    });
  }

  addFolder(folderPath, recursive = 1, tagIds = []) {
    const value = String(folderPath || '').trim();
    if (!value) throw new Error('文件夹路径不能为空');
    const cleanTags = [...new Set((tagIds || []).map((id) => Number(id)).filter((id) => id > 0))];
    db().run(
      `INSERT INTO video_folders (path, recursive, enabled, tag_ids, created_at) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(path) DO UPDATE SET recursive = excluded.recursive, tag_ids = excluded.tag_ids`,
      path.resolve(value), recursive ? 1 : 0, JSON.stringify(cleanTags), nowIso(),
    );
    return this.folders();
  }

  updateFolder(id, { recursive, enabled, tagIds } = {}) {
    const row = db().get('SELECT * FROM video_folders WHERE id = ?', id);
    if (!row) throw new Error('文件夹不存在');
    let nextTags = row.tag_ids;
    if (Array.isArray(tagIds)) {
      nextTags = JSON.stringify([...new Set(tagIds.map((value) => Number(value)).filter((value) => value > 0))]);
    }
    db().run(
      'UPDATE video_folders SET recursive = ?, enabled = ?, tag_ids = ? WHERE id = ?',
      recursive !== undefined ? (recursive ? 1 : 0) : row.recursive,
      enabled !== undefined ? (enabled ? 1 : 0) : row.enabled,
      nextTags,
      id,
    );
    return this.folders();
  }

  removeFolder(id) {
    db().run('DELETE FROM video_folders WHERE id = ?', id);
    return this.folders();
  }

  list({ tagIds = [], query = '', uploaded = '', page = 1, pageSize = 50, sort = 'newest' } = {}) {
    const where = ['v.removed = 0'];
    const params = [];
    if (query) {
      where.push(`(v.name LIKE ? OR v.md5 LIKE ? OR v.path LIKE ?
        OR EXISTS (SELECT 1 FROM video_tags vt JOIN tags t ON t.id = vt.tag_id WHERE vt.video_id = v.id AND t.name LIKE ?))`);
      const like = `%${query}%`;
      params.push(like, like, like, like);
    }
    if (uploaded === 'yes') where.push('v.id IN (SELECT video_id FROM upload_history WHERE status IN (\'success\',\'unknown\'))');
    if (uploaded === 'no') where.push("v.id NOT IN (SELECT video_id FROM upload_history WHERE video_id IS NOT NULL AND status IN ('success','unknown'))");
    if (tagIds.length) {
      where.push(`v.id IN (SELECT video_id FROM video_tags WHERE tag_id IN (${tagIds.map(() => '?').join(',')}))`);
      params.push(...tagIds);
    }
    const order = sort === 'name' ? 'v.name ASC' : sort === 'size' ? 'v.size DESC' : 'v.updated_at DESC, v.id DESC';
    const limit = Math.max(1, Math.min(500, toInt(pageSize, 50)));
    const offset = (Math.max(1, toInt(page, 1)) - 1) * limit;
    const total = Number(db().get(`SELECT COUNT(*) AS n FROM videos v ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, ...params)?.n || 0);
    const rows = db().all(
      `SELECT v.* FROM videos v ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ? OFFSET ?`,
      ...params, limit, offset,
    );
    const hydrated = hydrateTags('video', rows);
    const statsRows = db().all(VIDEO_STATS_SQL);
    const stats = new Map(statsRows.map((row) => [Number(row.id), row]));
    const data = hydrated.map((row) => {
      const stat = stats.get(Number(row.id));
      return {
        id: Number(row.id),
        path: row.path,
        name: row.name,
        ext: row.ext,
        size: Number(row.size || 0),
        md5: row.md5 || '',
        mtimeMs: Number(row.mtime_ms || 0),
        folder: row.folder || '',
        missing: Boolean(row.missing),
        removed: Boolean(row.removed),
        tags: row.tags,
        hasThumbnail: Boolean(row.thumb_path),
        thumbnailUrl: row.thumb_path ? `/api/videos/${Number(row.id)}/thumbnail?v=${Number(row.thumb_updated_at || 0) || Number(row.mtime_ms || 0)}` : '',
        uploadCount: Number(stat?.upload_count || 0),
        lastUploadedAt: stat?.last_uploaded_at || '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        exists: !row.missing,
      };
    });
    return { data, total, page: Math.max(1, toInt(page, 1)), pageSize: limit };
  }

  all({ tagIds = [], uploaded = '', missing = false } = {}) {
    const where = ['v.missing = ' + (missing ? 1 : 0), 'v.removed = 0'];
    const params = [];
    if (tagIds.length) {
      where.push(`v.id IN (SELECT video_id FROM video_tags WHERE tag_id IN (${tagIds.map(() => '?').join(',')}))`);
      params.push(...tagIds);
    }
    if (uploaded === 'yes') where.push('v.id IN (SELECT video_id FROM upload_history WHERE status IN (\'success\',\'unknown\'))');
    if (uploaded === 'no') where.push("v.id NOT IN (SELECT video_id FROM upload_history WHERE video_id IS NOT NULL AND status IN ('success','unknown'))");
    const rows = db().all(`SELECT v.* FROM videos v WHERE ${where.join(' AND ')} ORDER BY v.id`, ...params);
    const stats = new Map(db().all(VIDEO_STATS_SQL).map((row) => [Number(row.id), row]));
    return hydrateTags('video', rows).map((row) => ({
      id: Number(row.id), path: row.path, name: row.name, size: Number(row.size || 0), md5: row.md5 || '',
      tags: row.tags, uploadCount: Number(stats.get(Number(row.id))?.upload_count || 0),
    }));
  }

  get(id) {
    const row = db().get('SELECT * FROM videos WHERE id = ?', id);
    if (!row) return null;
    const tags = hydrateTags('video', [row])[0].tags;
    return {
      ...row,
      id: Number(row.id),
      hasThumbnail: Boolean(row.thumb_path),
      thumbnailUrl: row.thumb_path ? `/api/videos/${Number(row.id)}/thumbnail?v=${Number(row.thumb_updated_at || 0)}` : '',
      tags,
    };
  }

  count() {
    return Number(db().get('SELECT COUNT(*) AS n FROM videos WHERE removed = 0')?.n || 0);
  }

  async scan({ signal, progress } = {}) {
    this.ensureFoldersFromSettings();
    const settings = getSettings();
    const extensions = (settings.video?.extensions || []).map((ext) => ext.toLowerCase());
    const processed = new Set();
    const now = nowIso();
    let added = 0;
    let updated = 0;
    let archived = 0;
    let found = 0;

    const folders = db().all('SELECT * FROM video_folders WHERE enabled = 1');
    const existing = db().all('SELECT id, path, size, mtime_ms, md5, removed FROM videos');
    const existingMap = new Map(existing.map((row) => [row.path, row]));

    for (const folder of folders) {
      if (signal?.aborted) throw new Error('已取消');
      const folderPath = folder.path;
      const stack = [folderPath];
      const files = [];
      while (stack.length) {
        const current = stack.pop();
        let entries;
        try {
          entries = await fsp.readdir(current, { withFileTypes: true });
        } catch { continue; }
        for (const entry of entries) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) {
            if (folder.recursive) stack.push(full);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (extensions.includes(ext)) files.push(full);
          }
        }
      }
      progress?.(0, `扫描 ${folderPath}（${files.length} 个候选文件）`);
      let index = 0;
      for (const file of files) {
        if (signal?.aborted) throw new Error('已取消');
        index += 1;
        found += 1;
        processed.add(file);
        let stat;
        try {
          stat = await fsp.stat(file);
        } catch { continue; }
        const previous = existingMap.get(file);
        const name = path.basename(file);
        const ext = path.extname(file).toLowerCase();
        const size = stat.size;
        const mtime = Math.round(stat.mtimeMs);
        if (!previous) {
          // 新文件：先算 MD5，再用 MD5 关联此前「已移除/文件丢失」的历史记录，
          // 保留其标签、上传历史、使用次数等数据（视频名称仅作展示参考）
          let md5 = '';
          try { md5 = await md5File(file); } catch { md5 = ''; }
          const matched = md5
            ? db().get(
              `SELECT * FROM videos WHERE md5 = ? AND (removed = 1 OR missing = 1)
               AND id NOT IN (SELECT id FROM videos WHERE path = ?) ORDER BY id LIMIT 1`,
              md5, file,
            )
            : null;
          if (matched) {
            db().run(
              `UPDATE videos SET path = ?, name = ?, ext = ?, size = ?, mtime_ms = ?, folder = ?, missing = 0,
                 removed = 0, removed_at = NULL, md5 = ?, updated_at = ?, last_seen_at = ? WHERE id = ?`,
              file, name, ext, size, mtime, folderPath, md5, now, now, matched.id,
            );
            archived += 1;
          } else {
            db().run(
              `INSERT OR IGNORE INTO videos (path, name, ext, size, md5, mtime_ms, folder, missing, removed, created_at, updated_at, last_seen_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
              file, name, ext, size, md5 || null, mtime, folderPath, now, now, now,
            );
            added += 1;
          }
        } else {
          const changed = Number(previous.size || 0) !== size || Number(previous.mtime_ms || 0) !== mtime;
          let md5 = previous.md5 || '';
          if (changed || !md5) {
            try { md5 = await md5File(file); } catch { /* 保持原值 */ }
          }
          db().run(
            `UPDATE videos SET name = ?, ext = ?, size = ?, mtime_ms = ?, folder = ?, missing = 0, removed = 0, removed_at = NULL,
               md5 = ?, updated_at = ?, last_seen_at = ?
             ${changed ? ', thumb_path = NULL, thumb_updated_at = NULL' : ''}
             WHERE path = ?`,
            name, ext, size, mtime, folderPath, md5 || null, changed ? now : (previous.updated_at || now), now, file,
          );
          if (previous.removed) archived += 1;
          else if (changed) updated += 1;
        }
        if (index % 20 === 0) progress?.(index / files.length, `扫描中 ${index}/${files.length}`);
      }
      // 文件夹预设标签：扫描时自动给该文件夹下的视频打上标签
      let folderTags = [];
      try { folderTags = folder.tag_ids ? JSON.parse(folder.tag_ids) : []; } catch { folderTags = []; }
      for (const tagId of folderTags.map((id) => Number(id)).filter((id) => id > 0)) {
        try {
          db().run(
            'INSERT OR IGNORE INTO video_tags (video_id, tag_id) SELECT id, ? FROM videos WHERE folder = ?',
            tagId, folderPath,
          );
        } catch { /* 标签可能已删除 */ }
      }
    }

    // 标记丢失文件
    let missing = 0;
    for (const row of db().all('SELECT id, path, missing FROM videos')) {
      if (processed.has(row.path)) continue;
      const stillExists = await fsp.access(row.path).then(() => true).catch(() => false);
      if (!stillExists) {
        if (!row.missing) {
          db().run('UPDATE videos SET missing = 1, updated_at = ? WHERE id = ?', now, row.id);
          missing += 1;
        }
      } else if (row.missing) {
        db().run('UPDATE videos SET missing = 0, updated_at = ? WHERE id = ?', now, row.id);
      }
    }
    return { added, updated, archived, missing, total: this.count(), folders: folders.length };
  }

  startScanJob({ onDone = null } = {}) {
    if (!this.jobs) throw new Error('任务系统不可用');
    return this.jobs.start('扫描视频文件夹', async (ctx) => {
      const result = await this.scan({ signal: ctx.signal, progress: ctx.progress });
      ctx.setResult(result);
      ctx.setMessage(`完成：新增 ${result.added}，恢复 ${result.archived || 0}，更新 ${result.updated}，丢失 ${result.missing}`);
      return result;
    }, {
      onDone: (job) => {
        try { onDone?.(job); } catch { /* 忽略回调异常 */ }
      },
    });
  }

  async computeMd5(id) {
    const video = this.get(id);
    if (!video) throw new Error('视频不存在');
    const exists = await fsp.access(video.path).then(() => true).catch(() => false);
    if (!exists) throw new Error('视频文件不存在');
    const md5 = await md5File(video.path);
    db().run('UPDATE videos SET md5 = ?, updated_at = ? WHERE id = ?', md5, nowIso(), id);
    return md5;
  }

  startMd5Job(ids = null) {
    if (!this.jobs) throw new Error('任务系统不可用');
    return this.jobs.start('计算视频 MD5', async (ctx) => {
      const rows = ids?.length
        ? db().all(`SELECT id, path FROM videos WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)
        : db().all('SELECT id, path FROM videos WHERE md5 IS NULL OR md5 = \'\' ORDER BY id');
      ctx.setTotal(rows.length);
      let done = 0;
      let failed = 0;
      for (const row of rows) {
        if (ctx.signal.aborted) throw new Error('已取消');
        try {
          const exists = await fsp.access(row.path).then(() => true).catch(() => false);
          if (!exists) { failed += 1; continue; }
          const md5 = await md5File(row.path);
          db().run('UPDATE videos SET md5 = ?, updated_at = ? WHERE id = ?', md5, nowIso(), row.id);
        } catch {
          failed += 1;
        }
        done += 1;
        ctx.progress(rows.length ? done / rows.length : 1, `已计算 ${done}/${rows.length}`);
      }
      const result = { total: rows.length, done, failed };
      ctx.setResult(result);
      return result;
    });
  }

  setTags(id, tagIds) {
    attachTags('video', id, tagIds);
    return this.get(id);
  }

  /**
   * 从视频池移除：仅做软移除（数据库记录、标签、上传历史、使用次数全部保留），
   * 重新扫描入库时会按 MD5 关联回原记录。可选同时删除本地视频文件。
   */
  remove(id, { deleteFile = false } = {}) {
    const video = this.get(id);
    if (!video) return false;
    if (deleteFile) {
      // 仅在确认是视频文件时删除
      if (/\.(mp4|mov|m4v|avi|wmv|flv|mkv|webm)$/i.test(video.path)) {
        fsp.rm(video.path, { force: true }).catch(() => undefined);
      }
    }
    const now = nowIso();
    db().run(
      'UPDATE videos SET removed = 1, removed_at = ?, missing = ?, updated_at = ? WHERE id = ?',
      now, deleteFile ? 1 : video.missing ? 1 : 0, now, id,
    );
    return true;
  }

  ensureDataDirs() {
    return undefined;
  }
}
