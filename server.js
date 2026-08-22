import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { config } from './src/config.js';
import { processUrl } from './src/pipeline.js';
import { closeBrowser } from './src/webToImages.js';
import { createProvider } from './src/ai/index.js';
import { syncWechatPic, syncArticleFromMarkdown } from './src/wechat.js';
import { plainFromMarkdown } from './src/markdown.js';
import { fetchArxivMeta } from './src/arxiv.js';
import { fetchArxivHtml } from './src/arxivHtml.js';
import { extractInstitution, parseIsoDate } from './src/meta.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

/** 把正文里的「（图N）」引用处替换成图片 Markdown（按段落插入，位置由模型的相关性决定）。 */
function injectFigures(markdown, figures) {
  if (!figures || !figures.length) return markdown;
  const blocks = String(markdown || '').split(/\n\n+/);
  const images = blocks.map(() => []);

  figures.forEach((f, i) => {
    const n = i + 1;
    const re = new RegExp(`图\\s*${n}(?![0-9])`);
    const bi = blocks.findIndex((b) => re.test(b));
    if (bi >= 0) {
      const caption = String(f.caption || `图 ${n}`).replace(/[\[\]]/g, '');
      images[bi].push(`![${caption}](${f.url})`);
    }
  });

  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    out.push(blocks[i].trimEnd());
    for (const img of images[i]) out.push(img);
  }
  return out.join('\n\n');
}

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

// 论文深度解读：读 arXiv HTML 版，图片以 CDN 嵌入，输出 Markdown 报告
app.post('/api/deepread', async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: '缺少 url 参数' });
  }
  try {
    const provider = createProvider(); // 提前校验模型配置
    const arxiv = await fetchArxivMeta(url);
    const html = await fetchArxivHtml(url);

    const source = {
      type: 'pdf',
      title: arxiv?.title || html.title || html.id,
      byline: arxiv?.authors || '',
      institution: extractInstitution(html.text),
      date: arxiv?.published ? parseIsoDate(arxiv.published) : '',
      url: url.trim(),
      text: html.text,
    };

    const { markdown } = await provider.deepRead({ source, figures: html.figures });

    // 把正文里的「（图N）」引用处替换成真正的图片（位置由模型按相关性定）
    const processedMarkdown = injectFigures(markdown, html.figures);

    // 代码链接（正文前段里抽取，找不到就省略 Code 行）
    const codeUrl = html.codeUrl || '';

    // 元信息代码块（Paper / arXiv / Code）
    const metaBlock =
      '```text\n' +
      [`Paper：${source.title}`, `arXiv：https://arxiv.org/abs/${html.id}`, codeUrl ? `Code：${codeUrl}` : '']
        .filter(Boolean)
        .join('\n') +
      '\n```';
    const fullMarkdown = `${metaBlock}\n\n${processedMarkdown}`;

    const id = crypto.randomUUID();
    const dir = path.join(config.outputDir, id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'deepread.md'), fullMarkdown, 'utf-8');

    res.json({
      id,
      title: source.title,
      byline: source.byline,
      institution: source.institution,
      date: source.date,
      arxivUrl: `https://arxiv.org/abs/${html.id}`,
      figures: html.figures,
      codeUrl,
      markdown: fullMarkdown,
      markdownUrl: `/files/${id}/deepread.md`,
    });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error('[deepread]', message);
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

// 已配置的公众号账号列表（不含密钥）
app.get('/api/wechat/accounts', (_req, res) => {
  res.json({
    accounts: config.wechatAccounts.map((a) => ({ index: a.index, name: a.name })),
  });
});

// 同步到公众号「贴图」（图文转图模式；多账号）
app.post('/api/sync/wechat', async (req, res) => {
  const { id, filenames, accountIndex } = req.body || {};
  if (!id) return res.status(400).json({ error: '缺少 id 参数' });
  const dir = path.join(config.outputDir, id);
  try {
    const meta = JSON.parse(await readFile(path.join(dir, 'result.json'), 'utf-8'));

    if (!config.wechatAccounts.length) {
      return res.json({
        ok: false,
        needCreds: true,
        message: '未配置公众号凭证（WECHAT_APP_ID / WECHAT_APP_SECRET）',
        imageCount: (meta.images || []).length,
      });
    }

    const account =
      config.wechatAccounts.find((a) => a.index === Number(accountIndex)) ||
      config.wechatAccounts[0];

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
      account,
      title: meta.title,
      content: plainFromMarkdown(meta.copy || ''),
      images,
    });
    res.json({ ok: true, account: account.name, type: 'pic', draft: result });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error('[sync/wechat]', message);
    res.status(500).json({ error: message });
  }
});

// 同步「深度解读」为公众号文章（多账号）
app.post('/api/sync/wechat-article', async (req, res) => {
  const { title, markdown, figures, sourceUrl, accountIndex } = req.body || {};
  if (!markdown) return res.status(400).json({ error: '缺少 markdown 内容' });
  try {
    if (!config.wechatAccounts.length) {
      return res.json({
        ok: false,
        needCreds: true,
        message: '未配置公众号凭证（WECHAT_APP_ID / WECHAT_APP_SECRET）',
      });
    }
    const account =
      config.wechatAccounts.find((a) => a.index === Number(accountIndex)) ||
      config.wechatAccounts[0];

    const result = await syncArticleFromMarkdown({
      account,
      title: title || '深度解读',
      markdown,
      figures: Array.isArray(figures) ? figures : [],
      sourceUrl: sourceUrl || '',
    });
    res.json({ ok: true, account: account.name, type: 'article', draft: result });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error('[sync/wechat-article]', message);
    res.status(500).json({ error: message });
  }
});

const server = app.listen(config.port, () => {
  console.log(`\n  青稞解读 已启动 →  http://127.0.0.1:${config.port}\n`);
  console.log(`  文案引擎: ${config.llmProvider}（配置 .env 后切换真实模型）\n`);
});

async function shutdown() {
  await closeBrowser();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
