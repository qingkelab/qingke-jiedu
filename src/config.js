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

  // 同步：微信公众号（支持多个账号，需认证服务号凭证）
  // 账号1：WECHAT_APP_ID / WECHAT_APP_SECRET / WECHAT_NAME
  // 账号2：WECHAT2_APP_ID / WECHAT2_APP_SECRET / WECHAT2_NAME（依此类推）
  wechatAccounts: buildWechatAccounts(),
};

function buildWechatAccounts() {
  const accounts = [];
  for (let i = 1; i <= 5; i++) {
    const suffix = i === 1 ? '' : String(i);
    const appId = process.env[`WECHAT${suffix}_APP_ID`] || '';
    const appSecret = process.env[`WECHAT${suffix}_APP_SECRET`] || '';
    const name = process.env[`WECHAT${suffix}_NAME`] || `公众号${i}`;
    const theme = process.env[`WECHAT${suffix}_THEME`] || 'orange'; // orange | blue
    if (appId && appSecret) accounts.push({ index: i - 1, name, appId, appSecret, theme });
  }
  return accounts;
}
