/**
 * 手绘原语：头图 / 正文配图 / 专题速记图共用的一套「铅笔线稿」画法。
 *
 * 只做三件事，保持和海报一致的观感：
 *   · 一切图形只描边（不填色块）、线端圆角；
 *   · 线条带**确定性抖动**（同一 seed 永远同一张图），才有手绘的断口感；
 *   · 颜色只用 PALETTE 里那几种（纸张 / 铅笔 / 蓝 / 红）。
 *
 * 公式一律走 KaTeX 的 MathML（浏览器原生排版），所以这里只负责把它塞进 foreignObject。
 */

import { PALETTE, escapeXml, wrapText, renderMathMl } from './svg.js';

/** 与海报一致的手写体栈：系统行楷优先，其次仓库内嵌的霞鹜文楷 Lite。 */
export const FONT_HAND = "'Xingkai SC','Hanzipen SC','LXGW WenKai Lite','Kaiti SC','STKaiti','KaiTi',serif";
export const TAU = Math.PI * 2;

export function pencilLine(x1, y1, x2, y2, jitter, { color = PALETTE.ink, width = 2, opacity = 1, dash = '' } = {}) {
  return (
    `<line x1="${(x1 + jitter(0.8)).toFixed(1)}" y1="${(y1 + jitter(0.8)).toFixed(1)}" ` +
    `x2="${(x2 + jitter(0.8)).toFixed(1)}" y2="${(y2 + jitter(0.8)).toFixed(1)}" stroke="${color}" ` +
    `stroke-width="${width}" stroke-linecap="round" opacity="${opacity}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`
  );
}

export function pencilRect(x, y, w, h, jitter, opts = {}) {
  return [
    pencilLine(x, y, x + w, y, jitter, opts),
    pencilLine(x + w, y, x + w, y + h, jitter, opts),
    pencilLine(x + w, y + h, x, y + h, jitter, opts),
    pencilLine(x, y + h, x, y, jitter, opts),
  ].join('');
}

export function pencilPath(points, jitter, { color = PALETTE.ink, width = 2, dash = '', opacity = 1 } = {}) {
  const d = points
    .map(([x, y], i) => `${i ? 'L' : 'M'}${(x + jitter(0.9)).toFixed(1)},${(y + jitter(0.9)).toFixed(1)}`)
    .join(' ');
  return (
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" ` +
    `stroke-linejoin="round" opacity="${opacity}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`
  );
}

export function pencilArrow(x1, y1, x2, y2, jitter, { color = PALETTE.ink, width = 2, dash = '' } = {}) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const len = 11;
  const head = [
    [x2 - len * Math.cos(a - 0.42), y2 - len * Math.sin(a - 0.42)],
    [x2 - len * Math.cos(a + 0.42), y2 - len * Math.sin(a + 0.42)],
  ];
  return (
    pencilLine(x1, y1, x2, y2, jitter, { color, width, dash }) +
    head.map(([hx, hy]) => pencilLine(x2, y2, hx, hy, jitter, { color, width })).join('')
  );
}

/** 手绘椭圆（梯度云 / 分布草图）：参数化采样成折线，抖动后自然歪一点。 */
export function pencilEllipse(cx, cy, rx, ry, rotDeg, jitter, { color = PALETTE.ink, width = 2, opacity = 1 } = {}) {
  const rot = (rotDeg * Math.PI) / 180;
  const pts = [];
  for (let i = 0; i <= 72; i += 1) {
    const t = (i / 72) * TAU;
    const px = Math.cos(t) * rx;
    const py = Math.sin(t) * ry;
    pts.push([cx + px * Math.cos(rot) - py * Math.sin(rot), cy + px * Math.sin(rot) + py * Math.cos(rot)]);
  }
  return pencilPath(pts, jitter, { color, width, opacity });
}

export function textBlock(
  lines,
  x,
  y,
  size,
  { font = FONT_HAND, color = PALETTE.ink, anchor = 'start', lineHeight = 1.35, weight = 400 } = {},
) {
  return lines
    .map(
      (line, i) =>
        `<text x="${x}" y="${(y + i * size * lineHeight).toFixed(1)}" font-family="${font}" font-size="${size}" ` +
        `font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${escapeXml(line)}</text>`,
    )
    .join('');
}

/** 小方框节点：文字居中，用于流程图 / 循环迭代那几步。 */
export function nodeBox(x, y, w, h, lines, jitter, { color = PALETTE.ink, size = 14 } = {}) {
  const parts = [pencilRect(x, y, w, h, jitter, { color, width: 1.8 })];
  const lineH = size * 1.3;
  const startY = y + h / 2 + size * 0.35 - ((lines.length - 1) * lineH) / 2;
  parts.push(textBlock(lines, x + w / 2, startY, size, { color: PALETTE.ink, anchor: 'middle', lineHeight: 1.3 }));
  return parts.join('');
}

/**
 * 公式面板：KaTeX MathML 真排版（不是把 LaTeX 拍平成字符串）。
 * lines 里每项给绝对 y（foreignObject 顶边），版面由调用方说了算。
 */
export function formulaBox({ x, y, w, h, label, lines, note, jitter }) {
  const parts = [pencilRect(x, y, w, h, jitter, { color: PALETTE.ink, width: 1.6, opacity: 0.85 })];
  if (label) parts.push(textBlock([label], x + 14, y + 22, 13, { color: PALETTE.inkSoft }));
  for (const line of lines) {
    const mathml = renderMathMl(line.latex, { displayMode: false });
    if (!mathml) continue;
    const size = line.size || 20;
    parts.push(
      `<foreignObject x="${x + 14}" y="${line.y}" width="${line.w || w - 28}" height="${line.h || 34}">` +
        `<div xmlns="http://www.w3.org/1999/xhtml" style="font-size:${size}px;line-height:1.25;color:${line.color || PALETTE.blue};overflow:hidden">${mathml}</div>` +
        `</foreignObject>`,
    );
  }
  if (note) {
    const noteLines = wrapText(note, w - 28, 13).slice(0, 2);
    parts.push(
      textBlock(noteLines, x + 14, y + h - 12 - (noteLines.length - 1) * 18, 13, {
        color: PALETTE.inkSoft,
        lineHeight: 1.4,
      }),
    );
  }
  return parts.join('');
}

/** 纸张：米白底 + 二维噪声（feTurbulence，不是渐变）+ 双层歪边框 + 四角贴纸痕。 */
export function paperFrame({ w, h, jitter, fontCss = '' }) {
  const parts = [
    `<defs>${fontCss ? `<style>${fontCss}</style>` : ''}` +
      `<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="7"/>` +
      `<feColorMatrix type="saturate" values="0"/>` +
      `<feComponentTransfer><feFuncA type="linear" slope="0.05"/></feComponentTransfer></filter></defs>`,
  ];
  parts.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="${PALETTE.paper}"/>`);
  parts.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="url(#grain)" opacity="0.5"/>`);
  parts.push(pencilRect(18, 18, w - 36, h - 36, jitter, { color: PALETTE.pencil, width: 1.1, opacity: 0.65 }));
  parts.push(pencilRect(25, 25, w - 50, h - 50, jitter, { color: PALETTE.ink, width: 1.4, opacity: 0.5 }));
  for (const [cx, cy, sx, sy] of [
    [28, 28, 1, 1],
    [w - 28, 28, -1, 1],
    [28, h - 28, 1, -1],
    [w - 28, h - 28, -1, -1],
  ]) {
    parts.push(pencilLine(cx, cy, cx + 26 * sx, cy + 8 * sy, jitter, { color: PALETTE.red, width: 2.2 }));
  }
  return parts.join('');
}

/** 包成一张 SVG 文档。 */
export function svgDocument({ w, h, parts }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join('')}</svg>`;
}
