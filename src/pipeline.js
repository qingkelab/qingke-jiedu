import crypto from 'node:crypto';
import { config } from './config.js';
import { fetchSource } from './fetchSource.js';
import { extractWebpage } from './extractText.js';
import { pdfToImages, extractPdfInfo } from './pdfToImages.js';
import { webToImages } from './webToImages.js';
import { fetchArxivMeta } from './arxiv.js';
import { createProvider } from './ai/index.js';
import { saveResult } from './store.js';
import { charCount, truncateAtSentence, truncateTitle } from './textUtils.js';
import { extractDateFromText, extractInstitution, parseIsoDate, parsePdfDate } from './meta.js';

/** 从 PDF 正文里粗取标题（去掉 arXiv 头部与版权声明后，找首个 Title-Case 短语）。 */
function titleFromPdfText(text) {
  let t = String(text || '');
  t = t
    .replace(/^arxiv\s*:\s*\d{4}\.\d{4,5}(v\d+)?\s*(\[[^\]]*\])?[^A-Za-z\u4e00-\u9fff]*/i, '')
    .replace(/provided proper attribution is provided[^.]*\.\s*/i, '')
    .trim();

  // 英文标题：连续的首字母大写词（3~5 词，避免把作者名一起吞进去）
  const titleCase = t.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){2,4})\b/);
  if (titleCase) return titleCase[1].trim();

  // 全大写标题兜底
  const upper = t.match(/\b([A-Z]{3,}(?:\s+[A-Z]{3,}){1,12})\b/);
  if (upper) return upper[1].trim();

  // 中文/混合兜底：取首个较短片段
  const first = t.split(/\s{2,}/).find((s) => s.length > 2 && s.length < 140);
  return (first || t).slice(0, 100);
}

function urlBaseName(url) {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.split('/').pop() || u.hostname);
  } catch {
    return url;
  }
}

/**
 * 主流程：链接 → 抓取 → 转图 → 抽取正文 → 生成文案/标题 → 落盘。
 */
export async function processUrl(url) {
  const id = crypto.randomUUID();
  // 提前校验文案模型配置：未配 key 时立即报错，避免白做抓取与渲染
  const provider = createProvider();

  const raw = await fetchSource(url);

  let source;
  let images;

  if (raw.type === 'pdf') {
    const [pages, info] = await Promise.all([
      pdfToImages(raw.buffer),
      extractPdfInfo(raw.buffer),
    ]);
    images = pages;
    // arXiv 链接优先走 API 拿精确标题/作者，其次 PDF 元数据，最后启发式
    const arxiv = /arxiv\.org/.test(raw.finalUrl)
      ? await fetchArxivMeta(raw.finalUrl)
      : null;
    source = {
      type: 'pdf',
      title:
        arxiv?.title ||
        info.title ||
        titleFromPdfText(info.text) ||
        urlBaseName(raw.finalUrl),
      byline: arxiv?.authors || info.author || '',
      excerpt: '',
      text: info.text,
      institution: extractInstitution(info.text),
      date: arxiv?.published ? parseIsoDate(arxiv.published) : parsePdfDate(info.creationDate),
    };
  } else {
    const meta = extractWebpage(raw.html, raw.finalUrl);
    images = await webToImages(raw.finalUrl);
    source = {
      type: 'webpage',
      ...meta,
      date:
        parseIsoDate(meta.date) ||
        extractDateFromText(`${meta.byline} ${meta.text.slice(0, 400)}`) ||
        meta.date ||
        '',
    };
  }

  const limits = {
    maxCopyChars: config.maxCopyChars,
    maxTitleChars: config.maxTitleChars,
  };
  const generated = await provider.generate({ source, limits });
  // 兜底约束：无论 provider 是否守规矩，最终都截到上限内
  const title = truncateTitle(generated.title, limits.maxTitleChars) || '值得一读的新进展';
  const copy = truncateAtSentence(generated.copy, limits.maxCopyChars);
  const titles = (generated.titles || [title])
    .map((t) => truncateTitle(t, limits.maxTitleChars))
    .filter(Boolean);
  if (!titles.length) titles.push(title);

  const saved = await saveResult(id, images, {
    url: raw.finalUrl,
    type: raw.type,
    sourceTitle: source.title,
    institution: source.institution || '',
    date: source.date || '',
    title,
    titles,
    copy,
  });

  return {
    id,
    type: raw.type,
    source: {
      url: raw.finalUrl,
      title: source.title,
      byline: source.byline,
      excerpt: source.excerpt || '',
      institution: source.institution || '',
      date: source.date || '',
      textLength: charCount(source.text),
    },
    images: saved.images.map((i) => ({
      ...i,
      url: `/files/${id}/${i.filename}`,
    })),
    title: { text: title, charCount: charCount(title) },
    titles: titles.map((t) => ({ text: t, charCount: charCount(t) })),
    copy: { text: copy, charCount: charCount(copy) },
    provider: provider.name,
    zipUrl: `/files/${id}/images.zip`,
    markdownUrl: `/files/${id}/summary.md`,
  };
}
