import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * 微信机器人封装稳定性自检。
 * 默认 mock 模式：不发送真实微信消息，只验证发送重试、错误分类、续期通知与冷却。
 * 真实发送：node scripts/wechat-stability.mjs --live --yes --base http://127.0.0.1:3210
 */
const args = process.argv.slice(2);
const isLive = args.includes('--live');
const baseArgIndex = args.indexOf('--base');
const baseUrl = baseArgIndex >= 0 ? args[baseArgIndex + 1] : 'http://127.0.0.1:3210';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function liveTest() {
  if (!args.includes('--yes')) throw new Error('真实发送需要显式传入 --yes（会向机器人 owner 发送测试消息）');
  const statusRes = await fetch(`${baseUrl}/api/wechat/status`);
  const status = (await statusRes.json()).data;
  if (!status?.enabled) throw new Error('微信结果同步未启用');
  if (!status.bots?.length) throw new Error('还没有绑定微信机器人');
  const rounds = Number(args.find((arg) => /^--rounds=/.test(arg))?.split('=')[1] || 3);
  const results = [];
  for (let index = 0; index < rounds; index += 1) {
    const startedAt = Date.now();
    try {
      const response = await fetch(`${baseUrl}/api/wechat/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const payload = await response.json();
      results.push({ index: index + 1, ok: payload.ok === true, ms: Date.now() - startedAt, error: payload.error || '' });
    } catch (error) {
      results.push({ index: index + 1, ok: false, ms: Date.now() - startedAt, error: String(error?.message || error) });
    }
    await sleep(800);
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`[live] 真实发送 ${results.length} 次，失败 ${failed.length} 次`);
  for (const item of results) console.log(`  #${item.index} ${item.ok ? 'OK' : 'FAIL'} ${item.ms}ms ${item.error}`);
  if (failed.length) throw new Error('真实发送稳定性测试失败');
}

async function mockTest() {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wxa-wechat-test-'));
  process.env.WXA_DATA_DIR = tempDir;
  const { getDb } = await import('../server/db.js');
  const { updateSettings } = await import('../server/settings.js');
  const { WechatService, classifyWechatFailure } = await import('../server/services/wechat.js');
  const db = getDb();
  const notes = [];
  const service = new WechatService({
    sessionNotifier: async (payload) => { notes.push(payload); return { shown: true }; },
  });
  const now = new Date().toISOString();
  const botId = 'bot_test_stability';
  const owner = 'owner@im.wechat';
  db.run(
    `INSERT INTO wechat_bots (bot_id, account_id, token, owner_user_id, base_url, context_token, nickname, source, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'https://ilinkai.weixin.qq.com/', ?, ?, 'bind', 'active', ?, ?)`,
    botId, 'acct_test', 'test-token', owner, 'old-context', '测试机器人', now, now,
  );
  updateSettings({ wechat: { enabled: true, botId } });

  const originalFetch = globalThis.fetch;
  const seen = [];
  let mode = 'ok';
  const sessionError = { ret: 9001, errmsg: 'context token expired' };
  globalThis.fetch = async (url, options = {}) => {
    const text = String(url);
    let body = null;
    try { body = options.body ? JSON.parse(options.body) : null; } catch { body = null; }
    seen.push({ url: text, body });
    if (mode === 'network') throw new TypeError('fetch failed');
    if (text.includes('/getupdates')) {
      return { ok: true, json: async () => ({ msgs: [{ from_user_id: owner, context_token: 'fresh-context' }], get_updates_buf: 'new-buf' }) };
    }
    const hasContext = Boolean(body?.msg?.context_token);
    if (mode === 'session') return { ok: true, json: async () => sessionError };
    if (mode === 'reminder-ok') return { ok: true, json: async () => (hasContext ? sessionError : { ret: 0 }) };
    if (mode === 'auth') return { ok: true, json: async () => ({ ret: 1001, errmsg: 'bot token invalid, please rebind' }) };
    return { ok: true, json: async () => ({ ret: 0 }) };
  };

  const results = [];
  const check = (name, condition, detail = '') => {
    results.push({ name, ok: Boolean(condition), detail });
    if (!condition) throw new Error(`${name}${detail ? `：${detail}` : ''}`);
  };

  try {
    check('错误分类-network', classifyWechatFailure(new Error('fetch failed')) === 'network');
    check('错误分类-session', classifyWechatFailure(new Error('微信服务拒绝了消息（ret=1，context token expired）')) === 'session');
    check('错误分类-auth', classifyWechatFailure(new Error('HTTP 401 unauthorized')) === 'auth');

    // 连续发送 5 次成功
    for (let index = 0; index < 5; index += 1) await service.sendText(`测试消息 ${index + 1}`);
    check('连续发送 5 次成功', true, `${seen.length} 次请求`);

    // context 过期 → 本地兜底通知
    mode = 'session';
    let sessionErrorThrown = false;
    try { await service.sendText('触发上下文过期'); } catch { sessionErrorThrown = true; }
    check('context 过期返回失败', sessionErrorThrown);
    let bot = db.get('SELECT * FROM wechat_bots WHERE bot_id = ?', botId);
    check('context 过期标记 needs_context_refresh', Number(bot.needs_context_refresh) === 1);
    check('本地兜底通知已触发', notes.length === 1 && /续期/.test(notes[0].message || ''));
    const firstNoticeAt = bot.last_notice_at;
    // 冷却期内不重复通知
    try { await service.sendText('再次失败'); } catch { /* expected */ }
    check('10 分钟冷却内不重复通知', notes.length === 1, `通知次数 ${notes.length}`);

    // 刷新上下文成功 → 清除续期状态
    const refreshed = await service.refreshContextToken(botId);
    bot = db.get('SELECT * FROM wechat_bots WHERE bot_id = ?', botId);
    check('刷新上下文成功', refreshed.captured === 1, JSON.stringify(refreshed));
    check('刷新后清除续期标记', Number(bot.needs_context_refresh) === 0);
    check('刷新后更新 context_token', bot.context_token === 'fresh-context');

    // 微信提醒成功路径：不带 context 的提醒可以发出
    db.run('UPDATE wechat_bots SET needs_context_refresh = 0, last_notice_at = NULL WHERE bot_id = ?', botId);
    mode = 'reminder-ok';
    const beforeNotes = notes.length;
    try { await service.sendText('触发微信提醒兜底'); } catch { /* expected */ }
    bot = db.get('SELECT * FROM wechat_bots WHERE bot_id = ?', botId);
    check('微信提醒成功时走微信通道', bot.notice_delivery === 'wechat', `delivery=${bot.notice_delivery}`);
    check('微信提醒成功时不再弹本地通知', notes.length === beforeNotes);
    check('通知时间已记录', Boolean(bot.last_notice_at));

    // auth 错误 → 本地通知
    db.run('UPDATE wechat_bots SET last_notice_at = NULL WHERE bot_id = ?', botId);
    mode = 'auth';
    const beforeAuthNotes = notes.length;
    try { await service.sendText('触发 auth 错误'); } catch { /* expected */ }
    check('auth 错误触发重新绑定通知', notes.length === beforeAuthNotes + 1);

    // 网络错误 → 只记录，不触发续期通知
    mode = 'network';
    const beforeNetworkNotes = notes.length;
    let networkThrown = false;
    try { await service.sendText('触发网络错误'); } catch { networkThrown = true; }
    check('网络错误返回失败', networkThrown);
    check('网络错误不触发续期通知', notes.length === beforeNetworkNotes);

    console.log('微信机器人稳定性自检（mock）通过：');
    for (const item of results) console.log(`  PASS  ${item.name}${item.detail ? `  (${item.detail})` : ''}`);
  } finally {
    globalThis.fetch = originalFetch;
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

(async () => {
  if (isLive) await liveTest();
  else await mockTest();
})().catch((error) => {
  console.error('FAIL', error?.message || error);
  process.exit(1);
});
