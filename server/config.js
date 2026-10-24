import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.WXA_DATA_DIR
  ? path.resolve(process.env.WXA_DATA_DIR)
  : path.join(ROOT_DIR, 'data');

export const PATHS = {
  data: DATA_DIR,
  db: path.join(DATA_DIR, 'weixin-auto.sqlite'),
  profiles: path.join(DATA_DIR, 'profiles'),
  screenshots: path.join(DATA_DIR, 'screenshots'),
  thumbnails: path.join(DATA_DIR, 'thumbnails'),
  logs: path.join(DATA_DIR, 'logs'),
  backups: path.join(DATA_DIR, 'backups'),
  web: path.join(ROOT_DIR, 'web'),
};

export const DEFAULT_SETTINGS = {
  server: {
    port: Number(process.env.WXA_PORT || 3210),
    host: '127.0.0.1',
  },
  browser: {
    // 每个主体一个独立浏览器窗口（持久化用户目录），默认有头模式，方便扫码与排查
    headless: false,
    channel: '',              // 留空=Playwright 自带 chromium；可填 chrome / msedge 使用本机浏览器
    executablePath: '',       // 自定义浏览器路径，优先级最高
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    // 空闲多久自动关闭浏览器（分钟），0 表示不自动关闭
    idleCloseMinutes: 10,
    defaultTimeoutMs: 30000,
    navigationTimeoutMs: 60000,
    slowMoMs: 0,
  },
  timing: {
    // 兼容网络延迟：各操作之间的默认等待
    stepDelayMs: 1200,
    clickDelayMs: 400,
    typeDelayMs: 30,
    afterUploadSettleMs: 2500,
    uploadTimeoutMs: 600000,
    publishConfirmTimeoutMs: 60000,
    afterPublishDelayMs: 3000,
    actionRetries: 2,
  },
  publish: {
    // 发表成功后按提示文案/地址变化判定；未知时标记为 unknown 由人工确认
    verifySuccessTexts: ['发表成功', '发布成功', '已提交审核', '保存成功', '保存草稿成功', '已保存'],
    defaultAction: 'draft',
  },
  video: {
    folders: [],
    extensions: ['.mp4', '.mov', '.m4v', '.avi', '.wmv', '.flv', '.mkv', '.webm'],
    recursive: true,
    computeMd5OnScan: false,
  },
  wechat: {
    enabled: false,
    botId: '',
  },
  testing: {
    // 演练测试环境：开启后演练模式仍会消耗素材使用状态、写入使用次数，便于检查前端显示效果
    dryRunCountsUsage: false,
  },
  selectors: {},
};

export function resolveGlobalSettingsPath() {
  return path.join(DATA_DIR, 'settings.json');
}
