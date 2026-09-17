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

  // 上传
  uploadMaxMb: Number(process.env.UPLOAD_MAX_MB || 100), // 上传文件大小上限（MB）

  // 抓取
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS || 30000),
  userAgent:
    process.env.USER_AGENT ||
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',

  // AI 文案
  llmProvider: process.env.LLM_PROVIDER || 'deepseek', // deepseek | openai | ollama
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
  llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS || 300000),

  // 文案约束
  maxCopyChars: Number(process.env.MAX_COPY_CHARS || 1000), // 解读文案字数上限
  maxTitleChars: Number(process.env.MAX_TITLE_CHARS || 20), // 标题字数上限
  qualityReview: process.env.QUALITY_REVIEW !== '0', // 生成后自检自修一遍（提升质量；嫌慢可设 0 关闭）

  // 深度解读：Ollama 等本地模型默认用「分段生成再合并」（每节一次调用，绕开单次长文超时/写不满问题）；
  // 设 DEEPREAD_MULTIPASS=0 可关闭、走单次整篇生成
  deepreadMultipass: process.env.DEEPREAD_MULTIPASS !== '0',
  // 结构化全文理解（切片 → 研究地图 → 检索 → 审计 → 定点修复）
  deepreadStructured: process.env.DEEPREAD_STRUCTURED !== '0', // 关掉就完全走旧流程
  deepreadChunkChars: Number(process.env.DEEPREAD_CHUNK_CHARS || 1600), // 单个 chunk 的字数上限
  deepreadEvidenceChars: Number(process.env.DEEPREAD_EVIDENCE_CHARS || 6000), // 每节检索注入的证据字数预算
  deepreadMaxChunks: Number(process.env.DEEPREAD_MAX_CHUNKS || 12), // 每节最多注入多少个 chunk
  deepreadMapChars: Number(process.env.DEEPREAD_MAP_CHARS || 22000), // 研究地图阶段的输入预算
  deepreadAudit: process.env.DEEPREAD_AUDIT !== '0', // 终稿证据审计
  deepreadRepair: process.env.DEEPREAD_REPAIR !== '0', // 审计不通过时定点修复（只重写问题小节）

  // ===== 论文视频播客 =====
  // TTS 配音：auto = 有 MINIMAX_API_KEY 用 MiniMax(speech-02-hd)，否则用 edge-tts（免费，需已安装）
  ttsEngine: String(process.env.TTS_ENGINE || 'auto').trim().toLowerCase(),
  ttsRate: process.env.TTS_RATE || '+8%', // 语速：+8% 稍快（默认）
  minimaxApiKey: process.env.MINIMAX_API_KEY || '',
  minimaxBaseUrl: String(process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1').replace(/\/+$/, ''),
  minimaxTtsModel: process.env.MINIMAX_TTS_MODEL || 'speech-02-hd',
  videoWidth: Number(process.env.VIDEO_WIDTH || 1920),
  videoHeight: Number(process.env.VIDEO_HEIGHT || 1080),
  videoFps: Number(process.env.VIDEO_FPS || 25),
  xfadeSeconds: Number(process.env.XFADE_SECONDS || 0.6),
  // 播客画面可用的论文页数上限（整页渲染，用于开场/无图场景/背景）
  podcastMaxPages: Number(process.env.PODCAST_MAX_PAGES || 12),
  // 时长控制：超过该秒数自动加速重录一版（脚本目标 900–1150 字 ≈ 3.5–4.5 分钟）
  podcastMaxSeconds: Number(process.env.PODCAST_MAX_SECONDS || 310),

  // 公众号封面（贴图/文章首图）：按此比例铺白底缩放居中，避免被微信裁切
  coverWidth: Number(process.env.COVER_WIDTH || 900),
  coverHeight: Number(process.env.COVER_HEIGHT || 383),

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
