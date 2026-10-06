// 封面审计与契约修复：先审契约与版面，再定稿（对齐 paper-framework-figure-studio-pro 的「审计前移」）。
// 全部确定性；不依赖网络与 Chrome。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NEGATIVE_CONSTRAINTS,
  auditCover,
  auditCoverSpec,
  auditSvgLayout,
  auditSvgNumbers,
  buildCoverSpec,
  detectPanels,
  extractSvgNodes,
  formatFindings,
  isWhitelisted,
  scoreAudit,
  specVisibleText,
} from '../src/cover/audit.js';
import { coverCandidates, repairCoverSpec, sanitizeSpecText, specToRenderInput } from '../src/cover/repair.js';
import { buildAuditedCover, buildCoverSvg } from '../src/cover/index.js';
import { makeJitter, renderCoverSvg } from '../src/cover/svg.js';
import { paperFrame, pencilRect, svgDocument, textBlock } from '../src/cover/handdrawn.js';

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
].join('\n');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const codesOf = (findings) => findings.map((f) => f.code);

// ============ 契约层 ============

test('契约：buildCoverSpec 给出可审的结构（版式/模块/白名单/负约束/出处）', () => {
  const spec = buildCoverSpec({
    content: { title: 'T', subtitle: 'S', tags: ['Transformer'], steps: ['a'], numbers: [{ value: '28.4', label: 'BLEU', condition: '论文称在 WMT 2014 英德上报告 28.4 BLEU' }], claims: ['论文称…'], formula: { latex: 'h_t' } },
    structure: { primary: 'curve', modules: ['formula', 'tree'], reason: '有 5 个结论数字' },
    width: 1200,
    height: 1600,
    sourceUrl: 'https://arxiv.org/abs/1706.03762',
  });
  assert.equal(spec.version, 1);
  assert.deepEqual(spec.size, { width: 1200, height: 1600 });
  assert.equal(spec.layout, 'portrait');
  assert.equal(spec.blocks[0].id, 'diagram');
  assert.ok(spec.blocks.some((b) => b.id === 'module-formula'));
  assert.equal(spec.blocks[0].required, true);
  for (const c of NEGATIVE_CONSTRAINTS) assert.ok(spec.negativeConstraints.includes(c));
  assert.ok(spec.visibleText.includes('28.4'), '数字要进白名单');
  assert.ok(spec.visibleText.includes('核心公式'), '渲染器固定标签要进白名单');
  assert.equal(spec.grounding.numbers.includes('28.4'), true);
  // 横版用 landscape 版式
  assert.equal(buildCoverSpec({ content: {}, structure: {}, width: 1600, height: 900 }).layout, 'landscape');
});

test('契约：编出来的数字要报错，原文里有出处的数字放行', () => {
  const spec = buildCoverSpec({
    content: { title: 'T', numbers: [{ value: '28.4', label: 'BLEU', condition: '论文称在 WMT 2014 英德上报告 28.4 BLEU' }, { value: '99.9', label: 'BLEU', condition: '（编的）' }] },
    structure: { primary: 'curve', modules: [] },
    width: 1200,
    height: 1600,
  });
  const findings = auditCoverSpec({ spec, markdown: ARTICLE });
  assert.ok(codesOf(findings).includes('ungrounded-number'), '应报未落地的数字');
  assert.equal(findings.filter((f) => f.code === 'ungrounded-number').length, 1);
  assert.equal(findings.find((f) => f.code === 'ungrounded-number').where, '99.9');
});

test('契约：缺负约束 / 缺白名单要能报出来，specVisibleText 覆盖全部要画的字', () => {
  const bare = { title: 'T', negativeConstraints: [], visibleText: [], numbers: [] };
  const findings = auditCoverSpec({ spec: bare, markdown: ARTICLE });
  assert.ok(codesOf(findings).includes('spec-missing-negative-constraints'));
  assert.ok(codesOf(findings).includes('spec-no-visible-text-whitelist'));
  const spec = buildCoverSpec({ content: { title: '标题', subtitle: '副标题', tags: ['Transformer'], steps: ['步'] }, structure: { primary: 'concept' }, width: 1200, height: 1600 });
  const text = specVisibleText(spec);
  assert.ok(text.includes('标题') && text.includes('Transformer') && text.includes('步'));
});

// ============ SVG 解析与面板反解 ============

test('解析：text 的 x/y/字号/锚点与换行后的包围盒都能量出来', () => {
  const svg = svgDocument({ w: 200, h: 100, parts: [textBlock(['中文 abc'], 20, 40, 16, { anchor: 'middle' })] });
  const nodes = extractSvgNodes(svg);
  assert.equal(nodes.texts.length, 1);
  assert.equal(nodes.texts[0].size, 16);
  assert.equal(nodes.texts[0].anchor, 'middle');
  const box = nodes.texts[0].box;
  assert.ok(box.w > 40, `宽度应被估出来：${box.w}`);
  assert.ok(box.x < 20, 'middle 锚点要往左展');
});

test('面板反解：pencilRect（四条线段）能被认成面板，小格子被面积阈值滤掉', () => {
  const jitter = makeJitter('panel-test');
  const parts = [paperFrame({ w: 600, h: 400, jitter }), pencilRect(100, 100, 300, 200, jitter)];
  const nodes = extractSvgNodes(svgDocument({ w: 600, h: 400, parts }));
  const panels = detectPanels(nodes.lines);
  assert.ok(panels.some((p) => Math.abs(p.w - 300) < 4 && Math.abs(p.h - 200) < 4), `应认出 300×200 面板：${JSON.stringify(panels)}`);
  const tiny = detectPanels(nodes.lines, { minArea: 1e9 });
  assert.equal(tiny.length, 0, '面积阈值应能滤掉过小的矩形');
});

// ============ 版面审计 ============

test('版面：越界、超小字号、压字、裸 LaTeX、emoji、渐变都要被抓到', () => {
  const jitter = makeJitter('audit-faults');
  const svg = svgDocument({
    w: 400,
    h: 200,
    parts: [
      paperFrame({ w: 400, h: 200, jitter }),
      textBlock(['跑出画布的文字'], 380, 60, 14), // 越界
      textBlock(['太小'], 40, 60, 8), // 字号过小
      textBlock(['压字A'], 40, 100, 20),
      textBlock(['压字B'], 46, 104, 20), // 与上一行严重重叠
      textBlock(['$h_t = W e_t$'], 40, 140, 14), // 裸 LaTeX
      textBlock(['🚀 发布'], 40, 170, 14), // emoji
      '<linearGradient id="g"></linearGradient>',
    ],
  });
  const codes = codesOf(auditSvgLayout(svg, { width: 400, height: 200 }));
  for (const code of ['text-out-of-frame', 'font-too-small', 'text-overlap', 'raw-latex-in-text', 'emoji-in-text', 'forbidden-style']) {
    assert.ok(codes.includes(code), `应报告 ${code}；实际 ${codes.join(',')}`);
  }
  assert.equal(auditSvgLayout(svg, { width: 400, height: 200 }).some((f) => f.level === 'error'), true);
});

test('版面：文字撑破所在面板要报 panel-overflow（含溢出像素数）', () => {
  const jitter = makeJitter('panel-overflow');
  const svg = svgDocument({
    w: 600,
    h: 400,
    parts: [
      paperFrame({ w: 600, h: 400, jitter }),
      pencilRect(100, 100, 160, 80, jitter),
      textBlock(['这一段文字明显比面板宽很多很多'], 110, 150, 14),
    ],
  });
  const finding = auditSvgLayout(svg, { width: 600, height: 400 }).find((f) => f.code === 'panel-overflow');
  assert.ok(finding, '应报 panel-overflow');
  assert.match(finding.message, /撑破所在面板约 \d+px/);
  assert.ok(finding.panel.w >= 150);
});

test('版面：干净的图不该有误报', () => {
  const jitter = makeJitter('clean');
  const svg = svgDocument({
    w: 600,
    h: 400,
    parts: [
      paperFrame({ w: 600, h: 400, jitter }),
      pencilRect(120, 120, 360, 160, jitter),
      textBlock(['面板标题'], 140, 160, 15),
      textBlock(['一行说明文字，长度合适。'], 140, 200, 13),
    ],
  });
  const findings = auditSvgLayout(svg, { width: 600, height: 400 });
  assert.deepEqual(codesOf(findings), [], `不该有误报：${JSON.stringify(findings)}`);
});

test('版面：概念放射图的长标签要被夹在面板内（回归：曾经能推到画布外）', () => {
  const longSteps = [
    '旧路子卡在规模化负担上：人力研发跟不上，HCI 又暴露能力偏科',
    'L3 让学习者自己决定未来练什么，L4 在部署中适应环境，L5 连「怎么改进」本身都交给系统',
    '最后一版由人类建造的 AI？这需要把自主等级写进工程流程里',
    '把人类写好的改进流程跑成持久工件，再让系统自己迭代这些工件',
    '从论文到推论的映射需要证据锚点，而不是靠一句话概括',
  ];
  for (const [w, h] of [
    [1200, 1600],
    [1600, 900],
    [1200, 1200],
  ]) {
    const svg = renderCoverSvg({
      content: { title: '自主等级路线图', subtitle: '一段副标题', steps: longSteps, numbers: [], claims: [], tags: ['HCI'] },
      structure: { primary: 'concept', reason: '没有数字也没有太多小节 → 概念放射图', modules: [] },
      width: w,
      height: h,
      fontCss: '',
    });
    const findings = auditSvgLayout(svg, { width: w, height: h });
    const bad = findings.filter((f) => f.code === 'text-out-of-frame' || f.code === 'panel-overflow');
    assert.deepEqual(bad.map((f) => `${f.code}:${f.where}`), [], `${w}×${h} 的概念图不该把标签推出边界`);
  }
});

test('白名单：图上出现契约外的文字要报 text-not-whitelisted', () => {
  const jitter = makeJitter('whitelist');
  const svg = svgDocument({ w: 400, h: 200, parts: [paperFrame({ w: 400, h: 200, jitter }), textBlock(['白名单里没有这句'], 40, 100, 14)] });
  const findings = auditSvgLayout(svg, { width: 400, height: 200, visibleText: ['契约里的话'] });
  assert.ok(codesOf(findings).includes('text-not-whitelisted'));
  // 换行碎片与尺寸标注要放行
  assert.equal(isWhitelisted('契约里', ['契约里的话']), true);
  assert.equal(isWhitelisted('1600×900', ['契约里的话']), true);
  assert.equal(isWhitelisted('完全无关的一句', ['契约里的话']), false);
});

test('数字出处：图上有、原文没有的数字要报出来（两位数以上）', () => {
  const jitter = makeJitter('grounding');
  const svg = svgDocument({
    w: 400,
    h: 200,
    parts: [paperFrame({ w: 400, h: 200, jitter }), textBlock(['28.4 BLEU 与 77.7'], 40, 100, 14)],
  });
  const findings = auditSvgNumbers({ svg, markdown: ARTICLE });
  assert.deepEqual(codesOf(findings), ['number-not-in-source']);
  assert.equal(findings[0].where, '77.7');
});

// ============ 契约修复与收敛 ============

test('修复：编造的数字被删掉、负约束被补齐、清洗 emoji 与裸 LaTeX', () => {
  const spec = buildCoverSpec({
    content: {
      title: '🚀 标题 $h_t$',
      numbers: [{ value: '28.4', label: 'BLEU', condition: '论文称 28.4 BLEU' }, { value: '99.9', label: 'x', condition: '' }],
      tags: ['Transformer'],
    },
    structure: { primary: 'curve', modules: ['formula'] },
    width: 1200,
    height: 1600,
  });
  spec.negativeConstraints = [];
  const findings = [
    { level: 'error', code: 'ungrounded-number', where: '99.9', message: '' },
    { level: 'error', code: 'spec-missing-negative-constraints', where: 'spec.negativeConstraints', message: '' },
    { level: 'error', code: 'emoji-in-text', where: '🚀 标题', message: '' },
  ];
  const { spec: fixed, applied } = repairCoverSpec({ spec, findings });
  assert.equal(fixed.numbers.length, 1);
  assert.equal(fixed.numbers[0].value, '28.4');
  assert.deepEqual(fixed.negativeConstraints, NEGATIVE_CONSTRAINTS);
  assert.equal(fixed.title.includes('🚀'), false);
  assert.ok(applied.some((a) => a.action === 'drop-number') && applied.some((a) => a.action === 'sanitize-text'));
  assert.equal(sanitizeSpecText('用 $\\frac{a}{b}$ 做归一'), '用 做归一');
});

test('修复：spec → 渲染输入（content/structure）可用，结构候选按内容收敛', () => {
  const spec = buildCoverSpec({
    content: { title: 'T', steps: ['a', 'b'], numbers: [{ value: '1.0', condition: '' }] },
    structure: { primary: 'pipeline', modules: ['formula'] },
    width: 1200,
    height: 1600,
  });
  const input = specToRenderInput(spec);
  assert.equal(input.content.title, 'T');
  assert.equal(input.structure.primary, 'pipeline');
  assert.deepEqual(input.structure.modules, ['formula']);
  const cands = coverCandidates({ content: { numbers: [1, 2], steps: ['a'] }, structure: { primary: 'curve', modules: ['formula'] }, max: 3 });
  assert.equal(cands.length, 3);
  assert.equal(cands[0].primary, 'curve');
  assert.ok(cands.some((c) => c.primary === 'concept'));
});

// ============ 与真实渲染器接线 ============

test('接线：buildCoverSvg 带出 spec + 审计，真实海报审计通过', async () => {
  const built = await buildCoverSvg({ markdown: ARTICLE, ratio: 'poster', embedFont: false });
  assert.equal(built.audit.ok, true, `审计不该报错：${JSON.stringify(built.audit.findings)}`);
  assert.ok(built.audit.summary.texts > 10);
  assert.ok(built.audit.summary.panels > 0, '真实海报里应有面板被反解出来');
  assert.equal(built.spec.version, 1);
  assert.ok(built.spec.visibleText.length > 5);
  // 同一输入两次，findings 完全一致（确定性）
  const again = await buildCoverSvg({ markdown: ARTICLE, ratio: 'poster', embedFont: false });
  assert.deepEqual(again.audit.findings, built.audit.findings);
  assert.equal(JSON.stringify(again.audit.findings), JSON.stringify(built.audit.findings));
});

test('接线：buildAuditedCover 走「渲染→审计→修复→重渲染」并留 ledger', async () => {
  const built = await buildAuditedCover({ markdown: ARTICLE, ratio: 'wide', rounds: 2, embedFont: false });
  assert.ok(Array.isArray(built.ledger) && built.ledger.length >= 1);
  assert.ok(built.ledger[0].findings);
  assert.equal(built.audit.ok, true, `收敛后应无错误：${JSON.stringify(built.audit.findings)}`);
  assert.equal(typeof built.rounds, 'number');
  assert.equal(built.fontEmbedded, false);
});

test('CLI 报告：formatFindings 说人话，scoreAudit 让错误优先', () => {
  assert.match(formatFindings([])[0], /审计通过/);
  assert.match(formatFindings([{ level: 'error', code: 'x', where: 'a', message: 'm', fix: 'f' }])[0], /\[x\] a：m/);
  assert.ok(scoreAudit({ summary: { errors: 1, warns: 0 } }) > scoreAudit({ summary: { errors: 0, warns: 3 } }));
});

test('回归：output/handdrawn 下的手绘封面若在本地，审计必须干净', async () => {
  const dir = path.join(ROOT, 'output/handdrawn');
  const files = await fs.readdir(dir).catch(() => []);
  const svgs = files.filter((f) => f.endsWith('.svg'));
  if (!svgs.length) return; // output/ 不入库，没有就跳过
  for (const name of svgs) {
    const svg = await fs.readFile(path.join(dir, name), 'utf-8');
    const audit = auditCover({ svg });
    assert.deepEqual(audit.findings.map((f) => `${f.code}:${f.where}`), [], `${name} 不该有问题`);
  }
});
