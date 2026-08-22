import express from 'express';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { config } from './src/config.js';
import { processUrl } from './src/pipeline.js';
import { closeBrowser } from './src/webToImages.js';
import { createProvider } from './src/ai/index.js';
import { syncWechatPic } from './src/wechat.js';
import { plainFromMarkdown } from './src/markdown.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

// 静态前端
app.use(express.static(path.join(config.root, 'public')));

// 生成的图片 / zip / md（图片内联预览，其余直接返回）
app.get('/files/:id/:filename', (req, res, next) => {
  const { id, filename } = req.params;
  const safe = path.basename(filename);
  const abs = path.join(config.outputDir, id, safe);
  if (safe.endsWith('.png')) res.type('png');
  else if (safe.endsWith('.md')) res.type('text/markdown; charset=utf-8');
  else if (safe.endsWith('.zip')) res.type('application/zip');
  res.sendFile(abs, (err) => err && next());
});

// 强制下载（Content-Disposition: attachment）
app.get('/download/:id/:filename', (req, res, next) => {
  const { id, filename } = req.params;
  const safe = path.basename(filename);
  res.download(path.join(config.outputDir, id, safe), safe, (err) => err && next());
});

// 主处理接口
app.post('/api/process', async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: '缺少 url 参数' });
  }
  try {
    const result = await processUrl(url.trim());
    res.json(result);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error('[process]', message);
    res.status(500).json({ error: message });
  }
});

app.get('/api/health', (_req, res) => {
  let provider;
  try {
    provider = createProvider().name;
  } catch {
    provider = '未配置';
  }
  res.json({ ok: true, provider });
});

// 同步到公众号图片素材库（贴图）：有凭证上传所选图片；无凭证返回降级信息
app.post('/api/sync/wechat', async (req, res) => {
  const { id, filenames } = req.body || {};
  if (!id) return res.status(400).json({ error: '缺少 id 参数' });
  const dir = path.join(config.outputDir, id);
  try {
    const meta = JSON.parse(await readFile(path.join(dir, 'result.json'), 'utf-8'));

    if (!config.wechatAppId || !config.wechatAppSecret) {
      return res.json({
        ok: false,
        needCreds: true,
        message: '未配置公众号凭证（WECHAT_APP_ID / WECHAT_APP_SECRET）',
        imageCount: (meta.images || []).length,
      });
    }

    // 仅上传选中的图片（只允许 result.json 里存在的文件名，防路径穿越）
    const wanted = Array.isArray(filenames) && filenames.length ? new Set(filenames) : null;
    const images = [];
    for (const img of meta.images || []) {
      if (wanted && !wanted.has(img.filename)) continue;
      images.push({
        filename: img.filename,
        label: img.label,
        buffer: await readFile(path.join(dir, img.filename)),
      });
    }
    if (!images.length) {
      return res.status(400).json({ error: '未选中任何图片' });
    }

    const result = await syncWechatPic({
      title: meta.title,
      content: plainFromMarkdown(meta.copy || ''),
      images,
    });
    res.json({ ok: true, draft: result });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error('[sync/wechat]', message);
    res.status(500).json({ error: message });
  }
});

const server = app.listen(config.port, () => {
  console.log(`\n  link2post 已启动 →  http://127.0.0.1:${config.port}\n`);
  console.log(`  文案引擎: ${config.llmProvider}（配置 .env 后切换真实模型）\n`);
});

async function shutdown() {
  await closeBrowser();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
