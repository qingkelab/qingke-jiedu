#!/usr/bin/env node
/**
 * 生成一张「手绘研究笔记」风格单图：从 Adam 的对角归一化，到梯度二阶矩的白化（KL-Root-Kron）。
 *
 *   node scripts/make-whitening-figure.js                    # → output/handdrawn/adam-to-kron-whitening.svg|png
 *   node scripts/make-whitening-figure.js --svg-only          # 只出 SVG（不需要 Chrome）
 *   node scripts/make-whitening-figure.js --out /tmp/fig --name draft --scale 2
 *
 * 复用头图/正文配图同一套手绘语言：纸纹 + 铅笔线稿 + 蓝红强调 + 内嵌霞鹜文楷；
 * 公式走 KaTeX 的 MathML（浏览器原生排版，不依赖 KaTeX 字体）。
 * 与原海报渲染相互独立：这里不碰 src/cover/svg.js 的既有版面逻辑。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PALETTE, makeJitter, wrapText, renderMathMl } from '../src/cover/svg.js';
import { buildHandFontCss } from '../src/cover/font.js';
import {
  formulaBox,
  nodeBox,
  paperFrame,
  pencilArrow,
  pencilEllipse,
  pencilLine,
  pencilPath,
  pencilRect,
  svgDocument,
  textBlock,
} from '../src/cover/handdrawn.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* ------------------------------------------------------------------ *
 * 图上的手写文字（同一份清单也用来按需内嵌字体子集）
 * ------------------------------------------------------------------ */

const T = {
  meta: '手绘速记 · 优化器笔记',
  metaRight: '青稞解读 · 一篇文章一张图',
  title: '从 Adam 的对角归一化，到梯度二阶矩的白化',
  subtitle:
    '预条件器从「每个坐标除以根号二阶矩」推广到「整块二阶矩的白化」：不算特征分解与求逆，用残差在线迭代，再按 Kronecker 拆成两个小矩阵。',
  legend: '蓝＝推演与白化方向　红＝坐标轴与边界（⑤中两色各代表一条路线）',

  p1Label: '① 只按坐标缩放：Adam',
  p1Sub: '只看对角元，方向相关性丢掉',
  p1Axis1: 'w₁',
  p1Axis2: 'w₂',
  p1E1: 'e₁',
  p1E2: 'e₂',
  p1Cloud: '梯度云',

  p2Label: '② 完整二阶矩：沿特征方向白化',
  p2Sub: '用 Σ 的逆平方根，把梯度云压成球',
  p2U1: 'u₁',
  p2U2: 'u₂',
  p2Cloud: '梯度云',
  p2Iso: '各向同性',
  p2Arrow: 'P',
  p2FormNote: '（白化梯度二阶矩，区别于 Newton 的 Hessian 逆）',

  p3Label: '③ 不碰特征分解：用残差在线逼近',
  p3Sub: '每步只有当前梯度 g，于是 Σ̂ = g gᵀ',
  p3N1: ['当前 raw 梯度', 'g'],
  p3N2: ['单步二阶矩', 'Σ̂ = g gᵀ'],
  p3N3: ['白化残差', 'R = P^½ Σ̂ P^½ − I'],
  p3N4: ['乘法迭代', 'P ← P^½ (I − ½R) P^½'],
  p3Gemm: '每步只做少量 GEMM，不碰 eig / 求逆',
  p3Lambda: 'R 对称：λ>1 压缩、λ<1 放大',
  p3FormNote: 'P = SᵀS（S 为平方根因子）保证每步仍是对称正定；二阶项可选。',

  p4Label: '④ 矩阵参数：Kronecker 拆开两个方向',
  p4Sub: '把 m×n 的梯度矩阵拆成行空间与列空间两个小预条件器',
  p4Grid: '∇W',
  p4GridNote: '梯度矩阵',
  p4Row: 'A：行方向二阶矩',
  p4Col: 'B：列方向二阶矩',
  p4Right1: '两个方向各自套同一套一阶残差更新：',
  p4Right2: '把 Σ 换成该方向的二阶矩即可。',
  p4Right3: '空间 O(m²+n²) 与计算 O(m³+n³)，',
  p4Right4: '而不是 O(m²n²) / O(m³n³)。',
  p4BoxLabel: '关键式（Kronecker 化）',
  p4IdNote: '用恒等式把 vec 拉回矩阵',

  p5Label: '⑤ 两条路线在这里汇合',
  p5Route1: 'matrix function 一阶近似',
  p5Route2: 'Gaussian-KL + AIRM 自然梯度',
  p5Meet: '同一套更新',
  p5B1: '· 一阶展开逐项对上：线性项正好是 −½R',
  p5B2: '· Kronecker 不动点 = idealized KL-Shampoo',
  p5B3: '· 边界：Σ 退化时改看 Σ+εI，不动点变成 (Σ+εI)^(−1/2)',
  p5B4: '· 单步估计 Σ̂ 低秩，不代表总体 Σ 不可逆',

  footer: '手绘速记：依据文章推导重画，公式为要点式总结；细节以正文为准。',
};

const HAND_TEXTS = [
  ...Object.values(T).flat(),
  '手绘研究笔记优化器白化梯度二阶矩坐标方向矩阵行列表索引关键式边界取舍与来源文章推导公式',
].join('｜');

/* ------------------------------------------------------------------ *
 * 版面
 * ------------------------------------------------------------------ */

function renderWhiteningFigureSvg({ width = 1600, height = 1000, fontCss = '' } = {}) {
  const W = width;
  const H = height;
  const pad = 56;
  const jitter = makeJitter(`whitening|${W}x${H}|v1`);
  const parts = [paperFrame({ w: W, h: H, jitter, fontCss })];

  // 页眉
  parts.push(textBlock([T.meta], pad, 58, 13, { color: PALETTE.inkSoft }));
  parts.push(textBlock([T.metaRight], W - pad, 58, 13, { color: PALETTE.inkSoft, anchor: 'end' }));
  parts.push(textBlock([T.title], pad, 104, 34, { weight: 700 }));
  parts.push(pencilLine(pad, 116, pad + 348, 116, jitter, { color: PALETTE.red, width: 2.4 }));
  parts.push(textBlock([T.legend], W - pad, 100, 13, { color: PALETTE.inkSoft, anchor: 'end' }));
  parts.push(textBlock(wrapText(T.subtitle, 940, 15).slice(0, 2), pad, 140, 15, { color: PALETTE.inkSoft, lineHeight: 1.4 }));

  /* ---------------- 第一行：三个面板 ---------------- */
  const rowTop = 176;
  const rowH = 366;
  const colW = 480;
  const colX = [pad, pad + colW + 24, pad + (colW + 24) * 2];

  // ① Adam：只缩放坐标轴
  {
    const x = colX[0];
    const y = rowTop;
    parts.push(pencilRect(x, y, colW, rowH, jitter, { color: PALETTE.ink, width: 1.6, opacity: 0.85 }));
    parts.push(textBlock([T.p1Label], x + 14, y + 30, 17, { weight: 600 }));
    parts.push(textBlock([T.p1Sub], x + 14, y + 54, 13, { color: PALETTE.inkSoft }));

    const ox = x + 94;
    const oy = y + 214;
    parts.push(pencilArrow(ox, oy, x + 430, oy, jitter, { width: 1.8 }));
    parts.push(pencilArrow(ox, oy, ox, y + 66, jitter, { width: 1.8 }));
    parts.push(textBlock([T.p1Axis1], x + 438, oy + 5, 13, { color: PALETTE.inkSoft }));
    parts.push(textBlock([T.p1Axis2], ox - 10, y + 150, 13, { color: PALETTE.inkSoft, anchor: 'end' }));

    const cx = x + 279;
    const cy = y + 140;
    parts.push(pencilEllipse(cx, cy, 84, 34, -30, jitter, { width: 2.2 }));
    // 梯度云的采样点
    for (let i = 0; i < 14; i += 1) {
      const u = ((i / 13) * 2 - 1) * 84 * 0.82;
      const v = ((((i * 37) % 13) / 13) * 2 - 1) * 34 * 0.55;
      const rot = (-30 * Math.PI) / 180;
      const px = cx + u * Math.cos(rot) - v * Math.sin(rot);
      const py = cy + u * Math.sin(rot) + v * Math.cos(rot);
      parts.push(`<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="1.7" fill="${PALETTE.pencil}"/>`);
    }
    // Adam 能看到的两个方向：坐标轴本身（虚线红）
    parts.push(pencilArrow(cx - 130, cy, cx + 146, cy, jitter, { color: PALETTE.red, width: 1.8, dash: '7 6' }));
    parts.push(pencilArrow(cx, cy + 70, cx, cy - 70, jitter, { color: PALETTE.red, width: 1.8, dash: '7 6' }));
    parts.push(textBlock([T.p1E1], cx + 154, cy + 5, 13, { color: PALETTE.red }));
    parts.push(textBlock([T.p1E2], cx + 12, cy - 74, 13, { color: PALETTE.red }));
    parts.push(textBlock([T.p1Cloud], x + 20, y + 216, 13, { color: PALETTE.pencil }));

    parts.push(
      formulaBox({
        x: x + 14,
        y: y + 224,
        w: colW - 28,
        h: 134,
        label: '关键式',
        jitter,
        lines: [
          { latex: '\\Sigma=\\mathbb{E}\\left[g\\,g^{\\top}\\right]', y: y + 254, size: 21, h: 34 },
          { latex: 'P_{\\text{Adam}}=\\mathrm{diag}(\\Sigma)^{-1/2}', y: y + 288, size: 21, h: 34 },
          { latex: '\\Delta w=-\\eta\\,m\\,/\\,\\sqrt{v}', y: y + 322, size: 21, h: 34 },
        ],
      }),
    );
  }

  // ② 完整白化：Σ^{-1/2}
  {
    const x = colX[1];
    const y = rowTop;
    parts.push(pencilRect(x, y, colW, rowH, jitter, { color: PALETTE.ink, width: 1.6, opacity: 0.85 }));
    parts.push(textBlock([T.p2Label], x + 14, y + 30, 17, { weight: 600 }));
    parts.push(textBlock([T.p2Sub], x + 14, y + 54, 13, { color: PALETTE.inkSoft }));

    const cx = x + 112;
    const cy = y + 140;
    parts.push(pencilEllipse(cx, cy, 74, 29, -30, jitter, { width: 2.2 }));
    const rot = (-30 * Math.PI) / 180;
    const d1 = [Math.cos(rot), Math.sin(rot)];
    const d2 = [-d1[1], d1[0]];
    parts.push(
      pencilArrow(cx - d1[0] * 74, cy - d1[1] * 74, cx + d1[0] * 74, cy + d1[1] * 74, jitter, {
        color: PALETTE.blue,
        width: 2.2,
      }),
    );
    parts.push(
      pencilArrow(cx - d2[0] * 29, cy - d2[1] * 29, cx + d2[0] * 29, cy + d2[1] * 29, jitter, {
        color: PALETTE.blue,
        width: 2,
      }),
    );
    parts.push(textBlock([T.p2U1], cx + d1[0] * 86 + 4, cy + d1[1] * 86 + 4, 13, { color: PALETTE.blue }));
    parts.push(textBlock([T.p2U2], cx + d2[0] * 40 + 6, cy + d2[1] * 40 + 4, 13, { color: PALETTE.blue }));
    parts.push(textBlock([T.p2Cloud], x + 20, y + 216, 13, { color: PALETTE.pencil }));

    parts.push(pencilArrow(x + 196, cy, x + 240, cy, jitter, { width: 2 }));
    parts.push(textBlock([T.p2Arrow], x + 218, cy - 12, 17, { color: PALETTE.blue, anchor: 'middle', weight: 600 }));

    const sx = x + 306;
    parts.push(pencilEllipse(sx, cy, 54, 54, 0, jitter, { width: 2.2 }));
    for (const deg of [25, 115, 205, 295]) {
      const a = (deg * Math.PI) / 180;
      parts.push(
        pencilArrow(sx, cy, sx + Math.cos(a) * 50, cy + Math.sin(a) * 50, jitter, { color: PALETTE.blue, width: 1.8 }),
      );
    }
    parts.push(textBlock([T.p2Iso], sx, y + 216, 13, { color: PALETTE.inkSoft, anchor: 'middle' }));

    parts.push(
      formulaBox({
        x: x + 14,
        y: y + 224,
        w: colW - 28,
        h: 134,
        label: '关键式',
        jitter,
        note: T.p2FormNote,
        lines: [
          { latex: 'P=\\Sigma^{-1/2},\\qquad P\\,\\Sigma\\,P=I,\\qquad \\tilde g=Pg', y: y + 254, size: 20, h: 34 },
          { latex: '\\mathbb{E}\\left[\\tilde g\\,\\tilde g^{\\top}\\right]=I', y: y + 292, size: 20, h: 34 },
        ],
      }),
    );
  }

  // ③ 在线迭代：残差 + 乘法更新
  {
    const x = colX[2];
    const y = rowTop;
    parts.push(pencilRect(x, y, colW, rowH, jitter, { color: PALETTE.ink, width: 1.6, opacity: 0.85 }));
    parts.push(textBlock([T.p3Label], x + 14, y + 30, 17, { weight: 600 }));
    parts.push(textBlock([T.p3Sub], x + 14, y + 54, 13, { color: PALETTE.inkSoft }));

    const nw = 196;
    const nh = 44;
    const left = x + 16;
    const right = x + 254;
    const top = y + 62;
    const bottom = y + 138;
    parts.push(nodeBox(left, top, nw, nh, T.p3N1, jitter));
    parts.push(nodeBox(right, top, nw, nh, T.p3N2, jitter, { color: PALETTE.blue }));
    parts.push(nodeBox(right, bottom, nw, nh, T.p3N3, jitter, { color: PALETTE.blue }));
    parts.push(nodeBox(left, bottom, nw, nh, T.p3N4, jitter, { color: PALETTE.ink }));
    // 顺时针循环
    parts.push(pencilArrow(left + nw + 8, top + nh / 2, right - 8, top + nh / 2, jitter, { width: 1.6 }));
    parts.push(pencilArrow(right + nw - 26, top + nh + 8, right + nw - 26, bottom - 8, jitter, { width: 1.6 }));
    parts.push(pencilArrow(right - 8, bottom + nh / 2, left + nw + 8, bottom + nh / 2, jitter, { width: 1.6 }));
    parts.push(pencilArrow(left + 26, bottom - 8, left + 26, top + nh + 8, jitter, { width: 1.6 }));
    parts.push(textBlock([T.p3Gemm], x + 14, y + 208, 13, { color: PALETTE.pencil }));
    parts.push(textBlock([T.p3Lambda], x + 262, y + 208, 13, { color: PALETTE.red }));

    parts.push(
      formulaBox({
        x: x + 14,
        y: y + 224,
        w: colW - 28,
        h: 134,
        label: '关键式',
        jitter,
        note: T.p3FormNote,
        lines: [
          { latex: 'R=P^{1/2}\\,\\hat{\\Sigma}\\,P^{1/2}-I\\;\\to\\;0', y: y + 252, size: 20, h: 32 },
          { latex: 'P\\leftarrow P^{1/2}\\left(I-\\tfrac{1}{2}R\\right)P^{1/2}', y: y + 288, size: 20, h: 32 },
        ],
      }),
    );
  }

  /* ---------------- 第二行：Kronecker + 两条路线汇合 ---------------- */
  const row2Top = 566;
  const row2H = 330;

  // ④ 矩阵参数 → Kronecker
  {
    const x = pad;
    const y = row2Top;
    const w = 824;
    parts.push(pencilRect(x, y, w, row2H, jitter, { color: PALETTE.ink, width: 1.6, opacity: 0.85 }));
    parts.push(textBlock([T.p4Label], x + 14, y + 30, 17, { weight: 600 }));
    parts.push(textBlock([T.p4Sub], x + 14, y + 54, 13, { color: PALETTE.inkSoft }));

    // 梯度矩阵 ∇W：一个 m×n 的格子
    const gx = x + 32;
    const gy = y + 74;
    const gw = 140;
    const gh = 108;
    parts.push(pencilRect(gx, gy, gw, gh, jitter, { width: 2 }));
    for (let i = 1; i < 4; i += 1) parts.push(pencilLine(gx + (gw / 4) * i, gy, gx + (gw / 4) * i, gy + gh, jitter, { width: 1, opacity: 0.55 }));
    for (let i = 1; i < 3; i += 1) parts.push(pencilLine(gx, gy + (gh / 3) * i, gx + gw, gy + (gh / 3) * i, jitter, { width: 1, opacity: 0.55 }));
    parts.push(textBlock([T.p4Grid], gx + 10, gy + 26, 18, { weight: 600 }));
    parts.push(textBlock([T.p4GridNote], gx + gw / 2, gy + gh + 22, 13, { color: PALETTE.inkSoft, anchor: 'middle' }));

    // 两个方向的小矩阵
    const blockA = [x + 260, y + 74, 68, 46];
    const blockB = [x + 260, y + 140, 68, 46];
    parts.push(pencilArrow(gx + gw + 8, gy + 30, blockA[0] - 8, gy + 30, jitter, { width: 1.6 }));
    parts.push(pencilArrow(gx + gw + 8, gy + gh - 6, blockB[0] - 8, blockB[1] + 30, jitter, { width: 1.6 }));
    for (const [bx, by, bw, bh, label] of [
      [blockA[0], blockA[1], blockA[2], blockA[3], T.p4Row],
      [blockB[0], blockB[1], blockB[2], blockB[3], T.p4Col],
    ]) {
      parts.push(pencilRect(bx, by, bw, bh, jitter, { color: PALETTE.blue, width: 1.8 }));
      parts.push(pencilLine(bx + bw / 3, by, bx + bw / 3, by + bh, jitter, { color: PALETTE.blue, width: 1, opacity: 0.6 }));
      parts.push(pencilLine(bx + (bw / 3) * 2, by, bx + (bw / 3) * 2, by + bh, jitter, { color: PALETTE.blue, width: 1, opacity: 0.6 }));
      parts.push(pencilLine(bx, by + bh / 2, bx + bw, by + bh / 2, jitter, { color: PALETTE.blue, width: 1, opacity: 0.6 }));
      parts.push(textBlock([label], bx + bw + 12, by + 28, 13, { color: PALETTE.blue }));
    }

    // 右栏：两个方向各自维护
    const rx = x + 470;
    const rightLines = [T.p4Right1, T.p4Right2, T.p4Right3, T.p4Right4];
    parts.push(textBlock(rightLines, rx, y + 92, 13, { color: PALETTE.inkSoft, lineHeight: 1.5 }));
    parts.push(pencilPath([[rx - 22, y + 74], [rx - 22, y + 180]], jitter, { color: PALETTE.pencil, width: 1, opacity: 0.5 }));

    // 底部：Kronecker 恒等式与形状账
    const bx = x + 14;
    const by = y + 210;
    const bw = w - 28;
    const bh = 110;
    parts.push(pencilRect(bx, by, bw, bh, jitter, { color: PALETTE.ink, width: 1.6, opacity: 0.85 }));
    parts.push(textBlock([T.p4BoxLabel], bx + 14, by + 22, 13, { color: PALETTE.inkSoft }));
    for (const line of [
      { latex: 'P=A^{-1/2}\\otimes B^{-1/2}', y: by + 30, size: 20, h: 32 },
      { latex: '\\widetilde{\\nabla W}=B^{-1/2}\\,\\nabla W\\,A^{-1/2}', y: by + 68, size: 20, h: 32 },
    ]) {
      const mathml = renderMathMl(line.latex, { displayMode: false });
      parts.push(
        `<foreignObject x="${bx + 14}" y="${line.y}" width="360" height="${line.h}">` +
          `<div xmlns="http://www.w3.org/1999/xhtml" style="font-size:${line.size}px;line-height:1.25;color:${PALETTE.blue};overflow:hidden">${mathml}</div>` +
          `</foreignObject>`,
      );
    }
    parts.push(textBlock([T.p4IdNote], bx + 14, by + 104, 13, { color: PALETTE.inkSoft }));
    parts.push(
      textBlock(
        wrapText('(A⊗B)vec(X)=vec(BXAᵀ)，于是预条件只作用在两个小矩阵上：P 的存储与计算都不再随 m、n 的乘积爆炸。', bw - 420, 13).slice(0, 4),
        bx + 400,
        by + 46,
        13,
        { color: PALETTE.inkSoft, lineHeight: 1.45 },
      ),
    );
  }

  // ⑤ 两条路线汇合
  {
    const x = 908;
    const y = row2Top;
    const w = 1544 - 908;
    parts.push(pencilRect(x, y, w, row2H, jitter, { color: PALETTE.ink, width: 1.6, opacity: 0.85, dash: '9 7' }));
    parts.push(textBlock([T.p5Label], x + 14, y + 30, 17, { weight: 600 }));

    parts.push(textBlock([T.p5Route1], x + 22, y + 92, 14, { color: PALETTE.blue }));
    parts.push(textBlock([T.p5Route2], x + 22, y + 156, 14, { color: PALETTE.red }));
    const mergeX = x + 342;
    const meetY = y + 124;
    parts.push(pencilPath([[x + 300, y + 88], [mergeX - 26, y + 88], [mergeX, meetY]], jitter, { color: PALETTE.blue, width: 1.8 }));
    parts.push(pencilPath([[x + 300, y + 152], [mergeX - 26, y + 152], [mergeX, meetY]], jitter, { color: PALETTE.red, width: 1.8 }));
    parts.push(pencilArrow(mergeX, meetY, x + w - 22, meetY, jitter, { width: 1.8 }));
    parts.push(textBlock([T.p5Meet], x + w - 30, meetY - 14, 14, { anchor: 'end' }));

    parts.push(pencilLine(x + 14, y + 192, x + w - 14, y + 192, jitter, { color: PALETTE.pencil, width: 1, opacity: 0.6 }));
    parts.push(
      textBlock([T.p5B1, T.p5B2, T.p5B3, T.p5B4], x + 22, y + 214, 13, { color: PALETTE.ink, lineHeight: 1.68 }),
    );
  }

  // 页脚
  parts.push(pencilLine(pad, H - 72, W - pad, H - 72, jitter, { color: PALETTE.pencil, width: 1 }));
  parts.push(textBlock([T.footer], pad, H - 50, 12, { color: PALETTE.inkSoft }));

  return svgDocument({ w: W, h: H, parts });
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      args._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const width = Number(args.width || 1600);
  const height = Number(args.height || 1000);
  const scale = Number(args.scale || 2);
  const outDir = path.resolve(args.out || path.join(ROOT, 'output/handdrawn'));
  const name = String(args.name || 'adam-to-kron-whitening');
  const fontCss = await buildHandFontCss(HAND_TEXTS);
  const svg = renderWhiteningFigureSvg({ width, height, fontCss });
  await fs.mkdir(outDir, { recursive: true });
  const svgPath = path.join(outDir, `${name}.svg`);
  await fs.writeFile(svgPath, svg, 'utf-8');
  console.log(`· SVG ${svgPath}（${width}×${height}${fontCss ? '，已内嵌手写体' : ''}）`);
  if (args['svg-only']) return 0;

  const { svgToPng, closeBrowser } = await import('../src/webToImages.js');
  try {
    const res = await svgToPng(svg, { scale, waitForFonts: true, timeoutMs: 60000 });
    if (!res?.buffer) {
      console.error('· PNG 栅格化失败（本机 Chrome 不可用？），已保留 SVG');
      return 1;
    }
    const pngPath = path.join(outDir, `${name}.png`);
    await fs.writeFile(pngPath, res.buffer);
    console.log(`· PNG ${pngPath}（${res.width}×${res.height}）`);
  } finally {
    await closeBrowser().catch(() => {});
  }
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      console.error('[whitening-figure] 失败：', (err && err.message) || err);
      process.exit(1);
    });
}
