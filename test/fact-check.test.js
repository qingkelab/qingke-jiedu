// 数字核验表（fact-check.md）：终稿数字 ↔ 原文句子的确定性回查。
// 迁移自青稞社区「技术解读稿件」规范：本表之外不应出现数字化 claim。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFactCheck, renderFactCheckMarkdown } from '../src/deepread/factCheck.js';
import { aggregateMetrics, compareWithBaseline, computeMetrics } from '../src/deepread/benchmark.js';

/** 极小的 chunk 结构：只用到 id / text，避免依赖 chunker。 */
function structureOf(...texts) {
  return { chunks: texts.map((text, i) => ({ id: `c${i + 1}`, text })) };
}

const STRUCTURE = structureOf(
  '摘要：我们在 WMT 2014 英德上达到 28.4 BLEU，训练用了 8 块 GPU。',
  'We employ label smoothing of value 0.1 to improve BLEU.',
  '表 2 报告 WMT 2014 英法 41.8 BLEU，消融显示去掉该组件后掉到 39.1。',
);

const MARKDOWN = [
  '# 论文标题',
  '',
  '导语：这篇论文在 WMT 2014 英德上报告了 28.4 BLEU（Transformer big，8 块 GPU）。',
  '',
  '## 方法：平滑与残差',
  '',
  '作者报告 label smoothing 取 0.1，它降低了困惑度但把 BLEU 抬了上去。',
  '',
  '## 结果：它到底赢了多少',
  '',
  '实验显示英法方向为 41.8 BLEU，去掉组件后掉到 39.1。',
  '',
  '按论文数据计算，训练吞吐约为 99.9 步/秒。',
  '',
  '在私有内部集上，本文方法取得了 63.7 的成绩（该数字原文并未给出）。',
  '',
].join('\n');

test('fact-check：能定位到原文的数字判为 source，并带出 chunk 与条件句', () => {
  const { rows } = buildFactCheck({ markdown: MARKDOWN, structure: STRUCTURE });
  // 注意：数字 token 会带上紧跟其后的单位字母（audit 归一化口径），如 41.8 → 41.8b
  const bleu = rows.find((r) => r.section === '结果：它到底赢了多少' && r.number.startsWith('41.8'));
  assert.ok(bleu, '应记录 41.8 这一行');
  assert.equal(bleu.status, 'source');
  assert.deepEqual(bleu.chunkIds, ['c3']);
  assert.match(bleu.condition, /41\.8/, '条件列应带出承载该数字的原文句子');
});

test('fact-check：原文查不到的数字判为 unsupported（不静默放过）', () => {
  const res = buildFactCheck({ markdown: MARKDOWN, structure: STRUCTURE });
  const orphan = res.rows.find((r) => r.number === '63.7');
  assert.ok(orphan, '应记录 63.7 这一行');
  assert.equal(orphan.status, 'unsupported');
  assert.deepEqual(orphan.chunkIds, []);
  assert.equal(orphan.condition, '（原文未找到对应句子）');
  assert.ok(res.stats.unsupported >= 1);
});

test('fact-check：按论文数据推导的数字判为 derived，前提是正文标了推算措辞', () => {
  const { rows, stats } = buildFactCheck({ markdown: MARKDOWN, structure: STRUCTURE });
  const derived = rows.find((r) => r.number === '99.9');
  assert.ok(derived, '应记录 99.9 这一行');
  assert.equal(derived.status, 'derived');
  assert.ok(stats.derived >= 1);
});

test('fact-check：没标注推算措辞、原文也查不到的换算会被判为 unsupported', () => {
  const md = '## 结果\n\n训练吞吐约 55.5 步/秒。';
  const { rows } = buildFactCheck({ markdown: md, structure: STRUCTURE });
  assert.equal(rows[0].status, 'unsupported');
});

test('fact-check：导语（首个 H2 之前）里的数字也要进表，不能只看小节', () => {
  const { rows } = buildFactCheck({ markdown: MARKDOWN, structure: STRUCTURE });
  const intro = rows.find((r) => r.section === '论文标题' && r.number.startsWith('28.4'));
  assert.ok(intro, 'H1 节里的导语数字应被扫描');
  assert.equal(intro.status, 'source');
});

test('fact-check：命中 Evidence Ledger 关键事实的数字标 ★，同小节同数字只留一行', () => {
  const md = ['## 效率', '', '论文称显存从 40.2 GB 降到 18.6 GB。', '', '换句话说，18.6 GB 是终值。', ''].join('\n');
  // ledger 里的值是裸数字（18.6），终稿 token 会带单位后缀（18.6g），两边要能对上
  const ledger = { facts: [{ id: 'f1', mustUseNumbers: [{ value: '18.6' }] }] };
  const { rows } = buildFactCheck({ markdown: md, structure: STRUCTURE, ledger });
  const twenty = rows.filter((r) => r.number.startsWith('18.6'));
  assert.equal(twenty.length, 1, '同一小节同一数字应去重');
  assert.equal(twenty[0].critical, true);
});

test('fact-check：统计口径 = 三类计数 + coverage / unsupportedRate', () => {
  const { rows, stats } = buildFactCheck({ markdown: MARKDOWN, structure: STRUCTURE });
  assert.equal(stats.numbers, rows.length);
  assert.equal(stats.located + stats.derived + stats.unsupported, stats.numbers);
  assert.equal(stats.coverage, Number((stats.located / stats.numbers).toFixed(4)));
  assert.equal(stats.unsupportedRate, Number((stats.unsupported / stats.numbers).toFixed(4)));
});

test('fact-check：maxRows 截断，避免超长终稿把表格撑爆', () => {
  const { rows } = buildFactCheck({ markdown: MARKDOWN, structure: STRUCTURE, maxRows: 2 });
  assert.equal(rows.length, 2);
});

test('fact-check：空终稿不报错，coverage 为 null（而不是 0 假装通过）', () => {
  const res = buildFactCheck({ markdown: '', structure: null });
  assert.deepEqual(res.rows, []);
  assert.equal(res.stats.numbers, 0);
  assert.equal(res.stats.coverage, null);
  assert.equal(res.stats.unsupportedRate, null);
});

test('fact-check：渲染的 markdown 含表头、三态标记与「表外不得出现数字」声明', () => {
  const ledger = { facts: [{ id: 'f1', mustUseNumbers: [{ value: '41.8' }] }] };
  const { markdown } = buildFactCheck({ markdown: MARKDOWN, structure: STRUCTURE, ledger });
  assert.match(markdown, /数字核验表/);
  assert.match(markdown, /本表之外不应出现数字化 claim/);
  assert.match(markdown, /条件 \/ 原文句子/);
  assert.match(markdown, /✅/);
  assert.match(markdown, /🟡 derived/);
  assert.match(markdown, /❌ unsupported/);
  assert.match(markdown, /★/);
});

test('fact-check：渲染时转义表格竖线，避免把表格结构写坏', () => {
  const md = renderFactCheckMarkdown({
    rows: [{ section: 'A|B', number: '1.0', condition: 'x|y', chunkIds: ['c1'], critical: false, status: 'source' }],
    stats: { numbers: 1, located: 1, derived: 0, unsupported: 0, coverage: 1, unsupportedRate: 0 },
  });
  assert.match(md, /A\\\|B/);
  assert.match(md, /x\\\|y/);
});

// ============ 与 benchmark 的接线（加法指标，不动既有口径）============

const PAPER = {
  id: '1706.03762',
  category: 'LLM',
  title: 't',
  url: 'u',
  expectedSections: [],
  expectedEvidence: [{ type: 'main_result', text: 'BLEU 41.8', keywords: ['BLEU'] }],
  expectedFigures: [],
  expectedFormulas: [],
  expectedAblations: [],
  expectedLimitations: [],
};
const BENCH_STRUCTURE = { chunks: [{ id: 'c1', text: 'BLEU 41.8' }], sections: [{ title: 'R', chunkIds: ['c1'] }] };

test('benchmark：从 meta.factCheckStats 读出核验指标（没有该字段时为 null，不假装 0）', () => {
  const withStats = computeMetrics({
    paper: PAPER,
    structure: BENCH_STRUCTURE,
    result: {
      markdown: '## R\n\n实验显示 BLEU 41.8。',
      meta: { factCheckStats: { numbers: 4, located: 3, derived: 0, unsupported: 1, coverage: 0.75, unsupportedRate: 0.25 } },
      audit: null,
    },
  });
  assert.equal(withStats.metrics.factCheckCoverage, 0.75);
  assert.equal(withStats.metrics.factCheckUnsupportedRate, 0.25);
  assert.equal(withStats.metrics.factCheckNumbers, 4);
  assert.equal(withStats.detail.factCheck.coverage, 0.75);

  const withoutStats = computeMetrics({
    paper: PAPER,
    structure: BENCH_STRUCTURE,
    result: { markdown: '## R\n\n实验显示 BLEU 41.8。', meta: {}, audit: null },
  });
  assert.equal(withoutStats.metrics.factCheckCoverage, null);
  assert.equal(withoutStats.metrics.factCheckUnsupportedRate, null);
});

test('benchmark：unsupportedRate 是「越低越好」；旧 baseline 缺这几个键时进 missing 而不是被判退步', () => {
  const agg = aggregateMetrics([
    { status: 'completed', metrics: { factCheckCoverage: 0.5, factCheckUnsupportedRate: 0.1, factCheckNumbers: 10 } },
  ]);
  assert.equal(agg.metrics.factCheckCoverage, 0.5);

  const cmp = compareWithBaseline(agg, {
    metrics: { factCheckCoverage: 0.5, factCheckUnsupportedRate: 0.3, factCheckNumbers: 10 },
  });
  // 0.1 < 0.3 → 漏报更少 = 提升
  assert.deepEqual(cmp.improved.map((i) => i.metric), ['factCheckUnsupportedRate']);
  assert.ok(cmp.unchanged.some((i) => i.metric === 'factCheckCoverage'));

  const cmpLegacy = compareWithBaseline(agg, { metrics: {} });
  assert.ok(cmpLegacy.missing.includes('factCheckCoverage'));
  assert.equal(cmpLegacy.regressed.length, 0, '旧 baseline 没有的指标不能算退步');
});
