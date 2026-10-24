import fsp from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from '../config.js';
import { ensureDir, sleep, truncate } from '../util.js';
import { firstVisible } from '../selectors.js';
import { isLoginUrl } from './identity.js';

export class SessionExpiredError extends Error {
  constructor(message = '视频号登录态已过期，请到「主体」页重新扫码登录') {
    super(message);
    this.name = 'SessionExpiredError';
    this.code = 'SESSION_EXPIRED';
  }
}

export class PublishError extends Error {
  constructor(message, { screenshot = null } = {}) {
    super(message);
    this.name = 'PublishError';
    this.code = 'PUBLISH_ERROR';
    this.screenshot = screenshot;
  }
}

const EXACT_CONTAINERS = 'button, a, [role="button"], .ant-btn, .weui-btn, .mp-button, span';

export function createPublisher({ browser, getSettings, getSelectors, subjects }) {
  const baseTiming = () => getSettings()?.timing || {};
  let timingOverride = null;
  const timing = () => (timingOverride ? { ...baseTiming(), ...timingOverride } : baseTiming());

  async function delay(page, ms) {
    if (!ms || ms <= 0) return;
    await page.waitForTimeout(ms).catch(() => sleep(ms));
  }

  async function stepDelay(page) {
    await delay(page, Number(timing().stepDelayMs || 0));
  }

  /**
   * 读取页面可读文本：视频号助手使用 wujie 微前端，页面内容在 Shadow DOM 内，
   * document.body.innerText 取不到内容，必须递归遍历 shadowRoot。
   */
  async function readPageText(page) {
    return page.evaluate(() => {
      const parts = [];
      const walk = (node, depth) => {
        if (!node || depth > 40) return;
        if (node.nodeType === 3) { parts.push(node.textContent); return; }
        if (node.nodeType !== 1) return;
        const style = node.tagName === 'STYLE' || node.tagName === 'SCRIPT';
        if (!style && node.shadowRoot) walk(node.shadowRoot, depth + 1);
        for (const child of node.childNodes || []) walk(child, depth + 1);
      };
      walk(document.body, 0);
      return parts.join(' ').replace(/\s+/g, ' ').trim();
    }).catch(() => '');
  }

  function findTextLocator(page, text, { exact = true, root = null } = {}) {
    const scope = root || page;
    return scope.getByText(text, { exact });
  }

  /** 在页面里找可点击的按钮（按文案），支持多候选 */
  async function findButton(page, texts, { timeout = 10_000, root = null } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const text of texts) {
        for (const selector of EXACT_CONTAINERS.split(',').map((s) => s.trim())) {
          const locator = (root || page).locator(`${selector}:has-text(${JSON.stringify(text)})`);
          const count = await locator.count().catch(() => 0);
          for (let index = 0; index < Math.min(count, 8); index += 1) {
            const item = locator.nth(index);
            try {
              if (!(await item.isVisible())) continue;
              const own = (await item.innerText({ timeout: 800 })).trim();
              if (own === text || (text.length > 2 && own.startsWith(text) && own.length <= text.length + 4)) {
                return item;
              }
            } catch { /* continue */ }
          }
        }
        // 兜底：getByRole
        try {
          const byRole = page.getByRole('button', { name: text, exact: true }).first();
          if (await byRole.count() > 0 && await byRole.isVisible()) return byRole;
        } catch { /* continue */ }
      }
      await sleep(400);
    }
    return null;
  }

  async function clickText(page, text, options = {}) {
    const locator = await findButton(page, [text], options);
    if (!locator) {
      if (options.optional) return false;
      throw new PublishError(`页面上未找到「${text}」按钮`);
    }
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    await locator.click({ timeout: options.timeout || 8000 });
    await delay(page, Number(timing().clickDelayMs || 0));
    return true;
  }

  async function waitForPublishPageReady(page, timeout = 120_000) {
    const sel = getSelectors();
    const deadline = Date.now() + timeout;
    let readyStreak = 0;
    let diagnostic = {};
    while (Date.now() < deadline) {
      if (isLoginUrl(page.url(), sel)) throw new SessionExpiredError();
      const labels = (await page.locator('.form-item .label').allInnerTexts().catch(() => []))
        .map((text) => String(text).trim());
      const hasDescField = labels.some((text) => text.includes(sel.publish.descFormItemLabel));
      const hasUploadInput = (await page.locator('input[type="file"]').count().catch(() => 0)) > 0;
      const text = await readPageText(page);
      const initializing = sel.publish.pageInitializingTexts.some((hint) => text.includes(hint));
      diagnostic = { hasDescField, hasUploadInput, initializing, labels, url: page.url(), textLength: text.length };
      if (!initializing && hasUploadInput && hasDescField) {
        readyStreak += 1;
        if (readyStreak >= 2) return true;
      } else {
        readyStreak = 0;
      }
      await sleep(700);
    }
    throw new PublishError(`发表动态页面加载超时（诊断：${JSON.stringify(diagnostic)}）`);
  }

  async function gotoCreate(page) {
    const sel = getSelectors();
    // 优先通过与站点一致的操作入口进入（直接访问 /post/create 有时会被重定向回首页）
    await page.goto(sel.platform.postListUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
    await stepDelay(page);
    if (isLoginUrl(page.url(), sel)) throw new SessionExpiredError();
    const createButton = await findButton(page, sel.platform.createButtonTexts, { timeout: 30_000 });
    if (createButton) {
      await createButton.scrollIntoViewIfNeeded().catch(() => undefined);
      await createButton.click({ timeout: 10_000 }).catch(() => undefined);
      await delay(page, 1200);
    } else {
      // 兜底：直接打开发表动态地址
      await page.goto(sel.platform.postCreateUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await stepDelay(page);
      if (isLoginUrl(page.url(), sel)) throw new SessionExpiredError();
    }
    await waitForPublishPageReady(page, Number(timing().pageReadyTimeoutMs || 120_000));
    await delay(page, Number(timing().afterPageReadySettleMs || 800));
    return page;
  }

  async function findFileInput(page) {
    // file input 通常是隐藏的，不能用 isVisible 判断
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      for (const selector of getSelectors().publish.fileInputs) {
        const locator = page.locator(selector).first();
        if (await locator.count().catch(() => 0)) return locator;
      }
      await sleep(500);
    }
    return null;
  }

  /** 读取上传状态：百分比 + 是否仍在处理（兼容 Shadow DOM） */
  async function readUploadState(page) {
    const sel = getSelectors().publish;
    const body = await readPageText(page);
    const percentMatch = body.match(/(\d{1,3})\s*%/);
    const percent = percentMatch ? Number(percentMatch[1]) : null;
    const uploadingText = sel.uploadingTexts.find((text) => body.includes(text)) || null;
    let doneElementVisible = false;
    try {
      doneElementVisible = (await firstVisible(page, sel.uploadDoneSelectors, { timeout: 0 })) !== null;
    } catch { /* ignore */ }
    const doneText = sel.uploadDoneTexts.find((text) => body.includes(text)) || null;
    return {
      body,
      percent,
      uploadingText,
      uploading: Boolean(uploadingText) || (percent !== null && percent < 100),
      done: doneElementVisible || Boolean(doneText),
      errorText: sel.uploadErrorTexts.find((text) => body.includes(text)) || null,
    };
  }

  async function uploadVideo(page, filePath, onProgress, onSample = null) {
    const input = await findFileInput(page);
    if (!input) throw new PublishError('未找到视频上传控件');
    onProgress?.({ step: 'upload', message: `上传视频：${path.basename(filePath)}` });
    await input.setInputFiles(filePath);
    await delay(page, 600);
    const startedAt = Date.now();
    const timeout = Number(timing().uploadTimeoutMs || 600_000);
    let sawUploading = false;
    let lastPercent = null;
    let stableDoneSince = null;
    let lastLogged = 0;
    while (Date.now() - startedAt < timeout) {
      const state = await readUploadState(page);
      try {
        onSample?.({
          t: Math.round((Date.now() - startedAt) / 100) / 10,
          percent: state.percent,
          uploading: state.uploading,
          uploadText: state.uploadingText,
          done: state.done,
          error: state.errorText,
        });
      } catch { /* ignore */ }
      if (state.errorText) throw new PublishError(`视频上传失败：页面提示「${state.errorText}」`);
      if (state.percent !== null && state.percent !== lastPercent) {
        lastPercent = state.percent;
        onProgress?.({ step: 'upload', message: `上传中 ${state.percent}%` });
        lastLogged = Date.now();
      } else if (state.uploadingText && Date.now() - lastLogged > 12_000) {
        onProgress?.({ step: 'upload', message: `上传中：${state.uploadingText}` });
        lastLogged = Date.now();
      }
      if (state.uploading) {
        sawUploading = true;
        stableDoneSince = null;
        await sleep(1200);
        continue;
      }
      // 没有任何「上传中」迹象时，必须满足：曾经出现过上传中 / 或已完成标记，且稳定一段时间，
      // 避免 setInputFiles 之后立刻误判为上传完成
      const hasDoneMark = state.done;
      if (!sawUploading && !hasDoneMark) {
        await sleep(1000);
        continue;
      }
      if (!stableDoneSince) stableDoneSince = Date.now();
      if (Date.now() - stableDoneSince >= 2000 && (hasDoneMark || Date.now() - startedAt > 4000)) {
        await delay(page, Number(timing().afterUploadSettleMs || 0));
        onProgress?.({ step: 'upload', message: '视频上传完成' });
        return true;
      }
      await sleep(1000);
    }
    throw new PublishError('视频上传超时（可在设置中调大上传超时时间）');
  }

  async function findEditor(page, timeout = 0) {
    const sel = getSelectors().publish;
    const deadline = Date.now() + timeout;
    do {
      for (const selector of sel.descEditorSelectors) {
        const locator = page.locator(selector);
        const count = await locator.count().catch(() => 0);
        for (let index = 0; index < Math.min(count, 12); index += 1) {
          const candidate = locator.nth(index);
          if (await candidate.isVisible().catch(() => false)) return candidate;
        }
      }
      // 兜底：在「视频描述」表单项内部找可编辑元素
      try {
        const formItem = page.locator('.form-item').filter({ hasText: sel.descFormItemLabel }).first();
        if (await formItem.count().catch(() => 0)) {
          const inner = formItem.locator('[contenteditable="true"], textarea, .ql-editor, [data-placeholder]');
          const count = await inner.count().catch(() => 0);
          for (let index = 0; index < Math.min(count, 8); index += 1) {
            const candidate = inner.nth(index);
            if (await candidate.isVisible().catch(() => false)) return candidate;
          }
        }
      } catch { /* ignore */ }
      if (Date.now() >= deadline) break;
      await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
    } while (Date.now() < deadline);
    return null;
  }

  async function fillDescription(page, text, onProgress) {
    if (!text) return;
    const editor = await findEditor(page);
    if (!editor) throw new PublishError('未找到视频描述输入框');
    onProgress?.({ step: 'description', message: `填写视频描述（${text.length} 字）` });
    await editor.scrollIntoViewIfNeeded().catch(() => undefined);
    await editor.click();
    await page.keyboard.press('Control+A').catch(() => undefined);
    await page.keyboard.press('Delete').catch(() => undefined);
    const typeDelay = Number(timing().typeDelayMs || 0);
    const isContentEditable = await editor.evaluate((el) => el.getAttribute('contenteditable') !== null).catch(() => false);
    if (isContentEditable) {
      // 富文本编辑器用键盘输入，确保编辑器内部状态同步
      if (text.length <= 600 && typeDelay > 0) {
        await page.keyboard.type(text, { delay: typeDelay });
      } else {
        await page.keyboard.insertText(text);
      }
      await page.keyboard.press('Escape').catch(() => undefined);
    } else {
      await editor.fill(text);
    }
    await delay(page, 500);
    // 校验是否写入成功
    const current = await editor.evaluate((el) => (el.value ?? el.innerText ?? '')).catch(() => '');
    const expected = text.slice(0, 24).replace(/\s+/g, '');
    const actual = String(current).slice(0, 64).replace(/\s+/g, '');
    if (expected && !actual.includes(expected.slice(0, 12))) {
      onProgress?.({ step: 'description', message: '描述输入校验不一致，尝试重新写入' });
      await editor.click();
      await page.keyboard.press('Control+A').catch(() => undefined);
      await page.keyboard.insertText(text);
      await page.keyboard.press('Escape').catch(() => undefined);
      await delay(page, 500);
    }
    return true;
  }

  /** 短标题只允许：中英文、数字、书名号、引号、冒号、加号、问号、百分号、摄氏度、空格 */
  function sanitizeShortTitle(value) {
    const raw = String(value ?? '');
    const cleaned = raw
      .replace(/[^\u4e00-\u9fa5A-Za-z0-9 +《》<>“”"'‘’：:？?%℃、，,]/g, ' ')
      .replace(/，|,/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned.slice(0, 16);
  }

  async function fillShortTitle(page, value, onProgress) {
    const safe = sanitizeShortTitle(value);
    if (!safe) return false;
    const sel = getSelectors().publish;
    const input = await firstVisible(page, sel.shortTitleInputSelectors, { timeout: 3000 });
    if (!input) return false;
    onProgress?.({ step: 'short-title', message: `填写短标题：${truncate(safe, 20)}` });
    await input.scrollIntoViewIfNeeded().catch(() => undefined);
    await input.click().catch(() => undefined);
    await input.fill(safe);
    await delay(page, 600);
    const text = await readPageText(page);
    if (/标题包含特殊字符|标题超过.{0,4}字限制/.test(text)) {
      onProgress?.({ step: 'short-title', message: '短标题被页面判定为不合法，已尝试清理特殊字符' });
      return false;
    }
    return true;
  }

  async function setLocation(page, location, onProgress) {
    if (!location) return { ok: false, reason: '未配置位置' };
    const sel = getSelectors().publish;
    const formItem = page.locator('.form-item').filter({ hasText: sel.locationLabelText }).first();
    if (await formItem.count().catch(() => 0) === 0) return { ok: false, reason: '页面无位置选项' };
    const current = (await formItem.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (current.includes(location)) {
      onProgress?.({ step: 'location', message: `位置已是：${location}` });
      return { ok: true, already: true };
    }
    onProgress?.({ step: 'location', message: `设置位置：${location}` });
    // 新版页面：点击 .position-display 展开搜索面板
    const display = formItem.locator(sel.locationDisplaySelectors.join(', ')).first();
    const trigger = (await display.count().catch(() => 0)) ? display : formItem;
    await trigger.scrollIntoViewIfNeeded().catch(() => undefined);
    await trigger.click({ timeout: 8000 }).catch(() => undefined);
    await delay(page, 900);
    // 等待搜索框变为可见
    let search = null;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      search = await firstVisible(page, sel.locationSearchInputSelectors, { timeout: 400 });
      if (search && await search.isVisible().catch(() => false)) break;
      search = null;
      await sleep(400);
    }
    if (!search) return { ok: false, reason: '未出现位置搜索框' };
    await search.click().catch(() => undefined);
    await search.fill('').catch(() => undefined);
    await search.type(String(location), { delay: Number(timing().typeDelayMs || 0) || 20 }).catch(() => undefined);
    await sleep(2000);
    const options = page.locator(sel.locationOptionSelectors.join(', '));
    const count = await options.count().catch(() => 0);
    let chosen = null;
    let firstUsable = null;
    for (let index = 0; index < Math.min(count, 30); index += 1) {
      const option = options.nth(index);
      if (!(await option.isVisible().catch(() => false))) continue;
      const text = (await option.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (firstUsable === null && !sel.locationHideTexts.some((hide) => text.includes(hide))) firstUsable = option;
      if (text.includes(location)) { chosen = option; break; }
    }
    const target = chosen || firstUsable;
    if (!target) return { ok: false, reason: '未找到匹配的位置' };
    await target.click({ timeout: 6000 }).catch(() => undefined);
    await delay(page, 900);
    const after = (await formItem.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    return { ok: true, fallback: !chosen, selected: after.slice(0, 60) };
  }

  async function setCollection(page, name, onProgress) {
    if (!name) return { ok: false, reason: '未配置合集' };
    const sel = getSelectors().publish;
    const formItem = page.locator('.form-item').filter({ hasText: sel.collectionLabelText }).first();
    if (await formItem.count().catch(() => 0) === 0) return { ok: false, reason: '页面无合集选项' };
    onProgress?.({ step: 'collection', message: `选择合集：${name}` });
    for (const text of sel.collectionTriggerTexts) {
      const trigger = formItem.getByText(text, { exact: false }).first();
      if (await trigger.count().catch(() => 0) && await trigger.isVisible().catch(() => false)) {
        await trigger.click({ timeout: 6000 }).catch(() => undefined);
        await sleep(1200);
        break;
      }
    }
    const option = page.getByText(name, { exact: true }).first();
    if (await option.count().catch(() => 0) && await option.isVisible().catch(() => false)) {
      await option.click({ timeout: 5000 }).catch(() => undefined);
      await delay(page, 800);
      return { ok: true };
    }
    return { ok: false, reason: `未找到合集「${name}」` };
  }

  /** 视频标注（新版替代「原创声明」位置，下拉单选） */
  async function setVideoMark(page, value, onProgress) {
    const sel = getSelectors().publish;
    const mark = String(value || '').trim();
    if (!mark || mark === '无需标注') return { ok: true, skipped: true };
    const formItem = page.locator('.form-item').filter({ hasText: sel.videoMarkLabelText }).first();
    if (await formItem.count().catch(() => 0) === 0) return { ok: false, reason: '页面无视频标注选项' };
    const current = (await formItem.innerText().catch(() => '')).replace(/\s+/g, ' ');
    if (current.includes(mark)) return { ok: true, already: true };
    onProgress?.({ step: 'video-mark', message: `视频标注：${mark}` });
    const trigger = formItem.locator('.mark-tag-select, .select-display').first();
    await (await trigger.count().catch(() => 0) ? trigger : formItem).click({ timeout: 6000 }).catch(() => undefined);
    await delay(page, 700);
    const options = page.locator(sel.videoMarkOptionSelectors.join(', '));
    const count = await options.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 20); index += 1) {
      const option = options.nth(index);
      if (!(await option.isVisible().catch(() => false))) continue;
      const text = (await option.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (text.includes(mark)) {
        await option.click({ timeout: 5000 }).catch(() => undefined);
        await delay(page, 700);
        return { ok: true };
      }
    }
    await page.keyboard.press('Escape').catch(() => undefined);
    return { ok: false, reason: `未找到视频标注选项「${mark}」` };
  }

  async function setScheduled(page, schedule, onProgress) {
    if (!schedule?.enabled) return { ok: false, reason: '未启用定时发表' };
    const sel = getSelectors().publish;
    const wrap = page.locator('.post-time-wrap').first();
    if (await wrap.count().catch(() => 0) === 0) return { ok: false, reason: '页面无定时发表选项' };
    onProgress?.({ step: 'schedule', message: '设置定时发表' });
    const radio = wrap.getByText(sel.scheduleRadioTexts[0], { exact: true }).first();
    if (await radio.count().catch(() => 0)) {
      await radio.click({ timeout: 5000 }).catch(() => undefined);
      await sleep(800);
    }
    const picker = wrap.locator(`input[placeholder*="发表时间"]`).first();
    if (await picker.count().catch(() => 0)) {
      await picker.click({ timeout: 5000 }).catch(() => undefined);
      await sleep(800);
      const target = schedule.value ? new Date(schedule.value) : null;
      if (target && !Number.isNaN(target.getTime())) {
        // 日期选择器一般支持键盘输入；若不支持则尽力选择最接近的日期
        await picker.fill('').catch(() => undefined);
        await page.keyboard.type(`${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')} ${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`, { delay: 20 }).catch(() => undefined);
        await page.keyboard.press('Enter').catch(() => undefined);
        await sleep(800);
        return { ok: true };
      }
      const okBtn = await findButton(page, ['确定', '确认'], { timeout: 2000 });
      if (okBtn) await okBtn.click({ timeout: 4000 }).catch(() => undefined);
      return { ok: true, note: '已选择默认定时时间' };
    }
    return { ok: false, reason: '未找到发表时间选择器' };
  }

  async function setExtLink(page, url, onProgress) {
    if (!url) return { ok: false, reason: '未配置链接' };
    const input = await firstVisible(page, getSelectors().publish.extLinkInputSelectors, { timeout: 3000 });
    if (!input) return { ok: false, reason: '未找到链接输入框' };
    onProgress?.({ step: 'ext-link', message: `填写链接：${truncate(url, 40)}` });
    await input.click().catch(() => undefined);
    await input.fill(url);
    await sleep(1500);
    return { ok: true };
  }

  async function waitForSubmitEnabled(page, texts, timeout = 120_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const button = await findButton(page, texts, { timeout: 3000 });
      if (button) {
        const disabled = await button.evaluate((el) => el.disabled === true || el.getAttribute('aria-disabled') === 'true' || el.classList?.contains?.('disabled') || el.classList?.contains?.('is-disabled')).catch(() => false);
        if (!disabled) return button;
        const body = await readPageText(page);
        const reason = getSelectors().publish.submitDisabledReasons.find((t) => body.includes(t));
        if (reason) await sleep(1500);
        else await sleep(1000);
        continue;
      }
      await sleep(800);
    }
    return null;
  }

  async function readBodyText(page) {
    return readPageText(page);
  }

  async function verifyAction(page, action, beforeUrl, screenshotPath) {
    const sel = getSelectors().publish;
    const deadline = Date.now() + Number(timing().publishConfirmTimeoutMs || 60_000);
    while (Date.now() < deadline) {
      const body = await readBodyText(page);
      const success = sel.successTexts.find((t) => body.includes(t));
      if (success) return { status: 'success', message: success };
      const failure = sel.errorTexts.find((t) => body.includes(t));
      if (failure) return { status: 'failed', message: failure };
      const url = page.url();
      if (action === 'publish' && /\/platform\/post\/list/.test(url)) return { status: 'success', message: '已跳转到视频管理页' };
      if (!isLoginUrl(url, getSelectors()) && /post\/create/.test(beforeUrl || '') && action === 'publish' && url !== beforeUrl) {
        return { status: 'success', message: '页面已跳转' };
      }
      await sleep(1000);
    }
    return { status: 'unknown', message: '未捕获到明确的提交结果，请人工确认', screenshot: screenshotPath };
  }

  async function saveScreenshot(page, name) {
    const dir = PATHS.screenshots;
    await ensureDir(dir);
    const file = path.join(dir, `${name}.png`);
    try {
      await page.screenshot({ path: file, fullPage: false });
      return file;
    } catch {
      return null;
    }
  }

  async function runItem({ subjectId, video, text, config, taskId = 'task', itemId = 'item', dryRun = false, onProgress, signal }) {
    const startedAt = Date.now();
    timingOverride = config?.timingOverride || null;
    const warnings = [];
    const notes = [];
    const progress = (payload) => {
      if (signal?.aborted) return;
      onProgress?.(payload);
    };
    let page;
    let screenshot = null;
    try {
      return await browser.run(subjectId, async ({ page: browserPage }) => {
        page = browserPage;
        page.on('dialog', (dialog) => dialog.dismiss().catch(() => undefined));
        progress({ step: 'open', message: '打开发表动态页面' });
        await gotoCreate(page);
        await uploadVideo(page, video.path, progress);

        progress({ step: 'form', message: '等待表单就绪' });
        await delay(page, Number(timing().afterUploadSettleMs || 0) / 2);
        const editor = await findEditor(page, 20_000);
        if (!editor) throw new PublishError('上传后未出现视频描述输入框');

        const options = config.pageOptions || {};
        let description = text.content || '';
        if (options.description?.enabled) {
          const prefix = options.description.prefix || '';
          const suffix = options.description.suffix || '';
          const hashtags = Array.isArray(options.description.hashtags) ? options.description.hashtags.filter(Boolean) : [];
          const tagText = hashtags.map((tag) => (String(tag).startsWith('#') ? String(tag) : `#${tag}`)).join(' ');
          description = [prefix, description, suffix, tagText].filter(Boolean).join(description.includes('\n') ? '\n' : ' ');
        }
        if (description) {
          await fillDescription(page, description, progress);
          notes.push(`描述长度 ${description.length}`);
        }
        if (options.shortTitle?.enabled) {
          const value = options.shortTitle.value || '';
          const ok = await fillShortTitle(page, value, progress);
          if (!ok) warnings.push('短标题填写失败（页面无输入框或内容为空）');
        }
        if (options.location?.enabled) {
          const result = await setLocation(page, options.location.value, progress);
          if (!result.ok) warnings.push(`位置设置失败：${result.reason}`);
        }
        if (options.collection?.enabled) {
          const result = await setCollection(page, options.collection.value, progress);
          if (!result.ok) warnings.push(`合集设置失败：${result.reason}`);
        }
        if (options.extLink?.enabled) {
          const result = await setExtLink(page, options.extLink.value, progress);
          if (!result.ok) warnings.push(`链接设置失败：${result.reason}`);
        }
        if (options.scheduled?.enabled) {
          const result = await setScheduled(page, options.scheduled, progress);
          if (!result.ok) warnings.push(`定时发表设置失败：${result.reason}`);
          else if (result.note) notes.push(result.note);
        }
        if (options.videoMark?.enabled) {
          const result = await setVideoMark(page, options.videoMark.value, progress);
          if (!result.ok) warnings.push(`视频标注设置失败：${result.reason}`);
          else if (result.skipped) notes.push('视频标注：无需标注');
        }

        await delay(page, Number(timing().afterUploadSettleMs || 0));
        // 用编辑器自身内容校验描述是否写入（页面文本在 Shadow DOM 内，且可能被其他区域干扰）
        if (description) {
          const editorCheck = await findEditor(page, 3000);
          const editorText = editorCheck
            ? await editorCheck.evaluate((el) => el.value ?? el.textContent ?? el.innerText ?? '').catch(() => '')
            : '';
          const expectedHead = description.slice(0, 16).replace(/\s+/g, '');
          const actualText = String(editorText).replace(/\s+/g, '');
          if (expectedHead && !actualText.includes(expectedHead.slice(0, 10))) {
            warnings.push('页面中未找到描述内容，可能未成功写入');
          }
        }

        const action = dryRun ? 'dry-run' : (config.action === 'publish' ? 'publish' : 'draft');
        if (action === 'dry-run') {
          progress({ step: 'done', message: '演练模式：已完成填写，未提交' });
          screenshot = await saveScreenshot(page, `${taskId}-${itemId}-dryrun`);
          return { status: 'success', action: 'dry-run', message: '演练完成（未提交）', warnings, notes, screenshot, durationMs: Date.now() - startedAt };
        }

        const buttonTexts = action === 'publish' ? getSelectors().publish.publishButtonTexts : getSelectors().publish.draftButtonTexts;
        progress({ step: 'submit', message: action === 'publish' ? '点击发表' : '点击保存草稿' });
        const button = await waitForSubmitEnabled(page, buttonTexts, 120_000);
        if (!button) throw new PublishError(`未找到可点击的「${buttonTexts[0]}」按钮，或按钮一直不可用`);
        const beforeUrl = page.url();
        await button.scrollIntoViewIfNeeded().catch(() => undefined);
        await button.click({ timeout: 10_000 });
        await delay(page, 1000);
        // 处理二次确认弹窗
        if (action === 'publish') {
          const confirm = await findButton(page, getSelectors().publish.publishConfirmTexts, { timeout: 2500 });
          if (confirm) {
            await confirm.click({ timeout: 6000 }).catch(() => undefined);
            notes.push('已确认发表弹窗');
          }
        }
        await delay(page, Number(timing().afterPublishDelayMs || 0));
        const result = await verifyAction(page, action, beforeUrl, null);
        screenshot = await saveScreenshot(page, `${taskId}-${itemId}-${result.status}`);
        if (result.status === 'success' && action === 'publish') {
          await delay(page, 1500);
        }
        const url = page.url();
        const postIdMatch = url.match(/post[_-]?id=(\d+)/i) || url.match(/\/post\/(\d+)/);
        return {
          status: result.status === 'failed' ? 'failed' : result.status,
          action,
          message: result.message,
          url,
          postId: postIdMatch ? postIdMatch[1] : null,
          warnings,
          notes,
          screenshot,
          durationMs: Date.now() - startedAt,
        };
      });
    } catch (error) {
      if (page) screenshot = await saveScreenshot(page, `${taskId}-${itemId}-error`);
      const message = error?.code === 'SESSION_EXPIRED'
        ? error.message
        : (error?.message || String(error));
      if (error?.code === 'SESSION_EXPIRED') {
        return { status: 'failed', action: dryRun ? 'dry-run' : config.action, message, warnings, notes, screenshot, durationMs: Date.now() - startedAt };
      }
      return { status: 'failed', action: dryRun ? 'dry-run' : config.action, message, warnings, notes, screenshot, durationMs: Date.now() - startedAt };
    } finally {
      timingOverride = null;
    }
  }

  /** 采集页面 DOM 结构快照，用于排查站点改版（兼容 wujie Shadow DOM） */
  async function collectDomSnapshot(page) {
    return page.evaluate(() => {
      const roots = [];
      const allElements = [];
      const walkRoot = (root, depth) => {
        if (!root || depth > 30) return;
        roots.push(root);
        for (const el of root.querySelectorAll('*')) {
          allElements.push(el);
          if (el.shadowRoot) walkRoot(el.shadowRoot, depth + 1);
        }
      };
      walkRoot(document, 0);
      const textParts = [];
      const walkText = (node, depth) => {
        if (!node || depth > 40) return;
        if (node.nodeType === 3) { textParts.push(node.textContent); return; }
        if (node.nodeType !== 1) return;
        if (node.tagName === 'STYLE' || node.tagName === 'SCRIPT') return;
        if (node.shadowRoot) walkText(node.shadowRoot, depth + 1);
        for (const child of node.childNodes || []) walkText(child, depth + 1);
      };
      walkText(document.body, 0);

      const isVisible = (el) => {
        if (!el || !el.getBoundingClientRect) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1;
      };
      const pathFor = (el) => {
        const parts = [];
        let node = el;
        let depth = 0;
        while (node && node.nodeType === 1 && depth < 7) {
          let part = node.tagName.toLowerCase();
          if (node.id) { part += `#${node.id}`; parts.unshift(part); break; }
          const cls = typeof node.className === 'string'
            ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).map((c) => `.${c}`).join('')
            : '';
          part += cls;
          parts.unshift(part);
          const parent = node.parentElement || (node.getRootNode && node.getRootNode().host);
          node = parent;
          depth += 1;
        }
        return parts.join(' > ');
      };
      const info = (el) => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          path: pathFor(el),
          visible: isVisible(el),
          text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80),
          placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '',
          type: el.getAttribute('type') || '',
          accept: el.getAttribute('accept') || '',
          contenteditable: el.getAttribute('contenteditable'),
          cls: typeof el.className === 'string' ? el.className.slice(0, 160) : '',
          value: typeof el.value === 'string' ? el.value.slice(0, 60) : undefined,
          disabled: el.disabled === true,
          rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
        };
      };
      const matched = (selector) => allElements.filter((el) => { try { return el.matches(selector); } catch { return false; } });
      const bodyText = textParts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
      const percentMatch = bodyText.match(/(\d{1,3})\s*%/);
      const formItemEls = matched('.form-item');
      return {
        url: location.href,
        title: document.title,
        shadowRootCount: roots.length - 1,
        bodyText,
        bodyLength: bodyText.length,
        uploadState: {
          percent: percentMatch ? Number(percentMatch[1]) : null,
          hasCancelUpload: /取消上传/.test(bodyText),
          uploading: /上传中|正在上传|取消上传|正在处理文件|视频处理中|封面生成中/.test(bodyText),
          uploaded: /封面预览|更换封面/.test(bodyText),
        },
        fileInputs: matched('input[type="file"]').map(info),
        textareas: matched('textarea').map(info),
        editables: matched('[contenteditable], .ql-editor, [data-placeholder], .input-editor').map(info),
        inputs: matched('input:not([type="file"])').map(info).slice(0, 40),
        formItems: formItemEls.map((el) => ({
          label: ((el.querySelector('.label') || {}).innerText || '').trim(),
          text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 160),
          path: pathFor(el),
          controls: [...el.querySelectorAll('input, textarea, [contenteditable], .input-editor, [data-placeholder]')].slice(0, 6).map(info),
        })),
        buttons: matched('button, .ant-btn, .weui-btn, .mp-button, a, [role="button"]')
          .map(info).filter((item) => item.visible && item.text).slice(0, 60),
      };
    }).catch((error) => ({ error: String(error?.message || error) }));
  }

  async function withProbePage(subjectId, fn) {
    return browser.run(subjectId, async ({ context }) => {
      const page = await context.newPage();
      const dialogs = [];
      const dismiss = (dialog) => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => undefined); };
      page.on('dialog', dismiss);
      try {
        return await fn(page);
      } finally {
        await sleep(300);
        await page.close().catch(() => undefined);
      }
    });
  }

  async function probePage(subjectId) {
    return withProbePage(subjectId, async (page) => {
      const sel = getSelectors();
      const report = { startedAt: new Date().toISOString(), url: '', title: '', ready: false, error: null, matched: {}, screenshot: null, bodyText: '', dom: null };
      try {
        await gotoCreate(page);
        report.ready = true;
      } catch (error) {
        report.error = String(error?.message || error);
      }
      report.url = page.url();
      report.title = await page.title().catch(() => '');
      const count = async (locator) => locator.count().catch(() => 0);
      for (const [name, list] of Object.entries(sel.publish)) {
        if (!Array.isArray(list) || !list.length || typeof list[0] !== 'string') continue;
        if (!list[0].includes('[') && !list[0].includes('.')) continue;
        report.matched[name] = [];
        for (const selector of list) {
          try {
            const found = await count(page.locator(selector));
            if (found > 0) report.matched[name].push({ selector, count: found });
          } catch { /* skip */ }
        }
      }
      report.matched.formItems = await count(page.locator('.form-item'));
      report.matched.labels = await page.locator('.form-item .label').allInnerTexts().catch(() => []);
      report.matched.buttons = await page.locator('button, .ant-btn, a').allInnerTexts().catch(() => []);
      report.matched.fileInputs = await count(page.locator('input[type="file"]'));
      report.matched.contentEditables = await count(page.locator('[contenteditable="true"]'));
      report.dom = await collectDomSnapshot(page);
      report.bodyText = (report.dom && report.dom.bodyText) || '';
      report.screenshot = await saveScreenshot(page, `probe-${subjectId}-${Date.now()}`);
      return report;
    });
  }

  /**
   * 深度探测：真实上传一个测试视频，观察上传状态与表单出现时机，
   * 并逐个验证「视频描述」等选择器是否命中。不会点击保存/发表。
   */
  async function deepProbe(subjectId, { uploadFile = null, watchSeconds = 60 } = {}) {
    const result = {
      startedAt: new Date().toISOString(),
      ready: false,
      error: null,
      findings: {},
      steps: [],
      snapshots: [],
      screenshots: [],
      uploadSamples: [],
    };
    const note = (message) => { result.steps.push(`${new Date().toISOString().slice(11, 19)} ${message}`); };
    return withProbePage(subjectId, async (page) => {
      try {
        note('打开发表动态页面');
        await gotoCreate(page);
        result.ready = true;
        result.snapshots.push({ label: 'ready', dom: await collectDomSnapshot(page) });
        result.screenshots.push(await saveScreenshot(page, `deep-${subjectId}-ready`));
        if (uploadFile) {
          const stat = await fsp.stat(uploadFile).catch(() => null);
          if (!stat) throw new PublishError(`测试视频不存在：${uploadFile}`);
          note(`选择测试视频：${path.basename(uploadFile)}（${Math.round(stat.size / 1024)} KB）`);
          const uploadStartedAt = Date.now();
          const samples = [];
          result.findings.uploadStartAt = new Date().toISOString();
          try {
            await uploadVideo(
              page,
              uploadFile,
              (payload) => note(payload?.message || String(payload)),
              (sample) => {
                samples.push(sample);
                if (samples.length % 5 === 0) {
                  saveScreenshot(page, `deep-${subjectId}-upload-${sample.t}`)
                    .then((file) => { if (file) result.screenshots.push(file); })
                    .catch(() => undefined);
                }
              },
            );
            result.findings.uploadCompleted = true;
            result.findings.uploadDurationMs = Date.now() - uploadStartedAt;
            result.findings.uploadDoneDetected = true;
          } catch (error) {
            result.findings.uploadCompleted = false;
            result.findings.uploadError = String(error?.message || error);
            note(`上传失败：${result.findings.uploadError}`);
          }
          result.uploadSamples = samples.slice(-80);
          result.findings.uploadingSeen = samples.some((sample) => sample.uploading);
          result.findings.finalPercent = samples.at(-1)?.percent ?? null;
          await delay(page, 2500);
          result.snapshots.push({ label: 'after-upload', dom: await collectDomSnapshot(page) });
          result.screenshots.push(await saveScreenshot(page, `deep-${subjectId}-after-upload`));
          if (!result.findings.uploadCompleted) {
            result.ok = false;
            return result;
          }

          const editor = await findEditor(page, 8000);
          result.findings.editorFound = Boolean(editor);
          if (editor) {
            result.findings.editor = await editor.evaluate((el) => ({
              tag: el.tagName.toLowerCase(),
              className: typeof el.className === 'string' ? el.className.slice(0, 160) : '',
              contenteditable: el.getAttribute('contenteditable'),
              placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '',
              parentClass: el.parentElement && typeof el.parentElement.className === 'string' ? el.parentElement.className.slice(0, 160) : '',
            })).catch(() => null);
            try {
              await fillDescription(page, '【页面探测】视频描述写入测试文本', (payload) => note(payload?.message || String(payload)));
              result.findings.descriptionWritable = true;
              result.screenshots.push(await saveScreenshot(page, `deep-${subjectId}-desc-filled`));
            } catch (error) {
              result.findings.descriptionWritable = false;
              result.findings.descriptionError = String(error?.message || error);
            }
          }
          // 验证其他关键控件是否存在（不写入，仅检测）
          result.findings.shortTitleInput = await firstVisible(page, getSelectors().publish.shortTitleInputSelectors, { timeout: 2000 }) !== null;
          const formLabels = await page.locator('.form-item .label').allInnerTexts().catch(() => []);
          result.findings.formLabels = formLabels.map((text) => String(text).trim()).filter(Boolean);
          result.findings.buttons = (await page.locator('button, .ant-btn, .mp-button').allInnerTexts().catch(() => []))
            .map((text) => String(text).trim()).filter(Boolean).slice(0, 40);
          result.findings.editorSelectorMatched = await (async () => {
            for (const selector of getSelectors().publish.descEditorSelectors) {
              const count = await page.locator(selector).count().catch(() => 0);
              if (count > 0) return { selector, count };
            }
            return null;
          })();
          note('探测完成（未提交，已离开页面）');
        } else {
          note('未提供测试视频，仅做页面就绪探测');
        }
        result.ok = true;
      } catch (error) {
        result.error = String(error?.message || error);
        result.screenshots.push(await saveScreenshot(page, `deep-${subjectId}-error`).catch(() => null));
        note(`探测失败：${result.error}`);
      }
      return result;
    });
  }

  return { runItem, probePage, deepProbe, gotoCreate, findEditor, saveScreenshot };
}
