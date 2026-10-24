import fsp from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from '../config.js';
import { getDb } from '../db.js';
import { exportableSettings, getSettings, replaceSettings, updateSettings } from '../settings.js';
import { ensureDir, nowIso } from '../util.js';

const db = () => getDb();

const EXPORT_VERSION = 1;

export class BackupService {
  async exportAll({ include = {} } = {}) {
    const payload = {
      app: 'weixin-auto',
      version: EXPORT_VERSION,
      exportedAt: nowIso(),
      settings: include.settings === false ? undefined : exportableSettings().settings,
      tags: include.tags === false ? undefined : db().all('SELECT id, name, color, note FROM tags'),
      subjects: include.subjects === false ? undefined : db().all(
        `SELECT id, name, note, avatar_url, wechat_id, wechat_nickname, finder_username, finder_nickname,
                identity_key, status, last_login_at, created_at, updated_at FROM subjects`,
      ),
      subjectTags: include.subjects === false ? undefined : db().all('SELECT subject_id, tag_id FROM subject_tags'),
      videoFolders: include.videos === false ? undefined : db().all('SELECT path, recursive, enabled FROM video_folders'),
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
    const stats = { tags: 0, subjects: 0, videos: 0, texts: 0, publishConfigs: 0, folders: 0 };
    const tagIdMap = new Map();

    db().transaction(() => {
      if (mode === 'replace') {
        db().run('DELETE FROM publish_configs');
        db().run('DELETE FROM subject_tags');
        db().run('DELETE FROM video_tags');
        db().run('DELETE FROM text_tags');
        db().run('DELETE FROM tags');
      }
      // 标签：按名称合并
      for (const tag of payload.tags || []) {
        let existing = db().get('SELECT id FROM tags WHERE name = ?', tag.name);
        if (!existing) {
          const info = db().run('INSERT INTO tags (name, color, note, created_at) VALUES (?, ?, ?, ?)',
            tag.name, tag.color || '#fa9d3b', tag.note || '', nowIso());
          existing = { id: Number(info.lastInsertRowid) };
          stats.tags += 1;
        }
        tagIdMap.set(Number(tag.id), Number(existing.id));
      }
      // 视频文件夹
      for (const folder of payload.videoFolders || []) {
        try {
          db().run('INSERT OR IGNORE INTO video_folders (path, recursive, enabled, created_at) VALUES (?, ?, ?, ?)',
            folder.path, folder.recursive ? 1 : 0, folder.enabled ? 1 : 0, nowIso());
          stats.folders += 1;
        } catch { /* ignore */ }
      }
      // 视频（按路径合并）
      const videoIdMap = new Map();
      for (const video of payload.videos || []) {
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
    return { stats };
  }

  async createDbSnapshot() {
    await ensureDir(PATHS.backups);
    const file = path.join(PATHS.backups, `weixin-auto-db-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
    await fsp.copyFile(PATHS.db, file);
    return file;
  }
}
