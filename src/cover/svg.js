/**
 * 头图渲染：把提炼好的内容画成「手绘技术研究笔记」风格的海报 SVG。
 *
 * 风格约束（来自需求）：
 *   米白纸张纹理 / 黑色铅笔线稿 / 少量蓝红强调；
 *   一个大核心技术图为视觉中心，四周是流程图、坐标轴、公式、代码结构、决策树、数据图与手写注释；
 *   理性、克制、留白、信息密度高、略带手绘不规则感。
 *   禁止：3D、渐变、卡通、商业广告感、PPT 风。
 *
 * 做法：所有图形都用**描边**（不填色块）、线端圆角、带确定性抖动（同一输入永远同一张图）；
 * 纸纹用 SVG 的 feTurbulence（二维噪声，不是渐变）；颜色只用下面 PALETTE 里的几种。
 */

import katex from 'katex';
import { stripDecorative } from './distill.js';

/**
 * 公式渲染：用 KaTeX 生成 **MathML**（`output:'mathml'`），再放进 SVG 的 foreignObject。
 *
 * 为什么走 MathML：KaTeX 的 HTML 输出依赖它自己的字体文件（60+ 个 woff2），
 * 而 MathML 由浏览器原生排版（Chrome 支持 MathML Core），不需要额外字体，
 * 也不会出现「把 \frac{a}{b} 压成 a/b 字符串」那种假公式。
 */
export function renderMathMl(latex, { displayMode = true } = {}) {
  try {
    return katex.renderToString(String(latex || ''), { output: 'mathml', throwOnError: false, displayMode });
  } catch {
    return '';
  }
}

/** 纸张 / 铅笔 / 强调色（克制配色：只有蓝红两个强调色）。 */
export const PALETTE = {
  paper: '#F4EFE4',
  paperShade: '#E8E1D2',
  ink: '#1F1D1A',
  inkSoft: '#5A554D',
  pencil: '#8C857A',
  blue: '#2F5D8C',
  red: '#B23A32',
};

/**
 * 手写体栈：系统行楷/手写体优先（笔画感最强），再退到仓库内嵌的霞鹜文楷 Lite。
 * 内嵌字体保证「换一台机器 / 部署到 Linux」也不会退成黑体，行楷存在时又能拿到更手绘的观感。
 */
const FONT_HAND = "'Xingkai SC','Hanzipen SC','LXGW WenKai Lite','Kaiti SC','STKaiti','KaiTi','Palatino Linotype',serif";
const FONT_META = "'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
const FONT_CODE = "'SF Mono','Menlo','Consolas',monospace";

/** XML 转义（标题、批注都可能带 & < >）。 */
export function escapeXml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

/** 确定性伪随机：同一个 seed（标题哈希）永远给出同一串抖动。 */
export function makeJitter(seedStr) {
  let h = 2166136261;
  for (const ch of String(seedStr || '')) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (amp = 1.4) => (rand() * 2 - 1) * amp;
}

/** 粗略字宽（CJK 记 1，其余记 0.55），用于换行与居中。 */
export function textWidth(text, size) {
  let units = 0;
  for (const ch of String(text || '')) units += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.55;
  return units * size;
}

/**
 * 按宽度换行：把文本切成「原子」（拉丁词/数字串算一个原子，中文单字一个原子）再贪心排。
 * 这样 "Transformer" 这类术语永远不会被从中间劈开。
 */
export function wrapText(text, maxWidth, size) {
  const atoms = String(text || '').match(/[A-Za-z0-9][A-Za-z0-9.,:\/+\-]*|\s+|./gu) || [];
  const lines = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) lines.push(cur.trim());
    cur = '';
  };
  for (const atom of atoms) {
    if (!atom) continue;
    if (/^\s+$/.test(atom)) {
      if (cur) cur += ' ';
      continue;
    }
    if (textWidth(cur + atom, size) <= maxWidth) {
      cur += atom;
      continue;
    }
    push();
    // 原子本身超宽（超长英文串）：只能按字符硬切
    if (textWidth(atom, size) > maxWidth) {
      let chunk = '';
      for (const ch of atom) {
        if (textWidth(chunk + ch, size) > maxWidth) {
          lines.push(chunk);
          chunk = '';
        }
        chunk += ch;
      }
      cur = chunk;
    } else {
      cur = atom;
    }
  }
  push();
  return lines;
}

/** 手绘直线：两端各带一点抖动。 */
function pencilLine(x1, y1, x2, y2, jitter, { color = PALETTE.ink, width = 2, opacity = 1 } = {}) {
  const j = jitter;
  return `<line x1="${(x1 + j(0.8)).toFixed(1)}" y1="${(y1 + j(0.8)).toFixed(1)}" x2="${(x2 + j(0.8)).toFixed(1)}" y2="${(y2 + j(0.8)).toFixed(1)}" stroke="${color}" stroke-width="${width}" stroke-linecap="round" opacity="${opacity}"/>`;
}

/** 手绘矩形：四条独立的线（不许闭合，才有手绘断口感）。 */
function pencilRect(x, y, w, h, jitter, opts = {}) {
  return [
    pencilLine(x, y, x + w, y, jitter, opts),
    pencilLine(x + w, y, x + w, y + h, jitter, opts),
    pencilLine(x + w, y + h, x, y + h, jitter, opts),
    pencilLine(x, y + h, x, y, jitter, opts),
  ].join('');
}

/** 手绘折线。 */
function pencilPath(points, jitter, { color = PALETTE.ink, width = 2, dash = '' } = {}) {
  const d = points
    .map(([x, y], i) => `${i ? 'L' : 'M'}${(x + jitter(0.9)).toFixed(1)},${(y + jitter(0.9)).toFixed(1)}`)
    .join(' ');
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}

/** 手绘箭头（线 + 两道短线当箭头）。 */
function pencilArrow(x1, y1, x2, y2, jitter, opts = {}) {
  const { color = PALETTE.ink, width = 2 } = opts;
  const a = Math.atan2(y2 - y1, x2 - x1);
  const len = 11;
  const head = [
    [x2 - len * Math.cos(a - 0.42), y2 - len * Math.sin(a - 0.42)],
    [x2 - len * Math.cos(a + 0.42), y2 - len * Math.sin(a + 0.42)],
  ];
  return (
    pencilLine(x1, y1, x2, y2, jitter, { color, width }) +
    head.map(([hx, hy]) => pencilLine(x2, y2, hx, hy, jitter, { color, width })).join('')
  );
}

/** 多行文字（左对齐或居中）。 */
function textBlock(lines, x, y, size, { font = FONT_META, color = PALETTE.ink, anchor = 'start', lineHeight = 1.35, weight = 400 } = {}) {
  return lines
    .map(
      (line, i) =>
        `<text x="${x}" y="${(y + i * size * lineHeight).toFixed(1)}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${escapeXml(line)}</text>`,
    )
    .join('');
}

/** 手写批注：文字 + 下划波浪线。 */
function annotation(text, x, y, maxWidth, size, jitter, { color = PALETTE.blue } = {}) {
  const lines = wrapText(stripDecorative(text), maxWidth, size).slice(0, 3);
  const out = [textBlock(lines, x, y, size, { font: FONT_HAND, color: PALETTE.ink, lineHeight: 1.5 })];
  const lastY = y + (lines.length - 1) * size * 1.5 + 6;
  const w = Math.min(maxWidth, textWidth(lines[lines.length - 1] || '', size));
  const pts = [];
  for (let px = 0; px <= w; px += 14) pts.push([x + px, lastY + Math.sin(px / 9) * 1.2]);
  out.push(pencilPath(pts, jitter, { color, width: 1.6 }));
  return out.join('');
}

/**
 * 中央数据条（不是折线图）：
 * 一张海报上的几个结论数字往往**不是同一维度的序列**，画成折线会暗示不存在的趋势。
 * 所以用横向条形 + 各自的标签与条件句：信息密度高，也不会骗人。
 */
function drawBars({ x, y, w, h, numbers, jitter }) {
  // 没有标签的图（小节配图常见）就把标签列让给条形，别留一条空列
  const hasLabels = numbers.some((n) => String(n.label || '').trim());
  const labelW = hasLabels ? Math.min(150, w * 0.22) : 4;
  const barX = x + labelW + 16;
  const barMax = w - labelW - 140;
  const rows = numbers.slice(0, 5);
  // 行高跟着可用高度走：内容少的时候把条形摊开，避免下面留一大片空白
  const rowH = Math.max(64, Math.min(160, (h - 56) / Math.max(1, rows.length)));
  const values = rows.map((n) => {
    const m = String(n.value).match(/-?\d+(?:[.,]\d+)?/);
    return m ? Math.abs(Number(m[0].replace(',', ''))) : 0;
  });
  const maxV = Math.max(...values, 1);
  const best = values.indexOf(Math.max(...values));
  const printedConds = new Set();
  const parts = [];
  // 基线
  parts.push(pencilLine(barX - 8, y + 8, barX - 8, y + rows.length * rowH - 18, jitter, { color: PALETTE.ink, width: 1.8 }));
  rows.forEach((n, i) => {
    const cy = y + i * rowH + 20;
    const barW = Math.max(24, (values[i] / maxV) * barMax);
    const color = i === best ? PALETTE.red : PALETTE.blue;
    // 标签（指标名；没有就不占位）
    if (hasLabels && String(n.label || '').trim()) {
      parts.push(
        textBlock(wrapText(stripDecorative(n.label), labelW - 8, 15).slice(0, 2), x + 4, cy + 4, 15, {
          font: FONT_HAND,
          color: PALETTE.ink,
        }),
      );
    }
    // 条形：手绘两条线夹一条描边，像铅笔涂过
    parts.push(`<rect x="${barX.toFixed(1)}" y="${(cy - 12).toFixed(1)}" width="${barW.toFixed(1)}" height="20" fill="none" stroke="${PALETTE.paper}"/>`);
    parts.push(pencilRect(barX, cy - 12, barW, 20, jitter, { color, width: 1.8 }));
    for (let hx = barX + 8; hx < barX + barW - 6; hx += 11) {
      parts.push(pencilLine(hx, cy - 9, hx + 5, cy + 9, jitter, { color, width: 1, opacity: 0.35 }));
    }
    parts.push(textBlock([n.value], barX + barW + 12, cy + 5, 18, { font: FONT_HAND, color: PALETTE.ink, weight: 600 }));
    // 条件句：小字贴在条形下方（信息密度就在这里）；同一句只印一次
    const cond = String(n.condition || '').replace(/\$[^$]*\$/g, '').replace(/\s+/g, ' ').trim();
    if (cond && !printedConds.has(cond)) {
      printedConds.add(cond);
      parts.push(textBlock(wrapText(cond, w - labelW - 60, 12).slice(0, 1), barX, cy + 26, 12, { color: PALETTE.inkSoft }));
    }
  });
  parts.push(textBlock(['结论数字（长度按数值等比，红色为最大项）'], x + 4, y + rows.length * rowH + 6, 12, { color: PALETTE.pencil }));
  return parts.join('');
}

/** 中央流程图：节点 + 箭头（自动换行成两行）。 */
function drawPipeline({ x, y, w, h, steps, jitter }) {
  const parts = [];
  const perRow = Math.ceil(steps.length / 2);
  const rows = perRow > 0 ? Math.ceil(steps.length / perRow) : 1;
  const nodeW = (w - 40 - (perRow - 1) * 46) / perRow;
  // 节点高度跟着可用高度走（行间距也一起放大），避免流程图下面留一大片白
  const rowGap = rows > 1 ? Math.max(64, Math.min(120, (h - 60) * 0.22)) : 0;
  const nodeH = Math.max(96, Math.min(190, (h - 48 - (rows - 1) * rowGap) / rows));
  steps.slice(0, 6).forEach((step, i) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const reverse = row % 2 === 1;
    const c = reverse ? perRow - 1 - col : col;
    const nx = x + 20 + c * (nodeW + 46);
    const ny = y + 20 + row * (nodeH + rowGap);
    parts.push(`<rect x="${nx.toFixed(1)}" y="${ny.toFixed(1)}" width="${nodeW.toFixed(1)}" height="${nodeH.toFixed(1)}" rx="10" fill="none" stroke="${PALETTE.paper}"/>`);
    parts.push(pencilRect(nx, ny, nodeW, nodeH, jitter, { color: i === 0 ? PALETTE.red : PALETTE.ink, width: 2 }));
    const lines = wrapText(stripDecorative(step), nodeW - 26, 17).slice(0, 3);
    parts.push(textBlock(lines, nx + 13, ny + 30, 17, { font: FONT_HAND, color: PALETTE.ink, lineHeight: 1.45 }));
    const nextCol = i + 1;
    const sameRow = Math.floor(nextCol / perRow) === row && nextCol < steps.length && i < 5;
    if (sameRow) {
      const fromX = reverse ? nx - 10 : nx + nodeW + 10;
      const toX = reverse ? nx - 36 : nx + nodeW + 36;
      parts.push(pencilArrow(fromX, ny + nodeH / 2, toX, ny + nodeH / 2, jitter, { color: PALETTE.ink, width: 2 }));
    } else if (i < Math.min(steps.length, 6) - 1) {
      const bendY = ny + nodeH + rowGap / 2;
      parts.push(pencilPath([[nx + nodeW / 2, ny + nodeH + 6], [nx + nodeW / 2, bendY], [x + 40, bendY]], jitter, { color: PALETTE.ink, width: 2 }));
      parts.push(pencilArrow(x + 62, bendY, x + 30, bendY, jitter, { color: PALETTE.ink, width: 2 }));
    }
  });
  return parts.join('');
}

/** 中央概念图：中心节点 + 放射连线。 */
function drawConcept({ x, y, w, h, title, steps, jitter }) {
  const parts = [];
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = w * 0.30;
  const ry = h * 0.32;
  parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="${PALETTE.paper}"/>`);
  parts.push(
    `<ellipse cx="${cx}" cy="${cy}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="none" stroke="${PALETTE.ink}" stroke-width="2.4" stroke-linecap="round"/>`,
  );
  const centerLines = wrapText(stripDecorative(title), rx * 1.5, 20).slice(0, 3);
  parts.push(textBlock(centerLines, cx, cy - (centerLines.length - 1) * 15, 20, { font: FONT_HAND, anchor: 'middle', weight: 600, lineHeight: 1.5 }));
  const n = Math.min(steps.length, 5) || 3;
  for (let i = 0; i < n; i += 1) {
    const ang = (-Math.PI / 2) + (i * 2 * Math.PI) / n;
    const px = cx + Math.cos(ang) * rx * 1.9;
    const py = cy + Math.sin(ang) * ry * 1.85;
    const fromX = cx + Math.cos(ang) * rx;
    const fromY = cy + Math.sin(ang) * ry;
    parts.push(pencilArrow(fromX, fromY, px - Math.cos(ang) * 66, py - Math.sin(ang) * 34, jitter, { color: PALETTE.blue, width: 1.8 }));
    const lines = wrapText(stripDecorative(steps[i] || ''), 200, 15).slice(0, 3);
    parts.push(textBlock(lines, px, py, 15, { font: FONT_HAND, anchor: 'middle', color: PALETTE.ink, lineHeight: 1.4 }));
  }
  return parts.join('');
}

/**
 * 公式面板：用 KaTeX MathML 真排版（不是把 LaTeX 拍平成字符串）。
 * 公式宽度不可预估，所以按字符数估一个字号，让它尽量落在面板里。
 */
function drawFormula({ x, y, w, h, latex, jitter }) {
  const parts = [pencilRect(x, y, w, h, jitter, { color: PALETTE.ink, width: 1.6, opacity: 0.85 })];
  parts.push(textBlock(['核心公式'], x + 14, y + 24, 13, { color: PALETTE.inkSoft }));
  const mathml = renderMathMl(latex);
  if (mathml) {
    // 字号按字符数收缩：长公式在小面板里也不至于溢出
    const len = String(latex || '').length;
    const size = Math.max(15, Math.min(30, Math.round((w * 1.9) / Math.max(12, len))));
    const boxTop = y + 40;
    const boxH = Math.max(40, h - 54);
    parts.push(
      `<foreignObject x="${x + 12}" y="${boxTop}" width="${w - 24}" height="${boxH}">` +
        `<div xmlns="http://www.w3.org/1999/xhtml" style="font-size:${size}px;line-height:1.35;color:${PALETTE.blue};overflow:hidden">${mathml}</div>` +
        `</foreignObject>`,
    );
  } else {
    parts.push(textBlock([String(latex || '').slice(0, 60)], x + 14, y + 56, 16, { font: FONT_CODE, color: PALETTE.blue }));
  }
  return parts.join('');
}

/** 决策树面板：一个分叉 + 两个叶子。 */
function drawTree({ x, y, w, h, branches, jitter }) {
  const parts = [pencilRect(x, y, w, h, jitter, { color: PALETTE.ink, width: 1.6, opacity: 0.85 })];
  parts.push(textBlock(['取舍与边界'], x + 14, y + 24, 13, { color: PALETTE.inkSoft }));
  const rootX = x + 26;
  const rootY = y + h / 2 + 6;
  parts.push(textBlock(['方案'], rootX, rootY + 5, 15, { font: FONT_HAND }));
  const midX = x + w * 0.42;
  parts.push(pencilArrow(rootX + 38, rootY, midX, rootY, jitter, { color: PALETTE.ink, width: 1.8 }));
  const upY = y + h * 0.34;
  const downY = y + h * 0.78;
  parts.push(pencilPath([[midX, rootY], [midX, upY], [midX + 34, upY]], jitter, { color: PALETTE.blue, width: 1.8 }));
  parts.push(pencilPath([[midX, rootY], [midX, downY], [midX + 34, downY]], jitter, { color: PALETTE.red, width: 1.8 }));
  // 文本宽度按「面板右边界」算，避免枝干文字越出面板
  const branchW = Math.max(80, x + w - 14 - (midX + 40));
  const upLines = wrapText(stripDecorative(branches[0] || '保留'), branchW, 13).slice(0, 2);
  const downLines = wrapText(stripDecorative(branches[1] || '去掉'), branchW, 13).slice(0, 2);
  parts.push(textBlock(upLines, midX + 40, upY + 5, 13, { font: FONT_HAND, color: PALETTE.blue, lineHeight: 1.35 }));
  parts.push(textBlock(downLines, midX + 40, downY + 5, 13, { font: FONT_HAND, color: PALETTE.red, lineHeight: 1.35 }));
  return parts.join('');
}

/** 代码结构面板：把步骤画成缩进的伪代码骨架。 */
function drawCode({ x, y, w, h, lines, jitter }) {
  const parts = [pencilRect(x, y, w, h, jitter, { color: PALETTE.ink, width: 1.6, opacity: 0.85 })];
  parts.push(textBlock(['实现结构'], x + 14, y + 24, 13, { color: PALETTE.inkSoft }));
  const body = (lines || []).slice(0, 5).map((l, i) => `${'  '.repeat(i ? 1 : 0)}- ${stripDecorative(l)}`);
  parts.push(textBlock(body.flatMap((l) => wrapText(l, w - 28, 14)).slice(0, 6), x + 14, y + 52, 14, { font: FONT_CODE, color: PALETTE.inkSoft, lineHeight: 1.55 }));
  return parts.join('');
}

/** 时间轴面板：年份 + 刻度。 */
function drawTimeline({ x, y, w, h, years, jitter }) {
  const parts = [pencilRect(x, y, w, h, jitter, { color: PALETTE.ink, width: 1.6, opacity: 0.85 })];
  parts.push(textBlock(['时间线'], x + 14, y + 24, 13, { color: PALETTE.inkSoft }));
  const axisY = y + h / 2 + 10;
  parts.push(pencilArrow(x + 20, axisY, x + w - 20, axisY, jitter, { color: PALETTE.ink, width: 1.8 }));
  years.slice(0, 4).forEach((yr, i, arr) => {
    const px = x + 34 + ((w - 68) * i) / Math.max(1, arr.length - 1);
    parts.push(pencilLine(px, axisY - 7, px, axisY + 7, jitter, { color: PALETTE.red, width: 1.8 }));
    parts.push(textBlock([yr], px, axisY - 16, 14, { font: FONT_HAND, anchor: 'middle', color: PALETTE.ink }));
  });
  return parts.join('');
}

/** 术语与来源面板：模块数为奇数时补位，同时把「术语 + 出处」交代清楚。 */
function drawNotes({ x, y, w, h, tags, sourceUrl, sections, jitter }) {
  const parts = [pencilRect(x, y, w, h, jitter, { color: PALETTE.ink, width: 1.6, opacity: 0.85 })];
  parts.push(textBlock(['术语与来源'], x + 14, y + 24, 13, { color: PALETTE.inkSoft }));
  const lines = [];
  if (tags?.length) lines.push(`术语：${tags.slice(0, 5).join(' · ')}`);
  if (sections) lines.push(`全文按 ${sections} 个小节拆解，数字均回查原文切片。`);
  if (sourceUrl) lines.push(`原文：${sourceUrl}`);
  parts.push(
    textBlock(lines.flatMap((l) => wrapText(l, w - 28, 14)).slice(0, 6), x + 14, y + 54, 14, {
      font: FONT_HAND,
      color: PALETTE.inkSoft,
      lineHeight: 1.6,
    }),
  );
  return parts.join('');
}

/** 页眉术语带：标签用方框圈住（手绘感）。 */
function drawTags(tags, x, y, jitter, maxWidth) {
  const parts = [];
  let cx = x;
  for (const tag of tags.slice(0, 6)) {
    const w = textWidth(tag, 14) + 22;
    if (cx + w > x + maxWidth) break;
    parts.push(pencilRect(cx, y - 18, w, 26, jitter, { color: PALETTE.pencil, width: 1.2 }));
    parts.push(textBlock([tag], cx + 11, y, 14, { color: PALETTE.inkSoft }));
    cx += w + 10;
  }
  return parts.join('');
}

/** 纸张纹理：二维噪声叠加 + 四角订书/胶带痕迹。 */
function paperTexture({ w, h, jitter }) {
  const parts = [
    `<rect x="0" y="0" width="${w}" height="${h}" fill="${PALETTE.paper}"/>`,
    `<rect x="0" y="0" width="${w}" height="${h}" fill="url(#grain)" opacity="0.5"/>`,
  ];
  // 边框：双线，略歪
  parts.push(pencilRect(28, 28, w - 56, h - 56, jitter, { color: PALETTE.pencil, width: 1.2, opacity: 0.7 }));
  parts.push(pencilRect(36, 36, w - 72, h - 72, jitter, { color: PALETTE.ink, width: 1.6, opacity: 0.6 }));
  // 四角短线（像贴纸/装订痕）
  const corners = [
    [28, 28, 1, 1],
    [w - 28, 28, -1, 1],
    [28, h - 28, 1, -1],
    [w - 28, h - 28, -1, -1],
  ];
  for (const [cx, cy, sx, sy] of corners) {
    parts.push(pencilLine(cx, cy, cx + 26 * sx, cy + 8 * sy, jitter, { color: PALETTE.red, width: 2.2 }));
  }
  return parts.join('');
}

/**
 * 渲染整张海报 SVG。
 * @param {{content:object, structure:object, width?:number, height?:number, footer?:string}} args
 */
/**
 * 单节配图：同一套手绘语言（纸纹 / 铅笔线稿 / 蓝红强调），横版 1200×660。
 * 内容是「这一节的重述图」，不是复刻原论文插图——底部会写明依据与出处。
 */
export function renderFigureSvg({
  section = {},
  index = 1,
  total = 1,
  width = 1200,
  height = 660,
  sourceNote = '',
  fontCss = '',
} = {}) {
  const W = width;
  const H = height;
  const jitter = makeJitter(`fig|${section.title || ''}|${index}|${W}x${H}`);
  const pad = 44;
  const innerW = W - pad * 2;
  const parts = [
    `<defs>${fontCss ? `<style>${fontCss}</style>` : ''}<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="7"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope="0.05"/></feComponentTransfer></filter></defs>`,
  ];
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${PALETTE.paper}"/>`);
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="url(#grain)" opacity="0.5"/>`);
  parts.push(pencilRect(18, 18, W - 36, H - 36, jitter, { color: PALETTE.pencil, width: 1.1, opacity: 0.65 }));
  parts.push(pencilRect(25, 25, W - 50, H - 50, jitter, { color: PALETTE.ink, width: 1.4, opacity: 0.5 }));

  // 页眉：序号 + 小节标题（手写）
  parts.push(textBlock([`手绘重述 · 第 ${index}/${total} 节`], pad, 62, 13, { color: PALETTE.inkSoft }));
  const titleSize = String(section.title || '').length > 22 ? 28 : 34;
  const titleLines = wrapText(stripDecorative(section.title), innerW * 0.72, titleSize).slice(0, 2);
  parts.push(textBlock(titleLines, pad, 62 + titleSize + 6, titleSize, { font: FONT_HAND, weight: 700, lineHeight: 1.24 }));
  const headerBottom = 62 + titleSize + 6 + titleLines.length * titleSize * 1.24;
  parts.push(pencilLine(pad, headerBottom + 6, pad + 300, headerBottom + 6, jitter, { color: PALETTE.red, width: 2.2 }));

  // 主体：左图右注
  const bodyTop = headerBottom + 26;
  const bodyH = H - bodyTop - pad - 30;
  const leftW = innerW * 0.62;
  const dArgs = { x: pad + 10, y: bodyTop + 10, w: leftW - 20, h: bodyH - 20, jitter };
  if (section.primary === 'curve' && (section.numbers || []).length >= 1) {
    parts.push(drawBars({ ...dArgs, numbers: section.numbers.slice(0, 3) }));
  } else if (section.primary === 'pipeline' && (section.steps || []).length >= 2) {
    parts.push(drawPipeline({ ...dArgs, steps: section.steps.slice(0, 4) }));
  } else {
    parts.push(drawConcept({ ...dArgs, title: section.title, steps: section.steps || [] }));
  }

  const rightX = pad + leftW + 20;
  const rightW = innerW - leftW - 20;
  const boxes = [];
  if (section.formula) boxes.push('formula');
  if (section.claims?.length) boxes.push('annotation');
  // 有术语时才补「术语与来源」面板；否则让公式/批注自己占满右栏
  if (boxes.length < 2 && (section.tags || []).length) boxes.push('notes');
  const boxGap = 14;
  const boxH = (bodyH - (boxes.length - 1) * boxGap) / boxes.length;
  boxes.forEach((kind, i) => {
    const y = bodyTop + i * (boxH + boxGap);
    if (kind === 'formula') {
      parts.push(drawFormula({ x: rightX, y, w: rightW, h: boxH, latex: section.formula.latex, jitter }));
    } else if (kind === 'annotation') {
      parts.push(pencilRect(rightX, y, rightW, boxH, jitter, { color: PALETTE.ink, width: 1.6, opacity: 0.85 }));
      parts.push(textBlock(['手写批注'], rightX + 14, y + 24, 13, { color: PALETTE.inkSoft }));
      parts.push(annotation(section.claims[0], rightX + 14, y + 52, rightW - 28, 15, jitter, { color: PALETTE.blue }));
    } else {
      parts.push(
        drawNotes({
          x: rightX,
          y,
          w: rightW,
          h: boxH,
          tags: section.tags,
          sourceUrl: '',
          sections: 0,
          jitter,
        }),
      );
    }
  });

  parts.push(pencilLine(pad, H - pad - 16, W - pad, H - pad - 16, jitter, { color: PALETTE.pencil, width: 1 }));
  parts.push(
    textBlock([sourceNote || '本图由解读正文自动重述，不是论文原图；原图见文末出处。'], pad, H - pad + 6, 12, {
      color: PALETTE.inkSoft,
      font: FONT_HAND,
    }),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
}

export function renderCoverSvg({
  content = {},
  structure = {},
  width = 1200,
  height = 1600,
  footer = '青稞解读 · 论文深度解读',
  fontCss = '',
} = {}) {
  // 宽版（横图）走两栏排版：左栏标题 + 中央图，右栏模块；竖版走上下分带
  if (width > height * 1.25) {
    return renderLandscape({ content, structure, width, height, footer, fontCss });
  }
  const jitter = makeJitter(`${content.title || ''}|${width}x${height}`);
  const W = width;
  const H = height;
  const pad = 64;
  const innerW = W - pad * 2;
  const parts = [];

  parts.push(
    `<defs>${fontCss ? `<style>${fontCss}</style>` : ''}<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="7"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope="0.055"/></feComponentTransfer></filter></defs>`,
  );
  parts.push(paperTexture({ w: W, h: H, jitter }));

  // ── 页眉：出处 + 标题 + 副标题 + 术语带 ──
  let y = pad + 52;
  parts.push(textBlock([`${footer}${content.sourceUrl ? `　·　${content.sourceUrl}` : ''}`], pad, y, 15, { color: PALETTE.inkSoft }));
  y += 46;
  const titleSize = content.title && content.title.length > 34 ? 44 : 52;
  const titleLines = wrapText(stripDecorative(content.title), innerW - 20, titleSize).slice(0, 3);
  parts.push(textBlock(titleLines, pad, y, titleSize, { font: FONT_HAND, weight: 700, lineHeight: 1.28 }));
  parts.push(pencilLine(pad, y + titleLines.length * titleSize * 1.28 - 14, pad + Math.min(innerW * 0.42, 420), y + titleLines.length * titleSize * 1.28 - 14, jitter, { color: PALETTE.red, width: 2.6 }));
  y += titleLines.length * titleSize * 1.28 + 12;
  const subLines = wrapText(stripDecorative(content.subtitle), innerW - 40, 20).slice(0, 2);
  parts.push(textBlock(subLines, pad, y + 8, 20, { color: PALETTE.inkSoft, lineHeight: 1.5, font: FONT_HAND }));
  y += subLines.length * 30 + 26;
  parts.push(drawTags(content.tags || [], pad, y, jitter, innerW));
  y += 30;

  // ── 先算版面预算，再把中央图放大到吃掉剩余空间（页面不留半页空白）──
  const diagramTop = y + 8;
  const footerTop = H - pad - 44;
  const moduleH = 168;
  const moduleGap = 22;
  const years = [...new Set(String((content.steps || []).join(' ')).match(/\b(19|20)\d{2}\b/g) || [])].slice(0, 4);
  const mods = structure.modules || [];
  const slots = [];
  if (mods.includes('formula') && content.formula) slots.push('formula');
  if (mods.includes('tree') && (content.steps || []).length) slots.push('tree');
  if (mods.includes('code') && (content.steps || []).length) slots.push('code');
  if (mods.includes('timeline') && years.length >= 2) slots.push('timeline');
  slots.splice(4);
  // 奇数个模块会空出半个格子：用「术语与来源」补位（顺带把出处交代清楚）
  if (slots.length % 2 === 1) slots.push('notes');
  const claims = (content.claims || []).slice(0, 2);
  const claimsH = claims.length ? claims.length * 78 : 0;
  const moduleRows = Math.ceil(slots.length / 2);
  const reserved = moduleRows * (moduleH + moduleGap) + claimsH;
  // 中央图按内容算高（数据条按条数、流程按节点行数、概念图固定），再把剩余空间作为留白分摊
  const needDiagram =
    structure.primary === 'curve'
      ? 54 + Math.min(5, (content.numbers || []).length || 1) * 96
      : structure.primary === 'pipeline'
        ? 60 + Math.ceil(Math.min(6, (content.steps || []).length || 2) / 3) * 176
        : 420;
  // 剩余空间：55% 给中央图（它是视觉中心）、其余摊成三段留白，最后剩一点做页脚上方留白
  const free = footerTop - diagramTop - reserved - needDiagram;
  const toDiagram = free > 0 ? Math.min(Math.round(free * 0.55), Math.round(needDiagram * 0.7), 340) : 0;
  const rest = free - toDiagram;
  const slack = Math.max(18, Math.min(56, Math.round(rest / 3)));
  const diagramH = Math.round(needDiagram + toDiagram);

  parts.push(pencilRect(pad, diagramTop, innerW, diagramH, jitter, { color: PALETTE.ink, width: 2.4 }));
  parts.push(
    textBlock([structure.reason ? `视觉结构：${structure.reason}` : '视觉结构'], pad + 16, diagramTop + 26, 13, { color: PALETTE.inkSoft }),
  );
  const dArgs = { x: pad + 12, y: diagramTop + 34, w: innerW - 24, h: diagramH - 46, jitter };
  if (structure.primary === 'curve' && (content.numbers || []).length >= 2) {
    parts.push(drawBars({ ...dArgs, numbers: content.numbers.slice(0, 5) }));
  } else if (structure.primary === 'pipeline' && (content.steps || []).length) {
    parts.push(drawPipeline({ ...dArgs, steps: content.steps }));
  } else {
    parts.push(drawConcept({ ...dArgs, title: content.title, steps: content.steps || [] }));
  }

  // ── 辅助模块（2 列）──
  let my = diagramTop + diagramH + slack;
  const moduleW = (innerW - 26) / 2;
  slots.forEach((kind, i) => {
    const mx = pad + (i % 2) * (moduleW + 26);
    const mxy = my + Math.floor(i / 2) * (moduleH + moduleGap);
    const box = { x: mx, y: mxy, w: moduleW, h: moduleH, jitter };
    if (kind === 'formula') parts.push(drawFormula({ ...box, latex: content.formula.latex }));
    else if (kind === 'tree') parts.push(drawTree({ ...box, branches: [content.steps[1] || '保留', content.steps[2] || '去掉'] }));
    else if (kind === 'code') parts.push(drawCode({ ...box, lines: content.steps }));
    else if (kind === 'timeline') parts.push(drawTimeline({ ...box, years }));
    else
      parts.push(
        drawNotes({ ...box, tags: content.tags, sourceUrl: content.sourceUrl, sections: content.sections }),
      );
  });
  my += moduleRows * (moduleH + moduleGap);

  // ── 手写批注：短引线指回上方图纸（不再画横穿整页的长箭头）──
  if (claims.length) {
    my += Math.max(0, slack - moduleGap);
    claims.forEach((claim, i) => {
      const color = i ? PALETTE.red : PALETTE.blue;
      const ny = my + 46 + i * 78;
      const noteX = pad + 34;
      parts.push(pencilLine(noteX - 14, ny - 34, noteX - 14, ny + 6, jitter, { color, width: 1.6 }));
      parts.push(`<circle cx="${noteX - 14}" cy="${ny - 38}" r="3.2" fill="${color}"/>`);
      parts.push(textBlock([i ? '边界批注' : '论文主张'], noteX - 4, ny - 30, 12, { color: PALETTE.inkSoft }));
      parts.push(annotation(claim, noteX, ny, innerW - 80, 18, jitter, { color }));
    });
    my += claimsH;
  }

  // ── 页脚 ──
  parts.push(pencilLine(pad, H - pad - 34, W - pad, H - pad - 34, jitter, { color: PALETTE.pencil, width: 1.2 }));
  parts.push(
    textBlock(
      ['从论文到推论：黑色为原文事实线，蓝色为本文推演，红色为边界与取舍。'],
      pad,
      H - pad - 10,
      13,
      { color: PALETTE.inkSoft, font: FONT_HAND },
    ),
  );
  parts.push(textBlock([`${W}×${H}`], W - pad, H - pad - 10, 12, { color: PALETTE.pencil, anchor: 'end' }));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
}

/** 横版头图：两栏（左：标题 + 中央图；右：模块 + 批注）。 */
function renderLandscape({ content, structure, width, height, footer, fontCss = '' }) {
  const W = width;
  const H = height;
  const jitter = makeJitter(`${content.title || ''}|landscape|${W}x${H}`);
  const pad = 48;
  const innerW = W - pad * 2;
  const parts = [
    `<defs>${fontCss ? `<style>${fontCss}</style>` : ''}<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="7"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope="0.055"/></feComponentTransfer></filter></defs>`,
  ];
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${PALETTE.paper}"/>`);
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="url(#grain)" opacity="0.5"/>`);
  parts.push(pencilRect(20, 20, W - 40, H - 40, jitter, { color: PALETTE.pencil, width: 1.2, opacity: 0.7 }));
  parts.push(pencilRect(27, 27, W - 54, H - 54, jitter, { color: PALETTE.ink, width: 1.5, opacity: 0.55 }));

  // 页眉（整宽）
  parts.push(textBlock([`${footer}${content.sourceUrl ? `　·　${content.sourceUrl}` : ''}`], pad, 62, 14, { color: PALETTE.inkSoft }));
  const titleSize = String(content.title || '').length > 30 ? 36 : 44;
  const titleLines = wrapText(stripDecorative(content.title), innerW * 0.62, titleSize).slice(0, 2);
  parts.push(textBlock(titleLines, pad, 66 + titleSize, titleSize, { font: FONT_HAND, weight: 700, lineHeight: 1.24 }));
  const afterTitle = 66 + titleSize + titleLines.length * titleSize * 1.24;
  parts.push(pencilLine(pad, afterTitle, pad + 320, afterTitle, jitter, { color: PALETTE.red, width: 2.4 }));
  const subLines = wrapText(stripDecorative(content.subtitle), innerW * 0.62, 17).slice(0, 2);
  parts.push(textBlock(subLines, pad, afterTitle + 26, 17, { font: FONT_HAND, color: PALETTE.inkSoft }));
  parts.push(drawTags(content.tags || [], pad, afterTitle + 26 + subLines.length * 24 + 24, jitter, innerW * 0.6));

  // 左栏：中央图
  const bodyTop = afterTitle + 26 + subLines.length * 24 + 62;
  const bodyH = H - bodyTop - pad - 34;
  const leftW = innerW * 0.585;
  parts.push(pencilRect(pad, bodyTop, leftW, bodyH, jitter, { color: PALETTE.ink, width: 2.2 }));
  parts.push(textBlock([structure.reason ? `视觉结构：${structure.reason}` : '视觉结构'], pad + 14, bodyTop + 22, 12, { color: PALETTE.inkSoft }));
  const dArgs = { x: pad + 10, y: bodyTop + 28, w: leftW - 20, h: bodyH - 38, jitter };
  if (structure.primary === 'curve' && (content.numbers || []).length >= 2) parts.push(drawBars({ ...dArgs, numbers: content.numbers.slice(0, 5) }));
  else if (structure.primary === 'pipeline' && (content.steps || []).length) parts.push(drawPipeline({ ...dArgs, steps: content.steps }));
  else parts.push(drawConcept({ ...dArgs, title: content.title, steps: content.steps || [] }));

  // 右栏：模块（纵向堆叠，最多 3 个）+ 批注
  const rightX = pad + leftW + 22;
  const rightW = innerW - leftW - 22;
  const claims = (content.claims || []).slice(0, 1);
  const noteH = claims.length ? 118 : 0;
  const years = [...new Set(String((content.steps || []).join(' ')).match(/\b(19|20)\d{2}\b/g) || [])].slice(0, 4);
  const mods = structure.modules || [];
  const kinds = [];
  if (mods.includes('formula') && content.formula) kinds.push('formula');
  if (mods.includes('tree') && (content.steps || []).length) kinds.push('tree');
  if (mods.includes('timeline') && years.length >= 2) kinds.push('timeline');
  if (mods.includes('code') && (content.steps || []).length) kinds.push('code');
  kinds.push('notes');
  const picked = kinds.slice(0, 3);
  const modGap = 16;
  const modH = (bodyH - noteH - (picked.length - 1) * modGap - (noteH ? modGap : 0)) / picked.length;
  picked.forEach((kind, i) => {
    const box = { x: rightX, y: bodyTop + i * (modH + modGap), w: rightW, h: modH, jitter };
    if (kind === 'formula') parts.push(drawFormula({ ...box, latex: content.formula.latex }));
    else if (kind === 'tree') parts.push(drawTree({ ...box, branches: [content.steps[1] || '保留', content.steps[2] || '去掉'] }));
    else if (kind === 'timeline') parts.push(drawTimeline({ ...box, years }));
    else if (kind === 'code') parts.push(drawCode({ ...box, lines: content.steps }));
    else parts.push(drawNotes({ ...box, tags: content.tags, sourceUrl: content.sourceUrl, sections: content.sections }));
  });
  if (claims.length) {
    const y = bodyTop + bodyH - noteH + 30;
    parts.push(textBlock(['论文主张'], rightX, y - 12, 12, { color: PALETTE.inkSoft }));
    parts.push(annotation(claims[0], rightX, y + 6, rightW - 10, 15, jitter, { color: PALETTE.blue }));
  }

  parts.push(pencilLine(pad, H - pad - 22, W - pad, H - pad - 22, jitter, { color: PALETTE.pencil, width: 1.1 }));
  parts.push(
    textBlock(['黑＝原文事实　蓝＝本文推演　红＝边界与取舍'], pad, H - pad + 2, 12, { color: PALETTE.inkSoft, font: FONT_HAND }),
  );
  parts.push(textBlock([`${W}×${H}`], W - pad, H - pad + 2, 11, { color: PALETTE.pencil, anchor: 'end' }));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
}
