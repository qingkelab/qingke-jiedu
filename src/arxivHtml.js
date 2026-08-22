import { JSDOM } from 'jsdom';
import { config } from './config.js';

/** 从 arXiv 链接解析出论文 ID（abs/pdf/html 均可）。 */
export function parseArxivId(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})(v\d+)?/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function resolveUrl(src, base) {
  try {
    return new URL(src, base).href;
  } catch {
    return src;
  }
}

/** 从文本里抽论文代码链接（github.com，过滤 arXiv 自身工具/渲染链接）。 */
export function extractCodeUrl(html) {
  const s = String(html || '');
  const urls = [...s.matchAll(/https?:\/\/github\.com\/[A-Za-z0-9_.\-/]+/gi)].map((m) => m[0]);
  const clean = urls.filter(
    (u) => !/github\.com\/arXiv\//i.test(u) && !/html_feedback/i.test(u) && !/LaTeXML/i.test(u),
  );
  return clean[0] || '';
}

/**
 * 抓取 arXiv 论文的 HTML 版本，抽取正文文本与图片（CDN 链接 + 图注）。
 * @returns {Promise<{id:string, base:string, text:string, figures:Array<{url:string,caption:string}>}>}
 */
export async function fetchArxivHtml(url) {
  const id = parseArxivId(url);
  if (!id) throw new Error('不是 arXiv 论文链接（无法解析 ID）');

  const htmlUrl = `https://arxiv.org/html/${id}`;
  const res = await fetch(htmlUrl, {
    redirect: 'follow',
    signal: AbortSignal.timeout(config.fetchTimeoutMs),
    headers: { 'User-Agent': config.userAgent },
  });
  if (!res.ok) throw new Error(`抓取 arXiv HTML 失败 HTTP ${res.status}`);
  const html = await res.text();
  const base = res.url || htmlUrl;

  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // 正文文本：去掉脚本/样式/导航等
  doc.querySelectorAll('script, style, nav, footer, header, aside').forEach((el) => el.remove());
  const text = (doc.body?.textContent || '').replace(/\s+/g, ' ').trim();

  // 标题：优先 h1.ltx_title，其次 <title>（去掉 [ID] 前缀）
  const h1 = doc.querySelector('h1.ltx_title, h1.ltx_title_document, h1.title');
  const titleEl = h1 || doc.querySelector('title');
  const title = (titleEl?.textContent || '')
    .replace(/\s+/g, ' ')
    .replace(/^\[?\d{4}\.\d{4,5}(v\d+)?\]?\s*/i, '')
    .trim();

  // 图片：figure 内的内容图（跳过 logo/静态资源/base64）
  const figures = [];
  for (const f of doc.querySelectorAll('figure')) {
    const img = f.querySelector('img');
    const cap = f.querySelector('figcaption');
    const src = img?.getAttribute('src') || '';
    if (!src || src.startsWith('data:') || /static\/|funders|logo/i.test(src)) continue;
    figures.push({
      url: resolveUrl(src, base),
      caption: (cap?.textContent || img?.getAttribute('alt') || '').replace(/\s+/g, ' ').trim(),
    });
  }

  return {
    id,
    base,
    title,
    text,
    figures,
    // 代码链接：只在正文前段（摘要/引言）里找，避开页脚工具与参考文献里的链接
    codeUrl: extractCodeUrl(text.slice(0, 5000)),
  };
}
