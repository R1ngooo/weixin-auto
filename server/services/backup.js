import fsp from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from '../config.js';
import { getDb } from '../db.js';
import { exportableSettings, getSettings, replaceSettings, updateSettings } from '../settings.js';
import { ensureDir, nowIso } from '../util.js';

const db = () => getDb();

const EXPORT_VERSION = 2;

/** 检查导入路径：视频必须是存在的文件，文件夹必须是存在的目录 */
async function checkPath(target, type) {
  const value = String(target || '').trim();
  if (!value) return { ok: false, path: '', reason: '缺少本地路径' };
  const resolved = path.resolve(value);
  try {
    const stat = await fsp.stat(resolved);
    const ok = type === 'file' ? stat.isFile() : stat.isDirectory();
    return { ok, path: resolved, reason: ok ? '' : (type === 'file' ? '路径不是文件' : '路径不是文件夹') };
  } catch {
    return { ok: false, path: resolved, reason: '本地路径不存在' };
  }
}

export class BackupService {
  async exportAll({ include = {} } = {}) {
    const payload = {
      app: 'weixin-auto',
      version: EXPORT_VERSION,
      exportedAt: nowIso(),
      settings: include.settings === false ? undefined : exportableSettings().settings,
      tagGroups: include.tags === false ? undefined : db().all(
        'SELECT id, name, color, note, selection_mode, sort_order FROM tag_groups ORDER BY sort_order, id',
      ),
      tags: include.tags === false ? undefined : db().all('SELECT id, name, color, note, group_id, created_at FROM tags'),
      subjects: include.subjects === false ? undefined : db().all(
        `SELECT id, name, note, avatar_url, wechat_id, wechat_nickname, finder_username, finder_nickname,
                identity_key, status, last_login_at, created_at, updated_at FROM subjects`,
      ),
      subjectTags: include.subjects === false ? undefined : db().all('SELECT subject_id, tag_id FROM subject_tags'),
      videoFolders: include.videos === false ? undefined : db().all('SELECT path, recursive, enabled, tag_ids FROM video_folders'),
      videos: include.videos === false ? undefined : db().all('SELECT id, path, name, ext, size, md5, folder FROM videos'),
      videoTags: include.videos === false ? undefined : db().all('SELECT video_id, tag_id FROM video_tags'),
      texts: include.texts === false ? undefined : db().all('SELECT id, content, hash, note FROM texts'),
      textTags: include.texts === false ? undefined : db().all('SELECT text_id, tag_id FROM text_tags'),
      publishConfigs: include.publishConfigs === false ? undefined : db().all('SELECT id, name, config_json, created_at, updated_at FROM publish_configs'),
    };
    return payload;
  }

  async saveExport(payload) {
    await ensureDir(PATHS.backups);
    const file = path.join(PATHS.backups, `weixin-auto-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await fsp.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
    return file;
  }

  async importAll(payload, { mode = 'merge' } = {}) {
    if (!payload || typeof payload !== 'object') throw new Error('导入文件格式不正确');
    if (payload.app && payload.app !== 'weixin-auto') throw new Error('不是本工具导出的配置文件');
    const stats = { tagGroups: 0, tags: 0, subjects: 0, videos: 0, videosSkipped: 0, texts: 0, publishConfigs: 0, folders: 0, foldersSkipped: 0 };
    const warnings = [];
    // 先检查视频/文件夹的本地路径：目标机器没有的条目跳过并提示，不产生半导入数据
    const videoPrepared = [];
    for (const video of payload.videos || []) {
      const checked = await checkPath(video.path, 'file');
      if (!checked.ok) {
        stats.videosSkipped += 1;
        warnings.push({ type: 'video', name: video.name || path.basename(checked.path || String(video.path || '')), path: checked.path || String(video.path || ''), reason: checked.reason });
        continue;
      }
      videoPrepared.push({ ...video, path: checked.path });
    }
    const folderPrepared = [];
    for (const folder of payload.videoFolders || []) {
      const checked = await checkPath(folder.path, 'folder');
      if (!checked.ok) {
        stats.foldersSkipped += 1;
        warnings.push({ type: 'folder', name: path.basename(checked.path || String(folder.path || '')), path: checked.path || String(folder.path || ''), reason: checked.reason });
        continue;
      }
      folderPrepared.push({ ...folder, path: checked.path });
    }
    const tagIdMap = new Map();
    const groupIdMap = new Map();

    db().transaction(() => {
      if (mode === 'replace') {
        db().run('DELETE FROM publish_configs');
        db().run('DELETE FROM subject_tags');
        db().run('DELETE FROM video_tags');
        db().run('DELETE FROM text_tags');
        db().run('DELETE FROM tags');
        db().run('DELETE FROM tag_groups');
      }
      // 标签组：按名称合并（旧备份没有标签组时归入「未分组」）
      const existingGroups = new Map(db().all('SELECT id, name FROM tag_groups').map((row) => [row.name, Number(row.id)]));
      for (const group of payload.tagGroups || []) {
        const name = String(group.name || '').trim();
        if (!name) continue;
        let groupId = existingGroups.get(name);
        if (!groupId) {
          const now = nowIso();
          const info = db().run(
            'INSERT INTO tag_groups (name, color, note, selection_mode, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            name, group.color || '#6c5ce7', group.note || '', group.selection_mode === 'single' ? 'single' : 'multiple',
            Number(group.sort_order || 0), now, now,
          );
          groupId = Number(info.lastInsertRowid);
          existingGroups.set(name, groupId);
          stats.tagGroups += 1;
        }
        groupIdMap.set(Number(group.id), groupId);
      }
      let fallbackGroupId = existingGroups.values().next().value || null;
      if (!fallbackGroupId) {
        const now = nowIso();
        const info = db().run(
          'INSERT INTO tag_groups (name, color, note, selection_mode, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          '未分组', '#8c8c99', '系统默认分组', 'multiple', 0, now, now,
        );
        fallbackGroupId = Number(info.lastInsertRowid);
        existingGroups.set('未分组', fallbackGroupId);
      }
      // 标签：按名称合并
      for (const tag of payload.tags || []) {
        const mappedGroupId = tag.group_id ? (groupIdMap.get(Number(tag.group_id)) || fallbackGroupId) : fallbackGroupId;
        let existing = db().get('SELECT id FROM tags WHERE name = ?', tag.name);
        if (!existing) {
          const info = db().run('INSERT INTO tags (name, color, note, group_id, created_at) VALUES (?, ?, ?, ?, ?)',
            tag.name, tag.color || '#fa9d3b', tag.note || '', mappedGroupId, nowIso());
          existing = { id: Number(info.lastInsertRowid) };
          stats.tags += 1;
        }
        tagIdMap.set(Number(tag.id), Number(existing.id));
      }
      const remapFolderTags = (raw) => {
        let ids = [];
        try { ids = JSON.parse(raw || '[]'); } catch { ids = []; }
        if (!Array.isArray(ids)) return null;
        const mapped = [...new Set(ids.map((id) => tagIdMap.get(Number(id))).filter(Boolean))];
        return JSON.stringify(mapped);
      };
      // 视频文件夹
      for (const folder of folderPrepared) {
        try {
          const tagIds = folder.tag_ids !== undefined ? remapFolderTags(folder.tag_ids) : null;
          db().run('INSERT OR IGNORE INTO video_folders (path, recursive, enabled, tag_ids, created_at) VALUES (?, ?, ?, ?, ?)',
            folder.path, folder.recursive ? 1 : 0, folder.enabled ? 1 : 0, tagIds, nowIso());
          if (tagIds && db().get('SELECT id FROM video_folders WHERE path = ?', folder.path)) {
            db().run('UPDATE video_folders SET tag_ids = ? WHERE path = ?', tagIds, folder.path);
          }
          stats.folders += 1;
        } catch { /* ignore */ }
      }
      // 视频（按路径合并）
      const videoIdMap = new Map();
      for (const video of videoPrepared) {
        const existing = db().get('SELECT id FROM videos WHERE path = ?', video.path);
        let id;
        if (existing) {
          id = Number(existing.id);
        } else {
          const info = db().run(
            `INSERT INTO videos (path, name, ext, size, md5, folder, missing, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
            video.path, video.name, video.ext, video.size || 0, video.md5 || null, video.folder || '', nowIso(), nowIso(),
          );
          id = Number(info.lastInsertRowid);
          stats.videos += 1;
        }
        videoIdMap.set(Number(video.id), id);
      }
      for (const rel of payload.videoTags || []) {
        const videoId = videoIdMap.get(Number(rel.video_id));
        const tagId = tagIdMap.get(Number(rel.tag_id));
        if (videoId && tagId) db().run('INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?, ?)', videoId, tagId);
      }
      // 文本（按 hash 合并）
      const textIdMap = new Map();
      for (const text of payload.texts || []) {
        const existing = db().get('SELECT id FROM texts WHERE hash = ?', text.hash);
        let id;
        if (existing) id = Number(existing.id);
        else {
          const info = db().run('INSERT INTO texts (content, hash, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
            text.content, text.hash, text.note || '', nowIso(), nowIso());
          id = Number(info.lastInsertRowid);
          stats.texts += 1;
        }
        textIdMap.set(Number(text.id), id);
      }
      for (const rel of payload.textTags || []) {
        const textId = textIdMap.get(Number(rel.text_id));
        const tagId = tagIdMap.get(Number(rel.tag_id));
        if (textId && tagId) db().run('INSERT OR IGNORE INTO text_tags (text_id, tag_id) VALUES (?, ?)', textId, tagId);
      }
      // 主体（按 identity_key 或 id 合并）
      const subjectIdMap = new Map();
      for (const subject of payload.subjects || []) {
        const existing = (subject.identity_key && db().get('SELECT id FROM subjects WHERE identity_key = ?', subject.identity_key))
          || db().get('SELECT id FROM subjects WHERE id = ?', subject.id);
        let id;
        if (existing) {
          id = existing.id;
          db().run(
            `UPDATE subjects SET name = COALESCE(NULLIF(?, ''), name), note = COALESCE(?, note), avatar_url = COALESCE(?, avatar_url),
                    wechat_id = COALESCE(?, wechat_id), wechat_nickname = COALESCE(?, wechat_nickname),
                    finder_username = COALESCE(?, finder_username), finder_nickname = COALESCE(?, finder_nickname),
                    identity_key = COALESCE(?, identity_key), updated_at = ? WHERE id = ?`,
            subject.name || '', subject.note || null, subject.avatar_url || null, subject.wechat_id || null,
            subject.wechat_nickname || null, subject.finder_username || null, subject.finder_nickname || null,
            subject.identity_key || null, nowIso(), id,
          );
        } else {
          id = subject.id;
          db().run(
            `INSERT INTO subjects (id, name, note, avatar_url, wechat_id, wechat_nickname, finder_username, finder_nickname,
                                   identity_key, profile_dir, status, last_login_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id, subject.name, subject.note || '', subject.avatar_url || null, subject.wechat_id || null,
            subject.wechat_nickname || null, subject.finder_username || null, subject.finder_nickname || null,
            subject.identity_key || null, `profiles/${id}`, subject.status || 'unknown',
            subject.last_login_at || null, subject.created_at || nowIso(), nowIso(),
          );
          stats.subjects += 1;
        }
        subjectIdMap.set(String(subject.id), id);
      }
      for (const rel of payload.subjectTags || []) {
        const subjectId = subjectIdMap.get(String(rel.subject_id));
        const tagId = tagIdMap.get(Number(rel.tag_id));
        if (subjectId && tagId) db().run('INSERT OR IGNORE INTO subject_tags (subject_id, tag_id) VALUES (?, ?)', subjectId, tagId);
      }
      // 发布配置
      for (const config of payload.publishConfigs || []) {
        const existing = db().get('SELECT id FROM publish_configs WHERE id = ?', config.id);
        if (existing) {
          db().run('UPDATE publish_configs SET name = ?, config_json = ?, updated_at = ? WHERE id = ?',
            config.name, config.config_json, nowIso(), config.id);
        } else {
          db().run('INSERT INTO publish_configs (id, name, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
            config.id, config.name, config.config_json, config.created_at || nowIso(), nowIso());
          stats.publishConfigs += 1;
        }
      }
    });

    if (payload.settings && mode === 'replace') replaceSettings(payload.settings);
    else if (payload.settings) updateSettings(payload.settings);
    return { stats, warnings };
  }

  async createDbSnapshot() {
    await ensureDir(PATHS.backups);
    const file = path.join(PATHS.backups, `weixin-auto-db-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
    await fsp.copyFile(PATHS.db, file);
    return file;
  }
}
