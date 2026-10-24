import { sleep, uid } from '../util.js';
import { isLoginUrl, isPlatformUrl, readPageIdentity } from './identity.js';

const TERMINAL = new Set(['success', 'failed', 'cancelled']);

function snapshot(attempt) {
  return {
    attemptId: attempt.id,
    subjectId: attempt.subjectId,
    status: attempt.status,
    message: attempt.message || '',
    qrExpired: Boolean(attempt.qrExpired),
    refreshing: Boolean(attempt.refreshing),
    headless: attempt.headless !== false,
    browserOpen: Boolean(attempt.browserOpen),
    qr: attempt.qr ? { dataUrl: attempt.qr.dataUrl, capturedAt: attempt.qr.capturedAt } : null,
    qrLatencyMs: attempt.qrLatencyMs || null,
    refreshLatencyMs: attempt.refreshLatencyMs || null,
    refreshCount: attempt.refreshCount || 0,
    identity: attempt.identity || null,
    logs: attempt.logs.slice(-80),
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt || null,
    mergedInto: attempt.mergedInto || null,
  };
}

export function createLoginManager({ browser, subjects, getSettings, getSelectors }) {
  /** @type {Map<string, any>} */
  const attempts = new Map();
  let lastPrune = 0;

  const selectors = () => getSelectors();

  function prune() {
    if (Date.now() - lastPrune < 60_000) return;
    lastPrune = Date.now();
    for (const [id, attempt] of attempts) {
      if (TERMINAL.has(attempt.status) && Date.now() - (attempt.finishedAt || attempt.startedAt) > 15 * 60_000) {
        attempts.delete(id);
      }
    }
  }

  function log(attempt, message) {
    attempt.logs.push(`${new Date().toISOString().slice(11, 19)} ${message}`);
  }

  function activeAttemptForSubject(subjectId) {
    for (const attempt of attempts.values()) {
      if (attempt.subjectId === subjectId && !TERMINAL.has(attempt.status)) return attempt;
    }
    return null;
  }

  async function start({ subjectId = null, name = null, newSubject = false, headless = true } = {}) {
    prune();
    let subject;
    let autoCreated = false;
    if (subjectId) {
      subject = subjects.get(subjectId);
      if (!subject) throw new Error('主体不存在');
    } else if (newSubject || !subjectId) {
      subject = subjects.create({ name: name || undefined });
      autoCreated = true;
    }
    const running = activeAttemptForSubject(subject.id);
    if (running) return snapshot(running);

    const attempt = {
      id: uid('login_'),
      subjectId: subject.id,
      autoCreated,
      createdName: subject.name,
      status: 'starting',
      message: '正在打开登录页面…',
      qr: null,
      qrExpired: false,
      identity: null,
      logs: [],
      startedAt: Date.now(),
      controller: new AbortController(),
      refreshRequested: false,
      refreshCount: 0,
      quickSwitched: false,
      page: null,
      // 扫码登录默认无头执行；用户点「浏览器扫码」兜底后才切换为有头
      headless: headless !== false,
      browserOpen: false,
      switching: false,
      refreshing: false,
      qrLatencyMs: null,
      refreshLatencyMs: null,
    };
    attempts.set(attempt.id, attempt);
    attempt.task = run(attempt, subject).catch(async (error) => {
      log(attempt, `登录流程异常：${error?.message || error}`);
      attempt.status = 'failed';
      attempt.message = String(error?.message || error);
      await cleanupOnFailure(attempt, subject).catch(() => undefined);
    });
    return snapshot(attempt);
  }

  async function get(attemptId) {
    const attempt = attempts.get(attemptId);
    if (!attempt) return null;
    return snapshot(attempt);
  }

  async function requestRefresh(attemptId) {
    const attempt = attempts.get(attemptId);
    if (!attempt) throw new Error('登录会话不存在或已结束');
    if (TERMINAL.has(attempt.status)) throw new Error('登录会话已结束');
    attempt.refreshRequested = true;
    attempt.message = '正在刷新二维码…';
    return snapshot(attempt);
  }

  async function cancel(attemptId) {
    const attempt = attempts.get(attemptId);
    if (!attempt) return null;
    if (!TERMINAL.has(attempt.status)) {
      attempt.controller.abort();
      attempt.status = 'cancelled';
      attempt.message = '已取消登录';
      attempt.finishedAt = Date.now();
      log(attempt, '用户取消登录');
      // 不阻塞接口返回：后台等待任务收尾并清理临时主体
      Promise.resolve(attempt.task).catch(() => undefined).finally(() => {
        cleanupPlaceholder(attempt).catch(() => undefined);
      });
    }
    return snapshot(attempt);
  }

  async function cleanupPlaceholder(attempt) {
    const current = subjects.get(attempt.subjectId);
    if (!attempt.autoCreated) {
      if (current && !current.identityKey) {
        subjects.update(current.id, { status: 'expired', statusDetail: attempt.message || '登录未完成' });
      }
      return;
    }
    attempt.autoCreated = false;
    await browser.close(attempt.subjectId).catch(() => undefined);
    await browser.removeProfile(attempt.subjectId).catch(() => undefined);
    subjects.remove(attempt.subjectId);
  }

  async function cleanupOnFailure(attempt, subject) {
    attempt.finishedAt = Date.now();
    if (attempt.autoCreated) {
      await cleanupPlaceholder(attempt).catch(() => undefined);
    } else if (!subject.identityKey) {
      subjects.update(subject.id, { status: 'failed', statusDetail: attempt.message || '' });
    }
    await browser.close(attempt.subjectId).catch(() => undefined);
  }

  async function waitForQrFrame(page, timeoutMs, pollMs = 150) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frame = page.frames().find((f) => String(f.url()).includes('open.weixin.qq.com/connect/qrconnect'));
      if (frame) return frame;
      await sleep(pollMs);
    }
    return null;
  }

  async function switchToQrLogin(attempt, frame) {
    const sel = selectors().login;
    for (const text of sel.quickLoginSwitchTexts) {
      try {
        const locator = frame.getByText(text, { exact: false }).first();
        if (await locator.count() > 0 && await locator.isVisible().catch(() => false)) {
          log(attempt, `检测到快捷登录入口，点击「${text}」`);
          await locator.click({ timeout: 5000 });
          attempt.quickSwitched = true;
          await sleep(250);
          return true;
        }
      } catch { /* 继续尝试 */ }
    }
    return false;
  }

  /**
   * 快速捕获二维码：先在 iframe 中轮询图片地址；刷新场景下等待 src 变化，避免返回旧码。
   */
  async function captureQr(attempt, { waitForNewSrc = false, timeoutMs = 6000 } = {}) {
    const startedAt = Date.now();
    const page = attempt.page;
    if (!page || page.isClosed()) throw new Error('登录页面已关闭');
    const sel = selectors().login;
    let frame = await waitForQrFrame(page, 15_000, 150);
    if (!frame) {
      // 页面可能停留在快捷登录界面，重新加载一次登录页再尝试
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined);
      frame = await waitForQrFrame(page, 10_000, 150);
    }
    if (!frame) throw new Error('页面中未找到微信登录二维码框架，可能是网络异常，请点击「刷新二维码」重试');
    if (!attempt.quickSwitched) {
      const switched = await switchToQrLogin(attempt, frame);
      if (switched) frame = await waitForQrFrame(page, 5000, 150) || frame;
    }

    const img = frame.locator(sel.qrImage).first();
    await img.waitFor({ state: 'visible', timeout: 3000 }).catch(() => undefined);
    const previousSrc = attempt.qr?.src || null;
    let src = null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      src = await img.getAttribute('src').catch(() => null);
      if (src && (!waitForNewSrc || src !== previousSrc)) break;
      await sleep(150);
    }
    if (!src) throw new Error('未能获取二维码图片');

    let dataUrl = null;
    const absolute = /^https?:/i.test(src) ? src : new URL(src, frame.url()).toString();
    try {
      const response = await page.context().request.get(absolute, { timeout: 8000 });
      if (response.ok()) {
        const buffer = await response.body();
        const type = response.headers()['content-type'] || 'image/png';
        dataUrl = `data:${type};base64,${buffer.toString('base64')}`;
      }
    } catch { /* 回退到元素截图 */ }
    if (!dataUrl) {
      try {
        const buffer = await img.screenshot({ timeout: 5000 });
        dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
      } catch { /* ignore */ }
    }
    if (!dataUrl) {
      const buffer = await page.screenshot({ timeout: 5000 }).catch(() => null);
      if (buffer) dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
    }
    if (!dataUrl) throw new Error('未能获取二维码图片');
    attempt.qr = { dataUrl, src, capturedAt: Date.now() };
    attempt.qrExpired = false;
    attempt.qrLatencyMs = Date.now() - startedAt;
    log(attempt, `已获取登录二维码（${attempt.qrLatencyMs}ms）`);
    return true;
  }

  async function doRefresh(attempt) {
    if (attempt.refreshing) return;
    if (TERMINAL.has(attempt.status)) return;
    if (attempt.status === 'scanned' || attempt.status === 'choose-finder') return;
    attempt.refreshing = true;
    attempt.refreshCount += 1;
    const startedAt = Date.now();
    attempt.status = 'refreshing';
    attempt.message = '正在刷新二维码…';
    log(attempt, '刷新二维码');
    try {
      const page = attempt.page;
      if (!page || page.isClosed()) throw new Error('登录页面已关闭');
      // 先尝试点击登录页上的刷新按钮（旧逻辑错误地在 iframe 内找选择器，这里改为主页）
      let clicked = false;
      for (const choice of selectors().login.refreshPageSelectors || []) {
        try {
          const locator = page.locator(choice).first();
          if (await locator.count() > 0 && await locator.isVisible().catch(() => false)) {
            await locator.click({ timeout: 3000 });
            clicked = true;
            break;
          }
        } catch { /* 继续尝试 */ }
      }
      if (clicked) {
        const ok = await captureQr(attempt, { waitForNewSrc: true, timeoutMs: 8000 }).then(() => true).catch(() => false);
        if (ok) {
          attempt.status = 'qr';
          attempt.message = '请使用手机微信扫码登录';
          return;
        }
      }
      // 刷新按钮无效/不存在：直接重新加载登录页，最快获得新二维码
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(async () => {
        await page.goto(selectors().login.url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      });
      attempt.quickSwitched = false;
      await captureQr(attempt, { waitForNewSrc: true, timeoutMs: 12_000 });
      attempt.status = 'qr';
      attempt.message = '请使用手机微信扫码登录';
    } catch (error) {
      log(attempt, `刷新二维码失败：${error?.message || error}`);
      attempt.message = `二维码刷新失败：${error?.message || error}，请点击「刷新二维码」重试`;
    } finally {
      attempt.refreshLatencyMs = Date.now() - startedAt;
      attempt.refreshing = false;
      if (attempt.status === 'refreshing') {
        attempt.status = attempt.qr ? 'qr' : 'starting';
      }
      log(attempt, `二维码刷新完成（${attempt.refreshLatencyMs}ms）`);
    }
  }

  /** 绑定当前尝试使用的页面（登录弹窗默认无头；兜底打开浏览器后会换页） */
  function attachPage(attempt, page) {
    attempt.page = page;
    page.on('close', () => {
      if (attempt.switching) return;
      if (attempt.page !== page) return;
      if (!TERMINAL.has(attempt.status)) {
        attempt.status = 'cancelled';
        attempt.message = '登录窗口已关闭';
        attempt.finishedAt = Date.now();
        log(attempt, '登录窗口已关闭');
      }
    });
  }

  async function probeLoggedIn(page) {
    const sel = selectors().platform;
    const apiBase = sel.apiBase;
    const result = await page.evaluate(async ({ base, authPath }) => {
      try {
        const res = await fetch(base + authPath, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: '{}',
        });
        const json = await res.json().catch(() => null);
        return { errCode: json?.errCode ?? null, data: json?.data ?? null };
      } catch (error) {
        return { errCode: null, error: String(error?.message || error) };
      }
    }, { base: apiBase, authPath: sel.authDataPath }).catch(() => ({ errCode: null }));
    return result;
  }

  async function selectFinder(attempt, page) {
    const sel = selectors().platform;
    const apiBase = sel.apiBase;
    log(attempt, '检测到视频号选择页面，正在自动选择视频号');
    const listResult = await page.evaluate(async ({ base }) => {
      const post = async (pathname, body) => {
        try {
          const res = await fetch(base + pathname, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(body || {}),
          });
          return await res.json().catch(() => null);
        } catch (error) {
          return { error: String(error?.message || error) };
        }
      };
      return post('/auth/auth_finder_list', {});
    }, { base: apiBase }).catch((error) => ({ error: String(error?.message || error) }));

    const list = listResult?.data?.finderList || listResult?.finderList || [];
    if (!list.length) {
      log(attempt, '未获取到可登录的视频号列表，尝试点击页面上的第一个视频号');
      const item = page.locator(selectors().login.finderItem).first();
      if (await item.count() > 0) {
        await item.click({ timeout: 8000 }).catch(() => undefined);
        await sleep(2500);
        return true;
      }
      return false;
    }
    const subject = subjects.get(attempt.subjectId);
    const usable = list.filter((item) => item.spamFlag !== 1 && !item.blocked);
    const chosen = usable.find((item) => subject?.finderUsername && item.finderUsername === subject.finderUsername)
      || usable.find((item) => subject?.finderNickname && item.nickname === subject.finderNickname)
      || usable[0];
    if (!chosen) {
      log(attempt, '该微信下没有可用视频号');
      return false;
    }
    attempt.finderList = list;
    log(attempt, `选择视频号：${chosen.nickname || chosen.finderUsername}`);
    const loginResult = await page.evaluate(async ({ base, finderUsername }) => {
      try {
        const res = await fetch(base + '/auth/login_finder', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ finderUsername }),
        });
        return await res.json().catch(() => null);
      } catch (error) {
        return { error: String(error?.message || error) };
      }
    }, { base: apiBase, finderUsername: chosen.finderUsername }).catch((error) => ({ error: String(error?.message || error) }));
    if (loginResult?.errCode !== undefined && loginResult.errCode !== 0) {
      log(attempt, `选择视频号失败：errCode=${loginResult.errCode}`);
      return false;
    }
    await sleep(1500);
    return true;
  }

  async function run(attempt, subject) {
    const page = await browser.getPage(attempt.subjectId, { headless: attempt.headless });
    attachPage(attempt, page);
    const loginUrl = selectors().login.url;
    log(attempt, `打开登录页：${loginUrl}（${attempt.headless ? '无头模式' : '有头模式'}）`);
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // 页面本身也可能已经有登录态，直接进入平台
    if (isPlatformUrl(page.url())) {
      await finishSuccess(attempt, subject, page);
      return;
    }
    await captureQr(attempt);
    attempt.status = 'qr';
    attempt.message = '请使用手机微信扫码登录';

    const deadline = Date.now() + 6 * 60_000;
    let scannedNotified = false;
    while (Date.now() < deadline) {
      if (attempt.controller.signal.aborted) break;
      await sleep(500);
      if (attempt.switching) continue; // 正在切换无头/有头，暂停检查
      if (attempt.refreshRequested) {
        attempt.refreshRequested = false;
        await doRefresh(attempt);
        continue;
      }
      const page = attempt.page;
      if (!page || page.isClosed()) {
        // 兜底：页面被关闭时结束尝试（attachPage 已处理状态）
        if (!TERMINAL.has(attempt.status)) {
          attempt.status = 'cancelled';
          attempt.message = '登录页面已关闭';
          attempt.finishedAt = Date.now();
        }
        break;
      }

      let frameText = '';
      try {
        const frame = page.frames().find((f) => String(f.url()).includes('open.weixin.qq.com/connect/qrconnect'));
        if (frame) frameText = await frame.evaluate(() => document.body.innerText).catch(() => '');
      } catch { /* ignore */ }

      const loginSel = selectors().login;
      if (frameText && loginSel.expiredTexts.some((text) => frameText.includes(text))) {
        if (!attempt.qrExpired) {
          attempt.qrExpired = true;
          attempt.message = '二维码已过期，正在自动刷新…';
          log(attempt, '二维码已过期');
        }
        if (!attempt.refreshing) await doRefresh(attempt);
        continue;
      }
      if (frameText && loginSel.scannedTexts.some((text) => frameText.includes(text))) {
        if (!scannedNotified) {
          scannedNotified = true;
          attempt.status = 'scanned';
          attempt.message = '已扫码，请在手机上确认登录';
          log(attempt, '已扫码，等待手机确认');
        }
      }

      // 需要选择视频号
      try {
        if (await page.locator(loginSel.finderArea).first().isVisible().catch(() => false)) {
          attempt.status = 'choose-finder';
          attempt.message = '正在选择要登录的视频号…';
          const ok = await selectFinder(attempt, page);
          if (ok) {
            await page.goto(selectors().platform.homeUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
            await sleep(2500);
          }
        }
      } catch { /* ignore */ }

      const url = page.url();
      if (!isLoginUrl(url, selectors()) && isPlatformUrl(url)) {
        const probe = await probeLoggedIn(page);
        if (probe?.errCode === 0 || probe?.errCode === undefined) {
          await finishSuccess(attempt, subject, page);
          return;
        }
      }
      // 即使 URL 还在登录页，只要 Cookie 已建立也可继续
      if (attempt.status === 'scanned' || attempt.status === 'choose-finder') {
        const probe = await probeLoggedIn(page);
        if (probe?.errCode === 0) {
          await finishSuccess(attempt, subject, page);
          return;
        }
      }
    }
    if (attempt.controller.signal.aborted) {
      await cleanupPlaceholder(attempt).catch(() => undefined);
      return;
    }
    attempt.status = 'failed';
    attempt.message = '登录超时：未检测到扫码确认，请重新登录';
    attempt.finishedAt = Date.now();
    log(attempt, '登录超时');
    await cleanupOnFailure(attempt, subject).catch(() => undefined);
  }

  /** 兜底：把当前无头登录会话切换为有头浏览器并打开原登录页（同一 profile 目录） */
  async function openBrowser(attemptId) {
    const attempt = attempts.get(attemptId);
    if (!attempt) throw new Error('登录会话不存在或已结束');
    if (TERMINAL.has(attempt.status)) throw new Error('登录会话已结束，请重新发起扫码登录');
    if (attempt.status === 'scanned' || attempt.status === 'choose-finder') {
      throw new Error('已扫码确认，无法切换浏览器模式；请继续在手机上完成确认');
    }
    if (!attempt.headless) {
      try { await attempt.page?.bringToFront?.(); } catch { /* ignore */ }
      attempt.browserOpen = true;
      attempt.message = '已打开浏览器，请使用手机微信扫码或在浏览器中操作';
      return snapshot(attempt);
    }
    attempt.switching = true;
    attempt.status = 'opening-browser';
    attempt.message = '正在打开浏览器…';
    try {
      await browser.close(attempt.subjectId).catch(() => undefined);
      const page = await browser.getPage(attempt.subjectId, { headless: false });
      attempt.headless = false;
      attempt.browserOpen = true;
      attempt.quickSwitched = false;
      attempt.qr = null;
      attachPage(attempt, page);
      log(attempt, '已切换到有头浏览器，打开原登录页面');
      await page.goto(selectors().login.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await sleep(300);
      await captureQr(attempt).catch((error) => log(attempt, `有头模式二维码捕获失败：${error?.message || error}`));
      attempt.status = attempt.qr ? 'qr' : 'starting';
      attempt.message = '已打开浏览器，请使用手机微信扫码（也可使用面板二维码）';
    } catch (error) {
      // 兜底失败：回滚为无头模式继续面板二维码
      attempt.headless = true;
      attempt.browserOpen = false;
      try {
        const page = await browser.getPage(attempt.subjectId, { headless: true });
        attachPage(attempt, page);
        await page.goto(selectors().login.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await captureQr(attempt).catch(() => undefined);
        attempt.status = attempt.qr ? 'qr' : 'starting';
        attempt.message = '无法打开浏览器窗口，已回退为面板二维码';
      } catch { /* ignore */ }
      throw new Error(`无法打开浏览器窗口：${String(error?.message || error)}。可继续使用面板二维码`);
    } finally {
      attempt.switching = false;
    }
    return snapshot(attempt);
  }

  /** 主体被删除时取消其进行中的登录尝试 */
  function cancelForSubject(subjectId) {
    let cancelled = 0;
    for (const attempt of attempts.values()) {
      if (attempt.subjectId !== subjectId || TERMINAL.has(attempt.status)) continue;
      attempt.controller.abort();
      attempt.status = 'cancelled';
      attempt.message = '主体已删除，登录已取消';
      attempt.finishedAt = Date.now();
      cancelled += 1;
      Promise.resolve(attempt.task).catch(() => undefined).finally(() => {
        cleanupPlaceholder(attempt).catch(() => undefined);
      });
    }
    return cancelled;
  }

  async function finishSuccess(attempt, subject, page) {
    attempt.message = '登录成功，正在读取账号信息…';
    log(attempt, '登录成功，读取视频号/微信账号信息');
    let identity = null;
    let diagnostic = null;
    try {
      if (!isPlatformUrl(page.url())) {
        await page.goto(selectors().platform.homeUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
      }
      await sleep(2500);
      const result = await readPageIdentity(page, selectors());
      identity = result.identity;
      diagnostic = result.diagnostic;
      if (attempt.finderList) identity.finderList = attempt.finderList;
    } catch (error) {
      log(attempt, `读取账号信息失败：${error?.message || error}`);
    }
    const current = subjects.get(subject.id);
    const identityPayload = identity || {
      name: current?.name,
      identityKey: null,
      identityType: '未识别',
      displayName: current?.name,
      avatarUrl: null,
      wechatId: null,
      wechatNickname: null,
      finderUsername: null,
      finderNickname: null,
      raw: null,
    };
    identityPayload.diagnostic = diagnostic;

    let finalSubjectId = subject.id;
    try {
      // 按「视频号ID → 微信身份 → 视频号名称 → 微信ID」查重，命中则合并到已有主体，保证卡片唯一
      const existing = subjects.findDuplicate(identityPayload, subject.id);
      if (existing && existing.id !== subject.id) {
        log(attempt, `识别到已存在主体「${existing.name}」，合并登录状态`);
        await browser.close(subject.id).catch(() => undefined);
        await sleep(300);
        await browser.adoptProfile(browser.profileDir(subject.id), existing.id);
        const mergedTags = [...new Set([...(existing.tags || []).map((t) => t.id), ...(current?.tags || []).map((t) => t.id)])];
        subjects.applyIdentity(existing.id, identityPayload);
        subjects.update(existing.id, { tagIds: mergedTags });
        subjects.remove(subject.id);
        finalSubjectId = existing.id;
        attempt.mergedInto = existing.id;
      } else {
        subjects.applyIdentity(subject.id, identityPayload);
      }
    } catch (error) {
      log(attempt, `保存登录信息失败：${error?.message || error}`);
      subjects.update(subject.id, { status: 'active', statusDetail: '登录成功（账号信息读取不完整）' });
    }

    attempt.subjectId = finalSubjectId;
    attempt.identity = identityPayload;
    attempt.status = 'success';
    attempt.message = identityPayload.name ? `登录成功：${identityPayload.name}` : '登录成功';
    attempt.finishedAt = Date.now();
    log(attempt, `登录信息已保存（识别方式：${identityPayload.identityType || '未知'}）`);
    await sleep(300);
    await browser.close(finalSubjectId).catch(() => undefined);
  }

  function activeCount() {
    return [...attempts.values()].filter((a) => !TERMINAL.has(a.status)).length;
  }

  async function closeAll() {
    for (const attempt of attempts.values()) {
      if (!TERMINAL.has(attempt.status)) {
        attempt.controller.abort();
        attempt.status = 'cancelled';
      }
    }
  }

  return { start, get, requestRefresh, cancel, openBrowser, cancelForSubject, activeCount, closeAll, _attempts: attempts };
}
