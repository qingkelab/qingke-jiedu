/**
 * arXiv API（搜索 / 元数据）：export.arxiv.org 不放 CORS，必须经用户配置的代理。
 * 与 src/arxivSearch.js 同一套查询构造；Atom 用正则轻量解析（原实现的浏览器版）。
 */
import { fetchText, proxiedUrl } from './net.js';

function fmtDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
}

async function fetchApiText(url, proxy) {
  // export.arxiv.org 已知无 CORS，直接走代理；未配置代理时给出可读错误
  if (!String(proxy || '').trim()) {
    throw new Error('arXiv 搜索/元数据接口不支持跨域直连：请在「接口设置」里填写 CORS 代理');
  }
  const res = await fetch(proxiedUrl(url, proxy), { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`arXiv API 失败 HTTP ${res.status}（经代理）`);
  return res.text();
}

/**
 * 按时间/分类/关键词搜索最新论文。
 * @returns {Promise<Array<{id,title,published,authors,url,pdfUrl}>>}
 */
export async function searchArxiv({ days = 3, category = '', keyword = '', max = 60, proxy = '' } = {}) {
  const now = new Date();
  const from = new Date(now.getTime() - days * 86400000);

  const parts = [];
  if (category) parts.push(`cat:${category}`);
  if (keyword) parts.push(`all:"${keyword}"`);
  parts.push(`submittedDate:[${fmtDate(from)}0000 TO ${fmtDate(now)}2359]`);

  const url =
    `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(parts.join(' AND '))}` +
    `&sortBy=submittedDate&sortOrder=descending&max_results=${max}`;

  const xml = await fetchApiText(url, proxy);
  return parseAtomEntries(xml);
}

/** 按 ID 取精确标题 / 作者 / 发布时间（深度解读出处块用）。 */
export async function fetchArxivMeta(id, proxy = '') {
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}&max_results=1`;
  const xml = await fetchApiText(url, proxy);
  const papers = parseAtomEntries(xml);
  return papers[0] || null;
}

function parseAtomEntries(xml) {
  const entries = [...String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  const papers = [];
  for (const e of entries) {
    const rawId = (e.match(/<id>([\s\S]*?)<\/id>/) || [])[1] || '';
    const title = ((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '')
      .replace(/\s+/g, ' ')
      .trim();
    const published = (e.match(/<published>([\s\S]*?)<\/published>/) || [])[1] || '';
    const authors = [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)]
      .map((m) => m[1])
      .slice(0, 3)
      .join(', ');
    if (!title) continue;
    const id = rawId.replace(/^https?:\/\/arxiv\.org\/abs\//, '') || rawId;
    papers.push({
      id,
      title,
      published: (published || '').slice(0, 10),
      authors,
      url: `https://arxiv.org/abs/${id}`,
      pdfUrl: `https://arxiv.org/pdf/${id}`,
    });
  }
  return papers;
}

/** 备用通道： fetchText 兜底（某些代理把 export.arxiv.org 包成可读流）。 */
export { fetchText };
