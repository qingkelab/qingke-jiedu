#!/usr/bin/env node
/**
 * 生成一张「手绘研究笔记」风格封面：Bellman Policy Optimization（BPO）。
 *
 *   node scripts/make-bpo-cover.js                    # → output/handdrawn/bpo-cover.svg|png（1600×681，2.35:1）
 *   node scripts/make-bpo-cover.js --svg-only          # 只出 SVG（不需要 Chrome）
 *   node scripts/make-bpo-cover.js --width 1880 --height 800 --scale 2
 *
 * 中央图两件事：左panel 用一条轨迹说明「序列 IS 权重随长度爆炸」（T=16384、r_t=1.001），
 * 右panel 是 BPO 的推导链（PMD 逐 token 条件 → 代入贝尔曼 → 轨迹残差 δ → min δ²/2η）。
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
  meta: '手绘速记 · RL 后训练笔记',
  metaRight: '青稞解读 · 一篇文章一张图',
  title1: 'Bellman Policy Optimization',
  title2: '不靠 IS，也不要 critic',
  subtitle:
    'RLVR 的数据常来自旧策略。BPO 用 PMD 条件 + 贝尔曼方程把逐 token 优势望远镜消去，得到定义在 μ 下、不需要 IS 权重的轨迹级残差目标。',
  tags: ['RLVR', 'off-policy', 'PMD + Bellman', '无 critic', '二元 KL'],
  keyLabel: '关键式',
  tagPmd: 'PMD 解析解',
  tagBellman: '贝尔曼：望远镜消去',
  tagGoal: 'BPO 目标（无 IS）',
  tagSc: '= score centering 梯度',
  leftNote: 'BPO 把「最优化条件 + 贝尔曼」揉成一个残差：它定义在 μ 下，所以既不用 IS 权重，也不用单独训 critic。',

  centerHead: '为什么不用重要性采样',
  centerSub: '序列权重是 T 个 token 比率的连乘，长回答上直接爆炸',
  panelHead: 'IS 权重随长度爆炸',
  panelSub: 'T=16384、r=1.001',
  curveProd: '连乘 W ≈1.3×10⁷',
  curveLin: '一阶近似 17.4',
  axisLog: 'log 尺度',
  axisT: 'T=16384',
  panelBHead: 'BPO：把 critic 消掉',
  nodePmd: 'PMD 最优性条件',
  nodeBellman: '贝尔曼方程',
  nodeDelta: ['轨迹残差 δ', 'min δ² / 2η'],
  arrowInto: '代入',
  arrowTelescope: '望远镜求和',
  centerNote: '既不算 IS 权重、也不训练 critic：把中间状态价值沿轨迹消掉。',

  card1Head: '实用 loss：二元 KL + 平滑',
  card1Note: '把词表压成「采样 token vs 其余」两类',
  card1Foot: 'ω_t =(1+ε−q_t)/(1+ε−p_t)，M_t 按 Â 的符号裁剪',
  card2Head: '与 score centering 的关系',
  card2Note: '线性化之后，token 梯度完全相同',
  card2Foot: '差别只在近似 ∇D_KL(μ‖π)：BPO 走二元 KL，SC 走 top-k',
  card3Head: 'AIME 平均准确率（Avg@32, %）',
  card3Source: '来源：BPO 表 1',

  step1Head: '① π ≠ μ 是常态',
  step1Note: '同步 mini-batch、异步 stale、partial rollout、训推数值差',
  step2Head: '② IS 的代价',
  step2Note: '序列权重是 T 个比率连乘，长回答上方差爆炸',
  step3Head: '③ BPO 的取舍',
  step3Note: '不估 IS 权重、不训 critic；近似只在 reverse-KL 那一步',

  footer: '手绘速记：依据论文重画，公式为要点式总结；细节以原文为准。',
  source: '参考：Bellman Policy Optimization · arXiv 2609.15987（Song & Xu）',
};

const HAND_TEXTS = [
  ...Object.values(T).flat(),
  '手绘研究笔记离策略重要性采样序列权重连乘方差爆炸贝尔曼方程望远镜消去轨迹残差平方目标策略镜像下降关键式实验准确率来源取舍',
].join('｜');

/** 论文表 1：AIME 24/25/26 的 Avg@32 平均准确率。 */
const AIME_ROWS = [
  { label: 'BPO', value: 50.5 },
  { label: 'CISPO', value: 47.4 },
  { label: 'DPPO', value: 46.4 },
  { label: 'GSPO', value: 43.5 },
  { label: 'GRPO-ClipH', value: 39.5 },
];

function formulaLine(latex, { x, y, w, size = 15, h = 30 }) {
  const mathml = renderMathMl(latex, { displayMode: false });
  if (!mathml) return '';
  return (
    `<foreignObject x="${x}" y="${y}" width="${w}" height="${h}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="font-size:${size}px;line-height:1.25;color:${PALETTE.blue};overflow:hidden">${mathml}</div>` +
    `</foreignObject>`
  );
}

/** 迷你条形图：柱长按数值等比（不截断坐标轴），最大项用红色。 */
function miniBars({ x, y, labelW, barMax, rows, rowH, jitter }) {
  const max = Math.max(...rows.map((r) => r.value));
  const parts = [];
  rows.forEach((row, i) => {
    const cy = y + i * rowH;
    const color = i === 0 ? PALETTE.red : PALETTE.blue;
    const len = Math.max(14, (row.value / max) * barMax);
    parts.push(textBlock([row.label], x, cy, 11, { color: PALETTE.inkSoft }));
    parts.push(pencilRect(x + labelW, cy - 10, len, 12, jitter, { color, width: 1.6 }));
    for (let hx = x + labelW + 7; hx < x + labelW + len - 5; hx += 10) {
      parts.push(pencilLine(hx, cy - 8, hx + 5, cy + 1, jitter, { color, width: 0.9, opacity: 0.3 }));
    }
    parts.push(textBlock([row.value.toFixed(1)], x + labelW + barMax + 12, cy, 11.5, { weight: 600 }));
  });
  return parts.join('');
}

/* ------------------------------------------------------------------ *
 * 版面：1600×681（2.35:1）。左栏标题+关键式，中栏 IS 爆炸 vs BPO 推导链，右栏三张便签，底部三段。
 * ------------------------------------------------------------------ */

export function renderBpoCoverSvg({ width = 1600, height = 681, fontCss = '' } = {}) {
  const W = width;
  const H = height;
  const sx = W / 1600;
  const sy = H / 681;
  const X = (v) => v * sx;
  const Y = (v) => v * sy;
  const jitter = makeJitter(`bpo-cover|${W}x${H}|v1`);
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
    const tw = tag.length * 7.8 + 22;
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
        {
          latex: '\\pi^{+}(a\\mid s)=\\frac{\\mu(a\\mid s)\\exp\\left(\\eta A^{\\mu}(s,a)\\right)}{Z_{\\mu}(s)}',
          y: Y(316),
          size: 18,
          h: Y(32),
        },
        { latex: '\\sum_{t=1}^{T}A^{\\mu}(s_t,y_t)=R(x,y)-V^{\\mu}(x)', y: Y(352), size: 18, h: Y(32) },
        { latex: '\\mathcal L_{\\mathrm{exact}}=\\mathbb E_{y\\sim\\mu}\\left[\\phi(x)\\frac{\\delta^{2}}{2\\eta}\\right]', y: Y(388), size: 18, h: Y(32) },
        {
          latex: '\\nabla_\\theta\\ell_t\\approx-\\hat A\\,\\nabla_\\theta\\left[\\log\\pi_\\theta+D_{\\mathrm{KL}}(\\mu\\|\\pi_\\theta)\\right]',
          y: Y(424),
          size: 17,
          h: Y(32),
          color: PALETTE.red,
        },
      ],
    }),
  );
  const tagX = box.x + box.w - 14;
  parts.push(textBlock([T.tagPmd], tagX, Y(338), 12.5, { color: PALETTE.inkSoft, anchor: 'end' }));
  parts.push(textBlock([T.tagBellman], tagX, Y(374), 12.5, { color: PALETTE.inkSoft, anchor: 'end' }));
  parts.push(textBlock([T.tagGoal], tagX, Y(410), 12.5, { color: PALETTE.blue, anchor: 'end' }));
  parts.push(textBlock([T.tagSc], tagX, Y(446), 12.5, { color: PALETTE.red, anchor: 'end' }));
  parts.push(textBlock(wrapText(T.leftNote, X(556), 13).slice(0, 2), X(56), Y(492), 13, { color: PALETTE.red, lineHeight: 1.4 }));

  // ── 中栏：IS 爆炸曲线 + BPO 推导链 ──
  parts.push(textBlock([T.centerHead], X(648), Y(150), 16, { weight: 600 }));
  parts.push(textBlock([T.centerSub], X(648), Y(172), 13, { color: PALETTE.inkSoft }));
  parts.push(pencilRect(X(648), Y(196), X(230), Y(196), jitter, { color: PALETTE.pencil, width: 1.2, opacity: 0.5, dash: '6 6' }));
  parts.push(pencilRect(X(908), Y(196), X(204), Y(196), jitter, { color: PALETTE.pencil, width: 1.2, opacity: 0.5, dash: '6 6' }));
  parts.push(textBlock([T.panelHead], X(662), Y(220), 13, { color: PALETTE.inkSoft }));
  parts.push(textBlock([T.panelSub], X(662), Y(240), 12, { color: PALETTE.pencil }));
  parts.push(textBlock([T.panelBHead], X(922), Y(220), 13, { color: PALETTE.inkSoft }));

  // 左 panel：log 尺度上，连乘是一条陡线，一阶近似几乎贴着地面
  parts.push(pencilArrow(X(690), Y(374), X(866), Y(374), jitter, { color: PALETTE.pencil, width: 1.2, opacity: 0.5 }));
  parts.push(pencilArrow(X(690), Y(374), X(690), Y(258), jitter, { color: PALETTE.pencil, width: 1.2, opacity: 0.5 }));
  parts.push(textBlock([T.axisLog], X(682), Y(266), 11.5, { color: PALETTE.pencil, anchor: 'end' }));
  parts.push(textBlock([T.axisT], X(862), Y(390), 11.5, { color: PALETTE.pencil, anchor: 'end' }));
  parts.push(
    pencilPath(
      [
        [690, 370],
        [730, 338],
        [770, 306],
        [812, 274],
        [854, 246],
      ],
      jitter,
      { color: PALETTE.red, width: 2.2 },
    ),
  );
  parts.push(
    pencilPath(
      [
        [690, 370],
        [760, 362],
        [810, 356],
        [854, 350],
      ],
      jitter,
      { color: PALETTE.blue, width: 1.8 },
    ),
  );
  parts.push(textBlock([T.curveProd], X(852), Y(240), 11.5, { color: PALETTE.red, anchor: 'end' }));
  parts.push(textBlock([T.curveLin], X(852), Y(342), 11.5, { color: PALETTE.blue, anchor: 'end' }));

  // 右 panel：PMD 条件 → 代入贝尔曼 → 轨迹残差
  parts.push(nodeBox(X(918), Y(232), X(184), Y(30), [T.nodePmd], jitter, { color: PALETTE.ink, size: 12 }));
  parts.push(nodeBox(X(918), Y(288), X(184), Y(30), [T.nodeBellman], jitter, { color: PALETTE.ink, size: 12 }));
  parts.push(nodeBox(X(918), Y(344), X(184), Y(32), T.nodeDelta, jitter, { color: PALETTE.red, size: 11.5 }));
  parts.push(pencilArrow(X(1010), Y(262), X(1010), Y(288), jitter, { width: 1.6 }));
  parts.push(textBlock([T.arrowInto], X(1018), Y(280), 11.5, { color: PALETTE.inkSoft }));
  parts.push(pencilArrow(X(1010), Y(318), X(1010), Y(344), jitter, { width: 1.6 }));
  parts.push(textBlock([T.arrowTelescope], X(1018), Y(336), 11.5, { color: PALETTE.inkSoft }));
  parts.push(textBlock([T.centerNote], X(648), Y(440), 13.5, { color: PALETTE.ink }));

  // ── 右栏：三张便签（第三张是论文表 1 的柱状图）──
  for (const card of [
    { y: 150, head: T.card1Head, note: T.card1Note },
    { y: 280, head: T.card2Head, note: T.card2Note },
  ]) {
    const cx = X(1144);
    const cy = Y(card.y);
    parts.push(pencilRect(cx, cy, X(400), Y(116), jitter, { color: PALETTE.ink, width: 1.6, opacity: 0.85 }));
    parts.push(textBlock([card.head], cx + 14, cy + 24, 15, { weight: 600 }));
    parts.push(textBlock([card.note], cx + 14, cy + 46, 12.5, { color: PALETTE.inkSoft }));
  }
  parts.push(
    formulaLine('\\ell_t^{\\mathrm{BPO}}=-\\hat A\\,M_t\\,\\mathrm{sg}\\left[\\min(\\omega_t,C)\\right]\\log p_t', {
      x: X(1158),
      y: Y(200),
      w: X(372),
      h: Y(30),
    }),
  );
  parts.push(textBlock(wrapText(T.card1Foot, X(372), 12).slice(0, 2), X(1158), Y(244), 12, { color: PALETTE.inkSoft, lineHeight: 1.45 }));
  parts.push(
    formulaLine('-\\hat A\\,\\nabla_\\theta\\left[\\log\\pi_\\theta(y_t\\mid s_t)+D_{\\mathrm{KL}}(\\mu\\|\\pi_\\theta)\\right]', {
      x: X(1158),
      y: Y(330),
      w: X(372),
      h: Y(30),
    }),
  );
  parts.push(textBlock(wrapText(T.card2Foot, X(372), 12).slice(0, 2), X(1158), Y(372), 12, { color: PALETTE.inkSoft, lineHeight: 1.45 }));

  parts.push(pencilRect(X(1144), Y(410), X(400), Y(116), jitter, { color: PALETTE.ink, width: 1.6, opacity: 0.85 }));
  parts.push(textBlock([T.card3Head], X(1158), Y(432), 13.5, { weight: 600 }));
  parts.push(textBlock([T.card3Source], X(1530), Y(432), 11, { color: PALETTE.pencil, anchor: 'end' }));
  parts.push(miniBars({ x: X(1158), y: Y(452), labelW: X(88), barMax: X(200), rows: AIME_ROWS, rowH: Y(16), jitter }));

  // ── 底部：离策略由来 → IS 代价 → BPO 取舍 ──
  parts.push(pencilLine(X(56), Y(540), X(1544), Y(540), jitter, { color: PALETTE.pencil, width: 1, opacity: 0.6 }));
  const steps = [
    { x: 56, w: 470, head: T.step1Head, note: T.step1Note },
    { x: 560, w: 470, head: T.step2Head, note: T.step2Note },
    { x: 1064, w: 480, head: T.step3Head, note: T.step3Note },
  ];
  for (const step of steps) {
    parts.push(pencilRect(X(step.x), Y(556), X(step.w), Y(64), jitter, { color: PALETTE.ink, width: 1.6, opacity: 0.85 }));
    parts.push(textBlock([step.head], X(step.x) + 14, Y(580), 15, { weight: 600 }));
    parts.push(textBlock([step.note], X(step.x) + 14, Y(602), 12.5, { color: PALETTE.inkSoft }));
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
  const name = String(args.name || 'bpo-cover');
  const fontCss = await buildHandFontCss(HAND_TEXTS);
  const svg = renderBpoCoverSvg({ width, height, fontCss });
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
      console.error('[bpo-cover] 失败：', (err && err.message) || err);
      process.exit(1);
    });
}
