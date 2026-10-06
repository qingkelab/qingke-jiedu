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
import { auditCover, buildCoverSpec, scoreAudit, specVisibleText } from './audit.js';
import { coverCandidates, repairCoverSpec, specToRenderInput } from './repair.js';

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
  // 契约 + 审计：图生成之后立刻检查版面与出处，结果随产物一起返回（不改变既有字段）
  const spec = buildCoverSpec({ content, structure, width: size.width, height: size.height, sourceUrl });
  const audit = auditCover({ svg, spec, markdown, width: size.width, height: size.height });
  return { svg, content, structure, spec, audit, width: size.width, height: size.height, fontEmbedded: Boolean(fontCss) };
}

/**
 * 「先审计、再定稿」的封面生成：渲染 → 审计 → 修 spec → 重渲染，最多 rounds 轮。
 * 返回最干净的一版（错误优先、其次警告），并带上每一轮的 ledger，便于回查。
 */
export async function buildAuditedCover({
  markdown = '',
  meta = null,
  title = '',
  sourceUrl = '',
  ratio = 'poster',
  embedFont = true,
  footer = '',
  rounds = 2,
  structure = null,
} = {}) {
  const size = typeof ratio === 'string' ? COVER_RATIOS[ratio] || COVER_RATIOS.poster : ratio;
  const content0 = distillCoverContent({ markdown, meta, title, sourceUrl });
  const structure0 = structure || chooseCoverStructure(content0);
  let spec = buildCoverSpec({ content: content0, structure: structure0, width: size.width, height: size.height, footer, sourceUrl });
  const ledger = [];
  let best = null;

  for (let round = 0; round <= Math.max(0, rounds); round += 1) {
    const input = specToRenderInput(spec);
    const fontCss = embedFont ? await buildHandFontCss(specVisibleText(spec)) : '';
    const svg = renderCoverSvg({ content: input.content, structure: input.structure, width: size.width, height: size.height, fontCss });
    const audit = auditCover({ svg, spec, markdown, width: size.width, height: size.height });
    const entry = {
      round,
      score: scoreAudit(audit),
      errors: audit.summary.errors,
      warns: audit.summary.warns,
      findings: audit.findings.map((f) => ({ level: f.level, code: f.code, where: f.where, message: f.message })),
    };
    ledger.push(entry);
    const candidate = { svg, spec, structure: input.structure, content: input.content, audit, fontEmbedded: Boolean(fontCss) };
    if (!best || scoreAudit(audit) < scoreAudit(best.audit)) best = candidate;
    if (!audit.findings.length) break;
    const repaired = repairCoverSpec({ spec, findings: audit.findings });
    if (!repaired.applied.length) break;
    entry.applied = repaired.applied;
    spec = repaired.spec;
  }

  return { ...best, ledger, rounds: ledger.length, width: size.width, height: size.height };
}

/**
 * 候选发散：主图结构三选一（加一个最简变体），各自走「审计 + 修复」，
 * 收敛到最干净的一版（先发散后收敛，确定性）。
 */
export async function buildBestCover({ variants = 3, ...args } = {}) {
  const size = typeof args.ratio === 'string' ? COVER_RATIOS[args.ratio] || COVER_RATIOS.poster : args.ratio || COVER_RATIOS.poster;
  const content = distillCoverContent({ markdown: args.markdown || '', meta: args.meta || null, title: args.title || '', sourceUrl: args.sourceUrl || '' });
  const baseStructure = chooseCoverStructure(content);
  const candidates = coverCandidates({ content, structure: baseStructure, max: Math.max(1, Number(variants) || 1) });
  const built = [];
  for (const structure of candidates) {
    const cover = await buildAuditedCover({ ...args, structure });
    built.push({ structure: structure.primary, modules: structure.modules || [], score: scoreAudit(cover.audit), cover });
  }
  built.sort((a, b) => a.score - b.score);
  const winner = built[0];
  return {
    ...winner.cover,
    width: size.width,
    height: size.height,
    variants: built.map((b) => ({ structure: b.structure, modules: b.modules, score: b.score, errors: b.cover.audit.summary.errors, warns: b.cover.audit.summary.warns })),
  };
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
export async function buildCoverForDir(dir, { out = null, ratio = 'poster', scale = 2, audit = true, rounds = 2, variants = 1 } = {}) {
  const markdown = await fs.readFile(`${dir}/deepread.md`, 'utf-8');
  let meta = null;
  try {
    meta = JSON.parse(await fs.readFile(`${dir}/deepread.audit.json`, 'utf-8'))?.meta || null;
  } catch {
    meta = null;
  }
  const build = variants > 1 ? buildBestCover : buildAuditedCover;
  const built = await build({ markdown, meta, ratio, rounds, variants });
  let png = null;
  try {
    const { svgToPng } = await import('../webToImages.js');
    png = (await svgToPng(built.svg, { scale, waitForFonts: true }))?.buffer || null;
  } catch {
    png = null; // 没有 Chrome 的环境：退化成只给 SVG
  }
  const base = out || `${dir}/cover`;
  const svgPath = base.endsWith('.svg') ? base : `${base}.svg`;
  const pngPath = base.endsWith('.png') ? base : `${base}.png`;
  await fs.writeFile(svgPath, built.svg, 'utf-8');
  if (png) await fs.writeFile(pngPath, png);
  // 审计 ledger 落盘：哪一轮、发现了什么、修了什么，都能回查（checkpoint 治理）
  const auditPath = `${base}.audit.json`;
  if (audit) {
    await fs.writeFile(
      auditPath,
      JSON.stringify(
        {
          ok: built.audit.ok,
          summary: built.audit.summary,
          rounds: built.rounds || 1,
          ledger: built.ledger || [],
          variants: built.variants || null,
          findings: built.audit.findings,
        },
        null,
        2,
      ),
      'utf-8',
    );
  }
  return { ...built, png, svgPath, pngPath: png ? pngPath : null, auditPath: audit ? auditPath : null };
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
