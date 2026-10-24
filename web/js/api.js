const BASE = '/api';

async function request(path, { method = 'GET', body, parse = true } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { ok: false, error: text.slice(0, 200) }; }
  if (!res.ok || !data || data.ok === false) {
    const error = new Error(data?.error || `请求失败（HTTP ${res.status}）`);
    error.code = data?.code || 'HTTP_ERROR';
    throw error;
  }
  return parse ? data.data : data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body = {}) => request(path, { method: 'POST', body }),
  put: (path, body = {}) => request(path, { method: 'PUT', body }),
  del: (path) => request(path, { method: 'DELETE' }),

  // 概览
  overview: () => request('/overview'),
  health: () => request('/health'),

  // 标签
  tags: (withCounts = false) => request(`/tags${withCounts ? '?withCounts=1' : ''}`),
  createTag: (body) => request('/tags', { method: 'POST', body }),
  assignTags: (body) => request('/tags/assign', { method: 'POST', body }),
  updateTag: (id, body) => request(`/tags/${id}`, { method: 'PUT', body }),
  deleteTag: (id) => request(`/tags/${id}`, { method: 'DELETE' }),
  tagGroups: (withCounts = false) => request(`/tag-groups${withCounts ? '?withCounts=1' : ''}`),
  createTagGroup: (body) => request('/tag-groups', { method: 'POST', body }),
  updateTagGroup: (id, body) => request(`/tag-groups/${id}`, { method: 'PUT', body }),
  deleteTagGroup: (id) => request(`/tag-groups/${id}`, { method: 'DELETE' }),

  // 主体
  subjects: (query = {}) => {
    const params = new URLSearchParams();
    if (query.status) params.set('status', query.status);
    if (query.tagIds?.length) params.set('tagIds', query.tagIds.join(','));
    if (query.q) params.set('q', query.q);
    const suffix = params.toString();
    return request(`/subjects${suffix ? `?${suffix}` : ''}`);
  },
  createSubject: (body) => request('/subjects', { method: 'POST', body }),
  updateSubject: (id, body) => request(`/subjects/${id}`, { method: 'PUT', body }),
  deleteSubject: (id) => request(`/subjects/${id}`, { method: 'DELETE' }),
  startLogin: (body = {}) => request('/subjects/login', { method: 'POST', body }),
  loginStatus: (attemptId) => request(`/subjects/login/${attemptId}`),
  refreshLoginQr: (attemptId) => request(`/subjects/login/${attemptId}/refresh`, { method: 'POST', body: {} }),
  openLoginBrowser: (attemptId) => request(`/subjects/login/${attemptId}/open-browser`, { method: 'POST', body: {} }),
  cancelLogin: (attemptId) => request(`/subjects/login/${attemptId}/cancel`, { method: 'POST', body: {} }),
  checkSubject: (id) => request(`/subjects/${id}/check`, { method: 'POST', body: {} }),
  checkAllSubjects: (body = {}) => request('/subjects/check-all', { method: 'POST', body }),
  openSubjectBrowser: (id) => request(`/subjects/${id}/open`, { method: 'POST', body: {} }),
  closeSubjectBrowser: (id) => request(`/subjects/${id}/close-browser`, { method: 'POST', body: {} }),

  // 探测
  probe: (subjectId) => request(`/probe/${subjectId}`, { method: 'POST', body: {} }),
  probeDeep: (subjectId, body = {}) => request(`/probe/${subjectId}/deep`, { method: 'POST', body }),

  // 视频
  videos: (query = {}) => {
    const params = new URLSearchParams();
    if (query.tagIds?.length) params.set('tagIds', query.tagIds.join(','));
    if (query.q) params.set('q', query.q);
    if (query.uploaded) params.set('uploaded', query.uploaded);
    if (query.page) params.set('page', String(query.page));
    if (query.pageSize) params.set('pageSize', String(query.pageSize));
    if (query.sort) params.set('sort', query.sort);
    return request(`/videos?${params.toString()}`);
  },
  videoFolders: () => request('/videos/folders'),
  addVideoFolder: (body) => request('/videos/folders', { method: 'POST', body }),
  updateVideoFolder: (id, body) => request(`/videos/folders/${id}`, { method: 'PUT', body }),
  deleteVideoFolder: (id) => request(`/videos/folders/${id}`, { method: 'DELETE' }),
  pickFolder: (body = {}) => request('/system/pick-folder', { method: 'POST', body }),
  listDirs: (path = '') => request(`/system/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  scanVideos: () => request('/videos/scan', { method: 'POST', body: {} }),
  generateThumbnails: (body = {}) => request('/videos/thumbnails', { method: 'POST', body }),
  thumbnailStatus: () => request('/videos/thumbnails/status'),
  computeMd5: (ids = []) => request('/videos/md5', { method: 'POST', body: { ids } }),
  updateVideo: (id, body) => request(`/videos/${id}`, { method: 'PUT', body }),
  deleteVideo: (id, deleteFile = false) => request(`/videos/${id}${deleteFile ? '?deleteFile=1' : ''}`, { method: 'DELETE' }),
  videoFileUrl: (id) => `/api/videos/${id}/file`,

  // 文本
  texts: (query = {}) => {
    const params = new URLSearchParams();
    if (query.tagIds?.length) params.set('tagIds', query.tagIds.join(','));
    if (query.q) params.set('q', query.q);
    if (query.uploaded) params.set('uploaded', query.uploaded);
    if (query.page) params.set('page', String(query.page));
    if (query.pageSize) params.set('pageSize', String(query.pageSize));
    return request(`/texts?${params.toString()}`);
  },
  createText: (body) => request('/texts', { method: 'POST', body }),
  importTexts: (body) => request('/texts/import', { method: 'POST', body }),
  updateText: (id, body) => request(`/texts/${id}`, { method: 'PUT', body }),
  deleteText: (id) => request(`/texts/${id}`, { method: 'DELETE' }),

  // 发布配置
  configs: () => request('/configs'),
  config: (id) => request(`/configs/${id}`),
  createConfig: (body) => request('/configs', { method: 'POST', body }),
  updateConfig: (id, body) => request(`/configs/${id}`, { method: 'PUT', body }),
  deleteConfig: (id) => request(`/configs/${id}`, { method: 'DELETE' }),
  configSubjects: (id) => request(`/configs/${id}/subjects`),
  previewConfig: (id) => request(`/configs/${id}/preview`, { method: 'POST', body: {} }),
  resetConfigPool: (id) => request(`/configs/${id}/reset-pool`, { method: 'POST', body: {} }),

  // 任务
  tasks: (query = {}) => request(`/tasks?${new URLSearchParams(query).toString()}`),
  createTask: (body) => request('/tasks', { method: 'POST', body }),
  task: (id) => request(`/tasks/${id}`),
  startTask: (id) => request(`/tasks/${id}/start`, { method: 'POST', body: {} }),
  cancelTask: (id) => request(`/tasks/${id}/cancel`, { method: 'POST', body: {} }),

  // 设置
  settings: () => request('/settings'),
  updateSettings: (body) => request('/settings', { method: 'PUT', body }),
  updateSelectors: (selectors) => request('/settings/selectors', { method: 'PUT', body: { selectors } }),
  resetSettings: () => request('/settings/reset', { method: 'POST', body: {} }),
  browsers: () => request('/settings/browsers'),
  importPayload: (payload, mode) => request('/settings/import', { method: 'POST', body: { payload, mode } }),

  // 微信
  wechatStatus: () => request('/wechat/status'),
  wechatEnable: (enabled, botId) => request('/wechat/enable', { method: 'POST', body: { enabled, botId } }),
  wechatImport: (botId) => request('/wechat/import', { method: 'POST', body: { botId } }),
  wechatBind: () => request('/wechat/bind', { method: 'POST', body: {} }),
  wechatBinding: (id) => request(`/wechat/bind/${id}`),
  wechatVerify: (id, code) => request(`/wechat/bind/${id}/verify`, { method: 'POST', body: { code } }),
  wechatCancelBind: (id) => request(`/wechat/bind/${id}/cancel`, { method: 'POST', body: {} }),
  wechatTest: () => request('/wechat/test', { method: 'POST', body: {} }),
  wechatNotify: (text) => request('/wechat/notify', { method: 'POST', body: { text } }),
  wechatRefreshContext: () => request('/wechat/refresh-context', { method: 'POST', body: {} }),
  wechatRemoveBot: (botId) => request(`/wechat/bots/${botId}`, { method: 'DELETE' }),

  // 后台任务
  jobs: () => request('/jobs'),
  job: (id) => request(`/jobs/${id}`),
};
