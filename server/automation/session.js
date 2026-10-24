import { sleep } from '../util.js';
import { isLoginUrl, readPageIdentity } from './identity.js';

export function createSessionService({ browser, subjects, getSelectors }) {
  async function check(subjectId, { keepOpen = false } = {}) {
    const subject = subjects.get(subjectId);
    if (!subject) throw new Error('主体不存在');
    const sel = getSelectors();
    let outcome;
    try {
      outcome = await browser.run(subjectId, async ({ page }) => {
        await page.goto(sel.platform.postListUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
        await sleep(2800);
        const url = page.url();
        if (isLoginUrl(url, sel)) return { active: false, reason: '登录态已过期，需要重新扫码登录', url };
        const result = await readPageIdentity(page, sel);
        const identity = result.identity;
        const loggedIn = Boolean(identity?.identityKey || identity?.name);
        return {
          active: loggedIn || !isLoginUrl(url, sel),
          reason: loggedIn ? '' : '未读取到账号信息，请打开浏览器确认',
          identity,
          diagnostic: result.diagnostic,
          url,
        };
      });
    } catch (error) {
      outcome = { active: false, reason: String(error?.message || error) };
    } finally {
      if (!keepOpen) await browser.close(subjectId).catch(() => undefined);
    }
    const now = new Date().toISOString();
    if (outcome.active) {
      const patch = {
        status: 'active',
        statusDetail: '',
        lastCheckAt: now,
      };
      if (outcome.identity) {
        patch.avatarUrl = outcome.identity.avatarUrl || undefined;
        patch.wechatNickname = outcome.identity.wechatNickname || undefined;
        patch.finderNickname = outcome.identity.finderNickname || undefined;
        patch.finderUsername = outcome.identity.finderUsername || undefined;
        if (!subject.name || /^新主体/.test(subject.name)) {
          patch.name = outcome.identity.name || undefined;
        }
      }
      subjects.update(subjectId, patch);
    } else {
      subjects.update(subjectId, {
        status: 'expired',
        statusDetail: outcome.reason || '',
        lastCheckAt: now,
      });
    }
    return { ...outcome, subject: subjects.get(subjectId) };
  }

  async function checkAll({ tagIds = [], limit = 0 } = {}) {
    const list = subjects.list({ tagIds });
    const targets = limit > 0 ? list.slice(0, limit) : list;
    const results = [];
    for (const subject of targets) {
      const result = await check(subject.id);
      results.push({ subjectId: subject.id, name: subject.name, ...result });
    }
    return results;
  }

  return { check, checkAll };
}
