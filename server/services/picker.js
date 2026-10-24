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
 * 资源选择策略（已取消「顺序」策略）：
 *  - random        随机可重复
 *  - random-unique 随机不可重复（用尽后按配置决定是否自动重置）
 *  - fixed         固定资源（可多个，候选范围受标签+使用状态过滤约束）
 */
export class ResourcePicker {
  constructor({ videos, texts }) {
    this.videos = videos;
    this.texts = texts;
  }

  pool(kind, { tagIds = [], preferUnuploaded = false, requireUploaded = null } = {}) {
    const uploaded = requireUploaded === true ? 'yes' : requireUploaded === false ? 'no' : requireUploaded || '';
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

  pick(kind, options) {
    const {
      scope = 'default',
      strategy = 'random-unique',
      tagIds = [],
      fixedId = null,
      fixedIds = [],
      requireUploaded = null,
      allowReset = false,
      peek = false,
      excludeIds = [],
    } = options || {};

    const normalizedStrategy = strategy === 'sequential' ? 'random-unique' : strategy;

    if (normalizedStrategy === 'fixed') {
      const candidates = this.pool(kind, { tagIds, requireUploaded });
      const allowedIds = new Set(candidates.map((row) => Number(row.id)));
      const configuredIds = (Array.isArray(fixedIds) ? fixedIds : []).map((id) => Number(id)).filter(Boolean);
      const chosenId = Number(fixedId) || configuredIds[0] || null;
      const id = chosenId ? Number(chosenId) : null;
      if (!id) throw new NotFoundError(kind === 'video' ? '未选择固定视频' : '未选择固定文本');
      if (!allowedIds.has(id)) {
        throw new NotFoundError(kind === 'video'
          ? '固定视频不在所选标签/使用状态过滤范围内'
          : '固定文本不在所选标签/使用状态过滤范围内');
      }
      const row = kind === 'video' ? this.videos.get(id) : this.texts.get(id);
      if (!row) throw new NotFoundError(kind === 'video' ? '配置的固定视频不存在' : '配置的固定文本不存在');
      if (!peek) this.markUsed(scope, kind, id);
      return row;
    }

    let candidates = this.pool(kind, { tagIds, requireUploaded });
    const excluded = new Set((excludeIds || []).map((id) => String(id)));
    if (excluded.size) candidates = candidates.filter((row) => !excluded.has(String(row.id)));
    if (!candidates.length) {
      throw new PoolExhaustedError(kind === 'video' ? '视频池中没有符合标签条件的视频' : '文本池中没有符合标签条件的文本');
    }

    if (normalizedStrategy === 'random') {
      const row = candidates[Math.floor(Math.random() * candidates.length)];
      if (!peek) this.markUsed(scope, kind, row.id);
      return row;
    }

    // random-unique（默认策略）
    const used = this.usedIds(scope, kind);
    const unused = candidates.filter((row) => !used.has(String(row.id)));
    if (!unused.length) {
      // 试运行（peek）不做重置等写操作，避免污染使用状态
      if (peek) {
        const row = candidates[Math.floor(Math.random() * candidates.length)];
        return row;
      }
      if (!allowReset) throw new PoolExhaustedError();
      candidates = this.pool(kind, { tagIds, requireUploaded })
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

  pickVideo(options) {
    return this.pick('video', options);
  }

  pickText(options) {
    return this.pick('text', options);
  }
}
