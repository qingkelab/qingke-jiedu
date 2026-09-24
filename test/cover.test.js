// 头图（手绘技术研究笔记风格）：内容提炼、视觉结构决策、风格约束与发布接线。
// 全部确定性；PNG 栅格化需要本机 Chrome，没有就跳过（不影响 npm test）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chooseCoverStructure, distillCoverContent, numberContext, stripDecorative } from '../src/cover/distill.js';
import { distillSectionFigure, looksLikeMath } from '../src/cover/distill.js';
import { COVER_RATIOS, buildCoverSvg, buildSectionFigures } from '../src/cover/index.js';
import { buildHandFontCss, HAND_FONT_FAMILY } from '../src/cover/font.js';
import { PALETTE, escapeXml, renderCoverSvg, renderFigureSvg, renderMathMl, wrapText } from '../src/cover/svg.js';
import { applyHandDrawnFigures, planPublish } from '../src/publish/publicArticle.js';
import { parseArgs } from '../scripts/make-cover.js';
import { parseArgs as parseFigureArgs } from '../scripts/make-figures.js';

const ARTICLE = [
  '# 只有注意力也能做翻译：Transformer',
  '',
  '这篇论文把循环和卷积全部删掉，只用注意力做序列转导。',
  '',
  '## 结果与实验',
  '',
  '论文称在 WMT 2014 英德上报告 28.4 BLEU，比此前最佳高 2.0 BLEU（Transformer big，8 块 P100 GPU）。',
  '',
  '在 WMT 2014 英法上单模型达到 41.8 BLEU，训练用了 3.5 天。',
  '',
  '## 消融与取舍',
  '',
  '去掉残差 dropout 后 BLEU 掉到 39.1，说明这个正则项不能省。',
  '',
  '## 它还没有证明什么',
  '',
  '论文称只做了两个翻译方向的可视化，未给出因果实验。',
  '',
  '## 核心公式',
  '',
  '$$h_t = \\alpha \\odot h_{t-1} + (1-\\alpha) \\odot W e_t$$',
  '',
].join('\n');

// ============ 内容提炼 ============

test('distill：标题/副标题/小节骨架/术语都能从终稿里取出来', () => {
  const c = distillCoverContent({ markdown: ARTICLE });
  assert.equal(c.title, '只有注意力也能做翻译：Transformer');
  assert.match(c.subtitle, /循环和卷积/);
  assert.ok(c.steps.length >= 3, `小节骨架应至少 3 条，实际 ${c.steps.length}`);
  assert.ok(c.tags.includes('Transformer'), `术语里应有 Transformer：${c.tags}`);
  assert.equal(c.formula.latex.includes('h_t'), true);
});

test('distill：结论数字要带单位与条件句，小整数与配置参数不进海报', () => {
  const c = distillCoverContent({ markdown: ARTICLE });
  const values = c.numbers.map((n) => n.value);
  assert.ok(values.some((v) => /28\.4/.test(v)), `应抓到 28.4 BLEU：${values}`);
  assert.ok(values.some((v) => /41\.8/.test(v)), `应抓到 41.8 BLEU：${values}`);
  for (const n of c.numbers) {
    assert.ok(n.condition.length > 8, '每个数字都要带上条件句');
    assert.equal(n.value.length <= 18, true);
  }
  assert.ok(c.numbers.length <= 5, '海报最多 5 个数字');
});

test('distill：批注句去掉 markdown 记号', () => {
  const md = '## 小结\n\n论文称**在 8 块 GPU 上**训练，## 没有因果实验。';
  const c = distillCoverContent({ markdown: md });
  assert.ok(c.claims.length >= 1);
  assert.equal(/[*#]/.test(c.claims.join('')), false, `批注不该带 markdown 记号：${c.claims}`);
});

test('numberContext：优先取数字后面的单位/指标词', () => {
  assert.equal(numberContext('报告 28.4 BLEU，比基线高', '28.4b').label, 'BLEU');
  assert.equal(numberContext('训练用了 3.5 days on GPUs', '3.5').unitWord, 'days');
  // 纯符号单位时用前面的术语，避免整列都是「%」
  const ctx = numberContext('平均成功率从 76.3 掉到 45.6%', '45.6%');
  assert.notEqual(ctx.label, '%', '不该把裸符号当标签（取不到就留空，由小节标题兜底）');
  assert.equal(ctx.unitWord, '%');
});

test('stripDecorative：标题里的 emoji 不画进海报', () => {
  assert.equal(stripDecorative('🚀 发布安排：产品计划在第三季度发布'), '发布安排：产品计划在第三季度发布');
});

// ============ 视觉结构决策 ============

test('structure：数字多→数据条；数字少但小节多→流程链路；都没有→概念图', () => {
  assert.equal(chooseCoverStructure({ numbers: [1, 2, 3, 4], steps: ['a', 'b'], claims: ['x'] }).primary, 'curve');
  assert.equal(chooseCoverStructure({ numbers: [1], steps: ['a', 'b', 'c'], claims: ['x'] }).primary, 'pipeline');
  assert.equal(chooseCoverStructure({ numbers: [], steps: [], claims: [] }).primary, 'concept');
});

test('structure：模块按内容出现，并给出可读理由', () => {
  const withAll = chooseCoverStructure({
    numbers: [1, 2, 3, 4],
    steps: ['消融与取舍', '实现结构'],
    claims: ['论文称…'],
    formula: { latex: 'x' },
    markdown: '```js\ncode\n```',
  });
  assert.deepEqual(withAll.modules.filter((m) => m !== 'axes'), ['formula', 'tree', 'code', 'annotation']);
  assert.match(withAll.reason, /结论数字|小节/);
  const minimal = chooseCoverStructure({ numbers: [], steps: [], claims: [] });
  assert.ok(minimal.reason.length > 0);
});

// ============ 风格约束（禁止 3D / 渐变 / 卡通 / PPT 风）============

test('svg：不出现渐变、3D 阴影与 emoji；纸纹是二维噪声', () => {
  return buildCoverSvg({ markdown: ARTICLE, ratio: 'poster' }).then(({ svg }) => {
    assert.equal(/linear-gradient|radial-gradient|conic-gradient/.test(svg), false, '不许用渐变');
    assert.equal(/box-shadow|drop-shadow|feDropShadow/.test(svg), false, '不许用投影（3D 感）');
    assert.equal(/[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}]/u.test(svg), false, '不许出现 emoji');
    assert.match(svg, /feTurbulence/, '纸张纹理用二维噪声');
    assert.match(svg, new RegExp(PALETTE.paper));
    assert.match(svg, new RegExp(PALETTE.blue));
    assert.match(svg, new RegExp(PALETTE.red));
  });
});

test('svg：同一份内容渲染两次完全一致（确定性抖动，不是随机图）', async () => {
  const a = (await buildCoverSvg({ markdown: ARTICLE, ratio: 'poster' })).svg;
  const b = (await buildCoverSvg({ markdown: ARTICLE, ratio: 'poster' })).svg;
  assert.equal(a, b);
});

test('svg：三种版式尺寸正确，横版不与竖版同构', async () => {
  const poster = await buildCoverSvg({ markdown: ARTICLE, ratio: 'poster' });
  const wide = await buildCoverSvg({ markdown: ARTICLE, ratio: 'wide' });
  assert.equal(`${poster.width}x${poster.height}`, `${COVER_RATIOS.poster.width}x${COVER_RATIOS.poster.height}`);
  assert.equal(`${wide.width}x${wide.height}`, `${COVER_RATIOS.wide.width}x${COVER_RATIOS.wide.height}`);
  assert.match(poster.svg, new RegExp(`viewBox="0 0 ${poster.width} ${poster.height}"`));
  assert.notEqual(poster.svg, wide.svg);
});

test('svg：特殊字符被转义（标题带 & < > 不会写坏 XML）', () => {
  const svg = renderCoverSvg({
    content: { title: 'A & B <script>', subtitle: '', steps: [], numbers: [], claims: [], tags: [] },
    structure: { primary: 'concept', modules: [], reason: 'r' },
  });
  assert.equal(svg.includes('<script>'), false);
  assert.match(svg, /A &amp; B &lt;script&gt;/);
  assert.match(escapeXml('<"&>'), /^&lt;&quot;&amp;&gt;$/);
});

test('wrapText：英文术语不从中间劈开，长文本能排成多行', () => {
  const lines = wrapText('循环网络把位置当成时间，Transformer 把位置当成坐标', 200, 17);
  assert.ok(lines.length >= 2);
  assert.ok(lines.some((l) => l.includes('Transformer')), `不该劈开 Transformer：${JSON.stringify(lines)}`);
});

// ============ 公式：必须是真排版，不是把 LaTeX 拍平成字符串 ============

test('公式：KaTeX MathML 真排版（保留分式/上下标结构，不残留 LaTeX 命令）', () => {
  const mathml = renderMathMl(String.raw`\frac{a}{b} + \alpha \odot h_{t-1}`);
  assert.match(mathml, /<math/, '应产出 MathML');
  assert.match(mathml, /<mfrac/, '分式要保留 mfrac 结构');
  assert.match(mathml, /<msub/, '下标要保留 msub 结构');
  // MathML 规范要求带一份 TeX 注解（<annotation encoding="application/x-tex">），那是元数据不是渲染内容
  const rendered = mathml.replace(/<annotation[\s\S]*?<\/annotation>/g, '');
  assert.equal(/\\frac|\\alpha|\\odot/.test(rendered), false, '渲染部分不该残留 LaTeX 命令');
});

test('公式面板：SVG 里是 foreignObject + MathML（不是纯文本近似）', () => {
  const svg = renderCoverSvg({
    content: { title: 't', subtitle: '', steps: [], numbers: [], claims: [], tags: [], formula: { latex: String.raw`h_t = \alpha \odot h_{t-1}` } },
    structure: { primary: 'concept', modules: ['formula'], reason: 'r' },
  });
  assert.match(svg, /<foreignObject/);
  assert.match(svg, /<math/);
  assert.match(svg, /<annotation encoding="application\/x-tex"/, '只允许在 MathML 注解里保留 TeX');
  const outside = svg.replace(/<annotation[\s\S]*?<\/annotation>/g, '');
  assert.equal(/\\alpha|\\odot/.test(outside), false, '正文与面板里不该出现原始 LaTeX');
});

test('公式：非法 LaTeX 不炸（throwOnError: false，退化成可读文本）', () => {
  const mathml = renderMathMl(String.raw`\frac{a}{` + '\\');
  assert.equal(typeof mathml, 'string'); // 不抛错即可
});

// ============ 手写字体：按用字内联 ============

test('字体：只内联「这张海报用到的字」对应的分片，并带 OFL 字体家族名', async () => {
  const css = await buildHandFontCss('青稞解读 28.4 BLEU');
  assert.ok(css.length > 0, '应能取到字体分片');
  assert.match(css, /@font-face/);
  assert.match(css, /data:font\/woff2;base64,/);
  assert.match(css, new RegExp(HAND_FONT_FAMILY));
  // 用字少 → 内联体积应远小于整套字体（4MB）
  assert.ok(css.length < 1_500_000, `内联体积应可控，实际 ${css.length}`);
});

test('字体：embedFont:false 时 SVG 不内联字体（体积小、走系统字体栈）', async () => {
  const withFont = await buildCoverSvg({ markdown: ARTICLE, ratio: 'poster' });
  const noFont = await buildCoverSvg({ markdown: ARTICLE, ratio: 'poster', embedFont: false });
  assert.equal(withFont.fontEmbedded, true);
  assert.equal(noFont.fontEmbedded, false);
  assert.ok(withFont.svg.length > noFont.svg.length, '内联字体的 SVG 更大');
  assert.match(withFont.svg, /data:font\/woff2/);
  assert.equal(noFont.svg.includes('data:font/woff2'), false);
  // 两种情况下都保留字体栈（拿不到字体时仍用手写/楷体家族名）
  assert.match(noFont.svg, /LXGW WenKai Lite/);
});

// ============ CLI 与发布接线 ============

test('CLI：参数解析支持 --dir/--ratio/--out/--svg-only/--json', () => {
  const args = parseArgs(['--dir', 'output/x', '--ratio', 'wide', '--svg-only', '--json']);
  assert.equal(args.dir, 'output/x');
  assert.equal(args.ratio, 'wide');
  assert.equal(args['svg-only'], true);
  assert.equal(args.json, true);
});

async function tmpRepo(files = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cover-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return dir;
}

test('publish：有 cover.png 时写成头图（文章页顶部 + 不混进正文配图）', async () => {
  const repo = await tmpRepo({ 'index.html': '<ul>\n<!-- articles -->\n</ul>\n' });
  const coverDir = await tmpRepo({ 'cover.png': 'PNG-COVER', '1.png': 'INLINE-IMG' });
  const plan = await planPublish({
    repoDir: repo,
    markdown: ARTICLE,
    coverFile: path.join(coverDir, 'cover.png'),
    imageFiles: [path.join(coverDir, '1.png')],
  });
  assert.match(plan.summary, /含头图/);
  const coverWrite = plan.writes.find((w) => w.type === 'copy' && /cover\.png$/.test(w.target));
  assert.ok(coverWrite, '应把 cover.png 复制进文章目录');
  const html = plan.writes.find((w) => w.type === 'write').content;
  assert.match(html, /<figure class="cover"><img src="cover\.png"/);
});

test('publish：没有头图时不写 figure（不破坏旧流程）', async () => {
  const repo = await tmpRepo({ 'index.html': '<ul>\n<!-- articles -->\n</ul>\n' });
  const plan = await planPublish({ repoDir: repo, markdown: ARTICLE });
  const html = plan.writes.find((w) => w.type === 'write').content;
  assert.equal(html.includes('class="cover"'), false);
  assert.equal(plan.summary.includes('含头图'), false);
});

// ============ 正文配图：手绘重述替换论文原图 ============

const FIGURE_ARTICLE = [
  '# 论文解读',
  '',
  '## 旧方法卡在哪：顺序计算压住了并行化',
  '',
  '论文称循环网络必须逐步展开，长距离依赖要绕远路，训练时间随序列长度线性增长。',
  '这一段再补一点上下文，让本节正文长度超过出图阈值，保证小节会被选中生成配图。',
  '',
  '![Figure 1: 论文里的架构图](https://arxiv.org/html/1706.03762v7/Figures/ModalNet-21.png)',
  '',
  '## 注意力怎么算：一次矩阵乘解决所有词对',
  '',
  '缩放点积注意力把 Q/K/V 压进一次矩阵运算，论文称在 WMT 2014 英法上达到 41.8 BLEU。',
  '这段同样补足长度，确保第二个小节也能出图，便于检查插入位置是否落在对应小节里。',
  '',
  '![Figure 2: 论文里的注意力图](https://arxiv.org/html/1706.03762v7/Figures/ModalNet-19.png)',
  '',
].join('\n');

test('小节配图提炼：小整数不进图，标签只在指标词时才用，公式要像公式', () => {
  const fig = distillSectionFigure({
    heading: '🧮 注意力怎么算',
    body: '论文称缩放因子用 $1/\\sqrt{d_k}$，在 WMT 2014 上达到 41.8 BLEU；共 2 个数据集，模型宽 512。',
  });
  assert.equal(fig.title.includes('🧮'), false, '标题里的 emoji 不进图');
  assert.ok(fig.numbers.some((n) => /41\.8/.test(n.value)), `应保留 BLEU 数字：${JSON.stringify(fig.numbers)}`);
  assert.equal(fig.numbers.some((n) => n.value === '2'), false, '两位以内的小整数不进图');
  assert.ok(fig.numbers.every((n) => n.label === '' || /BLEU|accuracy|%/.test(n.label)));
  assert.equal(fig.formula.latex.includes('sqrt'), true);
});

test('looksLikeMath：中文散文不会被当成公式（$ 配对错位的典型翻车）', () => {
  assert.equal(looksLikeMath('，由前一步的 hidden state'), false);
  assert.equal(looksLikeMath('\\frac{a}{b}'), true);
  assert.equal(looksLikeMath('h_{t-1}'), true);
});

test('手绘配图：每节一张，结构与正文匹配，风格约束同封面', async () => {
  const figures = await buildSectionFigures({ markdown: FIGURE_ARTICLE, max: 4 });
  assert.equal(figures.length, 2, `应为一节出一张，实际 ${figures.length}`);
  for (const fig of figures) {
    assert.match(fig.svg, /<svg/);
    assert.match(fig.svg, /feTurbulence/);
    assert.equal(/linear-gradient|box-shadow/.test(fig.svg), false, '同样不许渐变/3D');
    assert.match(fig.svg, /手绘重述/);
    assert.ok(fig.sectionTitle.length > 4);
  }
  const svg = renderFigureSvg({ section: figures[0].distilled, index: 1, total: 2 });
  assert.match(svg, /viewBox="0 0 1200 660"/);
});

test('配图替换：原图从正文摘掉、按小节插入手绘图、文末保留原图出处', () => {
  const figures = [
    { sectionTitle: '旧方法卡在哪：顺序计算压住了并行化', title: '旧方法卡在哪', file: 'figure-01.png' },
    { sectionTitle: '注意力怎么算：一次矩阵乘解决所有词对', title: '注意力怎么算', file: 'figure-02.png' },
  ];
  const out = applyHandDrawnFigures(FIGURE_ARTICLE, { figures });
  assert.equal(out.removedOriginals.length, 2, '两张论文原图应被摘掉');
  assert.equal((out.markdown.match(/!\[[^\]]*\]\(https?:/g) || []).length, 0, '正文里不该再有远程原图');
  assert.equal(out.inserted.length, 2);
  for (const fig of figures) {
    const at = out.markdown.indexOf(fig.sectionTitle.slice(0, 8));
    const imgAt = out.markdown.indexOf(`figures/${fig.file}`);
    assert.ok(imgAt > at, `${fig.file} 应插在对应小节里`);
    assert.ok(imgAt - at < 260, `${fig.file} 应紧跟该小节标题，而不是跑到文末`);
  }
  assert.match(out.markdown, /## 原图出处/);
  assert.match(out.markdown, /ModalNet-21\.png/, '原图 URL 必须留在文末可回查');
  // 幂等：再跑一次不会重复插图
  const again = applyHandDrawnFigures(out.markdown, { figures });
  assert.equal((again.markdown.match(/figure-01\.png/g) || []).length, 1);
});

test('publish：有配图时复制 figures/ 并替换正文原图', async () => {
  const repo = await tmpRepo({ 'index.html': '<ul>\n<!-- articles -->\n</ul>\n' });
  const figDir = await tmpRepo({ 'figure-01.png': 'F1', 'figure-02.png': 'F2' });
  const plan = await planPublish({
    repoDir: repo,
    markdown: FIGURE_ARTICLE,
    figures: [
      { sectionTitle: '旧方法卡在哪：顺序计算压住了并行化', title: '旧方法卡在哪', file: 'figure-01.png', from: `${figDir}/figure-01.png` },
      { sectionTitle: '注意力怎么算：一次矩阵乘解决所有词对', title: '注意力怎么算', file: 'figure-02.png', from: `${figDir}/figure-02.png` },
    ],
  });
  assert.match(plan.summary, /手绘配图 2 张（替换原图 2 张）/);
  const copies = plan.writes.filter((w) => w.type === 'copy').map((w) => w.target);
  assert.equal(copies.some((t) => /figures\/figure-01\.png$/.test(t)), true);
  const html = plan.writes.find((w) => w.type === 'write').content;
  assert.match(html, /figures\/figure-01\.png/);
  assert.equal(/ModalNet-21\.png/.test(html.split('原图出处')[0] || ''), false, '正文里不再引用原图');
  assert.match(html, /原图出处/);
});

test('配图 CLI：参数解析支持 --dir/--max/--svg-only/--out', () => {
  const args = parseFigureArgs(['--dir', 'output/x', '--max', '3', '--svg-only']);
  assert.equal(args.dir, 'output/x');
  assert.equal(args.max, '3');
  assert.equal(args['svg-only'], true);
});
