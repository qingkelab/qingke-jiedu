import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

export const config = {
  root: ROOT,
  outputDir: process.env.OUTPUT_DIR || path.join(ROOT, 'output'),
  port: Number(process.env.PORT || 4780),

  // 渲染
  maxPdfPages: Number(process.env.MAX_PDF_PAGES || 30), // PDF 最多转图的页数
  pdfScale: Number(process.env.PDF_SCALE || 2), // PDF 渲染缩放（越大越清晰）
  webViewportWidth: Number(process.env.WEB_VIEWPORT_WIDTH || 1280),
  webDeviceScale: Number(process.env.WEB_DEVICE_SCALE || 2),
  webSegmentHeight: Number(process.env.WEB_SEGMENT_HEIGHT || 4000), // 长页面按此高度分段
  chromePath:
    process.env.CHROME_PATH ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',

  // 抓取
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS || 30000),
  userAgent:
    process.env.USER_AGENT ||
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',

  // AI 文案
  llmProvider: process.env.LLM_PROVIDER || 'deepseek', // deepseek | openai
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS || 60000),

  // 文案约束
  maxCopyChars: Number(process.env.MAX_COPY_CHARS || 1000), // 解读文案字数上限
  maxTitleChars: Number(process.env.MAX_TITLE_CHARS || 20), // 标题字数上限

  // 同步：微信公众号（新建图文草稿，需认证服务号凭证）
  wechatAppId: process.env.WECHAT_APP_ID || '',
  wechatAppSecret: process.env.WECHAT_APP_SECRET || '',
};
