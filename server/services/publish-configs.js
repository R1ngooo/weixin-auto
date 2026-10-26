import { getDb } from '../db.js';
import { nowIso, uid } from '../util.js';

const db = () => getDb();

export const STRATEGIES = ['random', 'random-unique', 'fixed'];
export const UPLOAD_FILTERS = ['', 'yes', 'no'];
export const PER_SUBJECT_VIDEO_LIMIT = 5;
export const SCHEDULE_MIN_LEAD_MS = 10 * 60_000;
export const SCHEDULE_INTERVAL_MIN = 1;
export const SCHEDULE_INTERVAL_MAX = 1440;

function toInt(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function uniqueIds(values = []) {
  return [...new Set(values.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0))];
}

function normalizeStrategy(value) {
  // 旧配置的「顺序」策略已废弃，迁移为随机不可重复
  if (value === 'sequential') return 'random-unique';
  return STRATEGIES.includes(value) ? value : 'random-unique';
}

function normalizeUploadFilter(value) {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  if (value === 'yes' || value === 'no') return value;
  return 'no'; // 默认仅未使用过的素材
}

function normalizeTags(values = []) {
  return uniqueIds(values);
}

export function defaultConfig() {
  return {
    name: '默认发布配置',
    action: 'draft',
    // 资源选择默认围绕标签组筛选：同一组标签同时作用于主体/视频/文本
    resourceTags: [],
    subjectSelection: { mode: 'tags', ids: [], tags: [] },
    videoSelection: {
      tags: [],
      strategy: 'random-unique',
      fixedVideoIds: [],
      requireUploaded: 'no',
      perSubjectCount: 1,
    },
    textSelection: {
      tags: [],
      strategy: 'random-unique',
      fixedTextIds: [],
      requireUploaded: 'no',
    },
    pageOptions: {
      // 新闻：先上传再删除全部素材，之后再逐个搭建发布信息
      preUploadAll: { enabled: false },
      description: { enabled: true, prefix: '', suffix: '', hashtags: [] },
      shortTitle: { enabled: false, value: '' },
      location: { enabled: false, value: '' },
      collection: { enabled: false, value: '' },
      videoMark: { enabled: false, value: '无需标注' },
      scheduled: { enabled: false, value: null, intervalMinutes: 10, intervalScope: 'subject' },
      // 页面上的「链接」，可填商品链接或商品ID（保留 extLink 字段兼容旧配置）
      extLink: { enabled: false, value: '' },
    },
    pool: { allowReset: false, scope: 'config' },
    syncWechat: false,
    timingOverride: {},
  };
}

export function normalizeConfig(input = {}) {
  const base = defaultConfig();
  const pageInput = input.pageOptions || {};

  // 迁移：旧配置按资源类型分别保存标签，这里合并成统一资源标签；新配置以 resourceTags 为准
  const explicitTags = Array.isArray(input.resourceTags) ? normalizeTags(input.resourceTags) : null;
  const legacyTags = normalizeTags([
    ...(input.subjectSelection?.tags || []),
    ...(input.videoSelection?.tags || []),
    ...(input.textSelection?.tags || []),
  ]);
  const resourceTags = explicitTags ?? legacyTags;

  const subjectIds = (input.subjectSelection?.ids || []).map(String);
  const subjectMode = input.subjectSelection?.mode === 'ids' || input.subjectSelection?.mode === 'tags'
    ? input.subjectSelection.mode
    : (subjectIds.length ? 'ids' : 'tags');

  const legacyFixedVideo = input.videoSelection?.fixedVideoId;
  const fixedVideoIds = uniqueIds(
    Array.isArray(input.videoSelection?.fixedVideoIds)
      ? input.videoSelection.fixedVideoIds
      : (legacyFixedVideo ? [legacyFixedVideo] : []),
  );
  const legacyFixedText = input.textSelection?.fixedTextId;
  const fixedTextIds = uniqueIds(
    Array.isArray(input.textSelection?.fixedTextIds)
      ? input.textSelection.fixedTextIds
      : (legacyFixedText ? [legacyFixedText] : []),
  );

  const pageOptions = {};
  for (const key of Object.keys(base.pageOptions)) {
    pageOptions[key] = { ...base.pageOptions[key], ...(pageInput[key] || {}) };
  }
  // 移除已废弃字段：声明原创、使用视频文件名
  delete pageOptions.original;
  pageOptions.description.hashtags = (pageOptions.description.hashtags || [])
    .map((tag) => String(tag || '').replace(/^#/, '').trim())
    .filter(Boolean);
  pageOptions.shortTitle = {
    enabled: Boolean(pageOptions.shortTitle?.enabled),
    value: String(pageOptions.shortTitle?.value || ''),
  };
  pageOptions.preUploadAll = {
    enabled: Boolean(pageOptions.preUploadAll?.enabled),
  };
  pageOptions.scheduled = {
    enabled: Boolean(pageOptions.scheduled?.enabled),
    value: pageOptions.scheduled?.value || null,
    intervalMinutes: Math.max(SCHEDULE_INTERVAL_MIN, Math.min(SCHEDULE_INTERVAL_MAX, toInt(pageOptions.scheduled?.intervalMinutes, 10))),
    intervalScope: pageOptions.scheduled?.intervalScope === 'task' ? 'task' : 'subject',
  };

  const out = {
    name: String(input.name || base.name),
    action: ['draft', 'publish'].includes(input.action) ? input.action : 'draft',
    resourceTags,
    subjectSelection: {
      mode: subjectMode,
      ids: subjectIds,
      // 兼容旧读取方：tags 与统一资源标签保持一致
      tags: resourceTags,
    },
    videoSelection: {
      tags: resourceTags,
      strategy: normalizeStrategy(input.videoSelection?.strategy),
      fixedVideoIds,
      requireUploaded: normalizeUploadFilter(input.videoSelection?.requireUploaded),
      perSubjectCount: Math.max(1, Math.min(PER_SUBJECT_VIDEO_LIMIT, toInt(input.videoSelection?.perSubjectCount, 1))),
    },
    textSelection: {
      tags: resourceTags,
      strategy: normalizeStrategy(input.textSelection?.strategy),
      fixedTextIds,
      requireUploaded: normalizeUploadFilter(input.textSelection?.requireUploaded),
    },
    pageOptions,
    pool: {
      allowReset: input.pool?.allowReset === true,
      scope: input.pool?.scope === 'subject' ? 'subject' : 'config',
    },
    syncWechat: Boolean(input.syncWechat),
    timingOverride: { ...(base.timingOverride || {}), ...(input.timingOverride || {}) },
  };
  return out;
}

function hasTag(kind, id, tagIds) {
  if (!tagIds.length) return true;
  const table = kind === 'video' ? 'video_tags' : 'text_tags';
  const column = kind === 'video' ? 'video_id' : 'text_id';
  const row = db().get(
    `SELECT 1 AS hit FROM ${table} WHERE ${column} = ? AND tag_id IN (${tagIds.map(() => '?').join(',')}) LIMIT 1`,
    id, ...tagIds,
  );
  return Boolean(row);
}

function hasUploadHistory(kind, id) {
  const column = kind === 'video' ? 'video_id' : 'text_id';
  return Boolean(db().get(
    `SELECT 1 AS hit FROM upload_history WHERE ${column} = ? AND status IN ('success','unknown') LIMIT 1`,
    id,
  ));
}

/** 校验固定资源是否在「标签 + 使用状态」筛选的交集范围内 */
function assertFixedResources(kind, ids, tagIds, requireUploaded) {
  if (!ids.length) return;
  const label = kind === 'video' ? '固定视频' : '固定文本';
  for (const id of ids) {
    const row = kind === 'video'
      ? db().get('SELECT id, name FROM videos WHERE id = ?', id)
      : db().get('SELECT id, content FROM texts WHERE id = ?', id);
    if (!row) throw new Error(`${label} #${id} 不存在，请重新选择`);
    const title = kind === 'video' ? (row.name || `#${id}`) : (String(row.content || '').slice(0, 20) || `#${id}`);
    if (!hasTag(kind, id, tagIds)) {
      throw new Error(`${label}「${title}」不在所选资源标签范围内，请重新选择`);
    }
    const uploaded = hasUploadHistory(kind, id);
    if (requireUploaded === 'yes' && !uploaded) {
      throw new Error(`${label}「${title}」未使用过，不符合「仅已使用过」过滤条件`);
    }
    if (requireUploaded === 'no' && uploaded) {
      throw new Error(`${label}「${title}」已使用过，不符合「仅未使用过」过滤条件`);
    }
  }
}

export class PublishConfigService {
  list() {
    return db().all('SELECT * FROM publish_configs ORDER BY updated_at DESC').map((row) => this.decorate(row));
  }

  decorate(row) {
    let config = null;
    try { config = JSON.parse(row.config_json); } catch { config = defaultConfig(); }
    return {
      id: row.id,
      name: row.name,
      config: normalizeConfig(config),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  get(id) {
    const row = db().get('SELECT * FROM publish_configs WHERE id = ?', id);
    return row ? this.decorate(row) : null;
  }

  /** 校验配置是否可保存/执行；返回规范化后的配置 */
  validateConfig(input = {}, { enforceScheduleLead = true } = {}) {
    const config = normalizeConfig(input);
    const page = config.pageOptions;

    if (page.shortTitle.enabled) {
      const value = String(page.shortTitle.value || '').trim();
      if (!value) throw new Error('勾选「填写短标题」后，短标题不能为空');
      const length = [...value].length;
      if (length < 6 || length > 16) {
        throw new Error(`短标题需为 6-16 个字（当前 ${length} 个字）`);
      }
    }
    if (page.scheduled.enabled) {
      const time = Date.parse(page.scheduled.value);
      if (!Number.isFinite(time)) throw new Error('请选择定时发表时间');
      if (enforceScheduleLead && time < Date.now() + SCHEDULE_MIN_LEAD_MS - 30_000) {
        throw new Error('定时发表起点需晚于当前时间至少 10 分钟（容错）');
      }
      if (!Number.isInteger(page.scheduled.intervalMinutes) || page.scheduled.intervalMinutes < SCHEDULE_INTERVAL_MIN) {
        throw new Error(`定时发表间隔需为不少于 ${SCHEDULE_INTERVAL_MIN} 分钟的整数`);
      }
    }
    if (page.extLink.enabled && !String(page.extLink.value || '').trim()) {
      throw new Error('勾选「链接」后，请填写商品链接或商品ID');
    }
    if (config.subjectSelection.mode === 'ids' && !config.subjectSelection.ids.length) {
      throw new Error('请至少选择一个主体');
    }
    if (config.subjectSelection.mode === 'tags' && !config.resourceTags.length) {
      throw new Error('请至少选择一个资源标签（用于筛选主体/视频/文本）');
    }
    if (config.videoSelection.strategy === 'fixed') {
      if (!config.videoSelection.fixedVideoIds.length) throw new Error('固定指定视频时，请至少选择一个固定视频');
      assertFixedResources('video', config.videoSelection.fixedVideoIds, config.resourceTags, config.videoSelection.requireUploaded);
    }
    if (config.textSelection.strategy === 'fixed') {
      if (!config.textSelection.fixedTextIds.length) throw new Error('固定指定文本时，请至少选择一个固定文本');
      assertFixedResources('text', config.textSelection.fixedTextIds, config.resourceTags, config.textSelection.requireUploaded);
    }
    return config;
  }

  create({ name, config }) {
    const normalized = this.validateConfig({ ...config, name: name || config?.name });
    const id = uid('cfg_');
    const now = nowIso();
    db().run(
      'INSERT INTO publish_configs (id, name, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      id, name || normalized.name, JSON.stringify(normalized), now, now,
    );
    return this.get(id);
  }

  update(id, { name, config }) {
    const current = this.get(id);
    if (!current) return null;
    const normalized = this.validateConfig({ ...current.config, ...(config || {}), name: name || config?.name || current.name });
    db().run(
      'UPDATE publish_configs SET name = ?, config_json = ?, updated_at = ? WHERE id = ?',
      name || current.name, JSON.stringify(normalized), nowIso(), id,
    );
    return this.get(id);
  }

  remove(id) {
    db().run('DELETE FROM publish_configs WHERE id = ?', id);
    return true;
  }

  resolveSubjects(id, subjectService) {
    const record = this.get(id);
    if (!record) throw new Error('发布配置不存在');
    const { subjectSelection, resourceTags } = record.config;
    if (subjectSelection.mode === 'tags') {
      if (!resourceTags.length) return [];
      return subjectService.list({ tagIds: resourceTags });
    }
    return (subjectSelection.ids || []).map((subjectId) => subjectService.get(subjectId)).filter(Boolean);
  }
}
