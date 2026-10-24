import { getDb } from '../db.js';
import { nowIso } from '../util.js';

const db = () => getDb();

export class PoolExhaustedError extends Error {
  constructor(message = '可用的视频/文本已被用尽（随机不重复策略）') {
    super(message);
    this.name = 'PoolExhaustedError';
    this.code = 'POOL_EXHAUSTED';
  }
}

export class NotFoundError extends Error {
  constructor(message = '资源不存在') {
    super(message);
    this.name = 'NotFoundError';
    this.code = 'NOT_FOUND';
  }
}

/**
 * 资源选择策略：
 *  - sequential    顺序：按 id 顺序循环（记录游标）
 *  - random        随机可重复
 *  - random-unique 随机不可重复（用尽后可按配置重置）
 *  - fixed         固定资源
 */
export class ResourcePicker {
  constructor({ videos, texts }) {
    this.videos = videos;
    this.texts = texts;
  }

  pool(kind, { tagIds = [], preferUnuploaded = false, requireUploaded = null } = {}) {
    const uploaded = requireUploaded === true ? 'yes' : requireUploaded === false ? 'no' : '';
    const rows = kind === 'video'
      ? this.videos.all({ tagIds, uploaded })
      : this.texts.all({ tagIds, uploaded });
    if (preferUnuploaded) {
      rows.sort((a, b) => (a.uploadCount || 0) - (b.uploadCount || 0) || a.id - b.id);
    }
    return rows;
  }

  usedIds(scope, kind) {
    return new Set(db().all('SELECT resource_id FROM pool_usage WHERE scope = ? AND kind = ?', scope, kind)
      .map((row) => String(row.resource_id)));
  }

  markUsed(scope, kind, id) {
    try {
      db().run(
        'INSERT OR IGNORE INTO pool_usage (scope, kind, resource_id, used_at) VALUES (?, ?, ?, ?)',
        scope, kind, String(id), nowIso(),
      );
    } catch { /* ignore */ }
  }

  cursor(scope, kind) {
    return Number(db().get('SELECT cursor FROM pool_cursor WHERE scope = ? AND kind = ?', scope, kind)?.cursor || 0);
  }

  setCursor(scope, kind, cursor) {
    db().run(
      `INSERT INTO pool_cursor (scope, kind, cursor) VALUES (?, ?, ?)
       ON CONFLICT(scope, kind) DO UPDATE SET cursor = excluded.cursor`,
      scope, kind, cursor,
    );
  }

  pick(kind, options) {
    const {
      scope = 'default',
      strategy = 'sequential',
      tagIds = [],
      fixedId = null,
      preferUnuploaded = false,
      requireUploaded = null,
      allowReset = true,
      peek = false,
      peekOffset = 0,
      excludeIds = [],
    } = options || {};

    if (strategy === 'fixed') {
      const id = Number(fixedId);
      const row = kind === 'video' ? this.videos.get(id) : this.texts.get(id);
      if (!row) throw new NotFoundError(kind === 'video' ? '配置的固定视频不存在' : '配置的固定文本不存在');
      if (!peek) this.markUsed(scope, kind, id);
      return row;
    }

    let candidates = this.pool(kind, { tagIds, preferUnuploaded, requireUploaded });
    const excluded = new Set((excludeIds || []).map((id) => String(id)));
    if (excluded.size) candidates = candidates.filter((row) => !excluded.has(String(row.id)));
    if (!candidates.length) {
      throw new PoolExhaustedError(kind === 'video' ? '视频池中没有符合标签条件的视频' : '文本池中没有符合标签条件的文本');
    }

    if (strategy === 'random') {
      const row = candidates[Math.floor(Math.random() * candidates.length)];
      if (!peek) this.markUsed(scope, kind, row.id);
      return row;
    }

    if (strategy === 'random-unique') {
      const used = this.usedIds(scope, kind);
      const unused = candidates.filter((row) => !used.has(String(row.id)));
      if (!unused.length) {
        // 试运行（peek）不做重置等写操作，避免污染使用状态
        if (peek) {
          const row = candidates[Math.floor(Math.random() * candidates.length)];
          return row;
        }
        if (!allowReset) throw new PoolExhaustedError();
        candidates = this.pool(kind, { tagIds, preferUnuploaded, requireUploaded })
          .filter((row) => !excluded.has(String(row.id)));
        if (!candidates.length) throw new PoolExhaustedError();
        db().run('DELETE FROM pool_usage WHERE scope = ? AND kind = ?', scope, kind);
      } else {
        candidates = unused;
      }
      const row = candidates[Math.floor(Math.random() * candidates.length)];
      if (!peek) this.markUsed(scope, kind, row.id);
      return row;
    }

    // sequential（peekOffset 用于试运行时在内存中推进一步，不写游标）
    const cursor = this.cursor(scope, kind);
    const row = candidates[(cursor + (peek ? Math.max(0, Number(peekOffset) || 0) : 0)) % candidates.length];
    if (!peek) {
      this.setCursor(scope, kind, cursor + 1);
      this.markUsed(scope, kind, row.id);
    }
    return row;
  }

  pickVideo(options) {
    return this.pick('video', options);
  }

  pickText(options) {
    return this.pick('text', options);
  }

  resetPool(scope) {
    db().run('DELETE FROM pool_usage WHERE scope = ?', scope);
    db().run('DELETE FROM pool_cursor WHERE scope = ?', scope);
  }

  poolState(scope) {
    return {
      used: db().all('SELECT kind, COUNT(*) AS n FROM pool_usage WHERE scope = ? GROUP BY kind', scope),
      cursors: db().all('SELECT kind, cursor FROM pool_cursor WHERE scope = ?', scope),
    };
  }
}
