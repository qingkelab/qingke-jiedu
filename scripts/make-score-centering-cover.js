#!/usr/bin/env node
/**
 * 生成一张「手绘研究笔记」风格封面：从 On-Policy Baseline 到 Off-Policy Score Centering。
 *
 *   node scripts/make-score-centering-cover.js                # → output/handdrawn/score-centering-cover.svg|png（1600×681，2.35:1）
 *   node scripts/make-score-centering-cover.js --svg-only      # 只出 SVG（不需要 Chrome）
 *   node scripts/make-score-centering-cover.js --width 1880 --height 800 --scale 2
 *
 * 中央图是「score 云」：a∼q 时目标策略 score 的样本均值不是零（红箭头 m_q），
 * 减去 m_q 之后样本均值归零 —— 这就是 Score Centering 恢复 baseline invariance 的那一步。
 * 画法与头图/正文配图共用 src/cover/handdrawn.js 的同一套手绘原语。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PALETTE, makeJitter, wrapText, renderMathMl } from '../src/cover/svg.js';
import { buildHandFontCss } from '../src/cover/font.js';
import { formulaBox, paperFrame, pencilArrow, pencilLine, pencilRect, svgDocument, textBlock } from '../src/cover/handdrawn.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** 图上的手写文字（同一份清单也用来按需内嵌字体子集）。 */
const T = {
  meta: '手绘速记 · RL 后训练笔记',
  metaRight: '青稞解读 · 一篇文章一张图',
  title1: '从 On-Policy Baseline',
  title2: '到 Off-Policy Score Centering',
  subtitle:
    'q 采样时 V(s) 不再是合法 baseline：目标策略的 score 在 q 下均值不为零；把 score 中心化，就把它搬回零。',
  tags: ['Score Centering', 'TIS / MIS', 'top-k 重建', 'STE 等价'],
  keyLabel: '关键式',
  leftNote: 'V(s) 漏出来的那一项就是 V·m_q(s)；换 Q→A 相当于删掉这个隐式的 reverse-KL 拉回项。',

  centerHead: '为什么 V(s) 会漏出来',
  centerSub: '固定 prefix s：样本来自 q，score 仍取目标策略 p',
  panelL: 'raw score z（a∼q）',
  panelR: 'centered z̃ = z − m_q',
  panelLNote: '样本均值 m_q(s) ≠ 0',
  panelRNote: '样本均值 E_q[z̃] = 0',
  minusLabel: '− m_q(s)',
  noteA: 'm_q(s) 就是 mean-score drift，也等于 reverse-KL 梯度的相反数。',
  noteB: '减去它之后样本均值归零 —— V(s) 重新成为合法 baseline。',

  card1Head: 'TIS / MIS + Score Centering',
  card1Note: '先加权、再中心化：wz − E_q[wz]',
  card1Foot: ['f(r)=1 / r / min(r,c) / r·1{ℓ≤r≤u}，取 c=2、ℓ=0.5、u=5', 'α：λ / 1 / min(1,cλ) / 1{0.2≤λ≤2}（只看 top-k head）'],
  card2Head: 'Score Centering ≡ STE（梯度等价）',
  card2Note: '前向 softmax 用 q，反向沿 z_p 传梯度',
  card2Foot: '只是梯度等价，两者的前向 loss 数值并不相同',
  card3Head: '边界与自检',
  card3Notes: [
    '· 只消除 mean-score drift，不修正 q→p mismatch',
    '· staleness 大时仍需与 TIS / MIS 组合',
    '· constant / 打乱 reward：平均更新 ≈ C(s)δ_f(s)',
  ],

  step1Head: '① on-policy',
  step1Note: 'a∼p：E_p[z] = 0，任意 V(s) 都是合法 baseline',
  step2Head: '② off-policy（q 采样、raw score）',
  step2Note: 'E_q[z] = m_q ≠ 0，更新多出 V·m_q(s)',
  step3Head: '③ centered score',
  step3Note: 'E_q[z̃] = 0，baseline invariance 恢复',

  footer: '手绘速记：依据文章推导重画，公式为要点式总结；细节以正文为准。',
  source: '参考：Score Centering Stabilizes Off-policy RL · arXiv 2609.20807',
};

const HAND_TEXTS = [
  ...Object.values(T).flat(),
  '手绘研究笔记强化学习后训练策略梯度基线漂移采样分布加权中心化边界自检关键式',
].join('｜');

/**
 * 一个前缀下采样到的若干条 score 向量（示意）。
 * 刻意让它们的均值落在右上方：均值不为零这件事本身就是要画的重点。
 */
const SCORE_VECTORS = [
  [100, -60],
  [60, -85],
  [10, -95],
  [-45, -70],
  [30, -35],
  [75, -15],
  [55, -50],
  [35, -40],
];

function meanVector(vectors) {
  return vectors.reduce((acc, v) => [acc[0] + v[0] / vectors.length, acc[1] + v[1] / vectors.length], [0, 0]);
}

function formulaLine(latex, { x, y, w, size = 18, h = 32, color = PALETTE.blue }) {
  const mathml = renderMathMl(latex, { displayMode: false });
  if (!mathml) return '';
  return (
    `<foreignObject x="${x}" y="${y}" width="${w}" height="${h}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="font-size:${size}px;line-height:1.25;color:${color};overflow:hidden">${mathml}</div>` +
    `</foreignObject>`
  );
}

/* ------------------------------------------------------------------ *
 * 版面：1600×681（2.35:1）。左栏标题+关键式，中栏 score 云，右栏三张便签，底部三段对照。
 * ------------------------------------------------------------------ */

export function renderScoreCenteringCoverSvg({ width = 1600, height = 681, fontCss = '' } = {}) {
  const W = width;
  const H = height;
  const sx = W / 1600;
  const sy = H / 681;
  const X = (v) => v * sx;
  const Y = (v) => v * sy;
  const jitter = makeJitter(`score-centering|${W}x${H}|v1`);
  const parts = [paperFrame({ w: W, h: H, jitter, fontCss })];

  // 页眉
  parts.push(textBlock([T.meta], X(56), Y(56), 13, { color: PALETTE.inkSoft }));
  parts.push(textBlock([T.metaRight], X(1544), Y(56), 13, { color: PALETTE.inkSoft, anchor: 'end' }));

  // ── 左栏：标题 + 副标题 + 术语带 + 关键式 ──
  const titleSize = Math.round(33 * sy);
  parts.push(textBlock([T.title1], X(56), Y(100), titleSize, { weight: 700 }));
  parts.push(textBlock([T.title2], X(56), Y(100) + titleSize * 1.2, titleSize, { weight: 700 }));
  parts.push(pencilLine(X(56), Y(158), X(386), Y(158), jitter, { color: PALETTE.red, width: 2.6 }));
  const subLines = wrapText(T.subtitle, X(548), 15).slice(0, 3);
  parts.push(textBlock(subLines, X(56), Y(188), 15, { color: PALETTE.inkSoft, lineHeight: 1.4 }));

  let tx = X(56);
  for (const tag of T.tags) {
    const tw = tag.length * 7.4 + 22;
    parts.push(pencilRect(tx, Y(250), tw, 26, jitter, { color: PALETTE.pencil, width: 1.2 }));
    parts.push(textBlock([tag], tx + 11, Y(270), 13, { color: PALETTE.inkSoft }));
    tx += tw + 10;
  }

  parts.push(
    formulaBox({
      x: X(56),
      y: Y(292),
      w: X(564),
      h: Y(176),
      label: T.keyLabel,
      jitter,
      lines: [
        { latex: '\\tilde z=z-m_q(s),\\qquad m_q(s)=\\mathbb E_q\\left[z\\right]', y: Y(320), size: 20, h: Y(34) },
        { latex: '\\mathbb E_q\\left[Q\\tilde z\\right]=\\mathbb E_q\\left[(Q-V)\\tilde z\\right]', y: Y(358), size: 20, h: Y(34) },
        { latex: 'G_q^{\\mathrm{SC}}(s)=\\mathrm{Cov}_q\\left(Q,z\\right)', y: Y(396), size: 19, h: Y(34) },
        {
          latex: 'm_q(s)=-\\nabla_\\theta D_{\\mathrm{KL}}\\left(q\\,\\|\\,p_\\theta\\right)',
          y: Y(434),
          size: 17,
          h: Y(30),
          color: PALETTE.red,
        },
      ],
    }),
  );
  parts.push(textBlock(wrapText(T.leftNote, X(556), 13).slice(0, 2), X(56), Y(492), 13, { color: PALETTE.red, lineHeight: 1.4 }));

  // ── 中栏：score 云 → 中心化 ──
  parts.push(textBlock([T.centerHead], X(648), Y(150), 16, { weight: 600 }));
  parts.push(textBlock([T.centerSub], X(648), Y(172), 13, { color: PALETTE.inkSoft }));
  parts.push(pencilRect(X(648), Y(196), X(232), Y(196), jitter, { color: PALETTE.pencil, width: 1.2, opacity: 0.5, dash: '6 6' }));
  parts.push(pencilRect(X(908), Y(196), X(204), Y(196), jitter, { color: PALETTE.pencil, width: 1.2, opacity: 0.5, dash: '6 6' }));
  parts.push(textBlock([T.panelL], X(662), Y(220), 13, { color: PALETTE.inkSoft }));
  parts.push(textBlock([T.panelR], X(922), Y(220), 13, { color: PALETTE.blue }));
  parts.push(textBlock([T.panelLNote], X(662), Y(240), 12.5, { color: PALETTE.red }));
  parts.push(textBlock([T.panelRNote], X(922), Y(240), 12.5, { color: PALETTE.blue }));

  // 坐标轴（画淡一点，别抢 score 箭头）
  parts.push(pencilArrow(X(664), Y(352), X(866), Y(352), jitter, { color: PALETTE.pencil, width: 1.2, opacity: 0.5 }));
  parts.push(pencilArrow(X(742), Y(384), X(742), Y(258), jitter, { color: PALETTE.pencil, width: 1.2, opacity: 0.5 }));
  parts.push(pencilArrow(X(922), Y(352), X(1096), Y(352), jitter, { color: PALETTE.pencil, width: 1.2, opacity: 0.5 }));
  parts.push(pencilArrow(X(1010), Y(384), X(1010), Y(258), jitter, { color: PALETTE.pencil, width: 1.2, opacity: 0.5 }));

  const scale = 0.9;
  const mean = meanVector(SCORE_VECTORS);
  const originL = [X(742), Y(352)];
  const originR = [X(1010), Y(352)];
  for (const v of SCORE_VECTORS) {
    parts.push(
      pencilArrow(originL[0], originL[1], originL[0] + X(v[0] * scale), originL[1] + Y(v[1] * scale), jitter, { width: 1.6 }),
    );
  }
  // 红箭头 = 非零的均值 m_q(s)
  const meanTip = [originL[0] + X(mean[0] * scale), originL[1] + Y(mean[1] * scale)];
  parts.push(pencilArrow(originL[0], originL[1], meanTip[0], meanTip[1], jitter, { color: PALETTE.red, width: 2.6 }));
  parts.push(`<circle cx="${meanTip[0].toFixed(1)}" cy="${meanTip[1].toFixed(1)}" r="3" fill="${PALETTE.red}"/>`);
  // 减去均值之后的 score 云：样本均值回到原点
  for (const v of SCORE_VECTORS) {
    const c = [v[0] - mean[0], v[1] - mean[1]];
    parts.push(
      pencilArrow(originR[0], originR[1], originR[0] + X(c[0] * scale), originR[1] + Y(c[1] * scale), jitter, {
        color: PALETTE.blue,
        width: 1.6,
      }),
    );
  }
  parts.push(
    `<circle cx="${originR[0].toFixed(1)}" cy="${originR[1].toFixed(1)}" r="6" fill="none" stroke="${PALETTE.blue}" stroke-width="1.6" stroke-dasharray="3 3"/>`,
  );
  // 中心化这一步
  parts.push(
    pencilArrow(meanTip[0] + 12, meanTip[1] - 8, originR[0] - 16, originR[1] - 6, jitter, {
      color: PALETTE.blue,
      width: 1.6,
      dash: '6 5',
    }),
  );
  // 注意：这个标签要完整落在左面板内，别跨过 648+232 的面板右边界（审计会按 panel-overflow 报出来）
  parts.push(textBlock([T.minusLabel], X(836), Y(286), 13, { color: PALETTE.blue, anchor: 'middle' }));
  parts.push(textBlock([T.noteA], X(648), Y(416), 13, { color: PALETTE.ink }));
  parts.push(textBlock([T.noteB], X(648), Y(438), 13, { color: PALETTE.blue }));

  // ── 右栏：三张便签 ──
  const cards = [
    { x: 1144, y: 150, h: 116, head: T.card1Head, note: T.card1Note, foot: T.card1Foot },
    { x: 1144, y: 280, h: 116, head: T.card2Head, note: T.card2Note, foot: T.card2Foot },
    { x: 1144, y: 410, h: 116, head: T.card3Head, note: '', foot: T.card3Notes },
  ];
  for (const card of cards) {
    const cx = X(card.x);
    const cy = Y(card.y);
    parts.push(pencilRect(cx, cy, X(400), Y(card.h), jitter, { color: PALETTE.ink, width: 1.6, opacity: 0.85 }));
    parts.push(textBlock([card.head], cx + 14, cy + 24, 15, { weight: 600 }));
    if (card.note) parts.push(textBlock([card.note], cx + 14, cy + 46, 12.5, { color: PALETTE.inkSoft }));
  }
  parts.push(
    formulaLine('\\widehat m_f(s)=\\sum_{v\\in\\mathcal H}\\left(q_vf(r_v)-\\alpha p_v\\right)z_v', {
      x: X(1158),
      y: Y(202),
      w: X(372),
      size: 16,
      h: Y(30),
    }),
  );
  parts.push(textBlock(T.card1Foot, X(1158), Y(244), 12, { color: PALETTE.inkSoft, lineHeight: 1.45 }));
  parts.push(
    formulaLine('\\tilde z=z_p+\\mathrm{sg}(z_q-z_p)\\;\\Rightarrow\\;e_a-p\\to e_a-q', {
      x: X(1158),
      y: Y(332),
      w: X(372),
      size: 16,
      h: Y(30),
    }),
  );
  parts.push(textBlock([T.card2Foot], X(1158), Y(378), 12, { color: PALETTE.inkSoft }));
  parts.push(textBlock(T.card3Notes, X(1158), Y(458), 12, { color: PALETTE.inkSoft, lineHeight: 1.5 }));

  // ── 底部：on-policy → off-policy → centered ──
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
  const name = String(args.name || 'score-centering-cover');
  const fontCss = await buildHandFontCss(HAND_TEXTS);
  const svg = renderScoreCenteringCoverSvg({ width, height, fontCss });
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
      console.error('[score-centering-cover] 失败：', (err && err.message) || err);
      process.exit(1);
    });
}
