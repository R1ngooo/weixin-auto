import { api } from '../api.js';
import { store } from '../store.js';
import { badge, confirmDialog, esc, modal, toast } from '../ui.js';

/**
 * 微信机器人（执行结果同步）面板：
 * 用于执行记录页顶部，与任务执行结果直接关联。
 */
export async function renderWechatPanel(container) {
  if (!container) return;
  let status;
  try {
    status = await store.loadWechat(true);
  } catch (error) {
    container.innerHTML = `<div class="card"><div class="card-title">微信机器人（执行结果同步）</div><div class="small" style="color:var(--red)">${esc(error.message)}</div></div>`;
    return;
  }

  const dsh = status.dshIm || { available: false, accounts: [] };
  container.innerHTML = `
    <div class="card">
      <div class="row between">
        <div class="card-title" style="margin:0">微信机器人（执行结果同步） <span class="hint">任务完成后把执行结果推送到微信</span></div>
        <label class="check"><input type="checkbox" data-wechat-enabled ${status.enabled ? 'checked' : ''}> 启用结果同步</label>
      </div>
      <div class="row" style="margin:12px 0">
        <button class="btn small ghost" data-wx="test">发送测试消息</button>
        <button class="btn small ghost" data-wx="refresh">刷新连接上下文</button>
        <button class="btn small primary" data-wx="bind">扫码绑定新机器人</button>
        ${status.bots.length ? `<span class="small muted-2">当前使用：${esc((status.bots.find((bot) => bot.botId === status.botId) || status.bots[0]).accountId || '')}</span>` : ''}
      </div>
      <div class="grid cols-2">
        <div>
          <div class="small muted" style="margin-bottom:8px">已绑定机器人</div>
          ${status.bots.length ? status.bots.map((bot) => `
            <div class="item-card" style="margin-bottom:8px">
              <div class="row between">
                <div>
                  <div style="font-weight:600">${esc(bot.nickname || bot.accountId || bot.botId)}</div>
                  <div class="small muted-2 mono">${esc(bot.accountId || bot.botId)}</div>
                  <div class="small muted-2">来源：${bot.source === 'dsh-im' ? '本机 dsh-im 导入' : '扫码绑定'} · ${bot.hasContextToken ? '有会话上下文' : '缺少上下文（先在微信里给机器人发一条消息，再点「刷新连接上下文」）'}</div>
                </div>
                <div class="row">
                  ${status.botId === bot.botId ? badge('当前使用', 'green') : `<button class="btn small ghost" data-wx="active" data-bot="${esc(bot.botId)}">设为使用</button>`}
                  <button class="btn small danger" data-wx="remove" data-bot="${esc(bot.botId)}">移除</button>
                </div>
              </div>
            </div>`).join('') : '<div class="small muted-2">还没有绑定微信机器人</div>'}
        </div>
        <div>
          <div class="small muted" style="margin-bottom:8px">检测到本机 dsh-im 微信机器人</div>
          ${dsh.available ? (dsh.accounts.length ? dsh.accounts.map((account) => `
            <div class="item-card" style="margin-bottom:8px">
              <div class="row between">
                <div>
                  <div style="font-weight:600">${esc(account.deliveryName || '微信机器人')}</div>
                  <div class="small muted-2 mono">${esc(account.accountId)}</div>
                  <div class="small muted-2">${account.tokenFound ? '已读取登录凭据' : '缺少登录凭据'} · ${account.hasContextToken ? '包含会话上下文' : '无会话上下文'}</div>
                </div>
                <button class="btn small primary" data-wx="import" data-bot="${esc(account.botId)}" ${account.tokenFound ? '' : 'disabled'}>导入</button>
              </div>
            </div>`).join('') : '<div class="small muted-2">dsh-im 中没有微信机器人账号</div>')
            : `<div class="small muted-2">${esc(dsh.reason || '未检测到 dsh-im 配置')}</div>`}
          <div class="help-text">导入会复用 dsh-im 已绑定的机器人凭据与会话上下文；也可以扫码绑定独立机器人。</div>
        </div>
      </div>
    </div>`;

  const refresh = async () => {
    store.wechat = await api.wechatStatus();
    await renderWechatPanel(container);
  };

  container.querySelector('[data-wechat-enabled]').addEventListener('change', async (event) => {
    try {
      store.wechat = await api.wechatEnable(event.target.checked);
      toast(event.target.checked ? '已启用结果同步' : '已关闭结果同步', 'success');
      await refresh();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  container.querySelector('[data-wx="test"]').addEventListener('click', async () => {
    try {
      await api.wechatTest();
      toast('测试消息已发送，请查看微信', 'success');
    } catch (error) {
      toast(error.message, 'error', 6000);
    }
  });
  container.querySelector('[data-wx="refresh"]').addEventListener('click', async () => {
    try {
      const result = await api.wechatRefreshContext();
      toast(`已刷新：拉取到 ${result.messages} 条消息，捕获 ${result.captured} 个上下文`, 'success', 5000);
      await refresh();
    } catch (error) {
      toast(error.message, 'error', 6000);
    }
  });
  container.querySelector('[data-wx="bind"]').addEventListener('click', () => openBindModal(refresh));
  container.querySelectorAll('[data-wx="import"]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await api.wechatImport(button.dataset.bot);
        toast('已导入本机 dsh-im 微信机器人', 'success');
        await refresh();
      } catch (error) {
        toast(error.message, 'error', 6000);
      }
    });
  });
  container.querySelectorAll('[data-wx="active"]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await api.wechatEnable(true, button.dataset.bot);
        toast('已切换使用的机器人', 'success');
        await refresh();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });
  container.querySelectorAll('[data-wx="remove"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: '移除机器人', message: '确定移除该微信机器人绑定吗？', okText: '移除', danger: true });
      if (!ok) return;
      try {
        await api.wechatRemoveBot(button.dataset.bot);
        await refresh();
        toast('已移除', 'success');
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });
}

function openBindModal(onDone) {
  const dialog = modal({
    title: '扫码绑定微信机器人',
    body: `
      <div class="qr-box">
        <div id="bind-qr" style="width:220px;height:220px;display:grid;place-items:center;background:var(--bg-soft);border-radius:14px;border:1px solid var(--border)"><span class="spinner"></span></div>
        <div class="qr-status" id="bind-status"><span class="spinner"></span><span>正在申请二维码…</span></div>
        <div class="small muted-2" style="text-align:center;max-width:360px">使用手机微信扫码并确认，即可把执行结果发送到该微信的机器人会话。</div>
        <div id="bind-verify" style="display:none;width:100%;max-width:320px">
          <label class="field"><span>手机微信上显示的配对数字</span><input type="text" data-verify-code placeholder="4-8 位数字"></label>
          <button class="btn small primary block mt-8" data-verify>提交配对码</button>
        </div>
      </div>`,
    footer: '<button class="btn" data-close>取消</button>',
  });
  const qrBox = dialog.body.querySelector('#bind-qr');
  const statusBox = dialog.body.querySelector('#bind-status');
  const verifyBox = dialog.body.querySelector('#bind-verify');
  let attemptId = null;
  let timer = null;
  let done = false;
  const stop = () => { if (timer) clearInterval(timer); timer = null; };

  dialog.overlay.addEventListener('click', (event) => {
    if (event.target.closest('[data-close]')) { done = true; stop(); }
  });
  dialog.body.querySelector('[data-verify]').addEventListener('click', async () => {
    const code = dialog.body.querySelector('[data-verify-code]').value.trim();
    try {
      await api.wechatVerify(attemptId, code);
      verifyBox.style.display = 'none';
      statusBox.innerHTML = '<span class="spinner"></span><span>已提交配对码，等待确认…</span>';
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  const poll = async () => {
    if (!attemptId || done) return;
    try {
      const snapshot = await api.wechatBinding(attemptId);
      if (snapshot.status === 'success') {
        done = true;
        stop();
        statusBox.innerHTML = '<span style="color:var(--green)">✓ 绑定成功</span>';
        toast('微信机器人绑定成功', 'success');
        setTimeout(async () => {
          dialog.close();
          await onDone?.();
        }, 800);
        return;
      }
      if (['failed', 'expired', 'cancelled'].includes(snapshot.status)) {
        done = true;
        stop();
        statusBox.innerHTML = `<span style="color:var(--red)">${esc(snapshot.message || '绑定失败')}</span>`;
        return;
      }
      qrBox.innerHTML = `<img src="${snapshot.qrUrl}?t=${Date.now()}" style="width:100%;height:100%;object-fit:contain;border-radius:12px" alt="绑定二维码" onerror="this.style.display='none';this.insertAdjacentHTML('afterend','<div class=&quot;small muted-2&quot;>二维码加载失败，请点击下方按钮在新窗口打开</div>')">`;
      statusBox.innerHTML = `<span class="spinner"></span><span>${esc(snapshot.message || '等待扫码…')}</span>`;
      verifyBox.style.display = snapshot.verifyRequired ? 'block' : 'none';
      if (snapshot.qrPageUrl && !dialog.foot.querySelector('[data-qr-page]')) {
        dialog.foot.querySelector('[data-close]').insertAdjacentHTML('beforebegin',
          `<a class="btn small ghost" data-qr-page href="${esc(snapshot.qrPageUrl)}" target="_blank" rel="noreferrer">打开二维码页面</a>`);
      }
    } catch (error) {
      statusBox.innerHTML = `<span style="color:var(--red)">${esc(error.message)}</span>`;
    }
  };

  (async () => {
    try {
      const attempt = await api.wechatBind();
      attemptId = attempt.attemptId;
      await poll();
      timer = setInterval(poll, 1500);
    } catch (error) {
      statusBox.innerHTML = `<span style="color:var(--red)">${esc(error.message)}</span>`;
    }
  })();
}
