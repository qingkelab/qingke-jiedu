/**
 * 头图生成入口：终稿 Markdown → 手绘研究笔记风格海报（SVG / PNG）。
 *
 * 一条链路：distill（提炼内容 + 自动决定视觉结构） → svg（画） → svgToPng（栅格化）。
 * 全程确定性、不调用图像模型；PNG 用项目已有的 Chrome 渲染（webToImages.svgToPng）。
 */

import fs from 'node:fs/promises';
import { splitMarkdownSections } from '../deepread/audit.js';
import { distillCoverContent, chooseCoverStructure, distillSectionFigure } from './distill.js';
import { renderCoverSvg, renderFigureSvg } from './svg.js';
import { buildHandFontCss, posterTextOf } from './font.js';

/** 常用版式：海报（竖版）/ 头图（宽版）/ 方图。 */
export const COVER_RATIOS = {
  poster: { width: 1200, height: 1600 },
  wide: { width: 1600, height: 900 },
  square: { width: 1200, height: 1200 },
};

/**
 * 生成封面 SVG（异步：需要按需内联手写字体；不碰网络与浏览器）。
 * @param {{markdown:string, meta?:object, title?:string, sourceUrl?:string, ratio?:string|object}} args
 */
export async function buildCoverSvg({
  markdown = '',
  meta = null,
  title = '',
  sourceUrl = '',
  ratio = 'poster',
  embedFont = true,
} = {}) {
  const size = typeof ratio === 'string' ? COVER_RATIOS[ratio] || COVER_RATIOS.poster : ratio;
  const content = distillCoverContent({ markdown, meta, title, sourceUrl });
  const structure = chooseCoverStructure(content);
  // 手写字体按「这张海报用到的字」按需内联（见 font.js），拿不到字体就退化成系统字体栈
  const fontCss = embedFont ? await buildHandFontCss(posterTextOf(content, structure)) : '';
  const svg = renderCoverSvg({ content, structure, width: size.width, height: size.height, fontCss });
  return { svg, content, structure, width: size.width, height: size.height, fontEmbedded: Boolean(fontCss) };
}

/**
 * 生成 PNG（需要本机 Chrome；失败时返回 png: null，调用方仍可用 SVG）。
 * @returns {Promise<{svg:string, png:Buffer|null, width:number, height:number, content:object, structure:object}>}
 */
export async function buildCoverPng({ scale = 2, ...args } = {}) {
  const built = await buildCoverSvg(args);
  let png = null;
  try {
    const { svgToPng } = await import('../webToImages.js');
    const res = await svgToPng(built.svg, { scale, waitForFonts: true });
    png = res?.buffer || null;
  } catch {
    png = null; // 没有 Chrome 的环境：退化成只给 SVG
  }
  return { ...built, png };
}

/** 从产物目录读一篇解读（deepread.md + deepread.audit.json），写出 cover.svg / cover.png。 */
export async function buildCoverForDir(dir, { out = null, ratio = 'poster', scale = 2 } = {}) {
  const markdown = await fs.readFile(`${dir}/deepread.md`, 'utf-8');
  let meta = null;
  try {
    meta = JSON.parse(await fs.readFile(`${dir}/deepread.audit.json`, 'utf-8'))?.meta || null;
  } catch {
    meta = null;
  }
  const built = await buildCoverPng({ markdown, meta, ratio, scale });
  const base = out || `${dir}/cover`;
  const svgPath = base.endsWith('.svg') ? base : `${base}.svg`;
  const pngPath = base.endsWith('.png') ? base : `${base}.png`;
  await fs.writeFile(svgPath, built.svg, 'utf-8');
  if (built.png) await fs.writeFile(pngPath, built.png);
  return { ...built, svgPath, pngPath: built.png ? pngPath : null };
}

/** 视觉结构 → 小节配图：只有「有内容可画」的小节才出图。 */
export const FIGURE_MIN_CHARS = 160;

/**
 * 为文章的每个二级小节生成一张手绘重述图（首页大图之外的正文配图）。
 * @param {{markdown:string, max?:number, onlySectionsWithFigures?:boolean}} args
 */
export async function buildSectionFigures({ markdown = '', max = 6, tags = [] } = {}) {
  const sections = splitMarkdownSections(String(markdown || '')).filter((s) => s.level === 2 && s.heading);
  const picked = sections.filter((s) => String(s.body || '').trim().length >= FIGURE_MIN_CHARS);
  const chosen = (picked.length ? picked : sections).slice(0, max);
  // 术语表整篇取一次（小节里往往只出现一次缩写，按篇取才稳定）
  const articleTags = tags && tags.length ? tags : distillCoverContent({ markdown }).tags;
  const figures = [];
  for (const [i, section] of chosen.entries()) {
    const distilled = distillSectionFigure({ heading: section.heading, body: section.body, tags: articleTags });
    const fontCss = await buildHandFontCss(
      posterTextOf({ title: distilled.title, steps: distilled.steps, claims: distilled.claims, numbers: distilled.numbers, tags: distilled.tags }, { reason: '' }),
    );
    const svg = renderFigureSvg({
      section: distilled,
      index: i + 1,
      total: chosen.length,
      fontCss,
      sourceNote: '手绘重述：依据本节正文与该节原图重绘，不是论文原图；原图见文末出处。',
    });
    figures.push({ sectionTitle: section.heading, heading: section.heading, distilled, svg, index: i + 1 });
  }
  return figures;
}

/** 生成 PNG（同上，需要本机 Chrome）。 */
export async function buildSectionFigurePngs(args = {}) {
  const figures = await buildSectionFigures(args);
  let svgToPng = null;
  try {
    ({ svgToPng } = await import('../webToImages.js'));
  } catch {
    svgToPng = null;
  }
  for (const fig of figures) {
    if (!svgToPng) continue;
    try {
      const res = await svgToPng(fig.svg, { scale: 2, waitForFonts: true });
      fig.png = res?.buffer || null;
    } catch {
      fig.png = null;
    }
  }
  return figures;
}
