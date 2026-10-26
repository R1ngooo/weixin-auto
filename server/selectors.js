/**
 * 页面选择器集中配置。
 * 微信视频号助手前端会随版本调整，这里的默认值按「语义/文案优先 + 多候选回退」设计，
 * 并支持在「设置 → 高级 → 选择器覆盖」里用 JSON 覆盖任意字段（深度合并）。
 */

export const DEFAULT_SELECTORS = {
  login: {
    url: 'https://channels.weixin.qq.com/login.html',
    qrIframe: 'iframe[src*="open.weixin.qq.com/connect/qrconnect"]',
    qrImage: 'img.js_qrcode_img, img.web_qrcode_img, img[src*="connect/qrcode"]',
    qrContainer: '.qrcode, .web_qrcode, .qrcode_img, .login_qrcode',
    refresh: '.js_web_qrcode_reload',
    // 刷新按钮在 channels 登录主页（不在 qrconnect iframe 内），供快速刷新使用
    refreshPageSelectors: ['.js_web_qrcode_reload', '.js_qrcode_reload', '[class*="qrcode"] [class*="reload"]', 'text=刷新二维码'],
    quickLoginSwitchTexts: ['使用其他头像、昵称或账号', '使用其它头像、昵称或账号', '切换账号'],
    quickLoginAvatar: '.js_quick_login_avatar, .qlogin_user_avatar',
    expiredTexts: ['二维码已过期', '二维码失效', '二维码已失效', '二维码过期', '已过期'],
    scannedTexts: ['扫描成功', '请在手机上确认', '已扫描', '扫码成功'],
    loadingTexts: ['正在加载', '加载失败', '点击重试'],
    // 扫码后若该微信绑定了多个视频号，需要选择要登录的视频号
    finderArea: '.choose-finder-area, .finder-list',
    finderItem: '.finder-list .finder-item',
    finderNoAccountTexts: ['暂无视频号', '没有可登录的视频号', '未开通视频号', '还没有视频号'],
    finderAllBannedTexts: ['全部被停止使用', '账号已被停止使用'],
    finderUseOtherTexts: ['使用其他账号登录'],
  },
  platform: {
    postListUrl: 'https://channels.weixin.qq.com/platform/post/list',
    postCreateUrl: 'https://channels.weixin.qq.com/platform/post/create',
    homeUrl: 'https://channels.weixin.qq.com/platform',
    apiBase: '/cgi-bin/mmfinderassistant-bin',
    authDataPath: '/auth/auth_data',
    wxInfoPath: '/auth/auth_wx',
    loginUrlPattern: 'login.html',
    // 登录后左侧导航 / 顶栏上可能出现的账号信息
    accountNameSelectors: [
      '.finder-nickname',
      '.finder-account-name',
      '.account-name',
      '.finder-info .nickname',
      '.post-nav .nickname',
    ],
    accountAvatarSelectors: [
      '.finder-avatar img',
      '.finder-account-avatar img',
      '.avatar img',
    ],
    createButtonTexts: ['发表视频', '发表动态', '发表'],
  },
  publish: {
    // 打开发表动态页后，判定页面就绪
    readySelectors: [
      '.post-upload-wrap',
      '.upload-wrap',
      'input[type="file"]',
    ],
    readyTexts: ['视频描述', '添加描述', '上传时长', '封面预览'],
    pageInitializingTexts: ['页面初始化中'],
    // 上传控件（Ant Design Vue Upload，真实 input 是隐藏的）
    fileInputs: [
      'input[type="file"][accept*="video"]',
      'input[type="file"][accept*="mp4"]',
      '.post-upload-wrap input[type="file"]',
      'input[type="file"]',
    ],
    // 仅用「上传完成」才会出现的元素/文案判定，不能用媒体预览容器（上传中就已存在）
    uploadDoneSelectors: ['.media-opr'],
    uploadDoneTexts: ['封面预览', '更换封面', '修改封面'],
    uploadingTexts: ['取消上传', '上传中', '正在上传', '正在处理文件', '视频处理中', '封面生成中', '秒传'],
    uploadErrorTexts: ['网络出错，请重新上传', '上传失败', '秒传失败'],
    uploadProgressSelector: '.media-progress .upload-progress, .media-progress, [class*="upload-progress"]',
    uploadDeleteButtonTexts: ['删除', '删除视频', '移除视频'],
    uploadDeleteConfirmTexts: ['确定', '确认', '删除'],
    // 视频描述（wujie Shadow DOM 内是 div.input-editor[contenteditable][data-placeholder="添加描述"]）
    descFormItemLabel: '视频描述',
    descEditorSelectors: [
      '.form-item .input-editor',
      '.input-editor',
      '[data-placeholder*="添加描述"]',
      '[data-placeholder*="描述"]',
      '.form-item .ql-editor[contenteditable="true"]',
      '.ql-editor[contenteditable="true"]',
      '.post-desc-wrap [contenteditable="true"]',
      '.form-item[class*="desc"] [contenteditable="true"]',
      '[contenteditable="true"]',
      '[contenteditable]',
      'textarea[placeholder*="描述"]',
      'textarea',
    ],
    shortTitleInputSelectors: [
      'input[placeholder*="短标题"]',
      'input[placeholder*="填写标题"]',
      'input[placeholder*="标题"]',
      '.post-mp-title-wrap input',
    ],
    locationLabelText: '位置',
    locationDisplaySelectors: ['.position-display', '.post-position-wrap .position-display', '.form-item .position-display'],
    locationSearchInputSelectors: [
      'input[placeholder*="搜索附近位置"]',
      'input[placeholder*="搜索位置"]',
      'input[placeholder*="位置"]',
    ],
    locationOptionSelectors: [
      '.location-filter-wrap .option-item',
      '.common-option-list-wrap .option-item',
      '.option-item',
    ],
    locationHideTexts: ['不显示位置'],
    locationNoResultTexts: ['暂无可用位置'],
    locationRefreshTexts: ['重新定位'],
    collectionLabelText: '添加到合集',
    collectionTriggerTexts: ['选择合集'],
    collectionEmptyTexts: ['暂无合集', '还没有合集'],
    videoMarkLabelText: '视频标注',
    // 新版发表页把「原创声明」调整为「视频标注」下拉
    videoMarkLabelText: '视频标注',
    videoMarkTriggerTexts: ['选择视频标注'],
    videoMarkOptionSelectors: ['.mark-tag-option .option-main', '.mark-tag-option'],
    videoMarkOptions: ['无需标注', '含AI生成内容', '内容为虚构剧情，仅供娱乐', '个人观点，仅供参考', '内容包含营销广告', '内容为自行拍摄', '内容为转载'],
    scheduleLabelText: '定时发表',
    scheduleRadioTexts: ['定时', '不定时'],
    scheduleDatePlaceholder: '请选择发表时间',
    extLinkInputSelectors: [
      'input[placeholder*="链接"]',
      'textarea[placeholder*="链接"]',
      '.form-item [class*="ext-link"] input',
    ],
    // 新版发表页「链接」：选择链接 → 商品 → 选择需要添加的商品 → 商品选择弹窗
    linkFormItemSelector: '.form-item.post-with-link',
    linkDisplaySelector: '.link-display-wrap',
    linkOptionItemSelector: '.link-option-item',
    linkProductOptionText: '商品',
    linkProductTriggerText: '选择需要添加的商品',
    linkProductUnsupportedTexts: ['暂时无法使用该功能', '暂无权限', '无权限'],
    productDialogSelector: '.weui-desktop-dialog__wrp.half-dialog',
    productDialogTitleText: '从橱窗添加商品',
    productSearchInputSelectors: [
      'input[placeholder*="请输入商品名称/编码搜索"]',
      'input[placeholder*="商品名称/编码"]',
      'input.ignore_default_input',
      '.weui-desktop-dialog__bd input[type="text"]',
    ],
    productSearchButtonTexts: ['筛选', '搜索'],
    productAddButtonTexts: ['添加', '完成添加', '确定'],
    productEmptyTexts: ['暂无商品', '没有找到相关商品', '暂无数据'],
    topicQuickButtonTexts: ['#话题'],
    // 底部操作
    publishButtonTexts: ['发表', '发布', '立即发表'],
    publishConfirmTexts: ['确认发表', '确定发表', '确认', '继续发表'],
    draftButtonTexts: ['保存草稿', '存草稿', '保存至草稿箱', '保存到草稿箱'],
    successTexts: ['发表成功', '发布成功', '已提交审核', '提交成功', '保存成功', '保存草稿成功', '已保存'],
    errorTexts: ['发表失败', '发布失败', '保存失败', '操作失败'],
    // 页面提示（可能以 toast / top-tip 形式出现）
    toastSelector: '.weui-desktop-toast, .ant-message-notice-content, .top-tip, .common-top-tip, .mp-toast',
    submitDisabledReasons: ['文件上传中，请等待完成后再', '封面生成中，请等待完成后再', '视频处理中，请等待完成后再'],
  },
};

export function mergeSelectors(overrides) {
  return deepMergeSelectors(structuredClone(DEFAULT_SELECTORS), overrides || {});
}

function deepMergeSelectors(base, extra) {
  if (extra === null || extra === undefined) return base;
  if (Array.isArray(base) || Array.isArray(extra)) return extra;
  if (typeof base !== 'object' || typeof extra !== 'object') return extra;
  const out = { ...base };
  for (const key of Object.keys(extra)) out[key] = deepMergeSelectors(base[key], extra[key]);
  return out;
}

/** 多候选选择器依次尝试 */
export async function firstVisible(page, selectors, { timeout = 0 } = {}) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  const deadline = Date.now() + timeout;
  do {
    for (const selector of list) {
      try {
        const locator = page.locator(selector).first();
        if (await locator.count() > 0) {
          if (await locator.isVisible().catch(() => false)) return locator;
          if (!timeout) return locator;
        }
      } catch { /* try next */ }
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(Math.min(400, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  return null;
}

/** 按文案点击：支持精确/包含、常见容器标签 */
export async function clickByTexts(page, texts, options = {}) {
  const { exact = true, timeout = 8000, within = null, prefer = 'button,a,[role="button"],.ant-btn,.ant-radio-wrapper,.weui-btn' } = options;
  const scope = within || page;
  const deadline = Date.now() + timeout;
  for (const text of texts) {
    const candidates = [];
    // 先在常见可点击容器里找
    for (const tag of prefer.split(',').map((s) => s.trim())) {
      candidates.push(scope.locator(`${tag}:has-text(${JSON.stringify(text)})`));
    }
    candidates.push(scope.getByText(text, { exact }));
    for (const candidate of candidates) {
      const count = await candidate.count().catch(() => 0);
      for (let index = 0; index < Math.min(count, 6); index += 1) {
        const item = candidate.nth(index);
        try {
          if (!(await item.isVisible())) continue;
          const ownText = (await item.innerText({ timeout: 500 })).trim();
          if (exact && ownText !== text) continue;
          await item.click({ timeout: 5000 });
          return true;
        } catch { /* try next */ }
      }
    }
    if (Date.now() >= deadline) break;
  }
  return false;
}

/** 在给定 locator 附近查找某个文案的可见元素 */
export function textLocator(scope, text, exact = false) {
  return scope.getByText(text, { exact });
}
