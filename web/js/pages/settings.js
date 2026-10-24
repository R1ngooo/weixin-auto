import { api } from '../api.js';
import { store } from '../store.js';
import {
  confirmDialog, esc, modal, readFileAsText, toast,
} from '../ui.js';

function numberField(label, key, value, hint = '', step = '1', min = '0') {
  return `<label class="field"><span>${esc(label)}</span><input type="number" data-num="${esc(key)}" value="${esc(value)}" step="${step}" min="${min}">${hint ? `<span class="help-text">${esc(hint)}</span>` : ''}</label>`;
}

/** 系统设置：单列瀑布式布局 + 左侧子导航 + 演练测试环境开关 */
export const settingsPage = {
  async mount(ctx) {
    const data = await store.loadSettings(true);
    const settings = data.settings;
    const browsers = await store.loadBrowsers(true);
    let selectorOverrides = settings.selectors || {};
    let navCleanup = () => undefined;

    const actionsEl = ctx.setActions('<button class="btn primary" data-act="save">保存设置</button>');
    actionsEl.querySelector('[data-act="save"]').addEventListener('click', () => saveBasic());

    function collectBasic() {
      const num = (key) => Number(document.querySelector(`[data-num="${key}"]`)?.value || 0);
      const browserChoice = document.querySelector('[data-browser-choice]')?.value || 'bundled';
      const customPath = document.querySelector('[data-custom-path]')?.value.trim() || '';
      return {
        testing: {
          dryRunCountsUsage: Boolean(document.querySelector('[data-dry-run-usage]')?.checked),
        },
        browser: {
          headless: document.querySelector('[data-headless]').checked,
          channel: browserChoice === 'chrome' ? 'chrome' : browserChoice === 'msedge' ? 'msedge' : '',
          executablePath: browserChoice === 'custom' ? customPath : '',
          viewport: {
            width: Number(document.querySelector('[data-vp-width]')?.value || 1440),
            height: Number(document.querySelector('[data-vp-height]')?.value || 900),
          },
          idleCloseMinutes: Number(document.querySelector('[data-idle]')?.value || 0),
        },
        timing: {
          stepDelayMs: num('stepDelayMs'),
          clickDelayMs: num('clickDelayMs'),
          typeDelayMs: num('typeDelayMs'),
          afterUploadSettleMs: num('afterUploadSettleMs'),
          uploadTimeoutMs: num('uploadTimeoutMs'),
          publishConfirmTimeoutMs: num('publishConfirmTimeoutMs'),
          afterPublishDelayMs: num('afterPublishDelayMs'),
        },
        video: {
          extensions: document.querySelector('[data-extensions]').value.split(/[,，\s]+/).map((v) => v.trim()).filter(Boolean),
          recursive: document.querySelector('[data-recursive]').checked,
        },
      };
    }

    async function saveBasic() {
      try {
        await api.updateSettings(collectBasic());
        await store.loadSettings(true);
        toast('设置已保存', 'success');
      } catch (error) {
        toast(error.message, 'error');
      }
    }

    function render() {
      const browserChoice = settings.browser.executablePath ? 'custom'
        : settings.browser.channel === 'chrome' ? 'chrome'
          : settings.browser.channel === 'msedge' ? 'msedge' : 'bundled';
      const sections = [
        ['env', '演练测试环境'],
        ['browser', '浏览器与运行'],
        ['timing', '操作延迟'],
        ['scan', '视频扫描'],
        ['selectors', '选择器（高级）'],
        ['transfer', '配置导入 / 导出'],
        ['about', '关于'],
      ];
      ctx.root.innerHTML = `
        <div class="settings-layout">
          <nav class="settings-nav" aria-label="设置导航">
            <div class="settings-nav-title">设置导航</div>
            ${sections.map(([id, label], index) => `
              <button class="settings-nav-item ${index === 0 ? 'active' : ''}" data-jump="settings-${id}">${label}</button>`).join('')}
          </nav>
          <div class="settings-sections">

            <section class="card settings-section" id="settings-env">
              <div class="card-title">演练测试环境 <span class="hint">用于验证前端显示效果</span></div>
              <label class="check"><input type="checkbox" data-dry-run-usage ${settings.testing?.dryRunCountsUsage ? 'checked' : ''}> 演练模式也计入素材使用状态与使用次数</label>
              <div class="help-text">
                开启后，勾选「演练模式」创建/执行任务时会正常消耗视频、文本的使用状态并累计使用次数（方便检查「已上传 / 已使用」等前端显示）；
                关闭时演练模式不改变任何使用数据（默认）。修改后点右上角「保存设置」生效。
              </div>
            </section>

            <section class="card settings-section" id="settings-browser">
              <div class="card-title">浏览器与运行 <span class="hint">每个主体一个独立浏览器</span></div>
              <div class="col">
                <label class="check"><input type="checkbox" data-headless ${settings.browser.headless ? 'checked' : ''}> 无头模式（后台运行，不显示浏览器窗口）</label>
                <label class="field"><span>浏览器内核</span>
                  <select data-browser-choice>
                    <option value="bundled" ${browserChoice === 'bundled' ? 'selected' : ''}>Playwright 内置 Chromium</option>
                    <option value="chrome" ${browserChoice === 'chrome' ? 'selected' : ''}>本机 Chrome</option>
                    <option value="msedge" ${browserChoice === 'msedge' ? 'selected' : ''}>本机 Edge</option>
                    <option value="custom" ${browserChoice === 'custom' ? 'selected' : ''}>自定义可执行文件</option>
                  </select>
                </label>
                <label class="field"><span>自定义浏览器路径（仅「自定义」时生效）</span><input type="text" data-custom-path value="${esc(settings.browser.executablePath || '')}" placeholder="例如 C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"></label>
                <div class="row small muted-2">
                  <span>检测到：</span>${browsers.found.length ? browsers.found.map((file) => `<span class="mono">${esc(file)}</span>`).join('') : '<span>未检测到本机 Chrome/Edge，将使用内置 Chromium</span>'}
                </div>
                <div class="form-grid">
                  <label class="field"><span>窗口宽</span><input type="number" data-vp-width value="${esc(settings.browser.viewport?.width || 1440)}" min="800" step="10"></label>
                  <label class="field"><span>窗口高</span><input type="number" data-vp-height value="${esc(settings.browser.viewport?.height || 900)}" min="600" step="10"></label>
                  <label class="field span-2"><span>浏览器空闲自动关闭（分钟，0 = 不关闭）</span><input type="number" data-idle value="${esc(settings.browser.idleCloseMinutes ?? 10)}" min="0" step="1"></label>
                </div>
                <div class="help-text">有头模式方便观察与人工接管；无头模式更快但遇验证码/异常时不易处理。</div>
              </div>
            </section>

            <section class="card settings-section" id="settings-timing">
              <div class="card-title">操作延迟（兼容网络延迟） <span class="hint">毫秒</span></div>
              <div class="form-grid">
                ${numberField('步骤间延迟', 'stepDelayMs', settings.timing.stepDelayMs, '每个操作之间的基础等待', '100')}
                ${numberField('点击后延迟', 'clickDelayMs', settings.timing.clickDelayMs, '', '50')}
                ${numberField('输入字符延迟', 'typeDelayMs', settings.timing.typeDelayMs, '模拟人工输入速度', '10')}
                ${numberField('上传完成等待', 'afterUploadSettleMs', settings.timing.afterUploadSettleMs, '上传后表单稳定等待', '500')}
                ${numberField('视频上传超时', 'uploadTimeoutMs', settings.timing.uploadTimeoutMs, '大文件建议 15-30 分钟', '10000')}
                ${numberField('提交结果确认超时', 'publishConfirmTimeoutMs', settings.timing.publishConfirmTimeoutMs, '', '1000')}
                ${numberField('提交后延迟', 'afterPublishDelayMs', settings.timing.afterPublishDelayMs, '', '500')}
              </div>
            </section>

            <section class="card settings-section" id="settings-scan">
              <div class="card-title">视频扫描 <span class="hint">扫描本地视频文件夹入库</span></div>
              <div class="col">
                <label class="field"><span>视频扩展名（逗号/空格分隔）</span><input type="text" data-extensions value="${esc((settings.video.extensions || []).join(' '))}"></label>
                <label class="check"><input type="checkbox" data-recursive ${settings.video.recursive ? 'checked' : ''}> 默认扫描子目录（新建文件夹时生效）</label>
                <div class="row">
                  <button class="btn small" data-act="scan">立即扫描全部视频文件夹</button>
                  <a class="btn small ghost" href="#/videos">前往视频池管理文件夹</a>
                </div>
                <div class="help-text">视频文件夹的增删、系统文件夹选择与导入标签，请在「视频池 → 文件夹管理」操作；扫描结果会按扩展名过滤，并自动计算 MD5、生成封面。</div>
              </div>
            </section>

            <section class="card settings-section" id="settings-selectors">
              <div class="card-title">选择器（高级） <span class="hint">页面改版时覆盖默认选择器</span></div>
              <div class="col">
                <textarea class="code-editor" data-selector-overrides placeholder='{"publish":{"publishButtonTexts":["发表"]}}'>${esc(JSON.stringify(selectorOverrides, null, 2))}</textarea>
                <div class="row">
                  <button class="btn small" data-act="selector-save">保存覆盖</button>
                  <button class="btn small ghost" data-act="selector-reset">清空覆盖</button>
                  <button class="btn small ghost" data-act="selector-defaults">查看默认选择器</button>
                </div>
                <div class="help-text">使用 JSON 深度覆盖默认值；保存后对之后的任务生效。页面探测可在「主体管理 → 页面探测」中进行。</div>
              </div>
            </section>

            <section class="card settings-section" id="settings-transfer">
              <div class="card-title">配置导入 / 导出 <span class="hint">版本升级迁移使用</span></div>
              <div class="grid cols-2">
                <div class="col">
                  <div class="field"><span>导出内容</span>
                    <div class="row">
                      ${['settings:设置', 'tags:标签', 'subjects:主体信息', 'videos:视频元数据', 'texts:文本池', 'configs:发布配置'].map((item) => {
                        const [key, label] = item.split(':');
                        return `<label class="check"><input type="checkbox" data-export="${key}" checked> ${label}</label>`;
                      }).join('')}
                    </div>
                  </div>
                  <div class="row">
                    <button class="btn small primary" data-act="export">导出为 JSON 文件</button>
                    <button class="btn small" data-act="export-save">保存到 data/backups</button>
                  </div>
                  <div class="help-text">导出不包含浏览器登录态（profiles）与微信机器人 token。</div>
                </div>
                <div class="col">
                  <div class="field"><span>导入配置</span>
                    <div class="row">
                      <label class="btn small ghost" style="cursor:pointer">选择 JSON 文件<input type="file" accept=".json,application/json" data-import-file style="display:none"></label>
                      <label class="check"><input type="radio" name="import-mode" value="merge" checked> 合并</label>
                      <label class="check"><input type="radio" name="import-mode" value="replace"> 替换标签/配置</label>
                    </div>
                    <textarea class="mt-8" data-import-text placeholder="或将备份 JSON 内容粘贴到这里" style="min-height:100px"></textarea>
                  </div>
                  <div class="row">
                    <button class="btn small primary" data-act="import">开始导入</button>
                    <span class="small muted-2">导入后建议到「标签管理」检查标签关联。</span>
                  </div>
                </div>
              </div>
            </section>

            <section class="card settings-section" id="settings-about">
              <div class="card-title">关于</div>
              <div class="kv small">
                <div class="k">版本</div><div>0.1.0</div>
                <div class="k">数据目录</div><div class="mono">${esc(data.dataDir)}</div>
                <div class="k">dsh 目录</div><div class="mono">${esc(data.dshHome)}</div>
                <div class="k">当前生效</div><div>${settings.browser.headless ? '无头浏览器' : '有头浏览器'} · 步骤延迟 ${settings.timing.stepDelayMs}ms · 演练计入使用次数：${settings.testing?.dryRunCountsUsage ? '开启' : '关闭'}</div>
                <div class="k">快捷入口</div><div class="row"><a href="#/tags">标签管理</a><a href="#/tasks">执行记录 / 微信结果同步</a></div>
              </div>
            </section>
          </div>
        </div>
      `;
      bindNav();
      bind();
    }

    function bindNav() {
      const items = [...ctx.root.querySelectorAll('.settings-nav-item')];
      const sections = [...ctx.root.querySelectorAll('.settings-section')];
      const setActive = (id) => {
        items.forEach((item) => item.classList.toggle('active', item.dataset.jump === id));
      };
      const updateActive = () => {
        let index = 0;
        sections.forEach((section, sectionIndex) => {
          if (section.getBoundingClientRect().top <= 150) index = sectionIndex;
        });
        setActive(sections[index]?.id);
      };
      // 找到实际滚动容器（#page 或 window）
      let scrollTarget = null;
      let parent = ctx.root.parentElement;
      while (parent && parent !== document.body) {
        const style = getComputedStyle(parent);
        if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 10) {
          scrollTarget = parent;
          break;
        }
        parent = parent.parentElement;
      }
      const target = scrollTarget || window;
      const onScroll = () => updateActive();
      target.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll);
      updateActive();

      items.forEach((item) => {
        item.addEventListener('click', () => {
          const section = ctx.root.querySelector(`#${item.dataset.jump}`);
          if (!section) return;
          section.scrollIntoView({ behavior: 'smooth', block: 'start' });
          setActive(item.dataset.jump);
          // 平滑滚动结束后再校正一次高亮
          setTimeout(() => setActive(item.dataset.jump), 500);
        });
      });
      navCleanup = () => {
        target.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onScroll);
      };
    }

    function bind() {
      ctx.root.querySelector('[data-act="scan"]').addEventListener('click', async () => {
        try {
          const job = await api.scanVideos();
          toast(`已开始扫描（任务 ${job.id.slice(0, 12)}…），可在视频池查看进度`, 'success');
        } catch (error) {
          toast(error.message, 'error');
        }
      });
      ctx.root.querySelector('[data-act="selector-save"]').addEventListener('click', async () => {
        try {
          const parsed = JSON.parse(ctx.root.querySelector('[data-selector-overrides]').value || '{}');
          await api.updateSelectors(parsed);
          selectorOverrides = parsed;
          await store.loadSettings(true);
          toast('选择器覆盖已保存', 'success');
        } catch (error) {
          toast(`保存失败：${error.message}`, 'error', 5000);
        }
      });
      ctx.root.querySelector('[data-act="selector-reset"]').addEventListener('click', async () => {
        ctx.root.querySelector('[data-selector-overrides]').value = '{}';
        await api.updateSelectors({});
        selectorOverrides = {};
        await store.loadSettings(true);
        toast('已清空覆盖，恢复默认选择器', 'success');
      });
      ctx.root.querySelector('[data-act="selector-defaults"]').addEventListener('click', async () => {
        try {
          const defaults = await fetch('/api/settings/selectors/defaults').then((r) => r.json());
          modal({
            title: '默认选择器',
            wide: true,
            body: `<pre class="mono small" style="white-space:pre-wrap;max-height:60vh;overflow:auto">${esc(JSON.stringify(defaults.data, null, 2))}</pre>`,
            footer: '<button class="btn" data-close>关闭</button>',
          });
        } catch (error) {
          toast(error.message, 'error');
        }
      });

      const exportParams = () => {
        const keys = ['settings', 'tags', 'subjects', 'videos', 'texts', 'configs'];
        const params = new URLSearchParams();
        for (const key of keys) {
          if (!ctx.root.querySelector(`[data-export="${key}"]`).checked) params.set(key, '0');
        }
        return params.toString();
      };
      ctx.root.querySelector('[data-act="export"]').addEventListener('click', () => {
        const link = document.createElement('a');
        link.href = `/api/settings/export?${exportParams()}`;
        link.click();
      });
      ctx.root.querySelector('[data-act="export-save"]').addEventListener('click', async () => {
        try {
          const response = await fetch(`/api/settings/export?${exportParams()}&save=1`);
          const payload = await response.json();
          toast(`已保存到：${payload.savedTo || payload.data?.savedTo}`, 'success', 6000);
        } catch (error) {
          toast(error.message, 'error');
        }
      });
      ctx.root.querySelector('[data-import-file]').addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
          ctx.root.querySelector('[data-import-text]').value = await readFileAsText(file);
          toast(`已读取 ${file.name}`, 'success');
        } catch (error) {
          toast(error.message, 'error');
        }
      });
      ctx.root.querySelector('[data-act="import"]').addEventListener('click', async () => {
        const raw = ctx.root.querySelector('[data-import-text]').value.trim();
        if (!raw) return toast('请先选择文件或粘贴备份 JSON', 'warn');
        const mode = ctx.root.querySelector('input[name="import-mode"]:checked').value;
        const ok = await confirmDialog({
          title: '导入配置',
          message: mode === 'replace'
            ? '替换模式会清空现有标签、标签关联与发布配置后导入，是否继续？'
            : '合并模式会按名称/内容去重后导入，是否继续？',
          okText: '开始导入',
        });
        if (!ok) return;
        try {
          const payload = JSON.parse(raw);
          const result = await api.importPayload(payload, mode);
          toast(`导入完成：标签 ${result.stats.tags}，主体 ${result.stats.subjects}，视频 ${result.stats.videos}，文本 ${result.stats.texts}，发布配置 ${result.stats.publishConfigs}`, 'success', 6000);
          await store.loadTags(true);
          await store.loadSettings(true);
          render();
        } catch (error) {
          toast(`导入失败：${error.message}`, 'error', 6000);
        }
      });
    }

    render();
    return () => { try { navCleanup(); } catch { /* ignore */ } };
  },
};
