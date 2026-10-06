#!/usr/bin/env node
/**
 * 生成一张「手绘研究笔记」风格封面：DFlash-2 的 Selector 与 DSpark 的 Markov Head 是同一机制。
 *
 *   node scripts/make-dflash-selector-cover.js               # → output/handdrawn/dflash-selector-cover.svg|png（1600×681，2.35:1）
 *   node scripts/make-dflash-selector-cover.js --svg-only     # 只出 SVG（不需要 Chrome）
 *   node scripts/make-dflash-selector-cover.js --width 1880 --height 800 --scale 2
 *
 * 中央图讲两件事：DSpark 那边「采一个才能校准下一个」的因果链，
 * 以及 Selector 把候选锁在 top-16、把 16×16 对提前算成一张表之后，串行只剩一次 walk。
 * 画法与头图/正文配图共用 src/cover/handdrawn.js 的同一套手绘原语。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PALETTE, makeJitter, wrapText, renderMathMl } from '../src/cover/svg.js';
import { buildHandFontCss } from '../src/cover/font.js';
import { formulaBox, nodeBox, paperFrame, pencilArrow, pencilLine, pencilPath, pencilRect, svgDocument, textBlock } from '../src/cover/handdrawn.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** 图上的手写文字（同一份清单也用来按需内嵌字体子集）。 */
const T = {
  meta: '手绘速记 · 推理加速笔记',
  metaRight: '青稞解读 · 一篇文章一张图',
  title1: 'Selector ≡ Markov Head',
  title2: '去掉门控就完全等价',
  subtitle:
    '两者都是 base logits + 低秩 token 转移偏置（秩都是 256）；差别只在 DFlash-2 把候选锁死在 top-16，于是校准可以提前穷举、并行执行。',
  tags: ['DFlash-2', 'DSpark', 'Markov Head', 'top-16 并行'],
  keyLabel: '关键式',
  tagSpark: 'DSpark',
  tagSel: 'Selector（去门控）',
  tagSelGate: 'Selector（带门控）',
  tagMap: '一一对应',
  leftNote: '门控项 H(h_t) 是唯一的差异：去掉它，Selector 的式子与 Markov Head 逐项对齐。',

  centerHead: '为什么 Selector 能并行',
  centerSub: '固定候选集合 + 穷举集合内所有组合，串行只剩一次轻量 walk',
  insetHead: 'DSpark：串行校准',
  insetNote: '每步都得等上一个 token',
  gridHead: '行 = 前驱候选 a ／ 列 = 当前候选 b',
  gridNote: '16×16 对全部预计算 → walk',
  centerNote: '把「等采样出来再算」换成「提前算好再查表」。',
  chain: ['a₁ 已采样', 'a₂', 'a₃'],
  biasLabel: '加转移偏置',

  card1Head: '等价性：去掉门控项',
  card1Note: 'H(h_t) 去掉（或视为全 1）后，两式逐项对齐',
  card1Foot: 'W₁ ↔ A、W₂ ↔ B，秩同为 256',
  card2Head: '推论一：训练不用考虑 Selector',
  card2Note: '直接按门控版 DSpark 训即可',
  card2Foot: '推理时固定 top-16、并行穷举、再 walk 一次即可',
  card3Head: '推论二：已训好的 DSpark 无需重训',
  card3Notes: [
    '· 用并行 backbone 取每个位置的 top-k',
    '· k×k 候选对的校准 logits 并行预计算',
    '· 轻量串行 walk + rejection sampling，输出无损',
  ],

  step1Head: '① 同一机制',
  step1Note: 'base logits + 低秩 token 转移偏置（秩 256）',
  step2Head: '② 并行从哪来',
  step2Note: '候选锁死 top-16，16×16 个组合提前穷举',
  step3Head: '③ 所以',
  step3Note: '新模型照 DSpark 训就行，老 DSpark 免重训并行跑',

  footer: '手绘速记：依据文章推导重画，公式为要点式总结；细节以正文为准。',
  source: '参考：DFlash-2 · inco.ai/blog/dflash2 ／ DSpark · arXiv 2607.05147',
};

const HAND_TEXTS = [
  ...Object.values(T).flat(),
  '手绘研究笔记推理加速校准转移偏置候选集合穷举并行串行行走查表等价推论训练重训无损关键式',
].join('｜');

function formulaLine(latex, { x, y, w, size = 16, h = 30, color = PALETTE.blue }) {
  const mathml = renderMathMl(latex, { displayMode: false });
  if (!mathml) return '';
  return (
    `<foreignObject x="${x}" y="${y}" width="${w}" height="${h}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="font-size:${size}px;line-height:1.25;color:${color};overflow:hidden">${mathml}</div>` +
    `</foreignObject>`
  );
}

/** 16×16 候选对表（画成 6×6 示意格）+ 一条红色的 walk 路径。 */
function drawPairGrid({ x, y, cell, cols, rows, path, jitter }) {
  const parts = [pencilRect(x, y, cols * cell, rows * cell, jitter, { color: PALETTE.ink, width: 1.8 })];
  for (let i = 1; i < cols; i += 1) {
    parts.push(pencilLine(x + i * cell, y, x + i * cell, y + rows * cell, jitter, { color: PALETTE.pencil, width: 1, opacity: 0.6 }));
  }
  for (let j = 1; j < rows; j += 1) {
    parts.push(pencilLine(x, y + j * cell, x + cols * cell, y + j * cell, jitter, { color: PALETTE.pencil, width: 1, opacity: 0.6 }));
  }
  // walk：每列挑一个候选，连成一条路径
  const centers = path.map((row, col) => [x + col * cell + cell / 2, y + row * cell + cell / 2]);
  for (const [col, row] of path.entries()) {
    parts.push(
      pencilRect(x + col * cell + 2, y + row * cell + 2, cell - 4, cell - 4, jitter, { color: PALETTE.red, width: 1.6 }),
    );
  }
  parts.push(pencilPath(centers, jitter, { color: PALETTE.red, width: 1.8 }));
  const last = centers[centers.length - 1];
  parts.push(`<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3" fill="${PALETTE.red}"/>`);
  return parts.join('');
}

/* ------------------------------------------------------------------ *
 * 版面：1600×681（2.35:1）。左栏标题+关键式，中栏串行 vs 预计算，右栏三张便签，底部三段。
 * ------------------------------------------------------------------ */

export function renderDflashSelectorCoverSvg({ width = 1600, height = 681, fontCss = '' } = {}) {
  const W = width;
  const H = height;
  const sx = W / 1600;
  const sy = H / 681;
  const X = (v) => v * sx;
  const Y = (v) => v * sy;
  const jitter = makeJitter(`dflash-selector|${W}x${H}|v1`);
  const parts = [paperFrame({ w: W, h: H, jitter, fontCss })];

  // 页眉
  parts.push(textBlock([T.meta], X(56), Y(56), 13, { color: PALETTE.inkSoft }));
  parts.push(textBlock([T.metaRight], X(1544), Y(56), 13, { color: PALETTE.inkSoft, anchor: 'end' }));

  // ── 左栏：标题 + 副标题 + 术语带 + 关键式 ──
  const titleSize = Math.round(33 * sy);
  parts.push(textBlock([T.title1], X(56), Y(100), titleSize, { weight: 700 }));
  parts.push(textBlock([T.title2], X(56), Y(100) + titleSize * 1.2, titleSize, { weight: 700 }));
  parts.push(pencilLine(X(56), Y(158), X(386), Y(158), jitter, { color: PALETTE.red, width: 2.6 }));
  parts.push(textBlock(wrapText(T.subtitle, X(548), 15).slice(0, 3), X(56), Y(188), 15, { color: PALETTE.inkSoft, lineHeight: 1.4 }));

  let tx = X(56);
  for (const tag of T.tags) {
    const tw = tag.length * 7.6 + 22;
    parts.push(pencilRect(tx, Y(250), tw, 26, jitter, { color: PALETTE.pencil, width: 1.2 }));
    parts.push(textBlock([tag], tx + 11, Y(270), 13, { color: PALETTE.inkSoft }));
    tx += tw + 10;
  }

  const box = { x: X(56), y: Y(292), w: X(564), h: Y(176) };
  parts.push(
    formulaBox({
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      label: T.keyLabel,
      jitter,
      lines: [
        { latex: '\\mathrm{logits}_k(b\\mid a)=U_k(b)+W_1[a]^{\\top}W_2[:,b]', y: Y(318), size: 19, h: Y(32) },
        { latex: 'S_t(a,b)=U_t(b)+A[a]^{\\top}B[b]', y: Y(354), size: 19, h: Y(32) },
        { latex: 'S_t(a,b)=U_t(b)+\\langle A[a]\\odot H(h_t),\\,B[b]\\rangle', y: Y(390), size: 19, h: Y(32) },
        {
          latex: 'W_1[a]\\leftrightarrow A[a],\\qquad W_2[:,b]\\leftrightarrow B[b]',
          y: Y(428),
          size: 17,
          h: Y(30),
          color: PALETTE.red,
        },
      ],
    }),
  );
  // 每条式子右边挂一个手写标签
  const tagX = box.x + box.w - 14;
  parts.push(textBlock([T.tagSpark], tagX, Y(340), 12.5, { color: PALETTE.inkSoft, anchor: 'end' }));
  parts.push(textBlock([T.tagSel], tagX, Y(376), 12.5, { color: PALETTE.blue, anchor: 'end' }));
  parts.push(textBlock([T.tagSelGate], tagX, Y(412), 12.5, { color: PALETTE.blue, anchor: 'end' }));
  parts.push(textBlock([T.tagMap], tagX, Y(448), 12.5, { color: PALETTE.red, anchor: 'end' }));
  parts.push(textBlock(wrapText(T.leftNote, X(556), 13).slice(0, 2), X(56), Y(492), 13, { color: PALETTE.red, lineHeight: 1.4 }));

  // ── 中栏：串行因果链 vs 预计算的候选对表 ──
  parts.push(textBlock([T.centerHead], X(648), Y(150), 16, { weight: 600 }));
  parts.push(textBlock([T.centerSub], X(648), Y(172), 13, { color: PALETTE.inkSoft }));
  parts.push(textBlock([T.insetHead], X(648), Y(216), 13, { color: PALETTE.inkSoft }));
  parts.push(textBlock([T.gridHead], X(860), Y(216), 12.5, { color: PALETTE.inkSoft }));

  const chainX = X(656);
  const chainW = X(130);
  [0, 1, 2].forEach((i) => {
    parts.push(nodeBox(chainX, Y(228 + i * 52), chainW, Y(30), [T.chain[i]], jitter, { color: PALETTE.ink, size: 13 }));
    if (i < 2) {
      parts.push(pencilArrow(chainX + chainW / 2, Y(260 + i * 52), chainX + chainW / 2, Y(278 + i * 52), jitter, { width: 1.6 }));
      parts.push(textBlock([T.biasLabel], chainX + chainW + 6, Y(274 + i * 52), 12, { color: PALETTE.inkSoft }));
    }
  });
  parts.push(textBlock([T.insetNote], X(648), Y(398), 12.5, { color: PALETTE.red }));

  parts.push(
    drawPairGrid({
      x: X(860),
      y: Y(236),
      cell: X(24),
      cols: 6,
      rows: 6,
      path: [2, 3, 2, 4, 1, 0],
      jitter,
    }),
  );
  parts.push(textBlock([T.gridNote], X(860), Y(398), 12.5, { color: PALETTE.blue }));
  parts.push(textBlock([T.centerNote], X(648), Y(440), 13.5, { color: PALETTE.ink }));

  // ── 右栏：三张便签 ──
  for (const card of [
    { y: 150, head: T.card1Head, note: T.card1Note },
    { y: 280, head: T.card2Head, note: T.card2Note },
    { y: 410, head: T.card3Head, note: '' },
  ]) {
    const cx = X(1144);
    const cy = Y(card.y);
    parts.push(pencilRect(cx, cy, X(400), Y(116), jitter, { color: PALETTE.ink, width: 1.6, opacity: 0.85 }));
    parts.push(textBlock([card.head], cx + 14, cy + 24, 15, { weight: 600 }));
    if (card.note) parts.push(textBlock([card.note], cx + 14, cy + 46, 12.5, { color: PALETTE.inkSoft }));
  }
  parts.push(
    formulaLine('U_k(b)+W_1[a]^{\\top}W_2[:,b]\n\\equiv U_t(b)+A[a]^{\\top}B[b]'.replace('\n', '\\;\\;'), {
      x: X(1158),
      y: Y(200),
      w: X(372),
      size: 15,
      h: Y(30),
    }),
  );
  parts.push(textBlock(wrapText(T.card1Foot, X(372), 12).slice(0, 2), X(1158), Y(242), 12, { color: PALETTE.inkSoft, lineHeight: 1.45 }));
  parts.push(
    formulaLine('\\mathrm{logits}_t=U_t+(W_1[a]\\odot H(h_t))^{\\top}W_2', {
      x: X(1158),
      y: Y(330),
      w: X(372),
      size: 15,
      h: Y(30),
    }),
  );
  parts.push(textBlock(wrapText(T.card2Foot, X(372), 12).slice(0, 2), X(1158), Y(372), 12, { color: PALETTE.inkSoft, lineHeight: 1.45 }));
  parts.push(textBlock(T.card3Notes, X(1158), Y(458), 12, { color: PALETTE.inkSoft, lineHeight: 1.5 }));

  // ── 底部：同一机制 → 并行从哪来 → 两个推论 ──
  parts.push(pencilLine(X(56), Y(540), X(1544), Y(540), jitter, { color: PALETTE.pencil, width: 1, opacity: 0.6 }));
  const steps = [
    { x: 56, w: 470, head: T.step1Head, note: T.step1Note },
    { x: 560, w: 470, head: T.step2Head, note: T.step2Note },
    { x: 1064, w: 480, head: T.step3Head, note: T.step3Note },
  ];
  for (const step of steps) {
    parts.push(pencilRect(X(step.x), Y(556), X(step.w), Y(64), jitter, { color: PALETTE.ink, width: 1.6, opacity: 0.85 }));
    parts.push(textBlock([step.head], X(step.x) + 14, Y(580), 15, { weight: 600 }));
    parts.push(textBlock([step.note], X(step.x) + 14, Y(602), 13, { color: PALETTE.inkSoft }));
  }
  parts.push(pencilArrow(X(534), Y(588), X(552), Y(588), jitter, { width: 1.8 }));
  parts.push(pencilArrow(X(1038), Y(588), X(1056), Y(588), jitter, { width: 1.8 }));

  // 页脚
  parts.push(textBlock([T.footer], X(56), Y(646), 12, { color: PALETTE.inkSoft }));
  parts.push(textBlock([T.source], X(1544), Y(646), 12, { color: PALETTE.inkSoft, anchor: 'end' }));

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
  const height = Number(args.height || 681);
  const scale = Number(args.scale || 2);
  const outDir = path.resolve(args.out || path.join(ROOT, 'output/handdrawn'));
  const name = String(args.name || 'dflash-selector-cover');
  const fontCss = await buildHandFontCss(HAND_TEXTS);
  const svg = renderDflashSelectorCoverSvg({ width, height, fontCss });
  await fs.mkdir(outDir, { recursive: true });
  const svgPath = path.join(outDir, `${name}.svg`);
  await fs.writeFile(svgPath, svg, 'utf-8');
  console.log(`· SVG ${svgPath}（${width}×${height}，${(width / height).toFixed(2)}:1${fontCss ? '，已内嵌手写体' : ''}）`);
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
      console.error('[dflash-selector-cover] 失败：', (err && err.message) || err);
      process.exit(1);
    });
}
