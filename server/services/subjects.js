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
    return {
      id: row.id,
      name: row.name,
      note: row.note || '',
      avatarUrl: row.avatar_url || '',
      wechatId: row.wechat_id || '',
      wechatNickname: row.wechat_nickname || '',
      finderUsername: row.finder_username || '',
      finderNickname: row.finder_nickname || '',
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
    return this.update(id, patch);
  }

  listByTagIds(tagIds) {
    if (!tagIds?.length) return this.list();
    return this.list({ tagIds });
  }
}

export class TagService {
  list() {
    return db().all(`SELECT * FROM tags ORDER BY name`).map((row) => ({ ...row, id: Number(row.id) }));
  }

  get(id) {
    return db().get('SELECT * FROM tags WHERE id = ?', id);
  }

  create({ name, color = '#fa9d3b', note = '' }) {
    const finalName = String(name || '').trim();
    if (!finalName) throw new Error('标签名称不能为空');
    if (db().get('SELECT id FROM tags WHERE name = ?', finalName)) throw new Error('标签已存在');
    const info = db().run('INSERT INTO tags (name, color, note, created_at) VALUES (?, ?, ?, ?)', finalName, color, note, nowIso());
    return this.get(Number(info.lastInsertRowid));
  }

  update(id, { name, color, note }) {
    const current = this.get(id);
    if (!current) return null;
    db().run('UPDATE tags SET name = ?, color = ?, note = ? WHERE id = ?',
      name !== undefined ? String(name).trim() : current.name,
      color !== undefined ? color : current.color,
      note !== undefined ? note : current.note,
      id);
    return this.get(id);
  }

  remove(id) {
    db().run('DELETE FROM tags WHERE id = ?', id);
    db().run('DELETE FROM subject_tags WHERE tag_id = ?', id);
    db().run('DELETE FROM video_tags WHERE tag_id = ?', id);
    db().run('DELETE FROM text_tags WHERE tag_id = ?', id);
    return true;
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
