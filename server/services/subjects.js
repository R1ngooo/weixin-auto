import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config.js';
import { getDb } from '../db.js';
import { nowIso, uid } from '../util.js';

const db = () => getDb();

function tagMapFor(kind, ids) {
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const table = kind === 'subject' ? 'subject_tags' : kind === 'video' ? 'video_tags' : 'text_tags';
  const column = kind === 'subject' ? 'subject_id' : kind === 'video' ? 'video_id' : 'text_id';
  const rows = db().all(
    `SELECT t.${column} AS owner_id, g.id, g.name, g.color
       FROM ${table} t JOIN tags g ON g.id = t.tag_id
      WHERE t.${column} IN (${placeholders}) ORDER BY g.name`,
    ...ids,
  );
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.owner_id)) map.set(row.owner_id, []);
    map.get(row.owner_id).push({ id: row.id, name: row.name, color: row.color });
  }
  return map;
}

export function attachTags(kind, ownerId, tagIds) {
  const table = kind === 'subject' ? 'subject_tags' : kind === 'video' ? 'video_tags' : 'text_tags';
  const column = kind === 'subject' ? 'subject_id' : kind === 'video' ? 'video_id' : 'text_id';
  db().run(`DELETE FROM ${table} WHERE ${column} = ?`, ownerId);
  for (const tagId of tagIds || []) {
    try {
      db().run(`INSERT INTO ${table} (${column}, tag_id) VALUES (?, ?)`, ownerId, tagId);
    } catch { /* tag 可能已被删除 */ }
  }
}

export function hydrateTags(kind, rows) {
  const map = tagMapFor(kind, rows.map((row) => row.id));
  return rows.map((row) => ({ ...row, tags: map.get(row.id) || [] }));
}

export class SubjectService {
  list({ status = '', tagIds = [], query = '' } = {}) {
    const where = [];
    const params = [];
    if (status) {
      where.push('s.status = ?');
      params.push(status);
    }
    if (query) {
      where.push(`(s.name LIKE ? OR s.note LIKE ? OR s.wechat_nickname LIKE ? OR s.finder_nickname LIKE ? OR s.finder_username LIKE ?
        OR EXISTS (SELECT 1 FROM subject_tags st JOIN tags t ON t.id = st.tag_id WHERE st.subject_id = s.id AND t.name LIKE ?))`);
      const like = `%${query}%`;
      params.push(like, like, like, like, like, like);
    }
    if (tagIds.length) {
      where.push(`s.id IN (SELECT subject_id FROM subject_tags WHERE tag_id IN (${tagIds.map(() => '?').join(',')}))`);
      params.push(...tagIds);
    }
    const sql = `SELECT s.* FROM subjects s ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.created_at DESC`;
    const rows = db().all(sql, ...params);
    const hydrated = hydrateTags('subject', rows);
    return hydrated.map((row) => this.decorate(row));
  }

  get(id) {
    const row = db().get('SELECT * FROM subjects WHERE id = ?', id);
    if (!row) return null;
    const tags = hydrateTags('subject', [row])[0].tags;
    return this.decorate({ ...row, tags });
  }

  findByIdentity(identityKey) {
    if (!identityKey) return null;
    const row = db().get('SELECT * FROM subjects WHERE identity_key = ?', identityKey);
    return row ? this.get(row.id) : null;
  }

  findByProfileDir(dir) {
    const row = db().get('SELECT * FROM subjects WHERE profile_dir = ?', dir);
    return row ? this.get(row.id) : null;
  }

  decorate(row) {
    let extra = {};
    try { extra = row.extra_json ? JSON.parse(row.extra_json) : {}; } catch { extra = {}; }
    const finderNickname = row.finder_nickname || '';
    const finderUsername = row.finder_username || '';
    const wechatNickname = row.wechat_nickname || '';
    const name = row.name || '';
    return {
      id: row.id,
      name,
      // 显示以视频号名称为主：视频号昵称 → 视频号ID → 手动名称/微信昵称
      displayName: finderNickname || finderUsername || name || wechatNickname,
      note: row.note || '',
      avatarUrl: row.avatar_url || '',
      wechatId: row.wechat_id || '',
      wechatNickname,
      finderUsername,
      finderNickname,
      identityKey: row.identity_key || '',
      identityType: extra.identityType || '',
      status: row.status || 'unknown',
      statusDetail: row.status_detail || '',
      lastCheckAt: row.last_check_at || '',
      lastLoginAt: row.last_login_at || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      tags: row.tags || [],
      diagnostic: extra.diagnostic || null,
      finderList: extra.finderList || [],
    };
  }

  create({ name, note = '', tagIds = [] } = {}) {
    const id = uid('sub_');
    const now = nowIso();
    const finalName = (name || '').trim() || `新主体 ${now.slice(5, 16).replace('T', ' ')}`;
    db().run(
      `INSERT INTO subjects (id, name, note, profile_dir, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'unknown', ?, ?)`,
      id, finalName, note, `profiles/${id}`, now, now,
    );
    attachTags('subject', id, tagIds);
    return this.get(id);
  }

  update(id, patch) {
    const current = this.get(id);
    if (!current) return null;
    const fields = [];
    const params = [];
    const map = {
      name: 'name', note: 'note', avatarUrl: 'avatar_url', wechatId: 'wechat_id',
      wechatNickname: 'wechat_nickname', finderUsername: 'finder_username',
      finderNickname: 'finder_nickname', status: 'status', statusDetail: 'status_detail',
      lastCheckAt: 'last_check_at', lastLoginAt: 'last_login_at', identityKey: 'identity_key',
    };
    for (const [key, column] of Object.entries(map)) {
      if (patch[key] !== undefined) {
        fields.push(`${column} = ?`);
        params.push(patch[key] ?? null);
      }
    }
    if (patch.extra !== undefined) {
      fields.push('extra_json = ?');
      params.push(JSON.stringify(patch.extra));
    }
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(nowIso(), id);
      db().run(`UPDATE subjects SET ${fields.join(', ')} WHERE id = ?`, ...params);
    }
    if (Array.isArray(patch.tagIds)) attachTags('subject', id, patch.tagIds);
    return this.get(id);
  }

  remove(id) {
    const subject = this.get(id);
    if (!subject) return false;
    db().run('DELETE FROM subjects WHERE id = ?', id);
    db().run('DELETE FROM subject_tags WHERE subject_id = ?', id);
    return true;
  }

  applyIdentity(id, identity) {
    const extra = {
      identityType: identity.identityType || '',
      diagnostic: identity.diagnostic || null,
      raw: identity.raw || null,
      finderList: identity.finderList || [],
      updatedByLoginAt: nowIso(),
    };
    const patch = {
      avatarUrl: identity.avatarUrl || undefined,
      wechatId: identity.wechatId || undefined,
      wechatNickname: identity.wechatNickname || undefined,
      finderUsername: identity.finderUsername || undefined,
      finderNickname: identity.finderNickname || undefined,
      identityKey: identity.identityKey || undefined,
      status: 'active',
      statusDetail: '登录成功',
      lastLoginAt: nowIso(),
      lastCheckAt: nowIso(),
      extra,
    };
    if (identity.name) patch.name = identity.name;
    if (identity.displayName && identity.displayName !== identity.name) patch.finderNickname = identity.finderNickname || identity.displayName;
    // 显示以视频号名称为主：有视频号昵称/ID 时把 name 归一为视频号名称
    const preferredName = identity.finderNickname || identity.finderUsername;
    if (preferredName) patch.name = preferredName;
    return this.update(id, patch);
  }

  /** 查找与候选身份重复的其他主体（按视频号ID → 微信身份 → 视频号名称 → 微信ID 优先级） */
  findDuplicate(candidate = {}, excludeId = null) {
    const exclude = excludeId ? String(excludeId) : null;
    const rows = db().all('SELECT * FROM subjects').filter((row) => String(row.id) !== exclude);
    const norm = (value) => String(value || '').trim().toLowerCase();
    const finderUsername = norm(candidate.finderUsername);
    const identityKey = String(candidate.identityKey || '').trim();
    const finderNickname = norm(candidate.finderNickname);
    const wechatId = norm(candidate.wechatId);
    const match = (predicate) => rows.find(predicate);
    const row = (finderUsername && match((item) => norm(item.finder_username) === finderUsername))
      || (identityKey && match((item) => String(item.identity_key || '').trim() === identityKey))
      || (finderNickname && match((item) => norm(item.finder_nickname) === finderNickname))
      || (wechatId && match((item) => norm(item.wechat_id) === wechatId));
    return row ? this.get(row.id) : null;
  }

  /** 把现有主体名称归一为视频号名称（无视频号信息时保留原名称） */
  normalizeNames() {
    const rows = db().all('SELECT id, name, finder_nickname FROM subjects');
    let changed = 0;
    for (const row of rows) {
      const finder = String(row.finder_nickname || '').trim();
      if (finder && row.name !== finder) {
        db().run('UPDATE subjects SET name = ?, updated_at = ? WHERE id = ?', finder, nowIso(), row.id);
        changed += 1;
      }
    }
    return changed;
  }

  /** 修复发布配置/任务中指向已合并（不存在）主体的 subjectIds（按合并备份的名称映射到保留主体） */
  repairSubjectReferences() {
    const existing = db().all('SELECT id, name, finder_nickname, finder_username FROM subjects');
    const existingIds = new Set(existing.map((row) => String(row.id)));
    const norm = (value) => String(value || '').trim().toLowerCase();
    const byKey = new Map();
    for (const row of existing) {
      const key = norm(row.finder_nickname) || norm(row.name);
      if (key && !byKey.has(key)) byKey.set(key, String(row.id));
    }
    const mapping = new Map();
    let files = [];
    try {
      files = fs.readdirSync(PATHS.backups).filter((file) => /^subjects-merge-.*\.json$/.test(file)).sort().reverse();
    } catch { files = []; }
    for (const file of files) {
      let rows = [];
      try { rows = JSON.parse(fs.readFileSync(path.join(PATHS.backups, file), 'utf8')); } catch { continue; }
      for (const row of rows) {
        if (!row?.id || existingIds.has(String(row.id))) continue;
        const key = norm(row.finder_nickname) || norm(row.name);
        const keeper = key ? byKey.get(key) : null;
        if (keeper) mapping.set(String(row.id), keeper);
      }
    }
    let fixed = 0;
    let removed = 0;
    const rewrite = (table) => {
      for (const record of db().all(`SELECT id, config_json FROM ${table}`)) {
        let json = null;
        try { json = JSON.parse(record.config_json); } catch { json = null; }
        const ids = json?.subjectSelection?.ids;
        if (!Array.isArray(ids)) continue;
        let changed = false;
        const next = ids.map((id) => {
          const key = String(id);
          if (existingIds.has(key)) return key;
          const mapped = mapping.get(key);
          if (mapped && existingIds.has(mapped)) {
            changed = true;
            return mapped;
          }
          changed = true;
          removed += 1;
          return null;
        }).filter(Boolean);
        if (!changed) continue;
        json.subjectSelection.ids = [...new Set(next)];
        if (table === 'publish_configs') {
          db().run('UPDATE publish_configs SET config_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(json), nowIso(), record.id);
        } else {
          db().run(`UPDATE ${table} SET config_json = ? WHERE id = ?`, JSON.stringify(json), record.id);
        }
        fixed += 1;
      }
    };
    rewrite('publish_configs');
    rewrite('tasks');
    return { fixed, removed, mappings: mapping.size };
  }

  /** 创建视频号名称/ID 的唯一索引（重复合并后执行） */
  ensureUniqueIndexes() {
    const results = {};
    try {
      db().exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_finder_username ON subjects(finder_username) WHERE finder_username IS NOT NULL AND finder_username <> \'\'');
      results.finderUsername = true;
    } catch (error) {
      results.finderUsername = String(error?.message || error);
    }
    try {
      db().exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_finder_nickname ON subjects(lower(finder_nickname)) WHERE finder_nickname IS NOT NULL AND finder_nickname <> \'\'');
      results.finderNickname = true;
    } catch (error) {
      results.finderNickname = String(error?.message || error);
    }
    return results;
  }

  /**
   * 合并重复主体（按视频号ID/微信身份/视频号名称/微信ID 建并查集）。
   * 保留规则：active 优先 → 有 identityKey/finderUsername → 最近登录 → 创建更早。
   * 被合并行的标签并集、历史记录改指向保留主体；被合并行与 profile 目录备份，不直接丢弃。
   */
  async mergeDuplicates({ dryRun = false, profileBackupRoot = null } = {}) {
    const rows = db().all('SELECT * FROM subjects');
    const parent = new Map(rows.map((row) => [String(row.id), String(row.id)]));
    const find = (id) => {
      let current = id;
      while (parent.get(current) !== current) {
        parent.set(current, parent.get(parent.get(current)));
        current = parent.get(current);
      }
      return current;
    };
    const union = (a, b) => {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) parent.set(rootB, rootA);
    };
    const keyFirst = new Map();
    const norm = (value) => String(value || '').trim().toLowerCase();
    const keyOf = (row) => {
      const keys = [];
      if (norm(row.finder_username)) keys.push(`fu:${norm(row.finder_username)}`);
      if (String(row.identity_key || '').trim()) keys.push(`ik:${String(row.identity_key).trim()}`);
      if (norm(row.finder_nickname)) keys.push(`fn:${norm(row.finder_nickname)}`);
      if (norm(row.wechat_id)) keys.push(`wx:${norm(row.wechat_id)}`);
      return keys;
    };
    for (const row of rows) {
      for (const key of keyOf(row)) {
        if (keyFirst.has(key)) union(String(row.id), keyFirst.get(key));
        else keyFirst.set(key, String(row.id));
      }
    }
    const groups = new Map();
    for (const row of rows) {
      const root = find(String(row.id));
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(row);
    }
    const statusRank = { active: 5, expired: 4, unknown: 3, pending: 2, failed: 1 };
    const rank = (row) => [
      statusRank[row.status] || 0,
      (row.identity_key || row.finder_username) ? 1 : 0,
      String(row.last_login_at || ''),
      -Date.parse(row.created_at || 0),
    ];
    const compare = (a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      for (let i = 0; i < ra.length; i += 1) {
        if (ra[i] === rb[i]) continue;
        return ra[i] > rb[i] ? -1 : 1;
      }
      return 0;
    };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(PATHS.backups, `subjects-merge-${stamp}.json`);
    const plans = [];
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const sorted = [...group].sort(compare);
      const keeper = sorted[0];
      const dropped = sorted.slice(1);
      const firstNonEmpty = (field) => {
        for (const row of sorted) if (String(row[field] || '').trim()) return row[field];
        return null;
      };
      const latest = (field) => sorted.map((row) => String(row[field] || '')).filter(Boolean).sort().pop() || null;
      const earliest = sorted.map((row) => String(row.created_at || '')).filter(Boolean).sort()[0] || keeper.created_at;
      let extra = {};
      try { extra = keeper.extra_json ? JSON.parse(keeper.extra_json) : {}; } catch { extra = {}; }
      const finderList = [];
      const seenFinders = new Set();
      for (const row of sorted) {
        let rowExtra = {};
        try { rowExtra = row.extra_json ? JSON.parse(row.extra_json) : {}; } catch { rowExtra = {}; }
        for (const finder of rowExtra.finderList || []) {
          const key = String(finder?.finderUsername || finder?.nickname || JSON.stringify(finder));
          if (seenFinders.has(key)) continue;
          seenFinders.add(key);
          finderList.push(finder);
        }
      }
      const note = [...new Set(sorted.map((row) => String(row.note || '').trim()).filter(Boolean))].join('；');
      const merged = {
        id: keeper.id,
        keep: keeper,
        dropped,
        name: firstNonEmpty('finder_nickname') || keeper.name,
        finder_nickname: firstNonEmpty('finder_nickname'),
        finder_username: firstNonEmpty('finder_username'),
        wechat_id: firstNonEmpty('wechat_id'),
        wechat_nickname: firstNonEmpty('wechat_nickname'),
        avatar_url: firstNonEmpty('avatar_url'),
        identity_key: firstNonEmpty('identity_key'),
        status: keeper.status,
        status_detail: firstNonEmpty('status_detail'),
        last_login_at: latest('last_login_at'),
        last_check_at: latest('last_check_at'),
        note,
        created_at: earliest,
        extra: { ...extra, finderList, mergedAt: nowIso(), mergedFrom: dropped.map((row) => row.id) },
      };
      plans.push(merged);
    }
    if (dryRun) {
      return { dryRun: true, groups: plans.map((plan) => ({ keeper: plan.id, dropped: plan.dropped.map((row) => row.id), name: plan.name })) };
    }
    if (!plans.length) return { mergedGroups: 0, droppedIds: [], backupFile: null };
    fs.mkdirSync(PATHS.backups, { recursive: true });
    const backupRows = plans.flatMap((plan) => plan.dropped);
    db().transaction(() => {
      for (const plan of plans) {
        const keeperId = String(plan.id);
        const droppedIds = plan.dropped.map((row) => String(row.id));
        // 标签并集
        const tagIds = new Set(db().all(
          `SELECT tag_id FROM subject_tags WHERE subject_id IN (${[keeperId, ...droppedIds].map(() => '?').join(',')})`,
          keeperId, ...droppedIds,
        ).map((row) => Number(row.tag_id)));
        for (const tagId of tagIds) db().run('INSERT OR IGNORE INTO subject_tags (subject_id, tag_id) VALUES (?, ?)', keeperId, tagId);
        for (const droppedId of droppedIds) {
          db().run('DELETE FROM subject_tags WHERE subject_id = ?', droppedId);
          db().run('UPDATE upload_history SET subject_id = ? WHERE subject_id = ?', keeperId, droppedId);
          db().run('UPDATE task_items SET subject_id = ?, subject_name = ? WHERE subject_id = ?', keeperId, plan.name, droppedId);
        }
        // 发布配置/任务中的 subjectIds 重映射
        for (const config of db().all('SELECT id, config_json FROM publish_configs')) {
          let json = null;
          try { json = JSON.parse(config.config_json); } catch { json = null; }
          if (!json?.subjectSelection?.ids) continue;
          const ids = [...new Set(json.subjectSelection.ids.map((id) => (droppedIds.includes(String(id)) ? keeperId : String(id))))];
          if (JSON.stringify(ids) === JSON.stringify(json.subjectSelection.ids)) continue;
          json.subjectSelection.ids = ids;
          db().run('UPDATE publish_configs SET config_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(json), nowIso(), config.id);
        }
        for (const task of db().all('SELECT id, config_json FROM tasks')) {
          let json = null;
          try { json = JSON.parse(task.config_json); } catch { json = null; }
          if (!json?.subjectSelection?.ids) continue;
          const ids = [...new Set(json.subjectSelection.ids.map((id) => (droppedIds.includes(String(id)) ? keeperId : String(id))))];
          if (JSON.stringify(ids) === JSON.stringify(json.subjectSelection.ids)) continue;
          json.subjectSelection.ids = ids;
          db().run('UPDATE tasks SET config_json = ? WHERE id = ?', JSON.stringify(json), task.id);
        }
        db().run(
          `UPDATE subjects SET name = ?, finder_nickname = ?, finder_username = ?, wechat_id = ?, wechat_nickname = ?,
             avatar_url = ?, identity_key = ?, status = ?, status_detail = ?, last_login_at = ?, last_check_at = ?,
             note = ?, created_at = ?, extra_json = ?, updated_at = ? WHERE id = ?`,
          plan.name, plan.finder_nickname, plan.finder_username, plan.wechat_id, plan.wechat_nickname,
          plan.avatar_url, plan.identity_key, plan.status, plan.status_detail, plan.last_login_at, plan.last_check_at,
          plan.note, plan.created_at, JSON.stringify(plan.extra), nowIso(), keeperId,
        );
        for (const droppedId of droppedIds) db().run('DELETE FROM subjects WHERE id = ?', droppedId);
      }
    });
    try {
      fs.mkdirSync(PATHS.backups, { recursive: true });
      fs.writeFileSync(backupFile, JSON.stringify(backupRows, null, 2), 'utf8');
    } catch { /* 文件备份失败不阻塞合并 */ }
    // 处理 profile 目录：保留对象无目录时接管被合并目录，其余移动到 _merged 备份
    const profileRoot = profileBackupRoot || path.join(PATHS.profiles, '_merged', stamp);
    const profileMoves = [];
    for (const plan of plans) {
      const keeperDir = path.join(PATHS.profiles, String(plan.id));
      let keeperUsable = false;
      try {
        keeperUsable = fs.existsSync(keeperDir) && (await fsp.readdir(keeperDir)).length > 0;
      } catch { keeperUsable = false; }
      for (const dropped of plan.dropped) {
        const droppedDir = path.join(PATHS.profiles, String(dropped.id));
        if (!fs.existsSync(droppedDir)) continue;
        try {
          if (!keeperUsable) {
            await fsp.rm(keeperDir, { recursive: true, force: true }).catch(() => undefined);
            await fsp.mkdir(path.dirname(keeperDir), { recursive: true });
            await fsp.rename(droppedDir, keeperDir);
            keeperUsable = true;
            profileMoves.push({ id: dropped.id, action: 'take-over' });
          } else {
            await fsp.mkdir(profileRoot, { recursive: true });
            await fsp.rename(droppedDir, path.join(profileRoot, String(dropped.id)));
            profileMoves.push({ id: dropped.id, action: 'backup' });
          }
        } catch {
          try {
            await fsp.mkdir(profileRoot, { recursive: true });
            await fsp.cp(droppedDir, path.join(profileRoot, String(dropped.id)), { recursive: true, force: true });
            await fsp.rm(droppedDir, { recursive: true, force: true });
            profileMoves.push({ id: dropped.id, action: 'backup-copy' });
          } catch { profileMoves.push({ id: dropped.id, action: 'failed' }); }
        }
      }
    }
    return {
      mergedGroups: plans.length,
      droppedIds: plans.flatMap((plan) => plan.dropped.map((row) => row.id)),
      backupFile,
      profileRoot,
      profileMoves,
      groups: plans.map((plan) => ({ keeper: plan.id, dropped: plan.dropped.map((row) => row.id), name: plan.name })),
    };
  }

  listByTagIds(tagIds) {
    if (!tagIds?.length) return this.list();
    return this.list({ tagIds });
  }
}

const TAG_SELECT = `
  SELECT t.*, g.name AS group_name, g.color AS group_color, g.selection_mode AS group_selection_mode,
         g.sort_order AS group_sort_order
    FROM tags t LEFT JOIN tag_groups g ON g.id = t.group_id
`;

const SELECTION_MODES = new Set(['single', 'multiple']);

/** 标签组：对具体标签做分类管理，并约束组内标签的选择方式（单选/多选） */
export class TagGroupService {
  list({ withCounts = false } = {}) {
    const rows = db().all('SELECT * FROM tag_groups ORDER BY sort_order, id');
    let counts = null;
    if (withCounts) {
      const tagRows = db().all('SELECT group_id, COUNT(*) AS n FROM tags GROUP BY group_id');
      counts = new Map(tagRows.map((row) => [Number(row.group_id), Number(row.n)]));
    }
    return rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      color: row.color,
      note: row.note || '',
      selectionMode: row.selection_mode === 'single' ? 'single' : 'multiple',
      sortOrder: Number(row.sort_order || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(counts ? { tagCount: counts.get(Number(row.id)) || 0 } : {}),
    }));
  }

  get(id) {
    return this.list().find((group) => Number(group.id) === Number(id)) || null;
  }

  create({ name, color = '#6c5ce7', note = '', selectionMode = 'multiple' } = {}) {
    const finalName = String(name || '').trim();
    if (!finalName) throw new Error('标签组名称不能为空');
    if (db().get('SELECT id FROM tag_groups WHERE name = ?', finalName)) throw new Error('标签组已存在');
    const mode = SELECTION_MODES.has(selectionMode) ? selectionMode : 'multiple';
    const now = nowIso();
    const info = db().run(
      'INSERT INTO tag_groups (name, color, note, selection_mode, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      finalName, color || '#6c5ce7', note || '', mode, 0, now, now,
    );
    return this.get(Number(info.lastInsertRowid));
  }

  update(id, { name, color, note, selectionMode, sortOrder } = {}) {
    const current = this.get(id);
    if (!current) throw new Error('标签组不存在');
    const nextName = name !== undefined ? String(name).trim() : current.name;
    if (!nextName) throw new Error('标签组名称不能为空');
    if (db().get('SELECT id FROM tag_groups WHERE name = ? AND id != ?', nextName, id)) throw new Error('标签组已存在');
    const mode = selectionMode !== undefined
      ? (SELECTION_MODES.has(selectionMode) ? selectionMode : current.selectionMode)
      : current.selectionMode;
    db().run(
      'UPDATE tag_groups SET name = ?, color = ?, note = ?, selection_mode = ?, sort_order = ?, updated_at = ? WHERE id = ?',
      nextName, color !== undefined ? color : current.color, note !== undefined ? note : current.note,
      mode, sortOrder !== undefined ? Number(sortOrder) || 0 : current.sortOrder, nowIso(), id,
    );
    return this.get(id);
  }

  remove(id) {
    const current = this.get(id);
    if (!current) throw new Error('标签组不存在');
    const tagCount = Number(db().get('SELECT COUNT(*) AS n FROM tags WHERE group_id = ?', id)?.n || 0);
    if (tagCount > 0) throw new Error(`该标签组下还有 ${tagCount} 个具体标签，请先移动或删除这些标签后再删除标签组`);
    db().run('DELETE FROM tag_groups WHERE id = ?', id);
    return true;
  }
}

export class TagService {
  constructor() {
    this.groups = new TagGroupService();
  }

  /** 统一输出标签组字段（groupId/groupName/groupColor/groupSelectionMode） */
  decorate(row) {
    return {
      ...row,
      id: Number(row.id),
      groupId: row.group_id ? Number(row.group_id) : null,
      groupName: row.group_name || '',
      groupColor: row.group_color || '#8c8c99',
      groupSelectionMode: row.group_selection_mode === 'single' ? 'single' : 'multiple',
    };
  }

  list() {
    return db().all(`${TAG_SELECT} ORDER BY COALESCE(g.sort_order, 0), COALESCE(g.name, ''), t.name`)
      .map((row) => this.decorate(row));
  }

  get(id) {
    const row = db().get(`${TAG_SELECT} WHERE t.id = ?`, id);
    return row ? this.decorate(row) : null;
  }

  defaultGroupId() {
    const group = db().get('SELECT id FROM tag_groups ORDER BY sort_order, id LIMIT 1');
    if (!group) {
      const created = this.groups.create({ name: '未分组', color: '#8c8c99', note: '系统默认分组' });
      return Number(created.id);
    }
    return Number(group.id);
  }

  create({ name, color = '#fa9d3b', note = '', groupId } = {}) {
    const finalName = String(name || '').trim();
    if (!finalName) throw new Error('标签名称不能为空');
    if (db().get('SELECT id FROM tags WHERE name = ?', finalName)) throw new Error('标签已存在');
    let group = groupId !== undefined && groupId !== null && groupId !== '' ? this.groups.get(groupId) : null;
    if (groupId !== undefined && groupId !== null && groupId !== '' && !group) throw new Error('所选标签组不存在');
    if (!group) group = this.groups.get(this.defaultGroupId());
    const info = db().run(
      'INSERT INTO tags (name, color, note, group_id, created_at) VALUES (?, ?, ?, ?, ?)',
      finalName, color, note, Number(group.id), nowIso(),
    );
    return this.get(Number(info.lastInsertRowid));
  }

  update(id, { name, color, note, groupId } = {}) {
    const current = this.get(id);
    if (!current) return null;
    let nextGroupId = current.groupId;
    if (groupId !== undefined && groupId !== null && groupId !== '') {
      const group = this.groups.get(groupId);
      if (!group) throw new Error('所选标签组不存在');
      nextGroupId = Number(group.id);
    }
    const nextName = name !== undefined ? String(name).trim() : current.name;
    if (!nextName) throw new Error('标签名称不能为空');
    if (db().get('SELECT id FROM tags WHERE name = ? AND id != ?', nextName, id)) throw new Error('标签已存在');
    db().run('UPDATE tags SET name = ?, color = ?, note = ?, group_id = ? WHERE id = ?',
      nextName, color !== undefined ? color : current.color, note !== undefined ? note : current.note, nextGroupId, id);
    return this.get(id);
  }

  remove(id) {
    const current = this.get(id);
    if (!current) throw new Error('标签不存在');
    const counts = this.linkCounts(id);
    const total = counts.subjects + counts.videos + counts.texts;
    if (total > 0) {
      const parts = [];
      if (counts.subjects) parts.push(`主体 ${counts.subjects}`);
      if (counts.videos) parts.push(`视频 ${counts.videos}`);
      if (counts.texts) parts.push(`文本 ${counts.texts}`);
      throw new Error(`该标签还有 ${parts.join('、')} 的关联，请先解除关联后再删除（标签组与具体标签均可删除，前提是没有关联内容）`);
    }
    db().transaction(() => {
      db().run('DELETE FROM tags WHERE id = ?', id);
      db().run('DELETE FROM subject_tags WHERE tag_id = ?', id);
      db().run('DELETE FROM video_tags WHERE tag_id = ?', id);
      db().run('DELETE FROM text_tags WHERE tag_id = ?', id);
      // 清理文件夹导入标签里的引用
      for (const folder of db().all('SELECT id, tag_ids FROM video_folders WHERE tag_ids IS NOT NULL AND tag_ids != \'\'')) {
        let tagIds = [];
        try { tagIds = JSON.parse(folder.tag_ids); } catch { tagIds = []; }
        if (!Array.isArray(tagIds) || !tagIds.some((value) => Number(value) === Number(id))) continue;
        db().run('UPDATE video_folders SET tag_ids = ? WHERE id = ?', JSON.stringify(tagIds.filter((value) => Number(value) !== Number(id))), folder.id);
      }
    });
    return true;
  }

  linkCounts(id) {
    return {
      subjects: Number(db().get('SELECT COUNT(*) AS n FROM subject_tags WHERE tag_id = ?', id)?.n || 0),
      videos: Number(db().get('SELECT COUNT(*) AS n FROM video_tags WHERE tag_id = ?', id)?.n || 0),
      texts: Number(db().get('SELECT COUNT(*) AS n FROM text_tags WHERE tag_id = ?', id)?.n || 0),
    };
  }

  /** 校验单选组约束：同一单选标签组内最多只能选一个标签 */
  assertSelectionAllowed(ownerTagIds) {
    const ids = [...new Set(ownerTagIds.map((id) => Number(id)).filter((id) => id > 0))];
    if (!ids.length) return;
    const rows = db().all(`${TAG_SELECT} WHERE t.id IN (${ids.map(() => '?').join(',')})`, ...ids);
    const bySingleGroup = new Map();
    for (const row of rows) {
      if (row.group_selection_mode !== 'single') continue;
      const groupId = Number(row.group_id);
      if (!bySingleGroup.has(groupId)) bySingleGroup.set(groupId, []);
      bySingleGroup.get(groupId).push(row);
    }
    for (const groupTags of bySingleGroup.values()) {
      if (groupTags.length > 1) {
        throw new Error(`标签组「${groupTags[0].group_name}」为单选模式，只能选择其中一个标签（当前选择了 ${groupTags.map((tag) => tag.name).join('、')}）`);
      }
    }
  }

  /** 批量给主体/视频/文本打标签：mode = add(追加) | set(覆盖) | remove(移除) */
  assign({ kind, ids = [], tagIds = [], mode = 'add' }) {
    const map = {
      subject: ['subject_tags', 'subject_id'],
      video: ['video_tags', 'video_id'],
      text: ['text_tags', 'text_id'],
    };
    const target = map[kind];
    if (!target) throw new Error('不支持的标签对象类型');
    if (!['add', 'set', 'remove'].includes(mode)) throw new Error('不支持的标签操作方式');
    const cleanIds = [...new Set(ids.map((id) => String(id)).filter(Boolean))];
    if (!cleanIds.length) throw new Error('请先选择要操作的对象');
    const cleanTagIds = [...new Set(tagIds.map((id) => Number(id)).filter((id) => id > 0))];
    if (mode !== 'set' && !cleanTagIds.length) throw new Error('请选择要操作的标签');
    const [table, column] = target;
    // 校验标签是否存在，避免写入悬空关联
    const existing = new Set(db().all(
      `SELECT id FROM tags WHERE id IN (${cleanTagIds.map(() => '?').join(',') || 'NULL'})`,
      ...cleanTagIds,
    ).map((row) => Number(row.id)));
    const validTagIds = cleanTagIds.filter((id) => existing.has(id));
    if (mode !== 'set' && !validTagIds.length) throw new Error('所选标签不存在或已被删除');
    // 单选标签组约束（对整个项目生效）
    if (mode === 'set') {
      this.assertSelectionAllowed(validTagIds);
    } else if (mode === 'add') {
      for (const ownerId of cleanIds) {
        const current = db().all(`SELECT tag_id FROM ${table} WHERE ${column} = ?`, ownerId).map((row) => Number(row.tag_id));
        this.assertSelectionAllowed([...current, ...validTagIds]);
      }
    }
    let affected = 0;
    db().transaction(() => {
      for (const ownerId of cleanIds) {
        if (mode === 'set') {
          db().run(`DELETE FROM ${table} WHERE ${column} = ?`, ownerId);
        }
        for (const tagId of validTagIds) {
          if (mode === 'remove') {
            db().run(`DELETE FROM ${table} WHERE ${column} = ? AND tag_id = ?`, ownerId, tagId);
          } else {
            db().run(`INSERT OR IGNORE INTO ${table} (${column}, tag_id) VALUES (?, ?)`, ownerId, tagId);
          }
        }
        affected += 1;
      }
    });
    return { kind, mode, affected, tags: validTagIds.length, skippedTags: cleanTagIds.length - validTagIds.length };
  }

  usageCounts() {
    const count = (table) => {
      const rows = db().all(`SELECT tag_id, COUNT(*) AS n FROM ${table} GROUP BY tag_id`);
      const map = new Map(rows.map((r) => [Number(r.tag_id), Number(r.n)]));
      return map;
    };
    const subjects = count('subject_tags');
    const videos = count('video_tags');
    const texts = count('text_tags');
    return this.list().map((tag) => ({
      ...tag,
      counts: {
        subjects: subjects.get(Number(tag.id)) || 0,
        videos: videos.get(Number(tag.id)) || 0,
        texts: texts.get(Number(tag.id)) || 0,
      },
    }));
  }
}
