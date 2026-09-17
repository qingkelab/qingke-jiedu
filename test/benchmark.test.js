import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  aggregateMetrics,
  anchorPosition,
  auditConfidenceOf,
  auditMissingRate,
  classifyAnchors,
  collectQualityNotes,
  compareWithBaseline,
  computeMetrics,
  isLateAnchor,
  lengthStability,
  loadPapers,
  matchAnchor,
  matchFigure,
  matchFormula,
  matchKeywords,
  matchNumbers,
  normalizeAnchor,
  entryFromResumedRecord,
  pickResumableRecords,
  readPaperFile,
  renderCliSummary,
  renderSummaryMarkdown,
  resolveProviderStatus,
  sectionCompleteness,
  stageMetaOf,
  validatePaperRecord,
} from '../src/deepread/benchmark.js';
import { buildPaperStructure } from '../src/deepread/chunker.js';
import { longPaperText } from './fixtures.js';

// ============ metadata 解析 ============

test('paper metadata：合法记录被归一化', () => {
  const res = validatePaperRecord({
    id: '1706.03762',
    title: 'Attention Is All You Need',
    category: 'LLM',
    url: 'https://arxiv.org/abs/1706.03762',
    expectedEvidence: [{ text: 'BLEU 28.4', keywords: ['BLEU'], numbers: ['28.4'] }],
    expectedFigures: [{ num: 1, captionKeywords: ['architecture'] }],
    expectedFormulas: [{ text: 'softmax', keywords: ['softmax'] }],
    expectedAblations: ['label smoothing'],
    expectedLimitations: [{ text: '复杂度的代价', keywords: ['complexity'] }],
  });
  assert.equal(res.ok, true);
  assert.equal(res.paper.id, '1706.03762');
  assert.equal(res.paper.expectedEvidence[0].numbers[0], '28.4');
  assert.equal(res.paper.expectedFigures[0].num, 1);
  // 字符串形式也被归一化
  assert.equal(res.paper.expectedAblations[0].type, 'ablation');
  assert.equal(res.paper.expectedAblations[0].text, 'label smoothing');
});

test('paper metadata：缺失必填字段 / 非法 URL 被拒绝（不抛错）', () => {
  const missing = validatePaperRecord({ title: 'x', url: 'https://arxiv.org/abs/1' });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(' '), /缺少必填字段 id/);

  const badUrl = validatePaperRecord({ id: 'x', title: 'x', url: 'arxiv.org/abs/1' });
  assert.equal(badUrl.ok, false);
  assert.match(badUrl.errors.join(' '), /url 不是 http/);

  assert.equal(validatePaperRecord(null).ok, false);
  assert.equal(validatePaperRecord([1, 2]).ok, false);
});

test('paper metadata：非数组 expectations 记 warning 并继续', () => {
  const res = validatePaperRecord({
    id: 'x',
    title: 'x',
    url: 'https://arxiv.org/abs/x',
    expectedEvidence: { text: 'a', keywords: ['a'] },
  });
  assert.equal(res.ok, true);
  assert.match(res.warnings.join(' '), /expectedEvidence 不是数组/);
  assert.equal(res.paper.expectedEvidence.length, 1);
});

test('paper metadata：损坏 JSON / 缺字段文件在目录加载时被隔离', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-papers-'));
  fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify({ id: 'ok', title: 'OK', url: 'https://arxiv.org/abs/ok' }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ this is not json ');
  fs.writeFileSync(path.join(dir, 'missing.json'), JSON.stringify({ title: 'no id', url: 'https://arxiv.org/abs/x' }));
  fs.writeFileSync(path.join(dir, 'ignored.txt'), 'not a json');

  const { papers, invalid, files } = loadPapers(dir);
  assert.equal(files.length, 3, '只读取 .json');
  assert.equal(papers.length, 1);
  assert.equal(papers[0].id, 'ok');
  assert.equal(invalid.length, 2, '损坏与非法记录进入 invalid，而不是抛错');
  assert.ok(invalid.some((i) => /JSON 解析失败/.test(i.errors.join(' '))));
  assert.ok(invalid.some((i) => /缺少必填字段 id/.test(i.errors.join(' '))));

  const missingFile = readPaperFile(path.join(dir, 'nope.json'));
  assert.equal(missingFile.ok, false);
  assert.match(missingFile.errors.join(' '), /读取失败/);
});

// ============ 匹配逻辑 ============

test('expected evidence 匹配：关键词 + 数字', () => {
  const anchor = normalizeAnchor({ type: 'main_result', text: 't', keywords: ['BLEU', 'WMT 2014'], numbers: ['28.4'] });
  const hit = matchAnchor(anchor, '在 WMT 2014 英德任务上达到 28.4 BLEU');
  assert.equal(hit.ok, true);
  assert.deepEqual(hit.missingNumbers, []);

  const missingNumber = matchAnchor(anchor, '在 WMT 2014 上取得了很好的 BLEU');
  assert.equal(missingNumber.ok, false);
  assert.deepEqual(missingNumber.missingNumbers, ['28.4']);

  const partialKeyword = matchAnchor(anchor, '达到 28.4 BLEU');
  assert.equal(partialKeyword.ok, true, '2 个关键词命中 1 个（50%）算覆盖');
  const missingKeyword = matchAnchor(normalizeAnchor({ keywords: ['a', 'b', 'c'], numbers: [] }), '只有 a');
  assert.equal(missingKeyword.ok, false, '关键词命中比例不足（1/3）应算未覆盖');

  const strict = normalizeAnchor({ keywords: ['a', 'b'], numbers: ['1'], strict: true });
  assert.equal(matchAnchor(strict, 'a 与 1').ok, false, 'strict 要求关键词全中');
});

test('数字匹配：等价写法命中，年份不算实验数字', () => {
  assert.equal(matchNumbers(['28.4'], 'BLEU 得分为 28.40').ratio, 1);
  assert.equal(matchNumbers(['41.8%'], '提升至 41.8').ratio, 1);
  assert.equal(matchNumbers(['3.5'], '训练 3.5 天').hits.length, 1);
  assert.equal(matchNumbers(['28.4'], '论文发表于 2017 年').missing.length, 1);

  // audit 定位：终稿有数字但 audit 判为原文查不到 → 计入 unlocated
  const located = matchNumbers(['99.9'], '准确率 99.9%', { locatedNumbers: [] });
  assert.deepEqual(located.unlocated, ['99.9']);
});

test('figure 匹配：图号优先，其次图注关键词', () => {
  assert.equal(matchFigure({ num: 1, captionKeywords: [] }, '整体结构见（图1）').ok, true);
  assert.equal(matchFigure({ num: 2, captionKeywords: [] }, '整体结构见（图1）').ok, false);
  const byCaption = matchFigure({ num: null, captionKeywords: ['scaled dot-product', 'multi-head'] }, '这一节讲 scaled dot-product attention 与 multi-head 的差别');
  assert.equal(byCaption.ok, true);
  assert.equal(byCaption.by, 'caption');
  assert.equal(matchFigure({ num: null, captionKeywords: ['nothing-here'] }, '无关内容').ok, false);
});

test('ablation / limitation 匹配', () => {
  const abla = normalizeAnchor({ type: 'ablation', keywords: ['label smoothing'], numbers: ['0.1'] });
  assert.equal(matchAnchor(abla, 'label smoothing 设为 0.1 时困惑度变好').ok, true);
  assert.equal(matchAnchor(abla, '没有提到这个消融').ok, false);

  const lim = normalizeAnchor({ type: 'limitation', keywords: ['language mixing'] });
  assert.equal(matchAnchor(lim, '模型存在 language mixing 问题').ok, true);
  assert.equal(matchAnchor(lim, '模型效果很好').ok, false);
});

test('formula 匹配：需要正文里真有 LaTeX 且关键词命中', () => {
  const anchor = normalizeAnchor({ text: 'softmax', keywords: ['softmax'] });
  assert.equal(matchFormula(anchor, '注意力写成 $\\mathrm{softmax}(QK^T/\\sqrt{d_k})V$').ok, true);
  assert.equal(matchFormula(anchor, '注意力用 softmax 归一化，但没给公式').ok, false);
});

// ============ late-paper 检测 ============

test('late-paper 检测：锚点出现在后半篇才判定为 late', () => {
  const structure = buildPaperStructure({ kind: 'tex', text: longPaperText() });
  const lateAnchor = normalizeAnchor({ text: '后半篇的消融', keywords: ['只在文本模态上验证'] });
  const earlyAnchor = normalizeAnchor({ text: '前半篇的方法', keywords: ['循环状态更新算子'] });

  const late = isLateAnchor(lateAnchor, structure);
  const early = isLateAnchor(earlyAnchor, structure);
  assert.equal(late.late, true, `后半篇锚点应判为 late（ratio=${late.ratio}）`);
  assert.equal(early.late, false, `前半篇锚点不应判为 late（ratio=${early.ratio}）`);
  assert.ok(anchorPosition(lateAnchor, structure).sectionTitle.length > 0, '应给出命中的 section');

  const classified = classifyAnchors(
    { expectedEvidence: [earlyAnchor, lateAnchor], expectedAblations: [], expectedLimitations: [] },
    structure,
  );
  assert.equal(classified.filter((a) => a.late).length, 1);
});

test('late-paper 检测：没有结构信息时返回 null（不误判）', () => {
  const res = isLateAnchor(normalizeAnchor({ keywords: ['x'] }), null);
  assert.equal(res.late, false);
  assert.equal(res.ratio, null);
});

// ============ 指标计算与聚合 ============

function fixtureResult(markdown) {
  return {
    markdown,
    degraded: false,
    audit: {
      checks: [
        { name: 'numbers', status: 'pass', missing: [] },
        { name: 'entities', status: 'pass', unknown: [] },
        { name: 'figures', status: 'pass', badRefs: [] },
        { name: 'formula', status: 'pass' },
      ],
      stats: { numbers: 10, entities: 2, formulas: 3, figureRefs: 2 },
    },
    meta: {
      pipeline: 'structured',
      plan: [{ title: '为什么值得读' }, { title: '方法机制' }, { title: '实验结果' }],
    },
  };
}

const GOOD_MARKDOWN = `# LoopFormer

## 为什么值得读

问题在于长上下文成本。

## 方法机制

状态更新算子 $h_t = \\alpha \\odot h_{t-1} + (1-\\alpha) \\odot W e_t$，其中 alpha 是门控。（图1）

## 实验结果

WMT14 上 BLEU 41.8，去掉循环状态掉到 39.1，显存降到 18.6 GB，只在文本模态验证。（图2）
`;

test('computeMetrics：10 项指标都能算出来（确定性）', () => {
  const structure = buildPaperStructure({ kind: 'tex', text: longPaperText() });
  const paper = {
    id: 'x',
    title: 'x',
    category: 'test',
    url: 'https://arxiv.org/abs/x',
    expectedEvidence: [
      normalizeAnchor({ type: 'main_result', text: 'BLEU 41.8', keywords: ['BLEU'], numbers: ['41.8'] }),
      normalizeAnchor({ type: 'main_result', text: '后半篇数字 18.6', keywords: ['显存'], numbers: ['18.6'] }),
    ],
    expectedFigures: [{ num: 1, captionKeywords: [] }, { num: 9, captionKeywords: [] }],
    expectedFormulas: [normalizeAnchor({ text: 'softmax', keywords: ['alpha'] })],
    expectedAblations: [normalizeAnchor({ type: 'ablation', text: '消融', keywords: ['去掉循环状态'], numbers: ['39.1'] })],
    expectedLimitations: [normalizeAnchor({ type: 'limitation', text: '局限', keywords: ['只在文本模态'] })],
  };
  const { metrics, detail } = computeMetrics({ paper, result: fixtureResult(GOOD_MARKDOWN), structure });

  assert.equal(metrics.sourceCoverage, 1, '两条 evidence 都应命中（41.8 / 18.6 都在终稿里）');
  assert.equal(metrics.numberEvidenceCoverage, 1, '期望数字 41.8/18.6 都应命中');
  assert.equal(metrics.figureCoverage, 0.5, '图1 命中、图9 未命中');
  assert.equal(metrics.formulaCoverage, 1);
  assert.equal(metrics.ablationCoverage, 1);
  assert.equal(metrics.limitationCoverage, 1);
  assert.equal(metrics.auditMissingRate, 0);
  assert.equal(metrics.sectionCompleteness, 1);
  assert.equal(metrics.lengthStability, 1);
  assert.equal(typeof metrics.latePaperCoverage, 'number');
  assert.ok(detail.numbers.missing.includes('18.6') === false);
});

test('numberEvidenceCoverage：终稿写了、但 audit 判为原文查不到的数字不算覆盖', () => {
  const structure = buildPaperStructure({ kind: 'tex', text: longPaperText() });
  const paper = {
    id: 'z',
    title: 'z',
    category: 'test',
    url: 'https://arxiv.org/abs/z',
    expectedEvidence: [normalizeAnchor({ type: 'main_result', text: 't', keywords: ['BLEU'], numbers: ['41.8', '99.9'] })],
    expectedFigures: [],
    expectedFormulas: [],
    expectedAblations: [],
    expectedLimitations: [],
  };
  // 99.9 出现在终稿里，但 audit 报了「原文查不到」：属于编造/改写，不能算证据覆盖
  const draft = GOOD_MARKDOWN.replace('BLEU 41.8', 'BLEU 41.8，准确率 99.9');
  const withAudit = fixtureResult(draft);
  withAudit.audit.checks.find((c) => c.name === 'numbers').missing = ['99.9'];
  const audited = computeMetrics({ paper, result: withAudit, structure });
  assert.equal(audited.metrics.numberEvidenceCoverage, 0.5, '2 个期望数字里只有 1 个能被 audit 定位');
  assert.deepEqual(audited.detail.numbers.unlocated, ['99.9']);
  assert.equal(audited.detail.numbers.located, 1);

  // 没有 audit（DEEPREAD_AUDIT=0）时退化为「出现即覆盖」，不把指标判成 0
  const noAudit = fixtureResult(draft);
  noAudit.audit = null;
  assert.equal(computeMetrics({ paper, result: noAudit, structure }).metrics.numberEvidenceCoverage, 1);
});

test('computeMetrics：空期望 → 该指标为 null（不拉低平均）', () => {
  const structure = buildPaperStructure({ kind: 'tex', text: longPaperText() });
  const paper = {
    id: 'y',
    title: 'y',
    category: 'test',
    url: 'https://arxiv.org/abs/y',
    expectedEvidence: [],
    expectedFigures: [],
    expectedFormulas: [],
    expectedAblations: [],
    expectedLimitations: [],
  };
  const { metrics } = computeMetrics({ paper, result: fixtureResult(GOOD_MARKDOWN), structure });
  assert.equal(metrics.sourceCoverage, null);
  assert.equal(metrics.figureCoverage, null);
  assert.equal(metrics.formulaCoverage, null);
  assert.equal(metrics.ablationCoverage, null);
  assert.equal(metrics.limitationCoverage, null);
  assert.equal(metrics.numberEvidenceCoverage, null);
});

test('auditMissingRate：来自 audit 的 missing/unknown/badRefs，越低越好', () => {
  const clean = auditMissingRate({
    checks: [
      { name: 'numbers', missing: [] },
      { name: 'entities', unknown: [] },
      { name: 'figures', badRefs: [] },
      { name: 'formula', status: 'pass' },
    ],
    stats: { numbers: 10, entities: 2, formulas: 3, figureRefs: 2 },
  });
  assert.equal(clean, 0);

  const dirty = auditMissingRate({
    checks: [
      { name: 'numbers', missing: ['99.9', '1.1'] },
      { name: 'entities', unknown: ['FooBench'] },
      { name: 'figures', badRefs: [7] },
      { name: 'formula', status: 'fail' },
    ],
    stats: { numbers: 10, entities: 2, formulas: 3, figureRefs: 2 },
  });
  assert.equal(dirty, 0.2941, '保留 4 位小数');
  assert.equal(auditMissingRate(null), null);
});

test('sectionCompleteness 与 lengthStability 能识别缺节与截断', () => {
  const full = fixtureResult(GOOD_MARKDOWN);
  assert.equal(sectionCompleteness(full).ratio, 1);
  assert.equal(lengthStability(full).stable, true);

  const truncated = fixtureResult('## 为什么值得读\n\n问题在这里，然后写到一半');
  const sec = sectionCompleteness(truncated);
  assert.ok(sec.ratio < 1);
  assert.ok(sec.missing.length >= 1);
  assert.equal(lengthStability(truncated).stable, false);
  assert.equal(lengthStability(truncated).endsComplete, false);
  assert.equal(lengthStability(truncated).score, 0);
});

test('aggregateMetrics：忽略 null，统计 completed/skipped/failed', () => {
  const agg = aggregateMetrics([
    { status: 'completed', metrics: { sourceCoverage: 1, figureCoverage: null, auditMissingRate: 0 } },
    { status: 'completed', metrics: { sourceCoverage: 0.5, figureCoverage: 1, auditMissingRate: 0.1 } },
    { status: 'skipped', reason: 'no key' },
    { status: 'failed', reason: 'timeout' },
  ]);
  assert.equal(agg.total, 4);
  assert.equal(agg.completed, 2);
  assert.equal(agg.skipped, 1);
  assert.equal(agg.failed, 1);
  assert.equal(agg.metrics.sourceCoverage, 0.75, '均值只算有值的论文');
  assert.equal(agg.metrics.figureCoverage, 1, 'null 不参与平均');
});

// ============ provider skip 处理 ============

test('skipped provider：缺 key / Ollama 不可达时给出明确原因与提示', () => {
  const deepseek = resolveProviderStatus({ providerName: 'deepseek', apiKeyPresent: false });
  assert.equal(deepseek.ok, false);
  assert.match(deepseek.reason, /DEEPSEEK_API_KEY/);
  assert.match(deepseek.hint, /DEEPSEEK_API_KEY/);

  const openai = resolveProviderStatus({ providerName: 'openai', apiKeyPresent: false });
  assert.match(openai.reason, /OPENAI_API_KEY/);

  const ollamaDown = resolveProviderStatus({ providerName: 'ollama', ollamaReachable: false });
  assert.equal(ollamaDown.ok, false);
  assert.match(ollamaDown.hint, /Ollama/);

  assert.equal(resolveProviderStatus({ providerName: 'ollama', ollamaReachable: true }).ok, true);
  assert.equal(resolveProviderStatus({ providerName: 'deepseek', apiKeyPresent: true }).ok, true);
});

// ============ baseline 对比与 summary 渲染 ============

test('collectQualityNotes：低覆盖、疑似截断、静默降级（research map 兜底）都要报出来', () => {
  const entries = [
    {
      id: 'a',
      status: 'completed',
      metrics: { sourceCoverage: 0.4, limitationCoverage: 0, auditMissingRate: 0.03 },
      lengthStability: 1,
      researchMapStatus: 'fallback',
    },
    { id: 'b', status: 'completed', metrics: { sourceCoverage: 1, auditMissingRate: 0 }, lengthStability: 0, degraded: true, researchMapStatus: 'model' },
    { id: 'c', status: 'skipped', reason: 'no key' },
  ];
  const notes = collectQualityNotes(entries);
  assert.ok(notes.some((n) => /^a：.*Source coverage=40%/.test(n)), '低覆盖要被点名');
  assert.ok(notes.some((n) => /a：.*Limitation coverage=0%/.test(n)));
  assert.ok(notes.some((n) => /a：research map 未产出模型地图/.test(n)), '静默降级要报出来');
  assert.ok(notes.some((n) => /b：终稿疑似截断/.test(n)));
  assert.ok(notes.some((n) => /b：走了降级流程/.test(n)));
  assert.equal(notes.some((n) => n.startsWith('c：')), false, 'skipped 的论文不进质量清单');
  assert.deepEqual(collectQualityNotes([{ id: 'd', status: 'completed', metrics: { sourceCoverage: 1, auditMissingRate: 0 } }]), []);
});

// ============ 阶段可靠性指标 ============

function stageFixture(status, source = 'local') {
  return {
    stage: 'research_map',
    status,
    source,
    fallback: status !== 'model_success',
    warning: status !== 'model_success',
    finishReason: status === 'model_truncated' ? 'length' : null,
    rawContentLength: status === 'model_truncated' ? 0 : 100,
    parsed: status === 'model_success',
  };
}

function resultWithReliability(markdown, { mapStatus = 'fallback', mapSource = 'local', planStatus = 'parse_failed', verdict = 'passed_with_warning' } = {}) {
  const result = fixtureResult(markdown);
  result.meta.stages = {
    research_map: { ...stageFixture(mapStatus, mapSource), stage: 'research_map' },
    plan: { stage: 'plan', status: planStatus, source: planStatus === 'model_success' ? 'model' : 'default', fallback: planStatus !== 'model_success', warning: planStatus !== 'model_success', parsed: planStatus === 'model_success' },
    retrieval: { stage: 'retrieval', status: 'success', source: 'local', fallback: false, warning: false, parsed: true },
    audit: { stage: 'audit', status: 'success', source: 'local', fallback: false, warning: false, parsed: true },
  };
  result.meta.stageSummary = { total: 4, withWarnings: (mapStatus !== 'model_success' ? 1 : 0) + (planStatus !== 'model_success' ? 1 : 0), stagesWithWarnings: ['research_map', 'plan'].filter((n) => (n === 'research_map' ? mapStatus !== 'model_success' : planStatus !== 'model_success')) };
  result.meta.researchMapEvidenceIds = ['c1'];
  result.meta.evidence = [{ section: '方法', role: 'method', chunkIds: ['c1', 'c2', 'c9'] }];
  result.audit = { ...result.audit, verdict, warnings: mapStatus === 'model_success' ? [] : [{ code: 'research_map_unavailable' }] };
  return result;
}

test('computeMetrics：阶段可靠性指标来自真实阶段状态（不写死）', () => {
  const structure = buildPaperStructure({ kind: 'tex', text: longPaperText() });
  const paper = {
    id: 'r',
    title: 'r',
    category: 'test',
    url: 'https://arxiv.org/abs/r',
    expectedEvidence: [normalizeAnchor({ type: 'main_result', text: 't', keywords: ['BLEU'], numbers: ['41.8'] })],
    expectedFigures: [],
    expectedFormulas: [],
    expectedAblations: [],
    expectedLimitations: [],
  };

  const degraded = computeMetrics({ paper, result: resultWithReliability(GOOD_MARKDOWN), structure });
  assert.equal(degraded.metrics.researchMapModelSuccess, 0);
  assert.equal(degraded.metrics.researchMapFallbackRate, 1);
  assert.equal(degraded.metrics.planModelSuccess, 0);
  assert.equal(degraded.metrics.planFallbackRate, 1);
  assert.equal(degraded.metrics.stagesWithWarnings, 2);
  assert.equal(degraded.metrics.evidenceFromModelMapRate, 0.3333, '3 条候选证据里 1 条来自模型地图');
  assert.equal(degraded.metrics.auditConfidence, 0.32, '本地兜底(0.4) × passed_with_warning(0.8)');
  assert.equal(degraded.detail.reliability.researchMapStatus, 'fallback');
  assert.equal(degraded.detail.reliability.evidenceFromModelMap, 1);

  const healthy = computeMetrics({
    paper,
    result: resultWithReliability(GOOD_MARKDOWN, { mapStatus: 'model_success', mapSource: 'model', planStatus: 'model_success', verdict: 'passed' }),
    structure,
  });
  assert.equal(healthy.metrics.researchMapModelSuccess, 1);
  assert.equal(healthy.metrics.researchMapFallbackRate, 0);
  assert.equal(healthy.metrics.planModelSuccess, 1);
  assert.equal(healthy.metrics.stagesWithWarnings, 0);
  assert.equal(healthy.metrics.auditConfidence, 1, '地图生效 + 干净通过 = 1');
});

test('computeMetrics：截断状态的阶段可靠性可被区分（model_truncated ≠ fallback）', () => {
  const structure = buildPaperStructure({ kind: 'tex', text: longPaperText() });
  const paper = {
    id: 't',
    title: 't',
    category: 'test',
    url: 'https://arxiv.org/abs/t',
    expectedEvidence: [],
    expectedFigures: [],
    expectedFormulas: [],
    expectedAblations: [],
    expectedLimitations: [],
  };
  const res = computeMetrics({
    paper,
    result: resultWithReliability(GOOD_MARKDOWN, { mapStatus: 'model_truncated', mapSource: 'local', planStatus: 'model_truncated' }),
    structure,
  });
  assert.equal(res.metrics.researchMapModelSuccess, 0);
  assert.equal(res.metrics.researchMapFallbackRate, 1);
  assert.equal(res.detail.reliability.researchMapFinishReason, 'length');
  assert.equal(res.metrics.auditConfidence, 0.32, '截断(0.5→本地 0.4 兜底) × passed_with_warning(0.8)');
});

test('stageMetaOf 兼容 v1 旧字段（researchMapStatus: model|fallback）', () => {
  const legacyModel = stageMetaOf({ meta: { researchMapStatus: 'model' } }, 'research_map');
  assert.equal(legacyModel.status, 'model_success');
  assert.equal(legacyModel.source, 'model');
  const legacyFallback = stageMetaOf({ meta: { researchMapStatus: 'fallback' } }, 'research_map');
  assert.equal(legacyFallback.status, 'fallback');
  assert.equal(legacyFallback.fallback, true);
  assert.equal(stageMetaOf({ meta: {} }, 'research_map'), null);
  assert.equal(stageMetaOf({ meta: { planStatus: 'model_success', planSource: 'model' } }, 'plan').status, 'model_success');
});

test('auditConfidenceOf：地图系数 × 结论系数，缺信息返回 null', () => {
  assert.equal(auditConfidenceOf({ researchMapStatus: 'model_success', verdict: 'passed' }), 1);
  assert.equal(auditConfidenceOf({ researchMapStatus: 'model_success', verdict: 'failed' }), 0.5);
  assert.equal(auditConfidenceOf({ researchMapStatus: 'parse_failed', researchMapSource: 'local', verdict: 'passed_with_warning' }), 0.32);
  assert.equal(auditConfidenceOf({ researchMapStatus: 'model_truncated', researchMapSource: 'local', verdict: 'passed' }), 0.4);
  assert.equal(auditConfidenceOf({}), null);
});

test('aggregateMetrics：阶段可靠性指标同样参与均值聚合', () => {
  const agg = aggregateMetrics([
    {
      status: 'completed',
      metrics: {
        researchMapModelSuccess: 1,
        researchMapFallbackRate: 0,
        planModelSuccess: 1,
        planFallbackRate: 0,
        stagesWithWarnings: 0,
        evidenceFromModelMapRate: 0.5,
        auditConfidence: 1,
      },
    },
    {
      status: 'completed',
      metrics: {
        researchMapModelSuccess: 0,
        researchMapFallbackRate: 1,
        planModelSuccess: 0,
        planFallbackRate: 1,
        stagesWithWarnings: 2,
        evidenceFromModelMapRate: 0,
        auditConfidence: 0.4,
      },
    },
    { status: 'skipped', reason: 'no key' },
  ]);
  assert.equal(agg.metrics.researchMapModelSuccess, 0.5);
  assert.equal(agg.metrics.researchMapFallbackRate, 0.5);
  assert.equal(agg.metrics.planModelSuccess, 0.5);
  assert.equal(agg.metrics.planFallbackRate, 0.5);
  assert.equal(agg.metrics.stagesWithWarnings, 1, '平均每篇告警阶段数');
  assert.equal(agg.metrics.evidenceFromModelMapRate, 0.25);
  assert.equal(agg.metrics.auditConfidence, 0.7);
});

test('CLI summary：分三组展示，并显式点名阶段降级', () => {
  const summary = {
    version: 'v1',
    total: 2,
    completed: 2,
    skipped: 0,
    failed: 0,
    metrics: {
      sourceCoverage: 0.9,
      latePaperCoverage: 0.8,
      numberEvidenceCoverage: 1,
      figureCoverage: 1,
      formulaCoverage: 1,
      ablationCoverage: 0.8,
      limitationCoverage: 0.5,
      auditMissingRate: 0.01,
      sectionCompleteness: 1,
      lengthStability: 1,
      researchMapModelSuccess: 0,
      researchMapFallbackRate: 1,
      planModelSuccess: 0,
      planFallbackRate: 1,
      stagesWithWarnings: 2.5,
      evidenceFromModelMapRate: 0,
      auditConfidence: 0.32,
    },
    papers: [
      { id: '1706.03762', status: 'completed', researchMapStatus: 'fallback', planStatus: 'parse_failed', metrics: { sourceCoverage: 0.9 } },
      { id: '2501.12948', status: 'completed', researchMapStatus: 'model_success', planStatus: 'model_success', metrics: { sourceCoverage: 0.9 } },
    ],
  };
  const cli = renderCliSummary(summary);
  assert.match(cli, /## 内容覆盖指标/);
  assert.match(cli, /## 阶段可靠性指标/);
  assert.match(cli, /## 审计可信度指标/);
  assert.match(cli, /Research map model success: 0%/);
  assert.match(cli, /Plan fallback rate: 100%/);
  assert.match(cli, /Stages with warnings \(avg\/papers\): 2\.5/, '非百分比指标按原值展示');
  assert.match(cli, /Audit confidence: 32%/);
  assert.match(cli, /阶段降级明细：/);
  assert.match(cli, /1706\.03762: research_map=fallback、plan=parse_failed/);
  assert.equal(/2501\.12948: research_map/.test(cli), false, '模型阶段生效的论文不进降级明细');
});

test('Markdown summary：分组表 + 逐篇阶段列', () => {
  const md = renderSummaryMarkdown({
    version: 'v1',
    startedAt: '2026-09-17T00:00:00Z',
    provider: 'deepseek',
    model: 'm',
    total: 1,
    completed: 1,
    skipped: 0,
    failed: 0,
    metrics: { sourceCoverage: 0.9, researchMapFallbackRate: 1, auditConfidence: 0.32 },
    papers: [{ id: '1706.03762', category: 'LLM', status: 'completed', researchMapStatus: 'model_truncated', planStatus: 'fallback', runtimeMs: 1000, metrics: { sourceCoverage: 0.9 } }],
  });
  assert.match(md, /\| 分组 \| 指标 \| 数值 \|/);
  assert.match(md, /阶段可靠性指标 \| Research map fallback rate \| 100\.0%/);
  assert.match(md, /research_map \| plan/);
  assert.match(md, /model_truncated/);
});

test('collectQualityNotes：截断/解析失败/计划降级/审计可信度偏低都会被告警', () => {
  const notes = collectQualityNotes([
    {
      id: 'a',
      status: 'completed',
      metrics: { sourceCoverage: 1, auditMissingRate: 0, auditConfidence: 0.32 },
      lengthStability: 1,
      researchMapStatus: 'model_truncated',
      planStatus: 'fallback',
      stagesWithWarnings: 2,
      stageWarnings: ['research_map', 'plan'],
    },
    { id: 'b', status: 'completed', metrics: { sourceCoverage: 1, auditMissingRate: 0, auditConfidence: 1 }, researchMapStatus: 'model_success', planStatus: 'model_success', stagesWithWarnings: 0 },
  ]);
  assert.ok(notes.some((n) => /a：research map 未产出模型地图（输出被 max_tokens 截断/.test(n)));
  assert.ok(notes.some((n) => /a：计划阶段未使用模型大纲（fallback）/.test(n)));
  assert.ok(notes.some((n) => /a：2 个阶段带告警/.test(n)));
  assert.ok(notes.some((n) => /a：审计可信度偏低（32%）/.test(n)));
  assert.equal(notes.some((n) => n.startsWith('b：')), false);
});

test('compareWithBaseline：识别 improved / regressed / unchanged（auditMissingRate 反向）', () => {
  const baseline = { metrics: { sourceCoverage: 0.9, auditMissingRate: 0.02, figureCoverage: 1 } };
  const current = { metrics: { sourceCoverage: 0.95, auditMissingRate: 0.01, figureCoverage: 1 } };
  const cmp = compareWithBaseline(current, baseline);
  assert.ok(cmp.improved.some((i) => i.metric === 'sourceCoverage'));
  assert.ok(cmp.improved.some((i) => i.metric === 'auditMissingRate'), '缺失率下降算提升');
  assert.ok(cmp.unchanged.some((i) => i.metric === 'figureCoverage'));

  const worse = compareWithBaseline({ metrics: { sourceCoverage: 0.8, auditMissingRate: 0.3 } }, baseline);
  assert.ok(worse.regressed.some((i) => i.metric === 'sourceCoverage'));
  assert.ok(worse.regressed.some((i) => i.metric === 'auditMissingRate'), '缺失率上升算回退');
});

test('CLI / Markdown summary：百分比来自传入数据而非写死', () => {
  const summary = {
    version: 'v1',
    startedAt: '2026-09-17T00:00:00Z',
    provider: 'deepseek',
    model: 'test-model',
    total: 5,
    completed: 4,
    skipped: 1,
    failed: 0,
    metrics: {
      sourceCoverage: 0.92,
      latePaperCoverage: 0.88,
      numberEvidenceCoverage: 1,
      figureCoverage: 1,
      formulaCoverage: 0.96,
      ablationCoverage: 0.83,
      limitationCoverage: 0.8,
      auditMissingRate: 0,
      sectionCompleteness: 0.9,
      lengthStability: 1,
    },
    papers: [
      { id: '1706.03762', category: 'LLM', status: 'completed', metrics: { sourceCoverage: 1 }, runtimeMs: 1000 },
      { id: '2501.12948', category: 'RL', status: 'skipped', reason: '未配置 DEEPSEEK_API_KEY' },
    ],
    comparison: {
      improved: [{ metric: 'sourceCoverage', label: 'Source coverage', baseline: 0.8, current: 0.92, delta: 0.12 }],
      regressed: [{ metric: 'figureCoverage', label: 'Figure coverage', baseline: 1, current: 0.5, delta: -0.5 }],
      unchanged: [],
    },
  };
  const cli = renderCliSummary(summary);
  assert.match(cli, /Source coverage: 92%/);
  assert.match(cli, /Late-paper coverage: 88%/);
  assert.match(cli, /Number evidence: 100%/);
  assert.match(cli, /Audit missing rate: 0%/);
  assert.match(cli, /Skipped: 1/);
  assert.match(cli, /回退 Figure coverage/);

  const md = renderSummaryMarkdown(summary);
  assert.match(md, /\| Source coverage \| 92\.0% \|/);
  assert.match(md, /不是对文章文学质量的绝对评分/);
  assert.match(md, /2501.12948/);
});

test('matchKeywords：比例与缺失列表', () => {
  const res = matchKeywords(['a', 'b', 'c'], 'a b');
  assert.equal(res.hits.length, 2);
  assert.deepEqual(res.missing, ['c']);
  assert.equal(Number(res.ratio.toFixed(3)), 0.667);
  assert.equal(matchKeywords([], 'x').ratio, 0);
});

// ============ 断点续跑（resume） ============

test('pickResumableRecords：只复用 completed 且有指标的记录', () => {
  const records = [
    { id: 'a', status: 'completed', metrics: { sourceCoverage: 1 } },
    { id: 'b', status: 'failed', reason: 'timeout' },
    { id: 'c', status: 'completed' }, // 缺 metrics，不能复用
    { id: 'd', status: 'completed', metrics: { sourceCoverage: 0.5 } },
    { id: 'zz', status: 'completed', metrics: { sourceCoverage: 1 } }, // 不在本次范围
  ];
  const { reusable, pending } = pickResumableRecords(records, ['a', 'b', 'c', 'd']);
  assert.deepEqual(reusable.map((r) => r.id), ['a', 'd']);
  assert.deepEqual(pending, ['b', 'c']);

  const none = pickResumableRecords(null, ['a', 'b']);
  assert.deepEqual(none.reusable, []);
  assert.deepEqual(none.pending, ['a', 'b'], '没有历史记录时全部待跑');
});

test('entryFromResumedRecord：补齐 summary 需要的字段', () => {
  const entry = entryFromResumedRecord({ id: 'a', status: 'completed', metrics: { sourceCoverage: 1, lengthStability: 1 } });
  assert.equal(entry.status, 'completed');
  assert.equal(entry.resumed, true);
  assert.equal(entry.lengthStability, 1);
});
