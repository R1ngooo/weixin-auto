import { api } from '../api.js';
import { store } from '../store.js';
import {
  bindTagBar, chipSelector, emptyState, esc, fmtBytes, fmtDate, modal, tagChips, tagBarHtml, toast,
} from '../ui.js';
import { batchBarHtml, openBatchTagModal } from './batch-tags.js';

export const videosPage = {
  async mount(ctx) {
    const VIEW_KEY = 'wxa.videos.view';
    const VIEWS = [
      { id: 'card', label: '卡片', icon: '▦' },
      { id: 'list', label: '列表', icon: '☰' },
      { id: 'folder', label: '文件夹', icon: '📁' },
    ];
    const savedView = localStorage.getItem(VIEW_KEY);
    const state = {
      tagIds: [],
      query: '',
      uploaded: '',
      sort: 'newest',
      page: 1,
      pageSize: 20,
      pageSizeOptions: [20, 40, 60, 80, 100, 120],
      view: VIEWS.some((item) => item.id === savedView) ? savedView : 'card',
      data: [],
      total: 0,
      tagsCache: [],
      batchMode: false,
      selected: new Set(),
      collapsedFolders: new Set(),
      hover: null,
      hoveredVideoId: null,
      quicklook: null,
    };

    const actionsEl = ctx.setActions(`
      <button class="btn" data-act="batch">批量编辑</button>
      <button class="btn" data-act="folders">文件夹管理</button>
      <button class="btn" data-act="thumbs">生成封面</button>
      <button class="btn primary" data-act="scan">扫描视频</button>
    `);
    actionsEl.querySelector('[data-act="batch"]').addEventListener('click', () => {
      state.batchMode = !state.batchMode;
      state.selected.clear();
      actionsEl.querySelector('[data-act="batch"]').textContent = state.batchMode ? '退出批量' : '批量编辑';
      render(state.tagsCache);
    });
    actionsEl.querySelector('[data-act="folders"]').addEventListener('click', () => openFoldersModal().then(load));
    actionsEl.querySelector('[data-act="thumbs"]').addEventListener('click', () => generateThumbnails());
    actionsEl.querySelector('[data-act="scan"]').addEventListener('click', () => runJob(() => api.scanVideos(), '扫描视频文件夹'));

    async function load() {
      const tags = await store.loadTags(true);
      state.tagsCache = tags;
      const result = await api.videos({
        tagIds: state.tagIds,
        q: state.query,
        uploaded: state.uploaded,
        sort: state.sort,
        page: state.page,
        pageSize: state.pageSize,
      });
      state.data = result.data;
      state.total = result.total;
      render(tags);
    }

    function render(tags) {
      state.tagsCache = tags;
      const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
      const totalOnPage = state.data.length;
      const hint = state.view === 'list'
        ? '点击行预览 · 打标签/移除请使用右上角「批量编辑」'
        : state.view === 'folder'
          ? '按本地文件夹分组显示 · 点击分组标题可展开/收起 · 悬浮卡片可预览'
          : '悬浮卡片整卡播放预览，按 <b>空格</b> 快速预览（QuickLook 风格）';
      ctx.root.innerHTML = `
        <div class="toolbar">
          <input type="search" placeholder="搜索视频名称 / MD5 / 路径 / 标签" value="${esc(state.query)}" data-search>
          <select data-uploaded>
            <option value="" ${state.uploaded === '' ? 'selected' : ''}>全部上传状态</option>
            <option value="no" ${state.uploaded === 'no' ? 'selected' : ''}>未上传</option>
            <option value="yes" ${state.uploaded === 'yes' ? 'selected' : ''}>已上传</option>
          </select>
          <select data-sort>
            <option value="newest" ${state.sort === 'newest' ? 'selected' : ''}>按更新时间</option>
            <option value="name" ${state.sort === 'name' ? 'selected' : ''}>按名称</option>
            <option value="size" ${state.sort === 'size' ? 'selected' : ''}>按大小</option>
          </select>
          <select data-pagesize title="每页显示数量">
            ${state.pageSizeOptions.map((size) => `<option value="${size}" ${state.pageSize === size ? 'selected' : ''}>${size} 条/页</option>`).join('')}
          </select>
          <div class="view-switch" role="group" aria-label="显示模式">
            ${VIEWS.map((view) => `<button class="view-switch-item ${state.view === view.id ? 'active' : ''}" data-view="${view.id}" title="${view.label}模式"><span class="view-icon">${view.icon}</span>${view.label}</button>`).join('')}
          </div>
          <div class="spacer"></div>
          <button class="btn small ghost" data-act="refresh">刷新</button>
        </div>
        ${tagBarHtml(tags, state.tagIds)}
        ${state.batchMode ? batchBarHtml({ selected: state.selected.size, total: totalOnPage, showRemove: true }) : ''}
        ${totalOnPage ? renderView() : emptyState('🎞️', '视频池还是空的', '点击右上角「扫描视频」添加本地视频文件夹并入库', '<button class="btn primary" data-act="scan-empty">扫描视频文件夹</button>')}
        <div class="row between mt-16">
          <div class="small muted-2">共 ${state.total} 个视频 · 第 ${state.page}/${pages} 页 · ${hint}</div>
          <div class="row">
            <button class="btn small" data-act="prev" ${state.page <= 1 ? 'disabled' : ''}>上一页</button>
            <button class="btn small" data-act="next" ${state.page >= pages ? 'disabled' : ''}>下一页</button>
          </div>
        </div>
      `;
      bind(tags);
    }

    function renderView() {
      if (state.view === 'list') return renderListMode();
      if (state.view === 'folder') return renderFolderMode();
      return `<div class="video-grid">${state.data.map(videoCard).join('')}</div>`;
    }

    /** 列表显示模式：无卡片，仅文字信息 */
    function renderListMode() {
      const allChecked = state.data.length > 0 && state.data.every((video) => state.selected.has(String(video.id)));
      return `
        <div class="table-wrap video-list-wrap">
          <table class="table video-list">
            <thead><tr>
              ${state.batchMode ? `<th style="width:36px"><input type="checkbox" data-select-all ${allChecked ? 'checked' : ''}></th>` : ''}
              <th style="width:56px">封面</th>
              <th>文件名</th>
              <th style="width:84px">大小</th>
              <th style="width:210px">MD5</th>
              <th style="width:180px">标签</th>
              <th style="width:90px">上传</th>
              <th style="width:120px">更新时间</th>
              <th style="width:120px">本地路径</th>
            </tr></thead>
            <tbody>
              ${state.data.map((video) => {
                const checked = state.selected.has(String(video.id));
                return `
                <tr class="video-row ${checked ? 'selected' : ''} ${video.missing ? 'is-missing' : ''}" data-video="${video.id}" data-missing="${video.missing ? 1 : 0}">
                  ${state.batchMode ? `<td><input type="checkbox" data-select="${video.id}" ${checked ? 'checked' : ''}></td>` : ''}
                  <td>
                    <div class="list-thumb">
                      ${!video.missing && video.hasThumbnail
                        ? `<img src="${esc(video.thumbnailUrl)}" alt="" loading="lazy">`
                        : '<span class="list-thumb-fallback">🎬</span>'}
                    </div>
                  </td>
                  <td>
                    <div class="list-name truncate" title="${esc(video.name)}">${esc(video.name)}</div>
                    ${video.uploadCount ? `<span class="badge green">已上传${video.uploadCount > 1 ? `×${video.uploadCount}` : ''}</span>` : ''}
                    ${video.missing ? '<span class="badge red">文件丢失</span>' : ''}
                  </td>
                  <td class="small muted">${fmtBytes(video.size)}</td>
                  <td class="mono small muted truncate" title="${esc(video.md5)}">${esc(video.md5 ? `${video.md5.slice(0, 16)}…` : '-')}</td>
                  <td>${video.tags.length ? tagChips(video.tags, { max: 3 }) : '<span class="muted-2 small">未打标签</span>'}</td>
                  <td class="small muted">${video.uploadCount ? `${video.uploadCount} 次` : '-'}</td>
                  <td class="small muted-2">${esc(fmtDate(video.updatedAt))}</td>
                  <td class="small muted-2 truncate" title="${esc(video.folder || '')}">${esc(video.folder || '-')}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>`;
    }

    /** 文件夹显示模式：按本地文件夹路径分组 */
    function renderFolderMode() {
      const groups = new Map();
      for (const video of state.data) {
        const key = video.folder || '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(video);
      }
      return [...groups.entries()].map(([folder, videos]) => {
        const collapsed = state.collapsedFolders.has(folder);
        return `
          <section class="folder-group ${collapsed ? 'collapsed' : ''}" data-folder-group="${esc(folder)}">
            <header class="folder-group-head" data-folder-toggle="${esc(folder)}" title="点击展开/收起">
              <span class="folder-arrow">${collapsed ? '▶' : '▼'}</span>
              <span class="folder-path" title="${esc(folder || '未归类')}">📁 ${esc(folder || '未归类')}</span>
              <span class="badge gray">${videos.length} 个视频</span>
            </header>
            ${collapsed ? '' : `<div class="video-grid folder-video-grid">${videos.map(videoCard).join('')}</div>`}
          </section>`;
      }).join('');
    }

    function videoCard(video) {
      const checked = state.selected.has(String(video.id));
      const thumbUrl = !video.missing && video.hasThumbnail ? video.thumbnailUrl : '';
      const uploaded = Number(video.uploadCount || 0) > 0;
      return `
        <div class="video-card ${checked ? 'selected' : ''} ${video.missing ? 'is-missing' : ''}" data-video="${video.id}" data-missing="${video.missing ? 1 : 0}">
          <div class="video-media">
            <div class="video-thumb ${thumbUrl ? 'has-thumb' : 'no-thumb'}" data-video-id="${video.id}" data-missing="${video.missing ? 1 : 0}">
              ${thumbUrl
                ? `<img class="thumb-img" src="${esc(thumbUrl)}" alt="${esc(video.name)}" loading="lazy"
                     onerror="this.style.display='none'; this.parentElement.classList.remove('has-thumb'); this.parentElement.classList.add('no-thumb')">`
                : ''}
              <span class="thumb-fallback">🎬</span>
              ${video.missing ? '' : '<span class="thumb-play">▶</span>'}
              ${!video.missing && !video.hasThumbnail ? '<span class="thumb-pending">暂无封面</span>' : ''}
            </div>
            ${uploaded ? `<div class="ribbon ribbon-uploaded" title="已上传 ${video.uploadCount} 次"><span>已上传${video.uploadCount > 1 ? `×${video.uploadCount}` : ''}</span></div>` : ''}
            ${video.missing ? '<div class="ribbon ribbon-missing"><span>文件丢失</span></div>' : ''}
            ${state.batchMode ? `<label class="select-box check" title="选择"><input type="checkbox" data-select="${video.id}" ${checked ? 'checked' : ''}></label>` : ''}
          </div>
          <div class="video-info">
            <div class="video-name" title="${esc(video.path)}">${esc(video.name)}</div>
            <div class="video-meta">
              <span>${fmtBytes(video.size)}</span>
              <span>${esc(fmtDate(video.updatedAt))}</span>
            </div>
            <div class="video-tags">${video.tags.length ? tagChips(video.tags, { max: 3 }) : '<span class="muted-2">未打标签</span>'}</div>
          </div>
        </div>`;
    }

    function bind(tags) {
      bindTagBar(ctx.root, tags, state.tagIds, (ids) => {
        state.tagIds = ids;
        state.page = 1;
        load();
      });
      // 显示模式切换（记忆到 localStorage）
      ctx.root.querySelectorAll('[data-view]').forEach((button) => {
        button.addEventListener('click', () => {
          if (state.view === button.dataset.view) return;
          state.view = button.dataset.view;
          localStorage.setItem(VIEW_KEY, state.view);
          render(state.tagsCache);
        });
      });
      // 文件夹模式：展开/收起
      ctx.root.querySelectorAll('[data-folder-toggle]').forEach((header) => {
        header.addEventListener('click', () => {
          const key = header.dataset.folderToggle;
          if (state.collapsedFolders.has(key)) state.collapsedFolders.delete(key);
          else state.collapsedFolders.add(key);
          render(state.tagsCache);
        });
      });
      // 批量选择
      ctx.root.querySelector('[data-batch="all"]')?.addEventListener('click', () => {
        state.data.forEach((video) => state.selected.add(String(video.id)));
        render(tags);
      });
      ctx.root.querySelector('[data-batch="clear"]')?.addEventListener('click', () => {
        state.selected.clear();
        render(tags);
      });
      ctx.root.querySelector('[data-batch="apply"]')?.addEventListener('click', async () => {
        await openBatchTagModal({
          kind: 'video',
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
      ctx.root.querySelector('[data-select-all]')?.addEventListener('change', (event) => {
        state.data.forEach((video) => {
          const id = String(video.id);
          if (event.target.checked) state.selected.add(id);
          else state.selected.delete(id);
        });
        render(tags);
      });
      ctx.root.querySelectorAll('[data-select]').forEach((checkbox) => {
        checkbox.addEventListener('click', (event) => event.stopPropagation());
        checkbox.addEventListener('change', () => {
          const id = String(checkbox.dataset.select);
          if (checkbox.checked) state.selected.add(id);
          else state.selected.delete(id);
          render(tags);
        });
      });
      // 卡片/行点击：批量模式=选择；普通模式=打开预览
      const onItemClick = (element) => {
        element.addEventListener('click', (event) => {
          if (event.target.closest('button, a, input, label')) return;
          const id = String(element.dataset.video);
          if (state.batchMode) {
            if (state.selected.has(id)) state.selected.delete(id);
            else state.selected.add(id);
            render(tags);
            return;
          }
          const video = state.data.find((item) => String(item.id) === id);
          if (video) previewVideo(video);
        });
      };
      ctx.root.querySelectorAll('.video-card, .video-row').forEach(onItemClick);
      ctx.root.querySelector('[data-search]')?.addEventListener('input', (event) => {
        state.query = event.target.value.trim();
        state.page = 1;
        load();
      });
      ctx.root.querySelector('[data-uploaded]')?.addEventListener('change', (event) => {
        state.uploaded = event.target.value;
        state.page = 1;
        load();
      });
      ctx.root.querySelector('[data-sort]')?.addEventListener('change', (event) => {
        state.sort = event.target.value;
        load();
      });
      ctx.root.querySelector('[data-pagesize]')?.addEventListener('change', (event) => {
        state.pageSize = Number(event.target.value) || 20;
        state.page = 1;
        load();
      });
      ctx.root.querySelector('[data-batch="remove"]')?.addEventListener('click', () => openBatchRemoveModal());
      ctx.root.querySelector('[data-act="refresh"]')?.addEventListener('click', () => load().then(() => toast('已刷新', 'success')));
      ctx.root.querySelector('[data-act="scan-empty"]')?.addEventListener('click', () => runJob(() => api.scanVideos(), '扫描视频文件夹'));
      ctx.root.querySelector('[data-act="prev"]')?.addEventListener('click', () => { state.page -= 1; load(); });
      ctx.root.querySelector('[data-act="next"]')?.addEventListener('click', () => { state.page += 1; load(); });
      bindHoverPreview();
    }

    async function openBatchRemoveModal() {
      const ids = [...state.selected];
      if (!ids.length) return toast('请先选择要移除的视频', 'warn');
      const dialog = modal({
        title: `批量移除视频（已选 ${ids.length} 个）`,
        body: `
          <div class="col">
            <div>确定把选中的 <b>${ids.length}</b> 个视频从视频池移除吗？</div>
            <div class="help-text">
              仅从视频池中移除显示：<b>不会删除数据库记录</b>，标签、上传历史、使用次数等数据都会保留；
              之后重新扫描到这些视频（按 <b>MD5</b> 关联，文件名仅作参考）会自动恢复并沿用原有数据。
            </div>
            <label class="check"><input type="checkbox" data-delete-file> 同时删除本地视频文件（不可恢复，默认不勾选）</label>
          </div>`,
        footer: '<button class="btn" data-close>取消</button><button class="btn danger" data-confirm>确认移除</button>',
      });
      dialog.foot.querySelector('[data-confirm]').addEventListener('click', async () => {
        const deleteFile = dialog.body.querySelector('[data-delete-file]').checked;
        let ok = 0;
        let failed = 0;
        for (const id of ids) {
          try {
            await api.deleteVideo(Number(id), deleteFile);
            ok += 1;
          } catch {
            failed += 1;
          }
        }
        dialog.close();
        state.selected.clear();
        state.batchMode = false;
        const batchButton = actionsEl.querySelector('[data-act="batch"]');
        if (batchButton) batchButton.textContent = '批量编辑';
        toast(`已移除 ${ok} 个视频${failed ? `，失败 ${failed} 个` : ''}${deleteFile ? '（含删除本地文件）' : '（数据库记录与历史数据保留）'}`, failed ? 'warn' : 'success', 5000);
        await load();
      });
    }

    // ---------- 卡片悬浮预览：整张卡片播放（抖音式竖卡，带可拖动进度条） ----------
    function bindHoverPreview() {
      if (state.batchMode) return;
      ctx.root.querySelectorAll('.video-card').forEach((card) => {
        const video = state.data.find((item) => String(item.id) === card.dataset.video);
        if (!video || video.missing) return;
        card.addEventListener('mouseenter', () => {
          state.hoveredVideoId = String(video.id);
          startHoverPreview(card, video);
        });
        card.addEventListener('mouseleave', () => {
          if (state.hoveredVideoId === String(video.id)) state.hoveredVideoId = null;
          stopHoverPreview(card);
        });
      });
    }

    function formatClock(seconds) {
      const total = Math.max(0, Math.round(Number(seconds) || 0));
      const minutes = Math.floor(total / 60);
      const rest = total % 60;
      return `${minutes}:${String(rest).padStart(2, '0')}`;
    }

    function startHoverPreview(card, video) {
      stopHoverPreview();
      const timer = setTimeout(() => {
        if (state.hover?.card !== card) return;
        const el = document.createElement('video');
        el.className = 'thumb-video';
        el.muted = true;
        el.loop = true;
        el.playsInline = true;
        el.preload = 'metadata';
        el.src = api.videoFileUrl(video.id);

        // 进度条（仅在悬浮播放时出现，可点击/拖动跳转）
        const progress = document.createElement('div');
        progress.className = 'thumb-progress';
        progress.innerHTML = `
          <div class="thumb-progress-track"><span class="thumb-progress-fill"></span></div>
          <div class="thumb-progress-time">0:00 / 0:00</div>`;
        const track = progress.querySelector('.thumb-progress-track');
        const fill = progress.querySelector('.thumb-progress-fill');
        const timeLabel = progress.querySelector('.thumb-progress-time');
        let dragging = false;
        let wasPlaying = false;

        const updateProgress = () => {
          const duration = Number.isFinite(el.duration) ? el.duration : 0;
          const ratio = duration ? Math.min(1, Math.max(0, el.currentTime / duration)) : 0;
          fill.style.width = `${(ratio * 100).toFixed(2)}%`;
          timeLabel.textContent = `${formatClock(el.currentTime)} / ${formatClock(duration)}`;
        };
        const seekTo = (event) => {
          const rect = track.getBoundingClientRect();
          if (!rect.width) return;
          const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
          if (Number.isFinite(el.duration) && el.duration > 0) {
            try { el.currentTime = ratio * el.duration; } catch { /* ignore */ }
          }
          updateProgress();
        };
        const onPointerDown = (event) => {
          event.preventDefault();
          event.stopPropagation();
          dragging = true;
          wasPlaying = !el.paused;
          try { el.pause(); } catch { /* ignore */ }
          track.setPointerCapture?.(event.pointerId);
          seekTo(event);
        };
        const onPointerMove = (event) => {
          if (!dragging) return;
          event.preventDefault();
          event.stopPropagation();
          seekTo(event);
        };
        const onPointerUp = (event) => {
          if (!dragging) return;
          dragging = false;
          event.stopPropagation();
          try { track.releasePointerCapture?.(event.pointerId); } catch { /* ignore */ }
          if (wasPlaying) el.play().catch(() => undefined);
          updateProgress();
        };
        track.addEventListener('pointerdown', onPointerDown);
        track.addEventListener('pointermove', onPointerMove);
        track.addEventListener('pointerup', onPointerUp);
        track.addEventListener('pointercancel', onPointerUp);
        progress.addEventListener('click', (event) => event.stopPropagation());

        el.addEventListener('loadedmetadata', () => {
          try { el.currentTime = Math.min(2, (Number.isFinite(el.duration) ? el.duration : 4) * 0.12); } catch { /* ignore */ }
          updateProgress();
        });
        el.addEventListener('timeupdate', () => { if (!dragging) updateProgress(); });
        el.addEventListener('canplay', () => {
          el.play().then(() => card.classList.add('previewing')).catch(() => undefined);
          updateProgress();
        });
        el.addEventListener('error', () => {
          el.remove();
          progress.remove();
        });
        card.appendChild(el);
        card.appendChild(progress);
        state.hover = { ...state.hover, el, progress };
      }, 280);
      state.hover = { card, el: null, progress: null, timer };
    }

    function stopHoverPreview(card = null) {
      const hover = state.hover;
      if (!hover) return;
      if (card && hover.card !== card) return;
      clearTimeout(hover.timer);
      try { hover.el?.pause(); } catch { /* ignore */ }
      hover.el?.remove();
      hover.progress?.remove();
      hover.card?.classList.remove('previewing');
      state.hover = null;
    }

    function openQuickLook(video) {
      closeQuickLook();
      if (!video || video.missing) {
        toast('视频文件不存在，无法预览', 'warn');
        return;
      }
      const overlay = document.createElement('div');
      overlay.className = 'quicklook-overlay';
      overlay.innerHTML = `
        <div class="quicklook-head">
          <div class="quicklook-title">${esc(video.name)}</div>
          <div class="quicklook-meta">${fmtBytes(video.size)} · ${esc(fmtDate(video.updatedAt))}${video.md5 ? ` · MD5 ${esc(video.md5.slice(0, 12))}…` : ''}</div>
          <div class="spacer" style="flex:1"></div>
          <button class="quicklook-close" title="关闭（空格 / Esc）" data-close>×</button>
        </div>
        <video class="quicklook-video" controls autoplay playsinline src="${api.videoFileUrl(video.id)}"></video>
        <div class="quicklook-hint">空格 / Esc 关闭 · 点击背景关闭（QuickLook 风格预览）</div>`;
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay || event.target.closest('[data-close]')) closeQuickLook();
      });
      state.quicklook = overlay;
      overlay.querySelector('video')?.focus?.();
    }

    function closeQuickLook() {
      if (!state.quicklook) return;
      try { state.quicklook.querySelector('video')?.pause?.(); } catch { /* ignore */ }
      state.quicklook.remove();
      state.quicklook = null;
    }

    function onKeyDown(event) {
      if (event.key !== ' ' && event.code !== 'Space') {
        if (event.key === 'Escape' && state.quicklook) {
          event.preventDefault();
          closeQuickLook();
        }
        return;
      }
      const target = event.target;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (document.querySelector('.modal-overlay')) return;
      if (state.quicklook) {
        event.preventDefault();
        closeQuickLook();
        return;
      }
      if (!state.hoveredVideoId) return;
      const video = state.data.find((item) => String(item.id) === state.hoveredVideoId);
      if (!video) return;
      event.preventDefault();
      openQuickLook(video);
    }

    async function generateThumbnails() {
      try {
        toast('开始生成视频封面…', 'info');
        const job = await api.generateThumbnails({});
        await watchJob(job.id, '生成视频封面', () => load());
      } catch (error) {
        toast(error.message, 'error');
      }
    }

    function previewVideo(video) {
      modal({
        title: video.name,
        wide: true,
        body: `
          ${video.missing
            ? '<div class="empty">文件已丢失，无法预览</div>'
            : `<video class="preview" controls preload="metadata" src="${api.videoFileUrl(video.id)}"></video>`}
          <div class="kv mt-16">
            <div class="k">路径</div><div class="mono small" style="word-break:break-all">${esc(video.path)}</div>
            <div class="k">大小</div><div>${fmtBytes(video.size)}</div>
            <div class="k">MD5</div><div class="mono small">${esc(video.md5 || '后台计算中…')}</div>
            <div class="k">已上传</div><div>${video.uploadCount ? `${video.uploadCount} 次${video.lastUploadedAt ? `，最近 ${esc(fmtDate(video.lastUploadedAt))}` : ''}` : '未上传'}</div>
            <div class="k">标签</div><div class="filter-tags">${video.tags.length ? tagChips(video.tags) : '<span class="muted-2">未打标签</span>'}</div>
          </div>`,
        footer: '<button class="btn" data-close>关闭</button>',
      });
    }

    // ---------- 文件夹管理：系统选择框 + 导入标签 ----------
    async function openFoldersModal() {
      const [folders, tags] = await Promise.all([api.videoFolders(), store.loadTags(true)]);
      const dialog = modal({
        title: '视频文件夹管理',
        wide: true,
        body: `
          <div class="col">
            <div class="folder-form card soft">
              <div class="row">
                <input type="text" placeholder="本地文件夹绝对路径（点右侧按钮用系统文件管理器选择）" data-folder-input style="flex:1">
                <button class="btn" data-pick>选择文件夹…</button>
                <button class="btn ghost" data-browse>浏览本机…</button>
                <label class="check"><input type="checkbox" data-recursive checked> 包含子目录</label>
              </div>
              <div class="field mt-8"><span>导入标签：扫描该文件夹时自动给视频打上这些标签</span><div class="chip-select" data-folder-tags></div></div>
              <div class="row between mt-8">
                <span class="small muted-2">添加后点「立即扫描」入库；扫描会自动计算 MD5 与生成封面。</span>
                <button class="btn primary" data-add>添加文件夹</button>
              </div>
            </div>
            <div class="table-wrap" style="max-height:320px" data-folder-table>
              ${folderTableHtml(folders)}
            </div>
            <div class="small muted-2">标签数量：${tags.length} 个 · 文件夹标签会在每次扫描时自动应用到该文件夹下的视频</div>
          </div>`,
        footer: '<button class="btn" data-close>关闭</button><button class="btn primary" data-scan>立即扫描</button>',
      });
      const chip = chipSelector(dialog.body.querySelector('[data-folder-tags]'), tags, []);

      function refreshFolders(nextFolders) {
        dialog.body.querySelector('[data-folder-table]').innerHTML = folderTableHtml(nextFolders);
        bindRowActions();
      }
      function folderTableHtml(list) {
        return `<table class="table">
          <thead><tr><th>文件夹</th><th style="width:70px">递归</th><th style="width:200px">导入标签</th><th style="width:130px"></th></tr></thead>
          <tbody>
            ${list.length ? list.map((folder) => `
              <tr data-folder-row="${folder.id}">
                <td class="mono small" style="word-break:break-all">${esc(folder.path)}</td>
                <td>${folder.recursive ? '是' : '否'}</td>
                <td><div class="filter-tags">${folder.tags?.length ? tagChips(folder.tags) : '<span class="muted-2">无</span>'}</div></td>
                <td class="actions">
                  <button class="btn small ghost" data-folder-tags-edit="${folder.id}">编辑标签</button>
                  <button class="btn small danger" data-remove="${folder.id}">删除</button>
                </td>
              </tr>`).join('')
              : '<tr><td colspan="4" class="muted-2" style="padding:20px">还没有添加文件夹</td></tr>'}
          </tbody></table>`;
      }
      async function editFolderTags(folderId) {
        const list = await api.videoFolders();
        const folder = list.find((item) => Number(item.id) === Number(folderId));
        if (!folder) return;
        const tagDialog = modal({
          title: '文件夹导入标签',
          body: '<div class="chip-select" data-tags></div><div class="help-text">保存后，下次扫描会把这里的标签自动应用到该文件夹下的视频。</div>',
          footer: '<button class="btn" data-close>取消</button><button class="btn primary" data-save>保存</button>',
        });
        const tagsChip = chipSelector(tagDialog.body.querySelector('[data-tags]'), tags, folder.tagIds || []);
        tagDialog.foot.querySelector('[data-save]').addEventListener('click', async () => {
          try {
            const next = await api.updateVideoFolder(folderId, { tagIds: tagsChip.getSelected() });
            tagDialog.close();
            refreshFolders(next);
            toast('已保存文件夹标签', 'success');
          } catch (error) {
            toast(error.message, 'error');
          }
        });
      }
      function bindRowActions() {
        dialog.body.querySelectorAll('[data-remove]').forEach((button) => {
          button.addEventListener('click', async () => {
            try {
              const next = await api.deleteVideoFolder(button.dataset.remove);
              refreshFolders(next);
              toast('已删除文件夹', 'success');
            } catch (error) {
              toast(error.message, 'error');
            }
          });
        });
        dialog.body.querySelectorAll('[data-folder-tags-edit]').forEach((button) => {
          button.addEventListener('click', () => editFolderTags(button.dataset.folderTagsEdit));
        });
      }
      bindRowActions();

      dialog.body.querySelector('[data-pick]').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = '选择中…';
        try {
          const result = await api.pickFolder();
          if (result?.path) {
            dialog.body.querySelector('[data-folder-input]').value = result.path;
            toast('已选择文件夹', 'success');
          } else {
            toast('已取消选择', 'info');
          }
        } catch (error) {
          toast(error.message, 'error', 6000);
        } finally {
          button.disabled = false;
          button.textContent = '选择文件夹…';
        }
      });
      dialog.body.querySelector('[data-browse]').addEventListener('click', () => {
        const input = dialog.body.querySelector('[data-folder-input]');
        openDirBrowser({
          initialPath: input.value.trim(),
          onPick: (picked) => {
            input.value = picked;
            toast('已选择文件夹', 'success');
          },
        });
      });
      dialog.body.querySelector('[data-add]').addEventListener('click', async () => {
        const input = dialog.body.querySelector('[data-folder-input]');
        const folderPath = input.value.trim();
        if (!folderPath) return toast('请先选择或输入文件夹路径', 'warn');
        try {
          const next = await api.addVideoFolder({
            path: folderPath,
            recursive: dialog.body.querySelector('[data-recursive]').checked,
            tagIds: chip.getSelected(),
          });
          input.value = '';
          refreshFolders(next);
          toast('已添加文件夹（带导入标签），点「立即扫描」入库', 'success');
        } catch (error) {
          toast(error.message, 'error');
        }
      });
      dialog.foot.querySelector('[data-scan]').addEventListener('click', () => {
        dialog.close();
        runJob(() => api.scanVideos(), '扫描视频文件夹');
      });
    }

    // ---------- 面板内文件夹浏览（系统对话框无法前置时的兜底） ----------
    async function openDirBrowser({ initialPath = '', onPick } = {}) {
      const dialog = modal({
        title: '浏览本机文件夹',
        wide: true,
        body: '<div data-browser><div class="small muted-2">加载中…</div></div>',
        footer: '<button class="btn" data-close>取消</button><button class="btn primary" data-pick-current>选择当前文件夹</button>',
      });
      const body = dialog.body.querySelector('[data-browser]');
      const pickButton = dialog.foot.querySelector('[data-pick-current]');
      let current = initialPath;
      let parent = null;

      async function render() {
        body.innerHTML = '<div class="small muted-2">加载中…</div>';
        let data;
        try {
          data = await api.listDirs(current);
        } catch (error) {
          body.innerHTML = `<div class="small" style="color:var(--red)">${esc(error.message)}</div><div class="row mt-8"><button class="btn small ghost" data-back>返回磁盘列表</button></div>`;
          body.querySelector('[data-back]')?.addEventListener('click', () => { current = ''; render(); });
          pickButton.disabled = true;
          return;
        }
        current = data.path || '';
        parent = data.parent || null;
        const drives = data.drives || [];
        body.innerHTML = `
          <div class="row between mb-8">
            <div class="row">
              <button class="btn small ghost" data-up ${parent ? '' : 'disabled'}>↑ 上一级</button>
              <span class="mono small">${current ? esc(current) : '选择磁盘'}</span>
            </div>
            <button class="btn small ghost" data-refresh>刷新</button>
          </div>
          <div class="dir-list">
            ${!current
              ? drives.map((drive) => `<button class="dir-item" data-dir="${esc(drive.path)}">💽 ${esc(drive.name)}</button>`).join('')
              : data.entries.length
                ? data.entries.map((entry) => `<button class="dir-item" data-dir="${esc(entry.path)}">📁 ${esc(entry.name)}</button>`).join('')
                : '<div class="small muted-2">该文件夹下没有子文件夹</div>'}
          </div>`;
        body.querySelectorAll('[data-dir]').forEach((button) => {
          button.addEventListener('click', () => { current = button.dataset.dir; render(); });
        });
        body.querySelector('[data-up]')?.addEventListener('click', () => { current = parent || ''; render(); });
        body.querySelector('[data-refresh]')?.addEventListener('click', () => render());
        pickButton.disabled = !current;
      }

      pickButton.addEventListener('click', () => {
        if (!current) return;
        dialog.close();
        onPick?.(current);
      });
      await render();
    }

    async function runJob(startFn, title) {
      try {
        const job = await startFn();
        await watchJob(job.id, title, () => load());
      } catch (error) {
        toast(error.message, 'error');
      }
    }

    async function watchJob(jobId, title, onDone) {
      const dialog = modal({
        title,
        body: `
          <div class="col">
            <div class="progress-bar"><span data-bar style="width:0%"></span></div>
            <div class="small muted" data-msg>准备中…</div>
          </div>`,
        footer: '',
        closeOnBackdrop: false,
      });
      const bar = dialog.body.querySelector('[data-bar]');
      const msg = dialog.body.querySelector('[data-msg]');
      return new Promise((resolve) => {
        const timer = setInterval(async () => {
          try {
            const job = await api.job(jobId);
            const percent = Math.round((job.progress || 0) * 100);
            bar.style.width = `${percent}%`;
            msg.textContent = `${job.message || ''} ${job.total ? `（${percent}%）` : ''}`;
            if (job.status !== 'running') {
              clearInterval(timer);
              dialog.close();
              if (job.status === 'success') {
                toast(`${title}完成：${job.message}`, 'success');
              } else if (job.status === 'cancelled') {
                toast(`${title}已取消`, 'warn');
              } else {
                toast(`${title}失败：${job.error || ''}`, 'error', 6000);
              }
              await onDone?.();
              resolve(job);
            }
          } catch (error) {
            clearInterval(timer);
            dialog.close();
            toast(error.message, 'error');
            resolve(null);
          }
        }, 700);
      });
    }

    await load();
    document.addEventListener('keydown', onKeyDown);
    return () => {
      stopHoverPreview();
      closeQuickLook();
      document.removeEventListener('keydown', onKeyDown);
    };
  },
};
