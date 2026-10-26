import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { getDb } from '../db.js';
import { getSettings, updateSettings } from '../settings.js';
import { nowIso, sleep, uid } from '../util.js';
import { showLocalNotification } from './notifier.js';

const db = () => getDb();

const ILINK_BASE = 'https://ilinkai.weixin.qq.com/';
const PROTOCOL_VERSION = '2.4.6';
const BOT_AGENT = 'weixin-auto/0.2.0';
const APP_ID = 'bot';
const CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;
const LONG_POLL_TIMEOUT_MS = 35_000;
const SESSION_NOTICE_COOLDOWN_MS = 10 * 60_000;
const SESSION_REMINDER_TEXT = '【视频号助手自动化工具】微信机器人会话需要续期：请给这个机器人发送任意一条消息，然后在工具「执行记录 → 微信机器人」中点击「刷新连接上下文」，之后结果同步即可恢复。';

const TERMINAL = new Set(['success', 'failed', 'expired', 'cancelled']);

/** 把微信发送失败归类；session 表示需要用户续期上下文，auth 表示机器人授权失效 */
export function classifyWechatFailure(error) {
  const message = String(error?.message || error || '');
  if (/超时|timeout|fetch failed|network|ENOTFOUND|ECONN|HTTP 5\d\d/i.test(message)) return 'network';
  if (/未启用|未绑定|缺少.*(token|凭据)|not configured|未配置/i.test(message)) return 'config';
  if (/HTTP 401|HTTP 403|unauthorized|forbidden/i.test(message)) return 'auth';
  if (/token.*(无效|失效|invalid|revoked)|机器人.*(被)?移除|unbind|重新绑定/i.test(message)) return 'auth';
  if (/context|会话|session|expired|过期|login|登录|授权|续期/i.test(message)) return 'session';
  return 'other';
}

function commonHeaders() {
  return {
    'iLink-App-Id': APP_ID,
    'iLink-App-ClientVersion': String(CLIENT_VERSION),
  };
}

function authHeaders(token) {
  const headers = {
    ...commonHeaders(),
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function baseInfo() {
  return { channel_version: PROTOCOL_VERSION, bot_agent: BOT_AGENT };
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim() || ILINK_BASE;
  const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  if (url.protocol !== 'https:' || !/(^|\.)weixin\.qq\.com$/.test(url.hostname)) {
    throw new Error('微信接口地址不受信任');
  }
  return url.toString();
}

function trustedQrUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    if (!/(^|\.)weixin\.qq\.com$/.test(url.hostname) && !/(^|\.)wechat\.com$/.test(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function requestJson({ method, baseUrl = ILINK_BASE, endpoint, body, token, timeoutMs = 15_000, authenticated = true }) {
  const url = new URL(endpoint, normalizeBaseUrl(baseUrl));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: authenticated ? authHeaders(token) : commonHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`微信接口请求失败（HTTP ${response.status}）`);
    return await response.json();
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('微信接口请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function parseCredentialsRefs(raw) {
  const refs = {};
  let inRefs = false;
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inRefs = /^refs:\s*$/.test(line);
      continue;
    }
    if (!inRefs) continue;
    const match = line.match(/^\s+([A-Za-z0-9_]+):\s*(.+?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    refs[match[1]] = value;
  }
  return refs;
}

export function readDshImWeixinAccounts() {
  const home = dshHome();
  const configPath = path.join(home, 'integrations', 'dsh-weixin', 'config.json');
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return { available: false, configPath, accounts: [], reason: '未检测到本机 dsh-im 的微信机器人配置' };
  }
  let refs = {};
  try {
    refs = parseCredentialsRefs(fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8'));
  } catch { /* ignore */ }

  let workspaces = null;
  try {
    workspaces = JSON.parse(fs.readFileSync(path.join(home, 'integrations', 'dsh-weixin', 'workspaces.json'), 'utf8'));
  } catch { /* ignore */ }

  const accounts = (config.accounts || []).map((account) => {
    const token = refs[account.tokenRef] || null;
    let contextToken = null;
    let deliveryName = '';
    try {
      const statePath = path.join(home, 'integrations', 'dsh-weixin', 'accounts', account.botId, 'state.json');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      contextToken = state?.contextTokens?.users?.[account.ownerUserId]?.token || null;
    } catch { /* ignore */ }
    const targets = workspaces?.deliveryTargets?.[account.botId] || {};
    const firstTarget = Object.values(targets)[0];
    if (firstTarget?.name) deliveryName = firstTarget.name;
    return {
      botId: account.botId,
      accountId: account.accountId,
      ownerUserId: account.ownerUserId,
      baseUrl: account.baseUrl || ILINK_BASE,
      createdAt: account.createdAt || '',
      connectedAt: account.connectedAt || '',
      tokenFound: Boolean(token),
      token,
      contextToken,
      deliveryName,
      source: 'dsh-im',
    };
  });
  return { available: true, configPath, accounts, reason: '' };
}

export class WechatService {
  constructor({ sessionNotifier = showLocalNotification } = {}) {
    /** @type {Map<string, any>} */
    this.bindingAttempts = new Map();
    this.sessionNotifier = sessionNotifier;
  }

  listBots() {
    return db().all('SELECT * FROM wechat_bots ORDER BY updated_at DESC').map((row) => ({
      botId: row.bot_id,
      accountId: row.account_id,
      ownerUserId: row.owner_user_id,
      baseUrl: row.base_url,
      hasContextToken: Boolean(row.context_token),
      needsContextRefresh: Boolean(row.needs_context_refresh),
      lastContextError: row.last_context_error || '',
      lastNoticeAt: row.last_notice_at || '',
      noticeDelivery: row.notice_delivery || '',
      nickname: row.nickname || '',
      source: row.source,
      status: row.status,
      lastError: row.last_error || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getBot(botId) {
    return db().get('SELECT * FROM wechat_bots WHERE bot_id = ?', botId);
  }

  activeBot() {
    const settings = getSettings();
    if (settings.wechat?.botId) {
      const preferred = this.getBot(settings.wechat.botId);
      if (preferred) return preferred;
    }
    return db().get("SELECT * FROM wechat_bots WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1");
  }

  isConfigured() {
    const settings = getSettings();
    if (!settings.wechat?.enabled) return false;
    return Boolean(this.activeBot());
  }

  status() {
    const dsh = readDshImWeixinAccounts();
    const settings = getSettings();
    const bots = this.listBots();
    const needsContext = bots.find((bot) => bot.needsContextRefresh);
    return {
      enabled: Boolean(settings.wechat?.enabled),
      botId: settings.wechat?.botId || '',
      bots,
      sessionNotice: needsContext ? {
        needed: true,
        botId: needsContext.botId,
        message: '微信机器人会话需要续期：请先给机器人发送任意消息，再点击「刷新连接上下文」',
        lastNoticeAt: needsContext.lastNoticeAt || '',
        delivery: needsContext.noticeDelivery || '',
        error: needsContext.lastContextError || '',
      } : null,
      dshIm: {
        available: dsh.available,
        configPath: dsh.configPath,
        reason: dsh.reason,
        accounts: dsh.accounts.map((account) => ({
          botId: account.botId,
          accountId: account.accountId,
          ownerUserId: account.ownerUserId,
          tokenFound: account.tokenFound,
          hasContextToken: Boolean(account.contextToken),
          deliveryName: account.deliveryName,
          createdAt: account.createdAt,
        })),
      },
      bindings: [...this.bindingAttempts.values()].filter((attempt) => !TERMINAL.has(attempt.status)).map((attempt) => this.bindingSnapshot(attempt)),
    };
  }

  bindingSnapshot(attempt) {
    return {
      attemptId: attempt.id,
      status: attempt.status,
      message: attempt.message || '',
      qrUrl: attempt.qrProxyUrl || attempt.qrUrl || null,
      qrPageUrl: attempt.qrUrl || null,
      verifyRequired: Boolean(attempt.verifyRequired),
      expiresAt: attempt.expiresAt || null,
      botId: attempt.botId || null,
    };
  }

  /** 导入本机 dsh-im 已绑定的微信机器人（复用其 token 与 context_token） */
  importFromDshIm(botId = null) {
    const dsh = readDshImWeixinAccounts();
    if (!dsh.available) throw new Error(dsh.reason || '未检测到本机 dsh-im 配置');
    const candidates = botId ? dsh.accounts.filter((account) => account.botId === botId) : dsh.accounts;
    if (!candidates.length) throw new Error('没有可导入的微信机器人账号');
    let imported = 0;
    for (const account of candidates) {
      if (!account.token) continue;
      const now = nowIso();
      db().run(
        `INSERT INTO wechat_bots (bot_id, account_id, token, owner_user_id, base_url, context_token, nickname, source, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'dsh-im', 'active', ?, ?)
         ON CONFLICT(bot_id) DO UPDATE SET token = excluded.token, owner_user_id = excluded.owner_user_id,
           base_url = excluded.base_url, context_token = COALESCE(excluded.context_token, context_token),
           nickname = COALESCE(excluded.nickname, nickname), status = 'active',
           needs_context_refresh = 0, last_context_error = NULL, last_notice_at = NULL, notice_delivery = NULL,
           updated_at = excluded.updated_at`,
        account.botId, account.accountId, account.token, account.ownerUserId, account.baseUrl,
        account.contextToken || null, account.deliveryName || null, now, now,
      );
      imported += 1;
      updateSettings({ wechat: { enabled: true, botId: account.botId } });
    }
    if (!imported) throw new Error('本机 dsh-im 账号缺少可用 token，无法导入');
    return { imported, bots: this.listBots() };
  }

  setEnabled(enabled, botId) {
    updateSettings({ wechat: { enabled: Boolean(enabled), ...(botId !== undefined ? { botId } : {}) } });
    return this.status();
  }

  removeBot(botId) {
    db().run('DELETE FROM wechat_bots WHERE bot_id = ?', botId);
    const settings = getSettings();
    if (settings.wechat?.botId === botId) updateSettings({ wechat: { botId: '' } });
    return this.listBots();
  }

  async startBinding({ botType = '3' } = {}) {
    const existing = [...this.bindingAttempts.values()].find((attempt) => !TERMINAL.has(attempt.status));
    if (existing) return this.bindingSnapshot(existing);
    const attempt = {
      id: uid('wxbind_'),
      status: 'starting',
      message: '正在申请二维码…',
      qrcode: null,
      qrUrl: null,
      qrProxyUrl: null,
      verifyRequired: false,
      pendingVerifyCode: null,
      expiresAt: Date.now() + 5 * 60_000,
      startedAt: Date.now(),
      baseUrl: ILINK_BASE,
      botId: null,
      error: null,
    };
    this.bindingAttempts.set(attempt.id, attempt);
    try {
      const response = await requestJson({
        method: 'POST',
        endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
        body: { local_token_list: [] },
        timeoutMs: 15_000,
        authenticated: false,
      });
      if (!response?.qrcode) throw new Error('微信服务没有返回二维码令牌');
      attempt.qrcode = response.qrcode;
      attempt.qrUrl = trustedQrUrl(response.qrcode_img_content);
      if (!attempt.qrUrl) throw new Error('微信服务返回的二维码地址无效');
      attempt.qrProxyUrl = `/api/wechat/bind/${attempt.id}/qr`;
      attempt.status = 'pending';
      attempt.message = '请使用手机微信扫码绑定机器人';
    } catch (error) {
      attempt.status = 'failed';
      attempt.error = String(error?.message || error);
      attempt.message = attempt.error;
      this.bindingAttempts.delete(attempt.id);
      throw error;
    }
    attempt.loop = this.pollBinding(attempt);
    return this.bindingSnapshot(attempt);
  }

  async pollBinding(attempt) {
    while (!TERMINAL.has(attempt.status) && Date.now() < attempt.expiresAt) {
      if (attempt.pendingVerifyCode) {
        attempt.status = 'scaned';
        // 等待用户提交验证码
        await sleep(800);
        continue;
      }
      let response;
      try {
        let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(attempt.qrcode)}`;
        if (attempt.verifyCode) endpoint += `&verify_code=${encodeURIComponent(attempt.verifyCode)}`;
        response = await requestJson({
          method: 'GET',
          endpoint,
          baseUrl: attempt.baseUrl,
          timeoutMs: LONG_POLL_TIMEOUT_MS,
          authenticated: false,
        });
      } catch (error) {
        attempt.message = `等待扫码中（网络波动：${String(error?.message || error).slice(0, 60)}）`;
        await sleep(1500);
        continue;
      }
      const status = response?.status;
      if (status === 'wait') {
        attempt.status = 'pending';
        attempt.message = '请使用手机微信扫码绑定机器人';
      } else if (status === 'scaned') {
        attempt.status = 'scaned';
        attempt.message = '已扫码，请在手机上确认';
      } else if (status === 'need_verifycode') {
        attempt.status = 'need_verifycode';
        attempt.verifyRequired = true;
        attempt.message = '请输入手机微信上显示的配对数字';
        attempt.verifyCode = null;
        await new Promise((resolve) => { attempt.verifyResolve = resolve; });
        attempt.verifyResolve = null;
        attempt.verifyRequired = false;
      } else if (status === 'verify_code_blocked') {
        attempt.status = 'failed';
        attempt.error = '配对码多次错误，请重新生成二维码';
        attempt.message = attempt.error;
        break;
      } else if (status === 'expired') {
        attempt.status = 'expired';
        attempt.error = '二维码已过期，请重新生成';
        attempt.message = attempt.error;
        break;
      } else if (status === 'scaned_but_redirect') {
        attempt.baseUrl = normalizeBaseUrl(response.redirect_host || attempt.baseUrl);
        attempt.message = '已扫码，正在切换接入点…';
      } else if (status === 'binded_redirect') {
        attempt.status = 'failed';
        attempt.error = '该微信账号已绑定其他机器人';
        attempt.message = attempt.error;
        break;
      } else if (status === 'confirmed') {
        const token = String(response?.bot_token || '').trim();
        const accountId = String(response?.ilink_bot_id || '').trim();
        const ownerUserId = String(response?.ilink_user_id || '').trim();
        if (!token || !accountId || !ownerUserId) {
          attempt.status = 'failed';
          attempt.error = '微信授权成功但返回的账号凭据不完整';
          attempt.message = attempt.error;
          break;
        }
        const baseUrl = normalizeBaseUrl(response?.baseurl || attempt.baseUrl);
        const now = nowIso();
        db().run(
          `INSERT INTO wechat_bots (bot_id, account_id, token, owner_user_id, base_url, context_token, nickname, source, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, 'bind', 'active', ?, ?)
           ON CONFLICT(bot_id) DO UPDATE SET token = excluded.token, owner_user_id = excluded.owner_user_id,
             base_url = excluded.base_url, status = 'active',
             needs_context_refresh = 0, last_context_error = NULL, last_notice_at = NULL, notice_delivery = NULL,
             updated_at = excluded.updated_at`,
          accountId, accountId, token, ownerUserId, baseUrl, now, now,
        );
        updateSettings({ wechat: { enabled: true, botId: accountId } });
        attempt.status = 'success';
        attempt.botId = accountId;
        attempt.message = '微信机器人绑定成功';
        break;
      }
      await sleep(800);
    }
    if (!TERMINAL.has(attempt.status)) {
      attempt.status = 'expired';
      attempt.message = '绑定超时，请重新生成二维码';
    }
  }

  getBinding(attemptId) {
    const attempt = this.bindingAttempts.get(attemptId);
    return attempt ? this.bindingSnapshot(attempt) : null;
  }

  submitVerifyCode(attemptId, code) {
    const attempt = this.bindingAttempts.get(attemptId);
    if (!attempt) throw new Error('绑定会话不存在或已结束');
    if (!/^\d{4,8}$/.test(String(code || ''))) throw new Error('配对码应为 4-8 位数字');
    attempt.verifyCode = String(code);
    attempt.status = 'scaned';
    attempt.verifyResolve?.();
    return this.bindingSnapshot(attempt);
  }

  cancelBinding(attemptId) {
    const attempt = this.bindingAttempts.get(attemptId);
    if (!attempt) return null;
    if (!TERMINAL.has(attempt.status)) {
      attempt.status = 'cancelled';
      attempt.message = '已取消绑定';
      attempt.verifyResolve?.();
    }
    return this.bindingSnapshot(attempt);
  }

  async qrImage(attemptId) {
    const attempt = this.bindingAttempts.get(attemptId);
    if (!attempt) throw new Error('绑定会话不存在');
    const cached = this.qrCache?.get(attemptId);
    if (cached && Date.now() - cached.at < 120_000) return cached.value;
    // 微信返回的是 liteapp 页面（由 JS 渲染二维码），这里用无头浏览器截图得到可直接展示的二维码图片
    const value = await this.renderQrScreenshot(attempt.qrUrl);
    if (!this.qrCache) this.qrCache = new Map();
    this.qrCache.set(attemptId, { at: Date.now(), value });
    return value;
  }

  async renderQrScreenshot(url) {
    const run = async () => {
      const browser = await chromium.launch({ headless: true, channel: 'chromium' });
      try {
        const page = await browser.newPage({ viewport: { width: 480, height: 640 }, deviceScaleFactor: 2 });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForFunction(() => {
          const canvas = document.querySelector('canvas');
          const img = document.querySelector('img');
          return Boolean(canvas || img);
        }, { timeout: 15_000 }).catch(() => undefined);
        await sleep(2000);
        const target = page.locator('canvas, img').first();
        let buffer = null;
        if (await target.count().catch(() => 0) > 0) {
          buffer = await target.screenshot({ timeout: 8000 }).catch(() => null);
        }
        if (!buffer) buffer = await page.screenshot({ timeout: 8000 });
        return { buffer, contentType: 'image/png' };
      } finally {
        await browser.close().catch(() => undefined);
      }
    };
    // 串行化，避免并发启动多个浏览器
    this.qrRenderChain = (this.qrRenderChain || Promise.resolve()).then(run, run);
    return this.qrRenderChain;
  }

  /** 底层发送；includeContext=false 时用于会话续期提醒的兜底尝试 */
  async deliver(bot, text, { includeContext = true } = {}) {
    const content = String(text || '').trim();
    if (!content) throw new Error('消息内容不能为空');
    const response = await requestJson({
      method: 'POST',
      baseUrl: bot.base_url,
      endpoint: 'ilink/bot/sendmessage',
      token: bot.token,
      timeoutMs: 20_000,
      body: {
        msg: {
          from_user_id: '',
          to_user_id: bot.owner_user_id,
          client_id: `weixin-auto-${crypto.randomUUID()}`,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text: content.slice(0, 1800) } }],
          ...(includeContext && bot.context_token ? { context_token: bot.context_token } : {}),
        },
        base_info: baseInfo(),
      },
    });
    if (response?.ret !== undefined && response.ret !== 0) {
      const error = new Error(`微信服务拒绝了消息（ret=${response.ret}${response.errmsg ? `，${response.errmsg}` : ''}）`);
      error.ret = response.ret;
      error.errmsg = response.errmsg || '';
      throw error;
    }
    return response;
  }

  async sendText(text, { botId = null, allowSessionNotice = true } = {}) {
    const settings = getSettings();
    if (!settings.wechat?.enabled) throw new Error('未启用微信结果同步');
    const bot = botId ? this.getBot(botId) : this.activeBot();
    if (!bot) throw new Error('未绑定微信机器人，请先在设置中导入或扫码绑定');
    const content = String(text || '').trim();
    if (!content) throw new Error('消息内容不能为空');
    try {
      await this.deliver(bot, content, { includeContext: true });
      db().run(
        'UPDATE wechat_bots SET updated_at = ?, last_error = NULL, needs_context_refresh = 0, last_context_error = NULL WHERE bot_id = ?',
        nowIso(), bot.bot_id,
      );
      return { sent: true, botId: bot.bot_id };
    } catch (error) {
      const kind = classifyWechatFailure(error);
      db().run('UPDATE wechat_bots SET updated_at = ?, last_error = ? WHERE bot_id = ?', nowIso(), String(error?.message || error), bot.bot_id);
      if (allowSessionNotice && kind === 'session') await this.handleSessionFailure(bot, error);
      else if (kind === 'auth') await this.handleAuthFailure(bot, error);
      throw error;
    }
  }

  /** 会话续期：先尝试微信提醒，再退化为本地通知；10 分钟内不重复通知 */
  async handleSessionFailure(bot, error) {
    const message = String(error?.message || error);
    db().run(
      'UPDATE wechat_bots SET needs_context_refresh = 1, last_context_error = ?, updated_at = ? WHERE bot_id = ?',
      message.slice(0, 500), nowIso(), bot.bot_id,
    );
    const previous = db().get('SELECT last_notice_at FROM wechat_bots WHERE bot_id = ?', bot.bot_id)?.last_notice_at;
    const previousAt = previous ? Date.parse(previous) : 0;
    if (previousAt && Date.now() - previousAt < SESSION_NOTICE_COOLDOWN_MS) return;
    let delivery = 'none';
    // 1) 尝试通过机器人自身发微信提醒（不带旧 context_token，避免被旧会话卡住）
    try {
      const fresh = this.getBot(bot.bot_id) || bot;
      await this.deliver(fresh, SESSION_REMINDER_TEXT, { includeContext: false });
      delivery = 'wechat';
    } catch { /* 继续本地兜底 */ }
    // 2) 本地 Windows 通知
    if (delivery === 'none' && typeof this.sessionNotifier === 'function') {
      try {
        const result = await this.sessionNotifier({
          title: '视频号助手自动化工具',
          message: '微信机器人会话需要续期：请给机器人发送任意消息，然后点击「刷新连接上下文」。',
        });
        delivery = result?.shown ? 'local' : 'log';
      } catch { delivery = 'log'; }
    } else if (delivery === 'none') {
      delivery = 'log';
    }
    db().run(
      'UPDATE wechat_bots SET last_notice_at = ?, notice_delivery = ?, updated_at = ? WHERE bot_id = ?',
      nowIso(), delivery, nowIso(), bot.bot_id,
    );
    console.warn(`[wechat] 会话需要续期（${bot.bot_id}），通知方式：${delivery}；原因：${message.slice(0, 120)}`);
    return delivery;
  }

  /** 机器人授权/token 失效：本地通知用户重新绑定 */
  async handleAuthFailure(bot, error) {
    const message = String(error?.message || error);
    const previous = db().get('SELECT last_notice_at FROM wechat_bots WHERE bot_id = ?', bot.bot_id)?.last_notice_at;
    const previousAt = previous ? Date.parse(previous) : 0;
    if (previousAt && Date.now() - previousAt < SESSION_NOTICE_COOLDOWN_MS) return;
    let delivery = 'none';
    if (typeof this.sessionNotifier === 'function') {
      try {
        const result = await this.sessionNotifier({
          title: '视频号助手自动化工具',
          message: '微信机器人授权可能已失效，请到「执行记录 → 微信机器人」重新导入或扫码绑定。',
        });
        delivery = result?.shown ? 'local' : 'log';
      } catch { delivery = 'log'; }
    }
    db().run(
      'UPDATE wechat_bots SET last_notice_at = ?, notice_delivery = ?, updated_at = ? WHERE bot_id = ?',
      nowIso(), delivery, nowIso(), bot.bot_id,
    );
    console.warn(`[wechat] 机器人授权异常（${bot.bot_id}），通知方式：${delivery}；原因：${message.slice(0, 120)}`);
  }

  async testSend() {
    const result = await this.sendText(`【视频号助手自动化工具】执行结果同步通道测试成功。\n时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`);
    return result;
  }

  /** 主动拉取一次更新，用于获取/刷新 context_token（不常驻轮询，避免与 dsh-im 抢消息） */
  async refreshContextToken(botId = null) {
    const bot = botId ? this.getBot(botId) : this.activeBot();
    if (!bot) throw new Error('未绑定微信机器人');
    const buf = db().get('SELECT value FROM settings WHERE key = ?', 'wechat-updates-buf');
    let getUpdatesBuf = '';
    try { getUpdatesBuf = buf ? JSON.parse(buf.value) : ''; } catch { getUpdatesBuf = ''; }
    const response = await requestJson({
      method: 'POST',
      baseUrl: bot.base_url,
      endpoint: 'ilink/bot/getupdates',
      token: bot.token,
      timeoutMs: LONG_POLL_TIMEOUT_MS,
      body: { get_updates_buf: getUpdatesBuf, base_info: baseInfo() },
    }).catch((error) => {
      throw new Error(`拉取消息失败：${error?.message || error}`);
    });
    let captured = 0;
    for (const message of response?.msgs || []) {
      const from = message?.from_user_id || message?.fromUserId;
      const contextToken = message?.context_token || message?.contextToken;
      if (from && contextToken) {
        if (from === bot.owner_user_id) {
          db().run('UPDATE wechat_bots SET context_token = ?, updated_at = ? WHERE bot_id = ?', contextToken, nowIso(), bot.bot_id);
          captured += 1;
        }
      }
    }
    if (response?.get_updates_buf) {
      db().setSetting('wechat-updates-buf', response.get_updates_buf);
    }
    if (captured > 0) {
      db().run(
        'UPDATE wechat_bots SET needs_context_refresh = 0, last_context_error = NULL, last_error = NULL, updated_at = ? WHERE bot_id = ?',
        nowIso(), bot.bot_id,
      );
    }
    return { messages: (response?.msgs || []).length, captured };
  }
}
