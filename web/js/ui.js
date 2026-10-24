export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function fmtDate(value, withSeconds = false) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const pad = (n) => String(n).padStart(2, '0');
  const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return withSeconds ? `${base}:${pad(date.getSeconds())}` : base;
}

export function timeAgo(value) {
  if (!value) return '';
  const diff = Date.now() - new Date(value).getTime();
  if (Number.isNaN(diff)) return '';
  const minute = 60_000;
  if (diff < minute) return '刚刚';
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
  return `${Math.floor(diff / (24 * 60 * minute))} 天前`;
}

export function fmtBytes(bytes) {
  const n = Number(bytes || 0);
  if (!n) return '-';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

export function fmtDuration(ms) {
  if (!ms && ms !== 0) return '-';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

export function toast(message, type = 'info', duration = 3000) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s, transform .2s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(10px)';
    setTimeout(() => el.remove(), 220);
  }, duration);
}

export function modal({ title, body, footer = '', wide = false, xwide = false, onClose = null, closeOnBackdrop = false }) {
  const root = document.getElementById('modal-root');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal ${xwide ? 'xwide' : wide ? 'wide' : ''}">
      <div class="modal-head">
        <div class="modal-title">${esc(title)}</div>
        <button class="modal-close" data-close>×</button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>`;
  root.appendChild(overlay);
  const close = () => {
    overlay.remove();
    onClose?.();
  };
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay && closeOnBackdrop) close();
    if (event.target.closest('[data-close]')) close();
  });
  return { overlay, el: overlay.querySelector('.modal'), body: overlay.querySelector('.modal-body'), foot: overlay.querySelector('.modal-foot'), close };
}

export function confirmDialog({ title = '确认操作', message = '', okText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    const dialog = modal({
      title,
      body: `<div style="white-space:pre-wrap;line-height:1.7">${esc(message)}</div>`,
      footer: `<button class="btn" data-cancel>${esc(cancelText)}</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(okText)}</button>`,
      onClose: () => resolve(false),
    });
    dialog.foot.querySelector('[data-ok]').addEventListener('click', () => { dialog.close(); resolve(true); });
    dialog.foot.querySelector('[data-cancel]').addEventListener('click', () => { dialog.close(); resolve(false); });
  });
}

export function badge(text, kind = 'gray') {
  return `<span class="badge ${kind}">${esc(text)}</span>`;
}

export const SUBJECT_STATUS = {
  active: { text: '在线', kind: 'green' },
  expired: { text: '已过期', kind: 'red' },
  failed: { text: '登录失败', kind: 'red' },
  pending: { text: '登录中', kind: 'yellow' },
  unknown: { text: '未检查', kind: 'gray' },
};

export const TASK_STATUS = {
  pending: { text: '待执行', kind: 'gray' },
  running: { text: '执行中', kind: 'blue' },
  success: { text: '成功', kind: 'green' },
  partial: { text: '部分成功', kind: 'yellow' },
  failed: { text: '失败', kind: 'red' },
  cancelled: { text: '已取消', kind: 'gray' },
};

export const ITEM_STATUS = {
  pending: { text: '待执行', kind: 'gray' },
  running: { text: '执行中', kind: 'blue' },
  success: { text: '成功', kind: 'green' },
  unknown: { text: '待确认', kind: 'yellow' },
  failed: { text: '失败', kind: 'red' },
  skipped: { text: '已跳过', kind: 'gray' },
  cancelled: { text: '已取消', kind: 'gray' },
};

export function statusBadge(status, map) {
  const item = map[status] || { text: status, kind: 'gray' };
  return badge(item.text, item.kind);
}

export function tagChips(tags = [], { max = 0 } = {}) {
  const list = max ? tags.slice(0, max) : tags;
  const more = max && tags.length > max ? `<span class="tag">+${tags.length - max}</span>` : '';
  return list.map((tag) => `<span class="tag"><span class="dot" style="background:${esc(tag.color || '#fa9d3b')}"></span>${esc(tag.name)}</span>`).join('') + more;
}

/** 独立标签筛选条（独占一行、水平排列，不与其它工具元素混排） */
export function tagBarHtml(tags = [], selectedIds = [], { label = '标签' } = {}) {
  const selected = new Set((selectedIds || []).map(Number));
  return `
    <div class="tag-bar">
      <div class="tag-bar-label">${esc(label)}</div>
      <div class="tag-bar-scroll">
        ${tags.length
          ? tags.map((tag) => `
            <span class="tag selectable ${selected.has(Number(tag.id)) ? 'on' : ''}" data-ftag="${Number(tag.id)}">
              <span class="dot" style="background:${esc(tag.color || '#fa9d3b')}"></span>${esc(tag.name)}
            </span>`).join('')
          : '<span class="small muted-2">暂无标签，可在「标签管理」中创建</span>'}
      </div>
      ${selected.size ? '<button class="btn small ghost" data-ftag-clear>清除筛选</button>' : ''}
    </div>`;
}

/** 绑定标签筛选条事件；onChange 收到当前选中的标签 id 数组 */
export function bindTagBar(root, tags, selectedIds, onChange) {
  const selected = new Set((selectedIds || []).map(Number));
  root.querySelectorAll('.tag-bar [data-ftag]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = Number(el.dataset.ftag);
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      onChange?.([...selected]);
    });
  });
  root.querySelector('.tag-bar [data-ftag-clear]')?.addEventListener('click', () => {
    selected.clear();
    onChange?.([]);
  });
}

/** 标签多选组件：渲染到容器，返回 { getSelected, setSelected } */
export function chipSelector(container, allTags, selectedIds = [], onChange = null) {
  const selected = new Set((selectedIds || []).map(Number));
  function render() {
    if (!allTags.length) {
      container.innerHTML = '<div class="empty-hint">暂无标签，可在「项目设置 → 标签」中创建</div>';
      return;
    }
    container.innerHTML = allTags.map((tag) => `
      <span class="tag selectable ${selected.has(Number(tag.id)) ? 'on' : ''}" data-tag="${Number(tag.id)}">
        <span class="dot" style="background:${esc(tag.color || '#fa9d3b')}"></span>${esc(tag.name)}
      </span>`).join('');
  }
  container.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-tag]');
    if (!chip) return;
    const id = Number(chip.dataset.tag);
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    render();
    onChange?.([...selected]);
  });
  render();
  return {
    getSelected: () => [...selected],
    setSelected: (ids) => {
      selected.clear();
      (ids || []).forEach((id) => selected.add(Number(id)));
      render();
    },
  };
}

export function debounce(fn, delay = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file, 'utf-8');
  });
}

export function spinner() {
  return '<span class="spinner"></span>';
}

export function emptyState(iconText, title, hint = '', action = '') {
  return `<div class="empty"><div class="empty-icon">${iconText}</div><div>${esc(title)}</div>${hint ? `<div class="small muted-2 mt-8">${esc(hint)}</div>` : ''}${action ? `<div>${action}</div>` : ''}</div>`;
}

export function icon(name) {
  const paths = {
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    subjects: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
    videos: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    texts: '<path d="M5 3h9l5 5v13H5z"/><path d="M14 3v5h5M8 13h8M8 17h5"/>',
    configs: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2" fill="currentColor"/><circle cx="15" cy="12" r="2" fill="currentColor"/><circle cx="7" cy="18" r="2" fill="currentColor"/>',
    tasks: '<path d="M4 5h16M4 12h16M4 19h10"/><circle cx="20" cy="19" r="2"/>',
    tags: '<path d="M20.6 13.4 12 22l-9-9V4a1 1 0 0 1 1-1h9z"/><circle cx="7.5" cy="7.5" r="1.5"/><path d="M13 10l7-7"/>',
    settings: '<circle cx="12" cy="12" r="3.2"/><path d="M19 12a7 7 0 0 0-.15-1.4l2-1.55-2-3.45-2.35.95a7 7 0 0 0-2.4-1.4L13.7 2h-3.4l-.4 2.55a7 7 0 0 0-2.4 1.4L5.15 5l-2 3.45 2 1.55A7 7 0 0 0 5 12c0 .48.05.94.15 1.4l-2 1.55 2 3.45 2.35-.95a7 7 0 0 0 2.4 1.4l.4 2.55h3.4l.4-2.55a7 7 0 0 0 2.4-1.4l2.35.95 2-3.45-2-1.55c.1-.46.15-.92.15-1.4z"/>',
  };
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ''}</svg>`;
}
