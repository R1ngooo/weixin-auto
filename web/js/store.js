import { api } from './api.js';

export const store = {
  tags: [],
  settings: null,
  wechat: null,
  browsers: null,
  listeners: new Set(),

  on(event, cb) {
    this.listeners.add({ event, cb });
    return () => this.listeners.delete({ event, cb });
  },

  emit(event, data) {
    for (const listener of this.listeners) {
      if (listener.event === event) listener.cb(data);
    }
  },

  async loadTags(force = false) {
    if (!force && this.tags.length) return this.tags;
    this.tags = await api.tags();
    return this.tags;
  },

  async loadSettings(force = false) {
    if (!force && this.settings) return this.settings;
    const data = await api.settings();
    this.settings = data;
    return data;
  },

  async loadWechat(force = false) {
    if (!force && this.wechat) return this.wechat;
    this.wechat = await api.wechatStatus();
    return this.wechat;
  },

  async loadBrowsers(force = false) {
    if (!force && this.browsers) return this.browsers;
    this.browsers = await api.browsers();
    return this.browsers;
  },

  invalidateTags() {
    this.tags = [];
  },
};
