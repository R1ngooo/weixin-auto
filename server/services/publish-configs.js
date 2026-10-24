import { getDb } from '../db.js';
import { nowIso, uid } from '../util.js';

const db = () => getDb();

export function defaultConfig() {
  return {
    name: '默认发布配置',
    action: 'draft',
    subjectSelection: { mode: 'ids', ids: [], tags: [] },
    videoSelection: {
      tags: [],
      strategy: 'sequential',
      fixedVideoId: null,
      preferUnuploaded: true,
      requireUploaded: null,
    },
    textSelection: {
      tags: [],
      strategy: 'sequential',
      fixedTextId: null,
      preferUnuploaded: true,
      requireUploaded: null,
    },
    pageOptions: {
      description: { enabled: true, prefix: '', suffix: '', hashtags: [] },
      shortTitle: { enabled: false, fromVideoName: true, value: '' },
      location: { enabled: false, value: '' },
      collection: { enabled: false, value: '' },
      original: { enabled: false },
      videoMark: { enabled: false, value: '无需标注' },
      scheduled: { enabled: false, value: null },
      extLink: { enabled: false, value: '' },
    },
    pool: { allowReset: true, scope: 'config' },
    syncWechat: false,
    timingOverride: {},
  };
}

export function normalizeConfig(input = {}) {
  const base = defaultConfig();
  const out = {
    ...base,
    ...input,
    subjectSelection: { ...base.subjectSelection, ...(input.subjectSelection || {}) },
    videoSelection: { ...base.videoSelection, ...(input.videoSelection || {}) },
    textSelection: { ...base.textSelection, ...(input.textSelection || {}) },
    pageOptions: {},
    pool: { ...base.pool, ...(input.pool || {}) },
    timingOverride: { ...base.timingOverride, ...(input.timingOverride || {}) },
  };
  for (const key of Object.keys(base.pageOptions)) {
    out.pageOptions[key] = { ...base.pageOptions[key], ...(input.pageOptions?.[key] || {}) };
  }
  out.subjectSelection.ids = (out.subjectSelection.ids || []).map(String);
  out.subjectSelection.tags = (out.subjectSelection.tags || []).map(Number).filter(Boolean);
  out.videoSelection.tags = (out.videoSelection.tags || []).map(Number).filter(Boolean);
  out.textSelection.tags = (out.textSelection.tags || []).map(Number).filter(Boolean);
  out.pageOptions.description.hashtags = (out.pageOptions.description.hashtags || [])
    .map((tag) => String(tag || '').replace(/^#/, '').trim())
    .filter(Boolean);
  if (!['draft', 'publish'].includes(out.action)) out.action = 'draft';
  return out;
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

  create({ name, config }) {
    const id = uid('cfg_');
    const normalized = normalizeConfig({ ...config, name: name || config?.name });
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
    const normalized = normalizeConfig({ ...current.config, ...(config || {}), name: name || config?.name || current.name });
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
    const { subjectSelection } = record.config;
    if (subjectSelection.mode === 'tags') {
      if (!subjectSelection.tags.length) return [];
      return subjectService.list({ tagIds: subjectSelection.tags });
    }
    return (subjectSelection.ids || []).map((subjectId) => subjectService.get(subjectId)).filter(Boolean);
  }
}
