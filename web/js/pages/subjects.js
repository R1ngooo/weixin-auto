import { api } from '../api.js';
import { store } from '../store.js';
import {
  badge, bindTagBar, chipSelector, confirmDialog, emptyState, esc, fmtDate, modal, statusBadge, SUBJECT_STATUS, tagBarHtml, tagChips, timeAgo, toast,
} from '../ui.js';
import { batchBarHtml, openBatchTagModal } from './batch-tags.js';

export const subjectsPage = {
  async mount(ctx) {
    const state = {
      subjects: [],
      filterTagIds: [],
      status: '',
      query: '',
      loginPolling: null,
      batchMode: false,
      selected: new Set(),
    };

    const actionsEl = ctx.setActions(`
      <button class="btn" data-act="batch">批量编辑</button>
      <button class="btn" data-act="check-all">检查全部会话</button>
      <button class="btn primary" data-act="login-new">扫码登录新主体</button>
    `);
    actionsEl.querySelector('[data-act="batch"]')?.addEventListener('click', () => {
      state.batchMode = !state.batchMode;
      if (!state.batchMode) state.selected.clear();
      actionsEl.querySelector('[data-act="batch"]').textContent = state.batchMode ? '退出批量' : '批量编辑';
      actionsEl.querySelector('[data-act="batch"]').classList.toggle('primary', false);
      render(state.tagsCache || []);
    });
    actionsEl.querySelector('[data-act="check-all"]')?.addEventListener('click', () => checkAll());
    actionsEl.querySelector('[data-act="login-new"]')?.addEventListener('click', () => openLoginModal(null));

    async function load() {
      const [subjects, tags] = await Promise.all([api.subjects(), store.loadTags(true)]);
      state.subjects = subjects;
      state.tagsCache = tags;
      render(tags);
    }

    function filtered(tags) {
      let list = state.subjects;
      if (state.status) list = list.filter((subject) => subject.status === state.status);
      if (state.filterTagIds.length) {
        list = list.filter((subject) => subject.tags.some((tag) => state.filterTagIds.includes(Number(tag.id))));
      }
      if (state.query) {
        const q = state.query.toLowerCase();
        list = list.filter((subject) => [...[subject.name, subject.note, subject.wechatNickname, subject.finderNickname, subject.finderUsername, subject.wechatId],
          ...(subject.tags || []).map((tag) => tag.name)]
          .some((field) => String(field || '').toLowerCase().includes(q)));
      }
      return list;
    }

    function render(tags) {
      state.tagsCache = tags;
      const list = filtered(tags);
      const selectedCount = state.selected.size;
      ctx.root.innerHTML = `
        <div class="toolbar">
          <input type="search" placeholder="搜索名称 / 微信昵称 / 视频号ID / 标签" value="${esc(state.query)}" data-search>
          <select data-status>
            <option value="">全部状态</option>
            <option value="active" ${state.status === 'active' ? 'selected' : ''}>在线</option>
            <option value="expired" ${state.status === 'expired' ? 'selected' : ''}>已过期</option>
            <option value="unknown" ${state.status === 'unknown' ? 'selected' : ''}>未检查</option>
          </select>
          <div class="spacer"></div>
          <button class="btn small ghost" data-act="refresh">刷新</button>
        </div>
        ${tagBarHtml(tags, state.filterTagIds)}
        ${state.batchMode ? batchBarHtml({ selected: selectedCount, total: list.length }) : ''}
        ${list.length ? `<div class="subject-grid">${list.map(subjectCard).join('')}</div>` : emptyState('👤', '没有符合条件的主体', '点击右上角「扫码登录新主体」开始', '<button class="btn primary" data-act="login-new">扫码登录</button>')}
        <div class="small muted-2 mt-16">共 ${list.length} 个主体 · 每个主体使用独立浏览器目录保存登录态</div>
      `;
      bind(tags);
    }

    function subjectCard(subject) {
      const checked = state.selected.has(subject.id);
      const displayName = subject.displayName || subject.finderNickname || subject.finderUsername || subject.name || '未命名主体';
      const subParts = [];
      if (subject.wechatNickname || subject.wechatId) subParts.push(`微信：${subject.wechatNickname || subject.wechatId}`);
      if (subject.finderUsername) subParts.push(`视频号ID：${subject.finderUsername}`);
      const subline = subParts.join(' · ') || '未识别账号信息';
      return `
        <div class="subject-card ${state.batchMode ? 'selectable' : ''} ${checked ? 'selected' : ''}" data-subject="${esc(subject.id)}">
          <div class="subject-head">
            ${state.batchMode ? `<label class="select-box check" title="选择"><input type="checkbox" data-select="${esc(subject.id)}" ${checked ? 'checked' : ''}></label>` : ''}
            ${subject.avatarUrl
              ? `<img class="avatar" src="${esc(subject.avatarUrl)}" alt="" referrerpolicy="no-referrer">`
              : `<div class="avatar">${esc((displayName || '主')[0])}</div>`}
            <div class="subject-identity">
              <div class="subject-name truncate" title="${esc(displayName)}">${esc(displayName)}</div>
              <div class="subject-sub truncate" title="${esc(subline)}">${esc(subline)}</div>
            </div>
            <span class="subject-status">${statusBadge(subject.status, SUBJECT_STATUS)}</span>
          </div>
          <div class="subject-body">
            <div class="subject-tags">${subject.tags.length ? tagChips(subject.tags) : '<span class="muted-2">未打标签</span>'}</div>
            <div class="subject-note-row">${subject.note ? `备注：${esc(subject.note)}` : '<span class="muted-2">无备注</span>'}</div>
            <div class="subject-meta-row">
              最近检查：${esc(subject.lastCheckAt ? `${timeAgo(subject.lastCheckAt)}（${fmtDate(subject.lastCheckAt)}）` : '未检查')}
              ${subject.lastLoginAt ? ` · 登录于 ${esc(fmtDate(subject.lastLoginAt))}` : ''}
            </div>
            <div class="subject-detail-row">${subject.statusDetail ? esc(subject.statusDetail) : ''}</div>
          </div>
          <div class="actions subject-actions">
            <button class="btn small ${subject.status === 'expired' ? 'primary' : ''}" data-card-act="login">重新扫码</button>
            <button class="btn small" data-card-act="check">检查会话</button>
            <button class="btn small ghost" data-card-act="open">打开浏览器</button>
            <button class="btn small ghost" data-card-act="probe">页面探测</button>
            <button class="btn small ghost" data-card-act="edit">编辑</button>
            <button class="btn small danger" data-card-act="delete">删除</button>
          </div>
        </div>`;
    }

    function bind(tags) {
      ctx.root.querySelector('[data-search]')?.addEventListener('input', (event) => {
        state.query = event.target.value.trim();
        render(tags);
      });
      ctx.root.querySelector('[data-status]')?.addEventListener('change', (event) => {
        state.status = event.target.value;
        render(tags);
      });
      bindTagBar(ctx.root, tags, state.filterTagIds, (ids) => {
        state.filterTagIds = ids;
        render(tags);
      });
      ctx.root.querySelector('[data-act="refresh"]')?.addEventListener('click', () => load().then(() => toast('已刷新', 'success')));

      // 批量选择
      const selectIds = (ids) => {
        ids.forEach((id) => state.selected.add(id));
        render(tags);
      };
      ctx.root.querySelector('[data-batch="all"]')?.addEventListener('click', () => {
        selectIds(filtered(tags).map((subject) => subject.id));
      });
      ctx.root.querySelector('[data-batch="clear"]')?.addEventListener('click', () => {
        state.selected.clear();
        render(tags);
      });
      ctx.root.querySelector('[data-batch="apply"]')?.addEventListener('click', async () => {
        await openBatchTagModal({
          kind: 'subject',
          ids: [...state.selected],
          onApplied: async () => { state.selected.clear(); await load(); },
        });
      });
      ctx.root.querySelector('[data-batch="exit"]')?.addEventListener('click', () => {
        state.batchMode = false;
        state.selected.clear();
        const batchButton = actionsEl.querySelector('[data-act="batch"]');
        if (batchButton) batchButton.textContent = '批量编辑';
        render(tags);
      });
      ctx.root.querySelectorAll('[data-select]').forEach((checkbox) => {
        checkbox.addEventListener('click', (event) => event.stopPropagation());
        checkbox.addEventListener('change', () => {
          const id = checkbox.dataset.select;
          if (checkbox.checked) state.selected.add(id);
          else state.selected.delete(id);
          render(tags);
        });
      });
      ctx.root.querySelectorAll('.subject-card.selectable').forEach((card) => {
        card.addEventListener('click', (event) => {
          if (event.target.closest('button, a, input, label')) return;
          const id = card.dataset.subject;
          if (state.selected.has(id)) state.selected.delete(id);
          else state.selected.add(id);
          render(tags);
        });
      });

      ctx.root.querySelectorAll('[data-card-act]').forEach((button) => {
        button.addEventListener('click', async () => {
          const card = button.closest('[data-subject]');
          const subject = state.subjects.find((item) => item.id === card.dataset.subject);
          if (!subject) return;
          const action = button.dataset.cardAct;
          if (action === 'login') return openLoginModal(subject.id);
          if (action === 'edit') return openEditModal(subject);
          if (action === 'delete') return removeSubject(subject);
          if (action === 'check') return checkSubject(subject, button);
          if (action === 'open') return openBrowser(subject, button);
          if (action === 'probe') return probePage(subject, button);
        });
      });
      ctx.root.querySelectorAll('[data-act="login-new"]').forEach((button) => {
        button.addEventListener('click', () => openLoginModal(null));
      });
    }

    async function openLoginModal(subjectId) {
      if (state.loginPolling) clearInterval(state.loginPolling);
      const target = subjectId ? state.subjects.find((item) => item.id === subjectId) : null;
      const dialog = modal({
        title: target ? `重新扫码登录：${target.displayName || target.name}` : '扫码登录新主体',
        body: `
          <div class="qr-box">
            <div id="qr-image" class="qr-image-box">
              <div class="col" style="align-items:center;gap:10px"><span class="spinner"></span><span class="small muted">正在启动无头浏览器…</span></div>
            </div>
            <div class="qr-status" id="qr-status"><span class="spinner"></span><span>正在后台打开登录页面并加载二维码…</span></div>
            <div class="small muted-2" style="text-align:center;max-width:400px">默认以<b>无头模式</b>后台运行，不显示浏览器窗口；二维码过期会自动快速刷新。如需在浏览器中手动操作，可点击下方「浏览器扫码」。</div>
          </div>
          <div id="qr-extra"></div>
        `,
        footer: `
          <button class="btn" data-act="refresh">刷新二维码</button>
          <button class="btn ghost" data-act="browser">浏览器扫码</button>
          <button class="btn danger" data-act="cancel">取消</button>
        `,
      });
      const imageBox = dialog.body.querySelector('#qr-image');
      const statusBox = dialog.body.querySelector('#qr-status');
      const extraBox = dialog.body.querySelector('#qr-extra');
      const refreshBtn = dialog.foot.querySelector('[data-act="refresh"]');
      const browserBtn = dialog.foot.querySelector('[data-act="browser"]');
      const cancelBtn = dialog.foot.querySelector('[data-act="cancel"]');
      let attemptId = null;
      let finished = false;
      let lastQrAt = 0;
      let refreshing = false;
      let openingBrowser = false;

      const stop = () => {
        if (state.loginPolling) clearInterval(state.loginPolling);
        state.loginPolling = null;
      };

      const updateButtons = (snapshot) => {
        const terminal = finished || ['success', 'failed', 'cancelled'].includes(snapshot?.status);
        const blocked = terminal || ['scanned', 'choose-finder', 'opening-browser'].includes(snapshot?.status);
        refreshBtn.disabled = Boolean(blocked || refreshing);
        browserBtn.disabled = Boolean(blocked || openingBrowser);
        refreshBtn.textContent = refreshing ? '刷新中…' : '刷新二维码';
        browserBtn.textContent = openingBrowser ? '打开中…' : '浏览器扫码';
      };

      const renderQr = (snapshot) => {
        if (!snapshot.qr?.dataUrl) return;
        if (snapshot.qr.capturedAt === lastQrAt) return;
        lastQrAt = snapshot.qr.capturedAt;
        imageBox.innerHTML = `<img src="${snapshot.qr.dataUrl}" alt="登录二维码" style="width:100%;height:100%;object-fit:contain;border-radius:10px">`;
        imageBox.classList.remove('refreshing');
      };

      const handle = async (snapshot) => {
        if (snapshot.status === 'success') {
          finished = true;
          stop();
          statusBox.innerHTML = '<span style="color:var(--green)">✓ 登录成功</span>';
          updateButtons(snapshot);
          toast(snapshot.message || '登录成功', 'success');
          setTimeout(async () => {
            dialog.close();
            await load();
          }, 900);
          return;
        }
        if (snapshot.status === 'failed' || snapshot.status === 'cancelled') {
          finished = true;
          stop();
          statusBox.innerHTML = `<span style="color:var(--red)">${esc(snapshot.message || '登录失败')}</span>`;
          imageBox.classList.remove('refreshing');
          extraBox.innerHTML = `<div class="row" style="justify-content:center;margin-top:8px"><button class="btn small" data-act="retry">重新生成二维码</button></div>`;
          extraBox.querySelector('[data-act="retry"]')?.addEventListener('click', () => start());
          updateButtons(snapshot);
          return;
        }
        const busyStatus = snapshot.status === 'refreshing' || snapshot.status === 'opening-browser';
        if (busyStatus) imageBox.classList.add('refreshing');
        renderQr(snapshot);
        const icon = snapshot.status === 'scanned' ? '📱' : snapshot.status === 'choose-finder' ? '🧭' : null;
        if (busyStatus || !icon) {
          statusBox.innerHTML = `<span class="spinner"></span><span>${esc(snapshot.message || '')}</span>`;
        } else {
          statusBox.innerHTML = `<span>${icon}</span><span>${esc(snapshot.message || '')}</span>`;
        }
        const timing = [];
        if (snapshot.qrLatencyMs) timing.push(`二维码 ${snapshot.qrLatencyMs}ms`);
        if (snapshot.refreshLatencyMs) timing.push(`刷新 ${snapshot.refreshLatencyMs}ms`);
        const timingText = timing.length ? `<span class="small muted-2">（${timing.join(' · ')}）</span>` : '';
        statusBox.innerHTML += timingText;
        if (snapshot.logs?.length) {
          extraBox.innerHTML = `<details class="mt-8"><summary>查看登录日志（${snapshot.logs.length} 条）</summary>
            <div class="log-list mt-8">${snapshot.logs.slice(-12).map((line) => `<div class="log-line"><span>${esc(line)}</span></div>`).join('')}</div></details>`;
        }
        updateButtons(snapshot);
      };

      const poll = async () => {
        if (!attemptId || finished) return;
        try {
          const snapshot = await api.loginStatus(attemptId);
          await handle(snapshot);
        } catch (error) {
          statusBox.innerHTML = `<span style="color:var(--red)">${esc(error.message)}</span>`;
        }
      };

      const start = async () => {
        finished = false;
        lastQrAt = 0;
        refreshing = false;
        openingBrowser = false;
        imageBox.classList.remove('refreshing');
        imageBox.innerHTML = '<div class="col" style="align-items:center;gap:10px"><span class="spinner"></span><span class="small muted">正在启动无头浏览器…</span></div>';
        statusBox.innerHTML = '<span class="spinner"></span><span>正在后台打开登录页面并加载二维码…</span>';
        extraBox.innerHTML = '';
        updateButtons(null);
        try {
          // 扫码登录默认无头执行（不弹出浏览器窗口）；仅「浏览器扫码」兜底才显示浏览器
          const attempt = await api.startLogin(subjectId ? { subjectId, headless: true } : { headless: true });
          attemptId = attempt.attemptId;
          await handle(attempt);
          stop();
          state.loginPolling = setInterval(poll, 500);
        } catch (error) {
          finished = true;
          stop();
          statusBox.innerHTML = `<span style="color:var(--red)">${esc(error.message)}</span>`;
          updateButtons({ status: 'failed' });
        }
      };

      refreshBtn.addEventListener('click', async () => {
        if (!attemptId || refreshing) return;
        refreshing = true;
        updateButtons(null);
        statusBox.innerHTML = '<span class="spinner"></span><span>正在刷新二维码…</span>';
        imageBox.classList.add('refreshing');
        try {
          await api.refreshLoginQr(attemptId);
          toast('正在刷新二维码，请稍候', 'info');
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          setTimeout(() => {
            refreshing = false;
            updateButtons(null);
          }, 3500);
        }
      });
      browserBtn.addEventListener('click', async () => {
        if (!attemptId || openingBrowser) return;
        openingBrowser = true;
        updateButtons(null);
        statusBox.innerHTML = '<span class="spinner"></span><span>正在打开浏览器窗口…</span>';
        try {
          const snapshot = await api.openLoginBrowser(attemptId);
          await handle(snapshot);
          toast('已打开浏览器窗口，请用手机微信扫码（也可继续使用面板二维码）', 'success', 5000);
        } catch (error) {
          toast(`打开浏览器失败：${error.message}`, 'error', 6000);
        } finally {
          openingBrowser = false;
          updateButtons(null);
        }
      });
      cancelBtn.addEventListener('click', async () => {
        finished = true;
        stop();
        dialog.close();
        try { await api.cancelLogin(attemptId); } catch { /* ignore */ }
        await load();
      });
      dialog.overlay.addEventListener('click', (event) => {
        if (event.target.closest('[data-close]')) {
          finished = true;
          stop();
          api.cancelLogin(attemptId).catch(() => undefined);
        }
      });
      await start();
    }

    async function openEditModal(subject) {
      const tags = await store.loadTags(true);
      const dialog = modal({
        title: '编辑主体',
        body: `
          <div class="col">
            <label class="field"><span>显示名称（兜底：有视频号名称时优先显示视频号名称）</span><input type="text" data-name value="${esc(subject.name)}" maxlength="40"></label>
            <label class="field"><span>备注</span><input type="text" data-note value="${esc(subject.note)}" maxlength="120"></label>
            <div class="field"><span>标签</span><div class="chip-select" data-tags></div></div>
            <div class="kv small muted">
              <div class="k">微信昵称</div><div>${esc(subject.wechatNickname || '-')}</div>
              <div class="k">微信ID</div><div class="mono">${esc(subject.wechatId || '-')}</div>
              <div class="k">视频号</div><div>${esc(subject.finderNickname || '-')} <span class="mono muted-2">${esc(subject.finderUsername || '')}</span></div>
              <div class="k">识别方式</div><div>${esc(subject.identityType || '-')}</div>
            </div>
          </div>`,
        footer: '<button class="btn" data-close>取消</button><button class="btn primary" data-save>保存</button>',
      });
      const chip = chipSelector(dialog.body.querySelector('[data-tags]'), tags, subject.tags.map((tag) => tag.id));
      dialog.foot.querySelector('[data-save]').addEventListener('click', async () => {
        try {
          await api.updateSubject(subject.id, {
            name: dialog.body.querySelector('[data-name]').value.trim() || subject.name,
            note: dialog.body.querySelector('[data-note]').value.trim(),
            tagIds: chip.getSelected(),
          });
          dialog.close();
          toast('已保存', 'success');
          await load();
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    }

    async function removeSubject(subject) {
      const displayName = subject.displayName || subject.name;
      const ok = await confirmDialog({
        title: '删除主体',
        message: `确定删除主体「${displayName}」吗？\n\n删除后卡片会立即消失；执行记录保留。浏览器登录态目录会备份到 data/profiles/_deleted（不直接丢失）。`,
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
      // 先乐观移除卡片，避免接口/浏览器清理慢造成「点了没反应」的错觉
      const snapshotList = [...state.subjects];
      state.subjects = state.subjects.filter((item) => item.id !== subject.id);
      state.selected.delete(subject.id);
      render(state.tagsCache || []);
      try {
        await api.deleteSubject(subject.id);
        toast('已删除主体（登录态目录已备份）', 'success');
        await load();
      } catch (error) {
        state.subjects = snapshotList;
        render(state.tagsCache || []);
        toast(`删除失败：${error.message}`, 'error', 6000);
      }
    }

    async function checkSubject(subject, button) {
      button.disabled = true;
      button.textContent = '检查中…';
      try {
        const result = await api.checkSubject(subject.id);
        toast(result.active ? '会话有效' : `会话不可用：${result.reason || ''}`, result.active ? 'success' : 'warn');
        await load();
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false;
        button.textContent = '检查会话';
      }
    }

    async function checkAll() {
      const ok = await confirmDialog({
        title: '检查全部会话',
        message: `将依次为 ${state.subjects.length} 个主体打开浏览器检查登录态，可能需要较长时间，是否继续？`,
        okText: '开始检查',
      });
      if (!ok) return;
      toast('开始逐个检查会话…', 'info');
      for (const subject of state.subjects) {
        try {
          await api.checkSubject(subject.id);
        } catch { /* 单个失败继续 */ }
        await load();
      }
      toast('全部检查完成', 'success');
    }

    async function openBrowser(subject, button) {
      button.disabled = true;
      button.textContent = '打开中…';
      try {
        const result = await api.openSubjectBrowser(subject.id);
        toast(`已打开浏览器：${result.url}`, 'success', 5000);
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        button.disabled = false;
        button.textContent = '打开浏览器';
      }
    }

    async function probePage(subject, button) {
      const mode = await new Promise((resolve) => {
        const dialog = modal({
          title: `页面探测：${subject.name}`,
          body: `
            <div class="col">
              <div class="item-card">
                <div><b>快速探测</b></div>
                <div class="small muted-2">只打开发表动态页，检查页面是否正常、表单字段与选择器命中情况（约 10 秒）</div>
                <div><button class="btn small primary" data-mode="quick">快速探测</button></div>
              </div>
              <div class="item-card">
                <div><b>深度探测（推荐）</b></div>
                <div class="small muted-2">自动上传一个内置测试视频（约 2.5MB），验证「上传检测 → 视频描述输入框 → 描述写入」完整链路，不会保存草稿或发表（约 30-60 秒）</div>
                <div><button class="btn small" data-mode="deep">深度探测</button></div>
              </div>
            </div>`,
          footer: '<button class="btn" data-close>取消</button>',
          onClose: () => resolve(null),
        });
        dialog.body.querySelector('[data-mode="quick"]').addEventListener('click', () => { dialog.close(); resolve('quick'); });
        dialog.body.querySelector('[data-mode="deep"]').addEventListener('click', () => { dialog.close(); resolve('deep'); });
      });
      if (!mode) return;
      button.disabled = true;
      button.textContent = mode === 'deep' ? '深度探测中…' : '探测中…';
      try {
        if (mode === 'deep') {
          const result = await api.probeDeep(subject.id, {});
          const findings = result.findings || {};
          const shots = (result.screenshotUrls || []).filter(Boolean);
          modal({
            title: result.ok ? '深度探测：通过 ✅' : '深度探测：未通过 ❌',
            xwide: true,
            body: `
              <div class="row" style="gap:8px;flex-wrap:wrap">
                <span class="badge ${result.ready ? 'green' : 'red'}">页面就绪：${result.ready ? '是' : '否'}</span>
                <span class="badge ${findings.uploadCompleted ? 'green' : 'red'}">上传检测：${findings.uploadCompleted ? '通过' : '失败'}</span>
                <span class="badge ${findings.editorFound ? 'green' : 'red'}">描述输入框：${findings.editorFound ? '识别成功' : '未识别'}</span>
                <span class="badge ${findings.descriptionWritable ? 'green' : 'red'}">描述写入：${findings.descriptionWritable ? '成功' : '失败'}</span>
              </div>
              ${result.error ? `<div class="mt-16 small" style="color:var(--red)">${esc(result.error)}</div>` : ''}
              <div class="kv mt-16">
                <div class="k">描述编辑器</div><div class="mono small">${esc(findings.editor ? `${findings.editor.tag}.${findings.editor.className}（占位：${findings.editor.placeholder || '-'}）` : '-')}</div>
                <div class="k">命中选择器</div><div class="mono small">${esc(findings.editorSelectorMatched ? `${findings.editorSelectorMatched.selector} × ${findings.editorSelectorMatched.count}` : '-')}</div>
                <div class="k">上传耗时</div><div>${findings.uploadDurationMs ? `${(findings.uploadDurationMs / 1000).toFixed(1)} 秒` : '-'}</div>
                <div class="k">表单字段</div><div class="small">${esc((findings.formLabels || []).join('、') || '-')}</div>
                <div class="k">短标题输入</div><div>${findings.shortTitleInput ? '可用' : '未找到'}</div>
              </div>
              ${shots.length ? `<div class="grid cols-2 mt-16">${shots.map((url) => `<a href="${esc(url)}" target="_blank"><img src="${esc(url)}" style="width:100%;border-radius:8px;border:1px solid var(--border)"></a>`).join('')}</div>` : ''}
              <details class="mt-16"><summary>探测步骤（${(result.steps || []).length} 条）</summary><div class="log-list mt-8">${(result.steps || []).map((line) => `<div class="log-line"><span>${esc(line)}</span></div>`).join('')}</div></details>
              <details class="mt-8"><summary>上传状态采样与完整结果（JSON）</summary><pre class="mono small" style="white-space:pre-wrap;max-height:260px;overflow:auto">${esc(JSON.stringify({ uploadSamples: result.uploadSamples, findings: result.findings }, null, 2))}</pre></details>
            `,
            footer: '<button class="btn" data-close>关闭</button>',
          });
          return;
        }
        const report = await api.probe(subject.id);
        const screenshotName = report.screenshot ? report.screenshot.split(/[\\/]/).pop() : null;
        const dialog = modal({
          title: '发表动态页面探测结果',
          wide: true,
          body: `
            <div class="kv">
              <div class="k">页面就绪</div><div>${report.ready ? '是' : `否（${esc(report.error || '')}）`}</div>
              <div class="k">页面地址</div><div class="mono small">${esc(report.url)}</div>
              <div class="k">表单字段</div><div>${esc((report.matched.labels || []).join('、') || '未找到')}</div>
              <div class="k">按钮文案</div><div class="small muted">${esc((report.matched.buttons || []).filter(Boolean).slice(0, 30).join(' / ') || '未找到')}</div>
              <div class="k">文件上传框</div><div>${report.matched.fileInputs || 0} 个</div>
              <div class="k">富文本编辑器</div><div>${report.matched.contentEditables || 0} 个</div>
            </div>
            ${screenshotName ? `<div class="mt-16"><a href="/files/screenshots/${encodeURIComponent(screenshotName)}" target="_blank"><img src="/files/screenshots/${encodeURIComponent(screenshotName)}" style="width:100%;border-radius:10px;border:1px solid var(--border)"></a></div>` : ''}
            <details class="mt-16"><summary>选择器命中详情（JSON）</summary><pre class="mono small" style="white-space:pre-wrap;max-height:260px;overflow:auto">${esc(JSON.stringify(report.matched, null, 2))}</pre></details>
            <details class="mt-8"><summary>页面文本（前 2000 字，用于排查改版）</summary><pre class="mono small" style="white-space:pre-wrap;max-height:220px;overflow:auto">${esc((report.bodyText || '').slice(0, 2000))}</pre></details>
          `,
          footer: '<button class="btn" data-close>关闭</button>',
        });
        return dialog;
      } catch (error) {
        toast(error.message, 'error', 6000);
      } finally {
        button.disabled = false;
        button.textContent = '页面探测';
      }
    }

    await load();
    return () => {
      if (state.loginPolling) clearInterval(state.loginPolling);
    };
  },
};
