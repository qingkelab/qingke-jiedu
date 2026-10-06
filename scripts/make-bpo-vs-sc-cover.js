#!/usr/bin/env node
/**
 * 生成一张「手绘研究笔记」风格封面：BPO 与 Score Centering 的对比。
 *
 *   node scripts/make-bpo-vs-sc-cover.js                  # → output/handdrawn/bpo-vs-sc-cover.svg|png（1600×681，2.35:1）
 *   node scripts/make-bpo-vs-sc-cover.js --svg-only        # 只出 SVG（不需要 Chrome）
 *   node scripts/make-bpo-vs-sc-cover.js --width 1880 --height 800 --scale 2
 *
 * 中央两图：左panel 把期望更新拆成 drift + signal（SC 减掉的是 drift），
 * 右panel 让「TIM 的 drift」与「PMD + 贝尔曼的残差」两条推导汇到同一个 token 梯度。
 * 画法与其它封面共用 src/cover/handdrawn.js 的同一套手绘原语。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PALETTE, makeJitter, wrapText, renderMathMl } from '../src/cover/svg.js';
import { buildHandFontCss } from '../src/cover/font.js';
import { formulaBox, paperFrame, pencilArrow, pencilLine, pencilPath, pencilRect, svgDocument, textBlock } from '../src/cover/handdrawn.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** 图上的手写文字（同一份清单也用来按需内嵌字体子集）。 */
const T = {
  meta: '手绘速记 · RL 后训练笔记',
  metaRight: '青稞解读 · 一篇文章一张图',
  title1: 'BPO × Score Centering',
  title2: '两条推导，同一个 token 梯度',
  subtitle:
    'SC 从 TIM 的 drift 出发，直接减掉平均 score；BPO 从 PMD + 贝尔曼推出无 critic 的轨迹残差。full-vocabulary 下，两者的 token 梯度是同一个。',
  tags: ['TIM / drift', 'PMD + Bellman', 'top-k 尾部', 'Binary KL', 'bias correction'],
  keyLabel: '关键式',
  tagSplit: 'drift + signal',
  tagSc: 'SC：减掉平均 score',
  tagDelta: 'BPO：轨迹残差 δ',
  tagShare: 'full-vocab 下共享',
  leftNote: '共享的 token 梯度：−Â[g_t(y_t) − ḡ_t]；差别只在怎么近似 reverse-KL。',

  centerHead: 'drift 与 signal 分开看',
  centerSub: '期望更新 = 平均奖励 × 平均 score + 协方差：前一项不携带学习信号',
  panelAHead: '期望更新 = drift + signal',
  labelSignal: 'signal',
  labelDrift: 'drift',
  labelResult: 'E_q[Rs]',
  panelANote: 'SC：减掉 drift，只留 signal',
  panelBHead: '两条推导，同一个梯度',
  routeSc: 'SC：TIM 的 drift 减掉',
  routeBpo: 'BPO：PMD + 贝尔曼 → δ',
  shareBox: ['同一个 token 梯度', '−Â (g_t − ḡ_t)'],
  centerNote: 'full-vocabulary 下梯度相同；差别只在各自怎么近似 ∇D_KL(μ‖π)。',

  card1Head: 'drift 是什么：往 sampler 蒸馏',
  card1Note: '平均 score 就是交叉熵的负梯度',
  card1Foot: '固定教师会收敛；在线 sampler 是 trainer 的有偏副本 → 偏差被反复注入',
  card2Head: 'BPO：为什么可以不要 critic',
  card2Note: '直接估 V^μ、Q^μ 要 T·N 次额外 rollout',
  card2Foot: '贝尔曼望远镜消掉中间价值；残差是鞅，δ=0 排除正负抵消的伪解',
  card3Head: '两种实用近似',
  card3Rows: [
    'SC：top-k（k=32/128）尾部 ρ 建模，每 token 存 O(k)',
    'BPO：Binary KL + ω 平滑 / cap / mask，只需 q_t，O(1)',
  ],
  card3Foot: '· SC 是 bias correction，不是 control variate',

  step1Head: '① TIM 从哪来',
  step1Note: '训推数值差、异步 stale、partial rollout、mini-batch 切分',
  step2Head: '② SC 的做法',
  step2Note: '不看 importance ratio，直接减掉 ḡ，也不需要裁剪',
  step3Head: '③ BPO 的做法',
  step3Note: 'PMD 条件 + 贝尔曼望远镜，得无 critic 残差再线性化',

  footer: '手绘速记：依据两篇论文重画，公式为要点式总结；细节以原文为准。',
  source: '参考：Score Centering · arXiv 2609.20807 ／ BPO · arXiv 2609.15987',
};

const HAND_TEXTS = [
  ...Object.values(T).flat(),
  '手绘研究笔记漂移信号期望更新协方差平均奖励蒸馏交叉熵策略镜像下降贝尔曼望远镜残差无评论家重要性采样裁剪近似关键式工程取舍',
].join('｜');

function formulaLine(latex, { x, y, w, size = 15, h = 30 }) {
  const mathml = renderMathMl(latex, { displayMode: false });
  if (!mathml) return '';
  return (
    `<foreignObject x="${x}" y="${y}" width="${w}" height="${h}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="font-size:${size}px;line-height:1.25;color:${PALETTE.blue};overflow:hidden">${mathml}</div>` +
    `</foreignObject>`
  );
}

/* ------------------------------------------------------------------ *
 * 版面：1600×681（2.35:1）。左栏标题+关键式，中栏 drift/signal 与两路汇合，右栏三张便签，底部三段。
 * ------------------------------------------------------------------ */

export function renderBpoVsScCoverSvg({ width = 1600, height = 681, fontCss = '' } = {}) {
  const W = width;
  const H = height;
  const sx = W / 1600;
  const sy = H / 681;
  const X = (v) => v * sx;
  const Y = (v) => v * sy;
  const jitter = makeJitter(`bpo-vs-sc|${W}x${H}|v1`);
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
          latex: '\\mathbb E_q[Rs]=\\mathbb E_q[R]\\,\\bar s+\\mathrm{Cov}_q(R,s)',
          y: Y(316),
          size: 18,
          h: Y(32),
        },
        {
          latex: '\\widetilde s=s-\\bar s\\;\\Rightarrow\\;\\mathbb E_q[\\widetilde s]=0,\\;\\mathbb E_q[R\\widetilde s]=\\mathrm{Cov}_q(R,s)',
          y: Y(352),
          size: 17,
          h: Y(32),
        },
        {
          latex: '\\delta=\\eta\\left(R-V^{\\mu}(x)\\right)-\\sum_t\\left[\\log\\tfrac{\\pi}{\\mu}+D_{\\mathrm{KL}}(\\mu\\|\\pi)\\right]',
          y: Y(388),
          size: 16,
          h: Y(32),
        },
        {
          latex: '\\nabla_\\theta\\ell_t=-\\hat A\\left[g_t(y_t)-\\bar g_t\\right]',
          y: Y(424),
          size: 18,
          h: Y(32),
          color: PALETTE.red,
        },
      ],
    }),
  );
  const tagX = box.x + box.w - 14;
  parts.push(textBlock([T.tagSplit], tagX, Y(338), 12.5, { color: PALETTE.inkSoft, anchor: 'end' }));
  parts.push(textBlock([T.tagSc], tagX, Y(374), 12.5, { color: PALETTE.blue, anchor: 'end' }));
  parts.push(textBlock([T.tagDelta], tagX, Y(410), 12.5, { color: PALETTE.inkSoft, anchor: 'end' }));
  parts.push(textBlock([T.tagShare], tagX, Y(446), 12.5, { color: PALETTE.red, anchor: 'end' }));
  parts.push(textBlock(wrapText(T.leftNote, X(556), 13).slice(0, 2), X(56), Y(492), 13, { color: PALETTE.red, lineHeight: 1.4 }));

  // ── 中栏：左panel drift/signal 分解，右panel 两路汇合 ──
  parts.push(textBlock([T.centerHead], X(648), Y(150), 16, { weight: 600 }));
  parts.push(textBlock([T.centerSub], X(648), Y(172), 13, { color: PALETTE.inkSoft }));
  parts.push(pencilRect(X(648), Y(196), X(230), Y(196), jitter, { color: PALETTE.pencil, width: 1.2, opacity: 0.5, dash: '6 6' }));
  parts.push(pencilRect(X(908), Y(196), X(204), Y(196), jitter, { color: PALETTE.pencil, width: 1.2, opacity: 0.5, dash: '6 6' }));
  parts.push(textBlock([T.panelAHead], X(662), Y(220), 13, { color: PALETTE.inkSoft }));
  parts.push(textBlock([T.panelBHead], X(922), Y(220), 13, { color: PALETTE.inkSoft }));

  // 左 panel：向量三角形 —— 期望更新 = signal + drift，SC 把 drift 划掉
  const ox = X(708);
  const oy = Y(362);
  parts.push(pencilArrow(ox, oy, X(804), oy, jitter, { color: PALETTE.blue, width: 2.2 }));
  parts.push(pencilArrow(ox, oy, X(748), Y(254), jitter, { color: PALETTE.red, width: 2.4 }));
  parts.push(pencilPath([[ox, oy], [X(844), Y(254)]], jitter, { color: PALETTE.ink, width: 1.8, dash: '7 6' }));
  parts.push(textBlock([T.labelSignal], X(810), Y(358), 12, { color: PALETTE.blue }));
  parts.push(textBlock([T.labelDrift], X(754), Y(258), 12, { color: PALETTE.red }));
  parts.push(textBlock([T.labelResult], X(852), Y(244), 12, { anchor: 'end' }));
  // 红叉：drift 这一项被 SC 减掉
  parts.push(pencilLine(X(720), Y(300), X(736), Y(316), jitter, { color: PALETTE.red, width: 2.4 }));
  parts.push(pencilLine(X(736), Y(300), X(720), Y(316), jitter, { color: PALETTE.red, width: 2.4 }));
  parts.push(textBlock([T.panelANote], X(662), Y(386), 12, { color: PALETTE.red }));

  // 右 panel：两条推导汇到同一个 token 梯度
  parts.push(textBlock([T.routeSc], X(922), Y(256), 12.5, { color: PALETTE.blue }));
  parts.push(textBlock([T.routeBpo], X(922), Y(294), 12.5, { color: PALETTE.red }));
  parts.push(pencilArrow(X(1010), Y(312), X(1010), Y(332), jitter, { width: 1.8 }));
  parts.push(pencilRect(X(920), Y(334), X(180), Y(34), jitter, { color: PALETTE.red, width: 1.8 }));
  parts.push(textBlock(T.shareBox, X(1010), Y(348), 11.5, { anchor: 'middle', lineHeight: 1.3 }));
  parts.push(textBlock([T.centerNote], X(648), Y(440), 13.5, { color: PALETTE.ink }));

  // ── 右栏：三张便签 ──
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
    formulaLine('\\bar s=-\\nabla_\\theta D_{\\mathrm{KL}}(\\mu\\|\\pi_\\theta)=-\\nabla_\\theta L_{\\mathrm{CE}}', {
      x: X(1158),
      y: Y(200),
      w: X(372),
      h: Y(30),
    }),
  );
  parts.push(textBlock(wrapText(T.card1Foot, X(372), 12).slice(0, 2), X(1158), Y(244), 12, { color: PALETTE.inkSoft, lineHeight: 1.45 }));
  parts.push(
    formulaLine('\\sum_t A^{\\mu}(s_t,y_t)=R(x,y)-V^{\\mu}(x)', {
      x: X(1158),
      y: Y(330),
      w: X(372),
      h: Y(30),
    }),
  );
  parts.push(textBlock(wrapText(T.card2Foot, X(372), 12).slice(0, 2), X(1158), Y(372), 12, { color: PALETTE.inkSoft, lineHeight: 1.45 }));

  parts.push(pencilRect(X(1144), Y(410), X(400), Y(116), jitter, { color: PALETTE.ink, width: 1.6, opacity: 0.85 }));
  parts.push(textBlock([T.card3Head], X(1158), Y(432), 13.5, { weight: 600 }));
  parts.push(textBlock(wrapText(T.card3Rows[0], X(372), 12.5).slice(0, 2), X(1158), Y(458), 12.5, { color: PALETTE.ink, lineHeight: 1.4 }));
  parts.push(textBlock(wrapText(T.card3Rows[1], X(372), 12.5).slice(0, 2), X(1158), Y(482), 12.5, { color: PALETTE.ink, lineHeight: 1.4 }));
  parts.push(textBlock([T.card3Foot], X(1158), Y(510), 12, { color: PALETTE.red }));

  // ── 底部：TIM 由来 → SC → BPO ──
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
  const name = String(args.name || 'bpo-vs-sc-cover');
  const fontCss = await buildHandFontCss(HAND_TEXTS);
  const svg = renderBpoVsScCoverSvg({ width, height, fontCss });
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
      console.error('[bpo-vs-sc-cover] 失败：', (err && err.message) || err);
      process.exit(1);
    });
}
