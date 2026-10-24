import { api } from '../api.js';
import { store } from '../store.js';
import { chipSelector, modal, toast } from '../ui.js';

const KIND_LABELS = { subject: '主体', video: '视频', text: '文本' };

/**
 * 批量打标签弹窗：
 * @param {{kind:'subject'|'video'|'text', ids:string[]|number[], onApplied?:Function}} options
 */
export async function openBatchTagModal({ kind, ids, onApplied = null }) {
  const cleanIds = [...new Set((ids || []).map((id) => String(id)).filter(Boolean))];
  if (!cleanIds.length) {
    toast('请先选择要操作的对象', 'warn');
    return false;
  }
  let tags = [];
  try {
    tags = await store.loadTags(true);
  } catch (error) {
    toast(error.message, 'error');
    return false;
  }
  const dialog = modal({
    title: `批量打标签：已选 ${cleanIds.length} 个${KIND_LABELS[kind] || '对象'}`,
    body: `
      <div class="col">
        <div class="field"><span>操作方式</span>
          <div class="row">
            <label class="check"><input type="radio" name="batch-tag-mode" value="add" checked> 追加标签</label>
            <label class="check"><input type="radio" name="batch-tag-mode" value="set"> 覆盖原有标签</label>
            <label class="check"><input type="radio" name="batch-tag-mode" value="remove"> 移除所选标签</label>
          </div>
        </div>
        <div class="field"><span>选择标签</span><div class="chip-select" data-batch-tags></div></div>
        <div class="help-text">「追加」保留原有标签并加入所选标签；「覆盖」会先清空原有标签；「移除」只删除所选标签。</div>
      </div>`,
    footer: '<button class="btn" data-close>取消</button><button class="btn primary" data-apply>应用到所选</button>',
  });
  const chip = chipSelector(dialog.body.querySelector('[data-batch-tags]'), tags, []);
  dialog.foot.querySelector('[data-apply]').addEventListener('click', async () => {
    const mode = dialog.body.querySelector('input[name="batch-tag-mode"]:checked')?.value || 'add';
    const tagIds = chip.getSelected();
    if (mode !== 'set' && !tagIds.length) {
      toast('请选择要操作的标签', 'warn');
      return;
    }
    try {
      const result = await api.assignTags({ kind, ids: cleanIds, tagIds, mode });
      dialog.close();
      toast(`已更新 ${result.affected} 个${KIND_LABELS[kind] || '对象'}的标签`, 'success');
      await onApplied?.(result);
      return true;
    } catch (error) {
      toast(error.message, 'error', 5000);
      return false;
    }
  });
  return true;
}

/** 批量操作条 HTML（页面自行绑定按钮事件） */
export function batchBarHtml({ selected, total, applyText = '批量打标签', showRemove = false }) {
  return `
    <div class="batch-bar" data-batch-bar>
      <span class="count">已选 ${selected} / ${total}</span>
      <span class="small muted">进入批量模式后，点击卡片或勾选框选择</span>
      <span class="spacer" style="flex:1"></span>
      <button class="btn small ghost" data-batch="all">全选</button>
      <button class="btn small ghost" data-batch="clear" ${selected ? '' : 'disabled'}>清空</button>
      <button class="btn small primary" data-batch="apply" ${selected ? '' : 'disabled'}>${applyText}</button>
      ${showRemove ? `<button class="btn small danger" data-batch="remove" ${selected ? '' : 'disabled'}>移除所选</button>` : ''}
      <button class="btn small" data-batch="exit">退出批量</button>
    </div>`;
}
