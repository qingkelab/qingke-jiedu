/**
 * 封面审计：把「图生成之后靠眼睛看」改成「先审契约与版面，再定稿」。
 *
 * 两层审计（对应 paper-framework-figure-studio-pro 的「审计前移」思路）：
 *   1. 契约层 auditCoverSpec：图中要出现的数字/术语必须能在原文里找到（不许编），
 *      负约束（无 3D / 无渐变 / 无卡通 / 无 PPT 味 / 无 emoji / 无裸 LaTeX）必须声明齐全；
 *   2. 版面层 auditSvgLayout：解析已渲染的 SVG，估算每个 text 的包围盒，
 *      检查越界、文字互相压字、字号过小、文字撑破所在面板，以及颜色/禁样式。
 *
 * 为什么能查面板：本项目的面板都是用 pencilRect（四条独立线段）画的，
 * 所以这里用「线段拼矩形」的方式把面板反解出来，不需要渲染器改成 `<rect>`。
 * 全部确定性：同一份 SVG 永远得到同一份审计结果。
 */

import { PALETTE, textWidth } from './svg.js';
import { stripDecorative } from './distill.js';

export const SPEC_VERSION = 1;

/** 负约束：海报不许出现的东西（test/cover.test.js 里有同口径的断言）。 */
export const NEGATIVE_CONSTRAINTS = ['no-3d', 'no-gradient', 'no-cartoon', 'no-ppt-template', 'no-emoji', 'no-raw-latex'];

/** 渲染器自己会写死的标签（白名单的固定部分，不属于「提炼内容」）。 */
export const RENDERER_LABELS = [
  '视觉结构',
  '核心公式',
  '术语与来源',
  '取舍与边界',
  '实现结构',
  '时间线',
  '论文主张',
  '边界批注',
  '手绘重述',
  '结论数字（长度按数值等比，红色为最大项）',
  '黑＝原文事实　蓝＝本文推演　红＝边界与取舍',
  '从论文到推论：黑色为原文事实线，蓝色为本文推演，红色为边界与取舍。',
  '方案',
  '保留',
  '去掉',
  '青稞解读 · 论文深度解读',
];

/** 渲染器按数量生成的文字（白名单用正则兜住，避免每种数量都写进契约）。 */
export const RENDERER_TEXT_PATTERNS = [
  /^\d+[×x]\d+$/,
  /^全文按\d+个小节拆解，数字均回查原文切片。$/,
  /^第\d+\/\d+节$/,
];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s) => String(s).replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENTITIES[e]);
const attrsOf = (raw) => {
  const out = {};
  // 注意：属性名里有数字（x1/y1/font-size/…），字符类必须带上 0-9，否则整张图会被静默跳过
  for (const m of String(raw).matchAll(/([a-zA-Z][a-zA-Z0-9-]*)="([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
};
const round1 = (v) => Math.round(v * 10) / 10;

/* ------------------------------------------------------------------ *
 * 契约层：把提炼结果写成一纸可审的 spec
 * ------------------------------------------------------------------ */

/**
 * 生成封面契约（JSON 可序列化，可随产物落盘做审查记录）。
 * @param {{content:object, structure:object, width:number, height:number, footer?:string, sourceUrl?:string}} args
 */
export function buildCoverSpec({ content = {}, structure = {}, width = 1200, height = 1600, footer = '', sourceUrl = '' } = {}) {
  const landscape = width > height * 1.25;
  const blocks = [
    { id: 'diagram', role: 'main', kind: structure.primary || 'concept', priority: 1, required: true },
  ];
  for (const kind of structure.modules || []) {
    if (kind === 'axes') continue; // axes 是主图的附属，不单独占版面
    blocks.push({ id: `module-${kind}`, role: 'module', kind, priority: kind === 'formula' ? 2 : 3, required: false });
  }
  if ((content.claims || []).length) {
    blocks.push({ id: 'claim', role: 'annotation', kind: 'annotation', priority: 4, required: false });
  }

  const numbers = (content.numbers || []).map((n) => ({
    value: String(n.value ?? ''),
    label: String(n.label ?? ''),
    condition: String(n.condition ?? ''),
    source: String(n.source || n.condition || '').trim(),
  }));
  const claims = (content.claims || []).slice(0, landscape ? 1 : 2).map(String);

  const blockList = blocks.map((b) => (b.kind ? b.kind : b.role));
  const spec = {
    version: SPEC_VERSION,
    size: { width, height },
    layout: landscape ? 'landscape' : 'portrait',
    title: String(content.title || ''),
    subtitle: String(content.subtitle || ''),
    tags: (content.tags || []).slice(0, 6).map(String),
    steps: (content.steps || []).slice(0, 6).map(String),
    numbers,
    claims,
    formula: content.formula?.latex ? { latex: String(content.formula.latex) } : null,
    footer: String(footer || ''),
    sourceUrl: String(sourceUrl || content.sourceUrl || ''),
    structure: { primary: structure.primary || 'concept', reason: String(structure.reason || ''), modules: structure.modules || [] },
    blocks,
    // 图文分工：图里允许出现的文字白名单（caption / 正文负责剩下的解释）
    grounding: {
      // 这些内容必须在原文里有出处，否则不许上图
      numbers: numbers.map((n) => n.value).filter(Boolean),
      terms: [...(content.tags || []), ...(content.steps || [])].map(String).filter(Boolean).slice(0, 12),
    },
    negativeConstraints: [...NEGATIVE_CONSTRAINTS],
    style: { palette: ['paper', 'pencil', 'ink', 'blue', 'red'], font: 'handwritten', texture: 'grain' },
  };
  // 可见文字白名单：图里允许出现的文字 = 契约里的字段 + 渲染器的固定标签
  spec.visibleText = [
    spec.title,
    spec.subtitle,
    ...spec.tags,
    ...spec.steps,
    ...spec.claims,
    ...numbers.flatMap((n) => [n.value, n.label, n.condition]),
    spec.formula ? '核心公式' : '',
    spec.structure.reason ? '视觉结构' : '',
    spec.footer,
    spec.sourceUrl,
    ...blockList,
    ...RENDERER_LABELS,
  ]
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  return spec;
}

/** spec 里会被画到图上的文字（用于按需内嵌字体；是渲染器实际用字的超集）。 */
export function specVisibleText(spec = {}) {
  return [
    spec.title,
    spec.subtitle,
    ...(spec.tags || []),
    ...(spec.steps || []),
    ...(spec.claims || []),
    ...(spec.numbers || []).flatMap((n) => [n.value, n.label, n.condition]),
    spec.formula?.latex,
    spec.structure?.reason,
    spec.footer,
    spec.sourceUrl,
    '手绘研究笔记视觉结构核心公式结论数字术语与来源论文主张边界批注黑原文事实蓝本文推演红边界取舍',
  ]
    .filter(Boolean)
    .join('｜');
}

/* ------------------------------------------------------------------ *
 * SVG 解析：text / line / foreignObject
 * ------------------------------------------------------------------ */

export function extractSvgNodes(svg = '') {
  const texts = [];
  for (const m of String(svg).matchAll(/<text\s([^>]*)>([\s\S]*?)<\/text>/g)) {
    const attrs = attrsOf(m[1]);
    const content = unescapeXml(m[2]).trim();
    if (!content) continue;
    const x = Number(attrs.x);
    const y = Number(attrs.y);
    const size = Number(attrs['font-size'] || 12);
    texts.push({
      x, y, size,
      anchor: attrs['text-anchor'] || 'start',
      color: attrs.fill || '',
      content,
      box: textBox({ x, y, size, anchor: attrs['text-anchor'] || 'start', content }),
    });
  }
  const lines = [];
  for (const m of String(svg).matchAll(/<line\s([^>]*)\/>/g)) {
    const a = attrsOf(m[1]);
    lines.push({ x1: Number(a.x1), y1: Number(a.y1), x2: Number(a.x2), y2: Number(a.y2) });
  }
  const foreign = [];
  for (const m of String(svg).matchAll(/<foreignObject\s([^>]*)>([\s\S]*?)<\/foreignObject>/g)) {
    const a = attrsOf(m[1]);
    foreign.push({ x: Number(a.x), y: Number(a.y), w: Number(a.width), h: Number(a.height) });
  }
  const colors = new Set();
  for (const m of String(svg).matchAll(/(?:stroke|fill)="(#[0-9A-Fa-f]{3,8}|url\(#[^)]+\)|[a-z]+)"/g)) colors.add(m[1]);
  return { texts, lines, foreign, colors };
}

/** 估一个 text 的包围盒：CJK 记 1em、其余 0.55em；纵向按基线上 0.88em / 下 0.17em。 */
export function textBox({ x, y, size, anchor = 'start', content = '' }) {
  const w = textWidth(content, size);
  const left = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
  return {
    x: round1(left),
    y: round1(y - size * 0.88),
    w: round1(w),
    h: round1(size * 1.05),
  };
}

/* ------------------------------------------------------------------ *
 * 面板反解：四条轴对齐线段拼出的矩形
 * ------------------------------------------------------------------ */

export function detectPanels(lines = [], { minArea = 2500, tol = 3 } = {}) {
  const hs = lines.filter((l) => Math.abs(l.y1 - l.y2) <= tol).map((l) => ({ y: (l.y1 + l.y2) / 2, a: Math.min(l.x1, l.x2), b: Math.max(l.x1, l.x2) }));
  const vs = lines.filter((l) => Math.abs(l.x1 - l.x2) <= tol).map((l) => ({ x: (l.x1 + l.x2) / 2, a: Math.min(l.y1, l.y2), b: Math.max(l.y1, l.y2) }));
  const near = (p, q) => Math.abs(p - q) <= tol;
  const panels = [];
  for (const h1 of hs) {
    for (const h2 of hs) {
      if (h2.y - h1.y < 24) continue;
      const x1 = Math.max(h1.a, h2.a);
      const x2 = Math.min(h1.b, h2.b);
      if (x2 - x1 < 24) continue;
      const v1 = vs.find((v) => near(v.x, x1) && v.a <= h1.y + tol && v.b >= h2.y - tol);
      const v2 = vs.find((v) => near(v.x, x2) && v.a <= h1.y + tol && v.b >= h2.y - tol);
      if (!v1 || !v2) continue;
      const w = x2 - x1;
      const h = h2.y - h1.y;
      if (w * h < minArea) continue;
      panels.push({ x: round1(x1), y: round1(h1.y), w: round1(w), h: round1(h) });
    }
  }
  // 同一矩形可能被多条线重复命中：去重
  const seen = new Set();
  return panels.filter((p) => {
    const key = `${Math.round(p.x)}:${Math.round(p.y)}:${Math.round(p.w)}:${Math.round(p.h)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const contains = (box, pt, pad = 0) => pt.x >= box.x - pad && pt.x <= box.x + box.w + pad && pt.y >= box.y - pad && pt.y <= box.y + box.h + pad;

/**
 * 白名单判定：文字要么是某条白名单的子串（换行后的碎片），要么自己包含某条白名单（
 * 例如渲染器拼出的「视觉结构：xxx」），要么是尺寸标注这类固定格式。
 */
export function isWhitelisted(content, whitelist = []) {
  // 去掉项目符号（代码/清单面板会给每行加 "- "），再比白名单
  const c = String(content || '').replace(/\s+/g, '').replace(/^[-·•]+/, '');
  if (!c) return true;
  if (RENDERER_TEXT_PATTERNS.some((re) => re.test(c))) return true;
  if (!/[0-9A-Za-z\u3400-\u9fff]/.test(c)) return true; // 纯符号/标点
  return whitelist.some((entry) => entry && (entry.includes(c) || c.includes(entry)));
}

const inside = (box, rect, tol = 1.5) =>
  box.x >= rect.x - tol && box.y >= rect.y - tol && box.x + box.w <= rect.x + rect.w + tol && box.y + box.h <= rect.y + rect.h + tol;
const overlapArea = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

/* ------------------------------------------------------------------ *
 * 版面审计
 * ------------------------------------------------------------------ */

/**
 * @param {string} svg 已渲染的 SVG
 * @param {{width?:number,height?:number,minFontSize?:number,safeInset?:number,panels?:Array,overlapRatio?:number}} [opts]
 */
export function auditSvgLayout(svg = '', opts = {}) {
  const nodes = extractSvgNodes(svg);
  const box = readSvgSize(svg);
  const width = Number(opts.width || box.width || 0);
  const height = Number(opts.height || box.height || 0);
  const minFontSize = Number(opts.minFontSize ?? 11);
  const safeInset = Number(opts.safeInset ?? 16);
  const overlapRatio = Number(opts.overlapRatio ?? 0.25);
  const panels = opts.panels && opts.panels.length ? opts.panels : detectPanels(nodes.lines);
  const findings = [];
  const svgText = String(svg);
  const whitelist = Array.isArray(opts.visibleText) && opts.visibleText.length ? opts.visibleText.map((s) => String(s).replace(/\s+/g, '')) : null;

  if (!nodes.texts.length) {
    findings.push({ level: 'error', code: 'svg-empty', where: 'svg', message: 'SVG 里没有任何文字，渲染可能失败了', fix: '检查提炼结果是否为空 / 渲染器是否报错' });
  }

  if (width && height) {
    const frame = { x: safeInset, y: safeInset, w: width - safeInset * 2, h: height - safeInset * 2 };
    for (const t of nodes.texts) {
      if (!inside(t.box, frame, 2)) {
        findings.push({
          level: 'error',
          code: 'text-out-of-frame',
          where: t.content.slice(0, 24),
          message: `文字越出安全边框（${Math.round(t.box.x)},${Math.round(t.box.y)} → ${Math.round(t.box.x + t.box.w)},${Math.round(t.box.y + t.box.h)}）`,
          fix: '缩短该行、换行或缩小字号',
          box: t.box,
        });
      }
      if (t.size < minFontSize) {
        findings.push({
          level: 'warn',
          code: 'font-too-small',
          where: t.content.slice(0, 24),
          message: `字号 ${t.size} 小于下限 ${minFontSize}`,
          fix: '提高字号或减少同屏文字',
          box: t.box,
        });
      }
      if (/\\(frac|dfrac|tfrac|sum|prod|hat|bar|tilde|mathbb|mathrm|nabla|eta|mu|pi|theta|alpha|odot|langle|rangle|text)/.test(t.content) || /\$[^$]{2,}\$/.test(t.content)) {
        findings.push({
          level: 'error',
          code: 'raw-latex-in-text',
          where: t.content.slice(0, 24),
          message: '文字节点里出现裸 LaTeX：公式应当走 MathML',
          fix: '把该片段改成 MathML（renderMathMl）或改写成中文',
          box: t.box,
        });
      }
      const emoji = /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}]/u.test(t.content);
      if (emoji) {
        findings.push({
          level: 'error',
          code: 'emoji-in-text',
          where: t.content.slice(0, 24),
          message: '文字里有 emoji，海报风格不允许',
          fix: '用 stripDecorative 去掉 emoji',
          box: t.box,
        });
      }
      if (whitelist && !isWhitelisted(t.content, whitelist)) {
        findings.push({
          level: 'warn',
          code: 'text-not-whitelisted',
          where: t.content.slice(0, 24),
          message: '这段文字不在可见文字白名单里：图上出现了契约外的内容',
          fix: '把该内容并进 spec.visibleText，或改成 caption/正文来说',
          box: t.box,
        });
      }
    }
  }

  // 文字压文字（同一段落内的多行由行距保证不触发：阈值按「较小盒子的 25%」算）
  for (let i = 0; i < nodes.texts.length; i += 1) {
    for (let j = i + 1; j < nodes.texts.length; j += 1) {
      const a = nodes.texts[i];
      const b = nodes.texts[j];
      const area = overlapArea(a.box, b.box);
      if (!area) continue;
      const ratio = area / Math.max(1, Math.min(a.box.w * a.box.h, b.box.w * b.box.h));
      if (ratio < overlapRatio) continue;
      findings.push({
        level: ratio >= 0.5 ? 'error' : 'warn',
        code: 'text-overlap',
        where: `${a.content.slice(0, 14)} ↔ ${b.content.slice(0, 14)}`,
        message: `两段文字重叠 ${(ratio * 100).toFixed(0)}%`,
        fix: '挪开标签、缩短文字或把其中一段降级到 caption',
        box: { x: a.box.x, y: a.box.y, w: a.box.w, h: a.box.h },
      });
    }
  }

  // 文字撑破所在面板（取「包含锚点且面积 ≥ minArea」的最小面板）
  for (const t of nodes.texts) {
    const pt = { x: t.box.x, y: t.box.y + t.box.h / 2 };
    const owners = panels.filter((p) => contains(p, pt, 1) && p.w * p.h >= 2500);
    if (!owners.length) continue;
    const panel = owners.sort((p, q) => p.w * p.h - q.w * q.h)[0];
    if (!inside(t.box, panel, 2)) {
      const over = Math.max(0, Math.round(Math.max(panel.x - t.box.x, t.box.x + t.box.w - (panel.x + panel.w), panel.y - t.box.y, t.box.y + t.box.h - (panel.y + panel.h))));
      findings.push({
        level: 'error',
        code: 'panel-overflow',
        where: t.content.slice(0, 24),
        message: `文字撑破所在面板约 ${over}px`,
        fix: '缩短文字、缩小字号，或把该面板的内容降级/删除',
        box: t.box,
        panel,
      });
    }
  }

  // 样式红线（与 test/cover.test.js 同口径）
  if (/linear-gradient|radial-gradient|conic-gradient|<linearGradient|<radialGradient|feDropShadow|box-shadow/.test(svgText)) {
    findings.push({ level: 'error', code: 'forbidden-style', where: 'svg', message: '出现渐变或投影（3D / PPT 味）', fix: '只保留纸纹噪声与描边' });
  }
  const palette = new Set(Object.values(PALETTE).map((c) => String(c).toUpperCase()));
  for (const color of nodes.colors) {
    if (!/^#/.test(color)) continue;
    if (!palette.has(color.toUpperCase())) {
      findings.push({ level: 'warn', code: 'color-outside-palette', where: color, message: `颜色 ${color} 不在 PALETTE 里`, fix: '改用 PALETTE 中的纸/铅笔/蓝/红' });
    }
  }

  return findings;
}

/** 从 SVG 根节点读画布尺寸。 */
export function readSvgSize(svg = '') {
  const root = String(svg).match(/<svg\s([^>]*)>/);
  const attrs = root ? attrsOf(root[1]) : {};
  const vb = String(attrs.viewBox || '').split(/[\s,]+/).map(Number);
  return {
    width: Number(attrs.width) || (Number.isFinite(vb[2]) ? vb[2] : 0),
    height: Number(attrs.height) || (Number.isFinite(vb[3]) ? vb[3] : 0),
  };
}

/* ------------------------------------------------------------------ *
 * 契约审计：不许编数字 / 术语，负约束与白名单要齐
 * ------------------------------------------------------------------ */

const normalize = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();

export function auditCoverSpec({ spec = {}, markdown = '' } = {}) {
  const findings = [];
  const src = normalize(markdown);
  const grounded = (needle) => {
    const n = normalize(stripDecorative(needle));
    return !n || src.includes(n);
  };

  if (!spec.title) findings.push({ level: 'error', code: 'spec-no-title', where: 'spec.title', message: '契约里没有标题', fix: '从终稿里取标题' });
  const missing = NEGATIVE_CONSTRAINTS.filter((c) => !(spec.negativeConstraints || []).includes(c));
  if (missing.length) {
    findings.push({
      level: 'error',
      code: 'spec-missing-negative-constraints',
      where: 'spec.negativeConstraints',
      message: `缺少负约束：${missing.join('、')}`,
      fix: '补齐 NEGATIVE_CONSTRAINTS',
    });
  }
  if (!(spec.visibleText || []).length) {
    findings.push({
      level: 'warn',
      code: 'spec-no-visible-text-whitelist',
      where: 'spec.visibleText',
      message: '没有声明「图里允许出现的文字」白名单，图文分工不可审',
      fix: '用 specVisibleText(spec) 写入白名单',
    });
  }

  if (markdown) {
    for (const n of spec.numbers || []) {
      if (!grounded(n.value)) {
        findings.push({
          level: 'error',
          code: 'ungrounded-number',
          where: String(n.value),
          message: `数字 ${n.value} 在原文里找不到出处`,
          fix: '删掉这个数字，或把原文出处补进条件句',
        });
      }
    }
    for (const term of spec.grounding?.terms || []) {
      const t = normalize(stripDecorative(term));
      // 短于 3 个字符的术语（如 "AI"）不参与，避免误报
      if (t.length < 3 || [...term].length < 3) continue;
      if (!src.includes(t)) {
        findings.push({
          level: 'warn',
          code: 'ungrounded-term',
          where: stripDecorative(term).slice(0, 24),
          message: `术语「${stripDecorative(term).slice(0, 24)}」在原文里找不到出处`,
          fix: '从标签里去掉，或换成原文里的说法',
        });
      }
    }
  }
  return findings;
}

/**
 * 对任意已渲染的 SVG 做「数字出处」核查：图上的数字（≥2 位）要能在原文里找到。
 * 主要用于审那些没有 spec 的手工封面（`audit-cover.js --md article.md`）。
 */
export function auditSvgNumbers({ svg = '', markdown = '', ignore = [] } = {}) {
  const src = String(markdown).replace(/[，,]/g, '');
  const { texts } = extractSvgNodes(svg);
  const findings = [];
  const seen = new Set();
  for (const t of texts) {
    for (const raw of t.content.match(/\d+(?:[.,]\d+)?%?/g) || []) {
      const num = raw.replace(/[%]$/, '');
      const digits = num.replace(/[^\d]/g, '');
      if (digits.length < 2) continue; // 一位数与「第 1 步」这类不算证据
      if (seen.has(num)) continue;
      seen.add(num);
      if (ignore.some((re) => (re instanceof RegExp ? re.test(num) : String(num) === String(re)))) continue;
      const plain = num.replace(/[.,]/g, (m) => m); // 保持原样
      if (src.includes(plain) || src.includes(plain.replace(/[.,]/g, ''))) continue;
      findings.push({
        level: 'warn',
        code: 'number-not-in-source',
        where: num,
        message: `图上的数字 ${num} 在给定的原文里找不到`,
        fix: '核对出处；确实来自原文图表/脚注就忽略这条',
      });
    }
  }
  return findings;
}

/** 合成审计：契约层 + 版面层，并给出总结。 */
export function auditCover({ svg = '', spec = null, markdown = '', panels = null, ...opts } = {}) {
  const findings = [
    ...(spec ? auditCoverSpec({ spec, markdown }) : []),
    ...auditSvgLayout(svg, { ...opts, panels: panels || undefined, visibleText: spec?.visibleText }),
    ...(markdown && !spec ? auditSvgNumbers({ svg, markdown, ignore: opts.ignoreNumbers }) : []),
  ];
  const errors = findings.filter((f) => f.level === 'error').length;
  const warns = findings.filter((f) => f.level === 'warn').length;
  const nodes = extractSvgNodes(svg);
  return {
    ok: errors === 0,
    findings,
    summary: { errors, warns, texts: nodes.texts.length, panels: (panels && panels.length) || detectPanels(nodes.lines).length },
    generatedAt: new Date().toISOString(),
  };
}

/** 人读版：CLI 直接打印。 */
export function formatFindings(findings = []) {
  if (!findings.length) return ['✓ 审计通过：没有发现问题'];
  const icon = { error: '✗', warn: '!', info: '·' };
  return findings.map((f) => `${icon[f.level] || '·'} [${f.code}] ${f.where ? `${f.where}：` : ''}${f.message}${f.fix ? `\n    → ${f.fix}` : ''}`);
}

/** 给候选打分：错误优先、其次警告，最后按结构偏好排序（用于多候选收敛）。 */
export function scoreAudit(audit = {}) {
  const s = audit.summary || { errors: 0, warns: 0 };
  return s.errors * 100 + s.warns * 10;
}
