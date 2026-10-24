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
    qr: attempt.qr ? { dataUrl: attempt.qr.dataUrl, capturedAt: attempt.qr.capturedAt } : null,
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

  const timing = () => getSettings()?.timing || {};
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

  async function start({ subjectId = null, name = null, newSubject = false } = {}) {
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

  async function waitForQrFrame(page, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frame = page.frames().find((f) => String(f.url()).includes('open.weixin.qq.com/connect/qrconnect'));
      if (frame) return frame;
      await sleep(250);
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
          await sleep(800);
          return true;
        }
      } catch { /* 继续尝试 */ }
    }
    return false;
  }

  async function captureQr(attempt) {
    const page = attempt.page;
    const sel = selectors().login;
    const frame = await waitForQrFrame(page, 25_000);
    if (!frame) throw new Error('页面中未找到微信登录二维码框架，可能是网络异常，请点击「刷新二维码」重试');
    if (!attempt.quickSwitched) await switchToQrLogin(attempt, frame);

    const img = frame.locator(sel.qrImage).first();
    await img.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined);
    const src = await img.getAttribute('src').catch(() => null);
    let dataUrl = null;
    if (src) {
      const absolute = /^https?:/i.test(src) ? src : new URL(src, frame.url()).toString();
      try {
        const response = await page.context().request.get(absolute, { timeout: 15_000 });
        if (response.ok()) {
          const buffer = await response.body();
          const type = response.headers()['content-type'] || 'image/png';
          dataUrl = `data:${type};base64,${buffer.toString('base64')}`;
        }
      } catch { /* 回退到元素截图 */ }
      if (!dataUrl) {
        try {
          const buffer = await img.screenshot({ timeout: 8000 });
          dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
        } catch { /* ignore */ }
      }
    }
    if (!dataUrl) {
      // 整体截图作为兜底
      const buffer = await page.screenshot({ timeout: 8000 }).catch(() => null);
      if (buffer) dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
    }
    if (!dataUrl) throw new Error('未能获取二维码图片');
    attempt.qr = { dataUrl, src: src || null, capturedAt: Date.now() };
    attempt.qrExpired = false;
    log(attempt, '已获取登录二维码');
    return true;
  }

  async function doRefresh(attempt) {
    const page = attempt.page;
    if (!page) return;
    attempt.refreshCount += 1;
    log(attempt, '刷新二维码');
    try {
      const frame = await waitForQrFrame(page, 5000);
      const sel = selectors().login;
      if (frame) {
        for (const choice of sel.refresh.split(',').map((s) => s.trim())) {
          const locator = frame.locator(choice).first();
          if (await locator.count() > 0 && await locator.isVisible().catch(() => false)) {
            await locator.click({ timeout: 4000 }).catch(() => undefined);
            break;
          }
        }
      } else {
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
      }
      await sleep(1200);
      attempt.quickSwitched = false;
      await captureQr(attempt);
      attempt.status = 'qr';
      attempt.message = '请使用手机微信扫码登录';
    } catch (error) {
      log(attempt, `刷新二维码失败：${error?.message || error}`);
    }
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
    const page = await browser.getPage(attempt.subjectId);
    attempt.page = page;
    page.on('close', () => {
      if (!TERMINAL.has(attempt.status)) {
        attempt.status = 'cancelled';
        attempt.message = '登录窗口已关闭';
      }
    });
    const loginUrl = selectors().login.url;
    log(attempt, `打开登录页：${loginUrl}`);
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await sleep(1000 + Number(timing().stepDelayMs || 0));
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
      await sleep(1200);
      if (attempt.refreshRequested) {
        attempt.refreshRequested = false;
        await doRefresh(attempt);
        continue;
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
        if (attempt.refreshCount < 6) await doRefresh(attempt);
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
      const existing = identityPayload.identityKey ? subjects.findByIdentity(identityPayload.identityKey) : null;
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

  return { start, get, requestRefresh, cancel, activeCount, closeAll, _attempts: attempts };
}
