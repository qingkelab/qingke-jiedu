/**
 * 发布到 public repo（GitHub Pages 形态）—— 把生成的文章落到一个公开仓库里的
 * `article/<NNN>/index.html` + `article/<NNN>/images/*.png`，并更新首页入口。
 *
 * 设计原则（对齐 qingke 的 release/public 规范，但保持本项目的轻量定位）：
 *   - **纯函数先规划、再落盘**：`planPublish()` 返回可审阅的写操作清单，便于 dry-run 与测试；
 *   - 默认 dry-run，真正写盘要显式 `--yes`；`--push`/`--pr` 才会碰远端（默认不碰）；
 *   - HTML 自包含（内联样式），图片只放 PNG，正文与核验表分开；
 *   - 编号由仓库现状决定（`article/NNN` 最大值 +1），不重排、不复用。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { markdownToHtml } from '../markdown.js';

/** 首页里用来定位「文章列表插入点」的标记（推荐在仓库 index.html 里保留）。 */
export const ARTICLES_MARKER = '<!-- articles -->';

/** 从 markdown 里取一级标题作为文章标题。 */
export function titleOf(markdown, fallback = '未命名解读') {
  const m = String(markdown || '').match(/^#\s+(.+)$/m);
  return (m ? m[1].trim() : '').slice(0, 120) || fallback;
}

/** 取正文第一段（非标题 / 非图片 / 非引用 / 非代码块）作为首页描述。 */
export function summaryOf(markdown, limit = 60) {
  // 先整块去掉围栏代码块（出处块就长这样，否则会把「作者：xxx」当描述）
  const body = String(markdown || '').replace(/```[\s\S]*?```/g, '\n');
  const lines = body.split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^(#|!\[|>|```|\||[-*+]\s|\d+[.)]\s)/.test(t)) continue;
    if (/^(作者|机构|时间|Paper|arXiv|Code)[：:]/.test(t)) continue;
    const plain = t.replace(/[*_`]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    return plain.slice(0, limit);
  }
  return '';
}

/** 首页列表项：仓库用卡片样式就跟卡片，否则用最朴素的 li。 */
function renderIndexEntry({ slug, title, desc, card = false }) {
  const safeTitle = escapeHtml(title);
  if (card) {
    return [
      '      <li>',
      `        <a class="card" href="${slug}/">`,
      `          <span class="card-title">${safeTitle}</span>`,
      desc ? `          <span class="card-desc">${escapeHtml(desc)}</span>` : '',
      '          <span class="card-meta">阅读全文 →</span>',
      '        </a>',
      '      </li>',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return `    <li><a href="./${slug}/">${safeTitle}</a></li>`;
}

async function pathExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 扫描 public repo，返回下一个可用编号（NNN，三位零填充）。 */
export async function nextArticleNumber(repoDir, { pad = 3 } = {}) {
  let entries = [];
  try {
    entries = await fs.readdir(path.join(repoDir, 'article'));
  } catch {
    return String(1).padStart(pad, '0');
  }
  const nums = entries
    .map((e) => Number(String(e).match(/^(\d+)/)?.[1]))
    .filter((n) => Number.isFinite(n) && n > 0);
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return String(next).padStart(pad, '0');
}

/** 自包含 HTML（内联样式；图片相对路径 `images/xxx.png`）。 */
export function buildPublicHtml({ title, markdown, articleNumber, sourceUrl = '', factCheckMarkdown = '', generatedAt = '' }) {
  const body = markdownToHtml(markdown, 'orange');
  const factCheckSection = factCheckMarkdown
    ? `<details class="fact-check"><summary>数字核验表（每个数字的来源与条件）</summary>\n${markdownToHtml(factCheckMarkdown, 'orange')}\n</details>`
    : '';
  const sourceLine = sourceUrl
    ? `<p class="meta">原文：<a href="${sourceUrl}" target="_blank" rel="noopener">${sourceUrl}</a></p>`
    : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #faf7f2; color: #221a12; font: 16px/1.8 -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; background: #fff; }
  h1 { font-size: 26px; line-height: 1.4; margin: 0 0 8px; }
  h2 { font-size: 20px; margin: 32px 0 12px; }
  h3 { font-size: 17px; margin: 24px 0 10px; }
  p { margin: 12px 0; }
  img { max-width: 100%; height: auto; display: block; margin: 16px auto; border-radius: 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; margin: 12px 0; }
  th, td { border: 1px solid #e3d9cc; padding: 6px 8px; text-align: left; vertical-align: top; }
  blockquote { margin: 12px 0; padding: 8px 12px; border-left: 3px solid #d97a3a; background: #fdf6ee; color: #5a4a3c; }
  code { background: #f4eee7; padding: 1px 4px; border-radius: 4px; }
  .meta { color: #6b5b4d; font-size: 14px; }
  .meta a { color: #b45f1d; text-decoration: none; }
  .fact-check { margin-top: 40px; border-top: 1px dashed #e3d9cc; padding-top: 12px; }
  .fact-check summary { cursor: pointer; color: #b45f1d; font-weight: 600; }
  footer { color: #8a7a6c; font-size: 13px; margin-top: 32px; }
</style>
</head>
<body>
<main>
<article id="article-${articleNumber}">
${body}
</article>
${sourceLine}
${factCheckSection}
<footer>青稞解读 · 深度解读 · article/${articleNumber}${generatedAt ? ` · ${escapeHtml(generatedAt)}` : ''}</footer>
</main>
</body>
</html>
`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * 规划一次发布：返回写操作清单（不落盘，便于 dry-run / 测试）。
 * @returns {{articleNumber, slug, dir, writes:Array, indexUpdate:object|null, summary:string}}
 */
export async function planPublish({
  repoDir,
  markdown,
  factCheckMarkdown = '',
  sourceUrl = '',
  theme = 'orange',
  imageFiles = [],
  articleNumber = null,
  generatedAt = '',
  allowOverwrite = false,
} = {}) {
  const num = articleNumber || (await nextArticleNumber(repoDir));
  const slug = `article/${num}`;
  const dir = path.join(repoDir, slug);
  const title = titleOf(markdown);
  const desc = summaryOf(markdown);

  // 编号撞车时拒绝执行：宁可让人换编号，也不覆盖已经发布出去的文章。
  if (!allowOverwrite && (await pathExists(path.join(dir, 'index.html')))) {
    throw new Error(`${slug} 已存在（${path.join(dir, 'index.html')}）；换一个 --number，或显式允许覆盖`);
  }

  const html = buildPublicHtml({ title, markdown, articleNumber: num, sourceUrl, factCheckMarkdown, generatedAt });

  const writes = [
    { type: 'mkdir', target: dir },
    { type: 'write', target: path.join(dir, 'index.html'), content: html },
  ];
  if (Array.isArray(imageFiles) && imageFiles.length) {
    writes.push({ type: 'mkdir', target: path.join(dir, 'images') });
    for (const img of imageFiles) writes.push({ type: 'copy', target: path.join(dir, 'images', path.basename(img)), from: img });
  }
  const indexPath = path.join(repoDir, 'index.html');
  const indexUpdate = await planIndexUpdate({ indexPath, slug, title, desc });
  return {
    articleNumber: num,
    title,
    slug,
    dir,
    writes,
    indexUpdate,
    summary: `${slug} ← ${title}（图片 ${imageFiles.length} 张${factCheckMarkdown ? '，含核验表' : ''}）`,
  };
}

/**
 * 首页入口（不落盘）：三种模式
 *   marker  首页有 <!-- articles --> → 插到标记后面（推荐，仓库里维护一个标记即可）
 *   list    没有标记但有 </ul> → 插到最后一个列表结束前（兼容已有卡片式首页）
 *   skip    两者都没有 → 不动首页，只把这一行还给人工粘贴（绝不瞎追加）
 */
export async function planIndexUpdate({ indexPath, slug, title, desc = '' }) {
  let current = '';
  try {
    current = await fs.readFile(indexPath, 'utf-8');
  } catch {
    return null; // 没有首页：不硬造
  }
  const card = /class="card"/.test(current);
  const entry = renderIndexEntry({ slug, title, desc, card });
  if (current.includes(ARTICLES_MARKER)) {
    return { path: indexPath, mode: 'marker', marker: ARTICLES_MARKER, entry, card };
  }
  const at = current.lastIndexOf('</ul>');
  if (at !== -1) {
    return { path: indexPath, mode: 'list', insertAt: at, entry, card };
  }
  return { path: indexPath, mode: 'skip', entry, card };
}

/** 执行计划。`dryRun` 时只返回计划，不落盘。 */
export async function applyPublish(plan, { dryRun = true } = {}) {
  if (dryRun) return { applied: false, plan };
  await fs.mkdir(plan.dir, { recursive: true });
  for (const w of plan.writes) {
    if (w.type === 'mkdir') await fs.mkdir(w.target, { recursive: true });
    else if (w.type === 'write') {
      await fs.mkdir(path.dirname(w.target), { recursive: true });
      await fs.writeFile(w.target, w.content, 'utf-8');
    } else if (w.type === 'copy') {
      await fs.mkdir(path.dirname(w.target), { recursive: true });
      await fs.copyFile(w.from, w.target);
    }
  }
  const index = await applyIndexUpdate(plan.indexUpdate);
  return { applied: true, plan, index };
}

/** 按规划好的模式更新首页；skip 模式返回 snippet 交给人工处理。 */
export async function applyIndexUpdate(indexUpdate) {
  if (!indexUpdate) return { updated: false, mode: 'none', snippet: '' };
  const { path: indexPath, mode, entry } = indexUpdate;
  if (mode === 'skip') return { updated: false, mode, snippet: entry };
  const current = await fs.readFile(indexPath, 'utf-8');
  if (mode === 'marker') {
    const marker = indexUpdate.marker || ARTICLES_MARKER;
    if (current.includes(marker)) {
      await fs.writeFile(indexPath, current.replace(marker, `${marker}\n${entry}`), 'utf-8');
      return { updated: true, mode, snippet: entry };
    }
    return { updated: false, mode: 'skip', snippet: entry };
  }
  // list：插到最后一个 </ul> 之前
  const at = current.lastIndexOf('</ul>');
  if (at === -1) return { updated: false, mode: 'skip', snippet: entry };
  const next = `${current.slice(0, at).replace(/\s*$/, '')}\n${entry}\n${current.slice(at)}`;
  await fs.writeFile(indexPath, next, 'utf-8');
  return { updated: true, mode, snippet: entry };
}

/** git 侧动作（默认不执行）：建分支 → add → commit →（可选）push + PR。 */
export function publishGitCommands({ articleNumber, title, branch = null, push = false, pr = false } = {}) {
  const br = branch || `article/${articleNumber}`;
  const cmds = [
    ['git', ['checkout', '-b', br]],
    ['git', ['add', `article/${articleNumber}`, 'index.html']],
    ['git', ['commit', '-m', `article(${articleNumber}): ${title}`]],
  ];
  if (push) cmds.push(['git', ['push', '-u', 'origin', br]]);
  if (pr) cmds.push(['gh', ['pr', 'create', '--fill', '--base', 'main']]);
  return cmds;
}
