import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PATHS } from './config.js';
import { ensureDir, safeParseJson } from './util.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tag_groups (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL UNIQUE,
  color          TEXT NOT NULL DEFAULT '#6c5ce7',
  note           TEXT,
  selection_mode TEXT NOT NULL DEFAULT 'multiple',
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT NOT NULL DEFAULT '#fa9d3b',
  note       TEXT,
  group_id   INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subjects (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  note            TEXT,
  avatar_url      TEXT,
  wechat_id       TEXT,
  wechat_nickname TEXT,
  finder_username TEXT,
  finder_nickname TEXT,
  identity_key    TEXT,
  extra_json      TEXT,
  profile_dir     TEXT,
  status          TEXT NOT NULL DEFAULT 'unknown',
  status_detail   TEXT,
  last_check_at   TEXT,
  last_login_at   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_identity ON subjects(identity_key) WHERE identity_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS subject_tags (
  subject_id TEXT NOT NULL,
  tag_id     INTEGER NOT NULL,
  PRIMARY KEY (subject_id, tag_id)
);

CREATE TABLE IF NOT EXISTS video_folders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  path       TEXT NOT NULL UNIQUE,
  recursive  INTEGER NOT NULL DEFAULT 1,
  enabled    INTEGER NOT NULL DEFAULT 1,
  tag_ids    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS videos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  ext         TEXT,
  size        INTEGER DEFAULT 0,
  md5         TEXT,
  mtime_ms    INTEGER,
  folder      TEXT,
  missing     INTEGER NOT NULL DEFAULT 0,
  removed     INTEGER NOT NULL DEFAULT 0,
  removed_at  TEXT,
  thumb_path  TEXT,
  thumb_updated_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_videos_md5 ON videos(md5);
CREATE INDEX IF NOT EXISTS idx_videos_name ON videos(name);

CREATE TABLE IF NOT EXISTS video_tags (
  video_id INTEGER NOT NULL,
  tag_id   INTEGER NOT NULL,
  PRIMARY KEY (video_id, tag_id)
);

CREATE TABLE IF NOT EXISTS texts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  content    TEXT NOT NULL,
  hash       TEXT NOT NULL UNIQUE,
  note       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS text_tags (
  text_id INTEGER NOT NULL,
  tag_id  INTEGER NOT NULL,
  PRIMARY KEY (text_id, tag_id)
);

CREATE TABLE IF NOT EXISTS upload_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id TEXT,
  video_id   INTEGER,
  text_id    INTEGER,
  task_id    TEXT,
  item_id    TEXT,
  action     TEXT,
  status     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_video ON upload_history(video_id);
CREATE INDEX IF NOT EXISTS idx_history_text ON upload_history(text_id);
CREATE INDEX IF NOT EXISTS idx_history_subject ON upload_history(subject_id);

CREATE TABLE IF NOT EXISTS publish_configs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  name           TEXT,
  config_id      TEXT,
  config_json    TEXT,
  action         TEXT,
  dry_run        INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending',
  total          INTEGER NOT NULL DEFAULT 0,
  succeeded      INTEGER NOT NULL DEFAULT 0,
  failed         INTEGER NOT NULL DEFAULT 0,
  canceled       INTEGER NOT NULL DEFAULT 0,
  skipped        INTEGER NOT NULL DEFAULT 0,
  unknown_count  INTEGER NOT NULL DEFAULT 0,
  sync_status    TEXT,
  sync_error     TEXT,
  created_at     TEXT NOT NULL,
  started_at     TEXT,
  finished_at    TEXT
);

CREATE TABLE IF NOT EXISTS task_items (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  subject_id    TEXT,
  subject_name  TEXT,
  video_id      INTEGER,
  video_name    TEXT,
  text_id       INTEGER,
  text_preview  TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  step          TEXT,
  progress      TEXT,
  error         TEXT,
  logs_json     TEXT,
  screenshot    TEXT,
  post_id       TEXT,
  started_at    TEXT,
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_items_task ON task_items(task_id, seq);

CREATE TABLE IF NOT EXISTS pool_usage (
  scope       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  used_at     TEXT NOT NULL,
  PRIMARY KEY (scope, kind, resource_id)
);

CREATE TABLE IF NOT EXISTS pool_cursor (
  scope    TEXT NOT NULL,
  kind     TEXT NOT NULL,
  cursor   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, kind)
);

CREATE TABLE IF NOT EXISTS wechat_bots (
  bot_id        TEXT PRIMARY KEY,
  account_id    TEXT,
  token         TEXT NOT NULL,
  owner_user_id TEXT,
  base_url      TEXT NOT NULL DEFAULT 'https://ilinkai.weixin.qq.com/',
  context_token TEXT,
  context_seq   TEXT,
  nickname      TEXT,
  source        TEXT NOT NULL DEFAULT 'bind',
  status        TEXT NOT NULL DEFAULT 'active',
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
`;

export class Db {
  constructor(file = PATHS.db) {
    this.file = file;
    ensureDirSync(path.dirname(file));
    this.raw = new DatabaseSync(file);
    this.raw.exec(SCHEMA);
    // 兼容旧数据库：补充后加的列
    this.ensureColumn('videos', 'thumb_path', 'TEXT');
    this.ensureColumn('videos', 'thumb_updated_at', 'TEXT');
    this.ensureColumn('videos', 'removed', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('videos', 'removed_at', 'TEXT');
    this.ensureColumn('video_folders', 'tag_ids', 'TEXT');
    this.ensureColumn('tags', 'group_id', 'INTEGER');
    // 定时发布 / 定时执行：任务级定时与每条计划的执行/发布时间
    this.ensureColumn('tasks', 'scheduled_at', 'TEXT');
    this.ensureColumn('tasks', 'schedule_interval_minutes', 'INTEGER');
    this.ensureColumn('tasks', 'schedule_kind', 'TEXT');
    this.ensureColumn('task_items', 'scheduled_at', 'TEXT');
    // 微信机器人会话续期通知状态
    this.ensureColumn('wechat_bots', 'needs_context_refresh', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('wechat_bots', 'last_context_error', 'TEXT');
    this.ensureColumn('wechat_bots', 'last_notice_at', 'TEXT');
    this.ensureColumn('wechat_bots', 'notice_delivery', 'TEXT');
    this.migrateTagGroups();
  }

  ensureColumn(table, column, type) {
    try {
      const columns = this.raw.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some((item) => item.name === column)) {
        this.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    } catch { /* 忽略迁移失败，保持旧库可用 */ }
  }

  /** 标签组迁移：保证每个具体标签都归属于一个标签组（旧数据归入「未分组」） */
  migrateTagGroups() {
    try {
      const now = new Date().toISOString();
      let groups = this.raw.prepare('SELECT id, name FROM tag_groups ORDER BY sort_order, id').all();
      if (!groups.length) {
        this.raw.prepare(
          'INSERT INTO tag_groups (name, color, note, selection_mode, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run('未分组', '#8c8c99', '系统默认分组（旧标签迁移）', 'multiple', 0, now, now);
        groups = this.raw.prepare('SELECT id, name FROM tag_groups ORDER BY sort_order, id').all();
      }
      const validIds = new Set(groups.map((group) => Number(group.id)));
      const orphanTags = this.raw.prepare('SELECT id, group_id FROM tags').all()
        .filter((tag) => !tag.group_id || !validIds.has(Number(tag.group_id)));
      if (orphanTags.length) {
        const fallback = Number(groups[0].id);
        const update = this.raw.prepare('UPDATE tags SET group_id = ? WHERE id = ?');
        for (const tag of orphanTags) update.run(fallback, tag.id);
      }
    } catch { /* 迁移失败时保持可用，标签组页面可手动整理 */ }
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  run(sql, ...params) {
    return this.raw.prepare(sql).run(...params);
  }

  get(sql, ...params) {
    return this.raw.prepare(sql).get(...params);
  }

  all(sql, ...params) {
    return this.raw.prepare(sql).all(...params);
  }

  transaction(fn) {
    this.raw.exec('BEGIN');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.raw.exec('ROLLBACK');
      } catch { /* ignore rollback failure */ }
      throw error;
    }
  }

  getSetting(key, fallback = null) {
    const row = this.get('SELECT value FROM settings WHERE key = ?', key);
    if (!row) return fallback;
    return safeParseJson(row.value, fallback);
  }

  setSetting(key, value) {
    const now = new Date().toISOString();
    this.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value),
      now,
    );
  }

  listSettings() {
    const out = {};
    for (const row of this.all('SELECT key, value FROM settings')) {
      out[row.key] = safeParseJson(row.value, null);
    }
    return out;
  }

  close() {
    try {
      this.raw.close();
    } catch { /* ignore */ }
  }
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

let instance = null;

export function getDb() {
  if (!instance) instance = new Db();
  return instance;
}

export function openDb(file) {
  return new Db(file);
}
