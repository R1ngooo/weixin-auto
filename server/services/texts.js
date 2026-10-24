import { getDb } from '../db.js';
import { sha256, nowIso, toInt } from '../util.js';
import { attachTags, hydrateTags } from './subjects.js';

const db = () => getDb();

const TEXT_STATS_SQL = `
  SELECT h.text_id AS id, COUNT(*) AS upload_count, MAX(h.created_at) AS last_uploaded_at
    FROM upload_history h
   WHERE h.text_id IS NOT NULL AND h.status IN ('success', 'unknown')
   GROUP BY h.text_id
`;

export class TextService {
  list({ tagIds = [], query = '', uploaded = '', page = 1, pageSize = 100 } = {}) {
    const where = [];
    const params = [];
    if (query) {
      where.push(`(t.content LIKE ? OR t.note LIKE ?
        OR EXISTS (SELECT 1 FROM text_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.text_id = t.id AND g.name LIKE ?))`);
      const like = `%${query}%`;
      params.push(like, like, like);
    }
    if (uploaded === 'yes') where.push("t.id IN (SELECT text_id FROM upload_history WHERE status IN ('success','unknown'))");
    if (uploaded === 'no') where.push("t.id NOT IN (SELECT text_id FROM upload_history WHERE text_id IS NOT NULL AND status IN ('success','unknown'))");
    if (tagIds.length) {
      where.push(`t.id IN (SELECT text_id FROM text_tags WHERE tag_id IN (${tagIds.map(() => '?').join(',')}))`);
      params.push(...tagIds);
    }
    const limit = Math.max(1, Math.min(500, toInt(pageSize, 100)));
    const offset = (Math.max(1, toInt(page, 1)) - 1) * limit;
    const total = Number(db().get(`SELECT COUNT(*) AS n FROM texts t ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, ...params)?.n || 0);
    const rows = db().all(
      `SELECT t.* FROM texts t ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.id DESC LIMIT ? OFFSET ?`,
      ...params, limit, offset,
    );
    const hydrated = hydrateTags('text', rows);
    const stats = new Map(db().all(TEXT_STATS_SQL).map((row) => [Number(row.id), row]));
    return {
      data: hydrated.map((row) => {
        const stat = stats.get(Number(row.id));
        return {
          id: Number(row.id),
          content: row.content,
          hash: row.hash,
          note: row.note || '',
          tags: row.tags,
          uploadCount: Number(stat?.upload_count || 0),
          lastUploadedAt: stat?.last_uploaded_at || '',
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      }),
      total,
      page: Math.max(1, toInt(page, 1)),
      pageSize: limit,
    };
  }

  all({ tagIds = [], uploaded = '' } = {}) {
    const where = [];
    const params = [];
    if (uploaded === 'yes') where.push("t.id IN (SELECT text_id FROM upload_history WHERE status IN ('success','unknown'))");
    if (uploaded === 'no') where.push("t.id NOT IN (SELECT text_id FROM upload_history WHERE text_id IS NOT NULL AND status IN ('success','unknown'))");
    if (tagIds.length) {
      where.push(`t.id IN (SELECT text_id FROM text_tags WHERE tag_id IN (${tagIds.map(() => '?').join(',')}))`);
      params.push(...tagIds);
    }
    const rows = db().all(`SELECT t.* FROM texts t ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.id`, ...params);
    const stats = new Map(db().all(TEXT_STATS_SQL).map((row) => [Number(row.id), row]));
    return hydrateTags('text', rows).map((row) => ({
      id: Number(row.id), content: row.content, hash: row.hash, tags: row.tags,
      uploadCount: Number(stats.get(Number(row.id))?.upload_count || 0),
    }));
  }

  get(id) {
    const row = db().get('SELECT * FROM texts WHERE id = ?', id);
    if (!row) return null;
    const tags = hydrateTags('text', [row])[0].tags;
    return { ...row, id: Number(row.id), tags };
  }

  count() {
    return Number(db().get('SELECT COUNT(*) AS n FROM texts')?.n || 0);
  }

  create({ content, note = '', tagIds = [] }) {
    const text = String(content ?? '').trim();
    if (!text) throw new Error('文本内容不能为空');
    const hash = sha256(text);
    const existing = db().get('SELECT id FROM texts WHERE hash = ?', hash);
    if (existing) return { ...this.get(Number(existing.id)), duplicated: true };
    const info = db().run(
      'INSERT INTO texts (content, hash, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      text, hash, note, nowIso(), nowIso(),
    );
    attachTags('text', Number(info.lastInsertRowid), tagIds);
    return this.get(Number(info.lastInsertRowid));
  }

  /** 批量导入；按换行或空行拆分，去重 */
  import({ text = '', items = null, separator = 'line', note = '', tagIds = [] }) {
    let list = [];
    if (Array.isArray(items)) {
      list = items;
    } else {
      const raw = String(text || '').replace(/\r\n/g, '\n');
      if (separator === 'blank-line') {
        list = raw.split(/\n\s*\n/);
      } else if (separator === 'json') {
        try {
          const parsed = JSON.parse(raw);
          list = Array.isArray(parsed) ? parsed.map((item) => (typeof item === 'string' ? item : item?.content ?? '')) : [];
        } catch {
          throw new Error('JSON 格式不正确，应为字符串数组');
        }
      } else {
        list = raw.split('\n');
      }
    }
    let created = 0;
    let duplicated = 0;
    let skipped = 0;
    for (const item of list) {
      const content = String(item ?? '').trim();
      if (!content) { skipped += 1; continue; }
      try {
        const result = this.create({ content, note, tagIds });
        if (result.duplicated) duplicated += 1;
        else created += 1;
      } catch {
        skipped += 1;
      }
    }
    return { created, duplicated, skipped, total: list.length };
  }

  update(id, { content, note, tagIds }) {
    const current = this.get(id);
    if (!current) return null;
    if (content !== undefined) {
      const text = String(content).trim();
      if (!text) throw new Error('文本内容不能为空');
      const hash = sha256(text);
      const clash = db().get('SELECT id FROM texts WHERE hash = ? AND id <> ?', hash, id);
      if (clash) throw new Error('相同内容的文本已存在（内容需全局唯一）');
      db().run('UPDATE texts SET content = ?, hash = ?, updated_at = ? WHERE id = ?', text, hash, nowIso(), id);
    }
    if (note !== undefined) db().run('UPDATE texts SET note = ?, updated_at = ? WHERE id = ?', note, nowIso(), id);
    if (Array.isArray(tagIds)) attachTags('text', id, tagIds);
    return this.get(id);
  }

  remove(id) {
    db().run('DELETE FROM texts WHERE id = ?', id);
    db().run('DELETE FROM text_tags WHERE text_id = ?', id);
    return true;
  }

  setTags(id, tagIds) {
    attachTags('text', id, tagIds);
    return this.get(id);
  }
}
