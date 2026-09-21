// Evidence/Writer v3：Evidence Ledger、Fact Coverage（含 provenance）、Repair v2 输入、Review 回归护栏。
// 全部确定性，不依赖真实 LLM。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaperStructure } from '../src/deepread/chunker.js';
import { buildSourceSectionIndex } from '../src/deepread/sourceSections.js';
import { buildCorpusIndex, distributeCriticalFacts, seedCriticalFacts } from '../src/deepread/criticalFacts.js';
import {
  assessFactInText,
  buildEvidenceLedger,
  checkReviewFactRegression,
  checkSectionFactCoverage,
  coverageStats,
  extractFactNumbers,
  repairTargetsFromCoverage,
  sectionsFromMarkdown,
} from '../src/deepread/evidenceLedger.js';
import { normalizeNumberToken, replaceSection, splitMarkdownSections } from '../src/deepread/audit.js';
import { retrievalProbeResults } from '../src/deepread/benchmark.js';

/** 1706 风格：关键事实在 Regularization；主结果在 Machine Translation。 */
const PAPER = [
  '## Abstract\n我们提出 Transformer，在 WMT 2014 英德上达到 28.4 BLEU。',
  '## 1 Introduction\n序列转导模型依赖循环或卷积。',
  '## 2 Model Architecture\n编码器与解码器各堆叠 N=6 层。',
  '## 3 Training\n使用 Adam 优化器，训练 100K steps。',
  '## 4 Regularization\nWe employ label smoothing of value epsilon_ls = 0.1. We also apply residual dropout with P_drop = 0.1 to each sub-layer output.',
  '## 5 Machine Translation\nTable 2 reports 28.4 BLEU on WMT 2014 English-to-German and 41.8 on English-to-French.',
  '## 6 Model Variations\nTable 3 varies the number of heads h and key size d_k.',
  '## 7 Limitations\nWe only test text modality; failure cases on long sequences remain unverified.',
  '## 8 Conclusion\nWe presented Transformer.',
].join('\n\n');

function setup() {
  const structure = buildPaperStructure({ kind: 'tex', text: PAPER });
  const sourceIndex = buildSourceSectionIndex(structure);
  const corpus = buildCorpusIndex(structure);
  return { structure, sourceIndex, corpus };
}

const PLAN = [
  { title: '导语', role: 'intro', sourceSections: ['1 Introduction'], mustUseTerms: ['Transformer'] },
  { title: '机制', role: 'method', sourceSections: ['2 Model Architecture'], mustUseTerms: ['LayerNorm'] },
  { title: '消融与配方', role: 'ablation', sourceSections: ['6 Model Variations'], mustUseTerms: ['Table 3'] },
  { title: '实验结果', role: 'results', sourceSections: ['5 Machine Translation'], mustUseTerms: ['BLEU'] },
  { title: '失败边界', role: 'limitation', sourceSections: ['7 Limitations'], mustUseTerms: ['failure cases'] },
];

function buildLedgerWithFacts() {
  const { structure, sourceIndex, corpus } = setup();
  const seeded = seedCriticalFacts({
    researchMap: {
      main_results: [{ text: 'WMT 2014 English-to-German 28.4 BLEU，English-to-French 41.8 BLEU' }],
      ablations: [{ text: '标签平滑 ε_ls=0.1 让困惑度变好但 BLEU 变差' }],
      limitations: [{ text: 'failure cases on long sequences remain unverified' }],
    },
    structure,
    sourceIndex,
    corpus,
  });
  const distributed = distributeCriticalFacts({ plan: PLAN, facts: seeded, sourceIndex, structure, corpus });
  const ledger = buildEvidenceLedger({
    paperId: 'test-paper',
    researchMap: { main_results: [], ablations: [], limitations: [] },
    criticalFacts: distributed.facts,
    plan: distributed.plan,
    retrievalResults: distributed.plan.map((s) => {
      // 模拟 retrieval：把该节 sourceSections 对应的 chunk 当作已召回
      const ids = [];
      for (const title of s.sourceSections || []) {
        const sec = sourceIndex.sections.find((x) => x.title === title);
        for (const id of sec?.chunkIds || []) ids.push(id);
      }
      return { chunkIds: ids, evidence: [] };
    }),
    structure,
  });
  return { structure, sourceIndex, corpus, plan: distributed.plan, facts: distributed.facts, ledger };
}

// ============ 1–4：台账构建与三层映射 ============

test('1. Evidence Ledger construction：事实带 category/priority/provenance/证据', () => {
  const { ledger } = buildLedgerWithFacts();
  assert.ok(ledger.facts.length >= 3, `应至少 3 条事实（实际 ${ledger.facts.length}）`);
  for (const f of ledger.facts) {
    assert.ok(f.id, 'fact 必须有 id');
    assert.ok(['main_result', 'ablation', 'limitation', 'failure', 'method', 'comparison', 'formula', 'figure'].includes(f.category));
    assert.ok(['source', 'derived', 'interpretation'].includes(f.provenance));
    assert.ok(['high', 'medium'].includes(f.priority));
    assert.ok(Array.isArray(f.chunkIds));
    assert.ok(Array.isArray(f.mustUseNumbers));
  }
  assert.ok(ledger.stats.total === ledger.facts.length);
  assert.ok(ledger.stats.withEvidence >= 1);
});

test('2. criticalFact → evidence：绑定 chunk 且数字来自原文', () => {
  const { ledger } = buildLedgerWithFacts();
  const ablation = ledger.facts.find((f) => f.category === 'ablation');
  assert.ok(ablation, '应有 ablation 事实');
  assert.ok(ablation.chunkIds.length > 0, 'ablation 事实必须绑定 chunk');
  assert.ok(ablation.sourceNumbers.includes('0.1'), `sourceNumbers 应含 0.1（实际 ${JSON.stringify(ablation.sourceNumbers)}）`);
  assert.ok(ablation.mustUseNumbers.some((n) => n.value === '0.1'));
});

test('3. criticalFact → plan section：分发结果写进台账', () => {
  const { ledger } = buildLedgerWithFacts();
  const ablation = ledger.facts.find((f) => f.category === 'ablation');
  assert.ok(ablation.planSections.length >= 1, 'ablation 事实必须分到某个计划小节');
  assert.ok(ledger.bySection[ablation.planSections[0]].includes(ablation.id));
});

test('4. criticalFact → writer section：写作小节与写入位置可追踪', () => {
  const { ledger } = buildLedgerWithFacts();
  for (const f of ledger.facts) {
    assert.ok(Array.isArray(f.writerSections), 'writerSections 必须是数组');
    assert.ok(['missing_evidence', 'unwritten', 'unsupported', 'derived', 'covered'].includes(f.status));
  }
  const mainResult = ledger.facts.find((f) => f.category === 'main_result');
  assert.ok(mainResult.writerSections.length >= 1);
});

// ============ 5–7：provenance ============

test('5. source provenance：写了且能在原文定位 → covered', () => {
  const { ledger } = buildLedgerWithFacts();
  const fact = ledger.facts.find((f) => f.category === 'main_result');
  const md = `## 实验结果\n\nTransformer 在 WMT 2014 English-to-German 上达到 28.4 BLEU，English-to-French 上 41.8 BLEU。`;
  const verdict = assessFactInText(fact, md);
  assert.equal(verdict.status, 'covered', verdict.reason);
  assert.ok(verdict.numberHits >= 1);
});

test('6. derived provenance：标注「按论文数据计算」→ derived（不算编造）', () => {
  const fact = {
    id: 'F-D1',
    category: 'derived',
    priority: 'medium',
    claim: '20 分钟视频按 2fps 采样得到 2400 帧',
    mustUseTerms: [],
    mustUseNumbers: [],
    chunkIds: ['c1'],
    sourceNumbers: ['16384'],
  };
  const derived = assessFactInText(fact, '按论文数据计算，20 分钟 × 2fps = 2400 帧。', { structure: null });
  assert.equal(derived.status, 'derived', derived.reason);
  assert.ok(derived.derivedNumbers.includes('2400'), JSON.stringify(derived.derivedNumbers));
  const unsupported = assessFactInText(fact, '视频长度达到 2400 帧。', { structure: null });
  assert.equal(unsupported.status, 'unsupported');
  assert.deepEqual(unsupported.unsupportedNumbers, ['2400']);
});

test('7. interpretation provenance：作者判断不能被当成论文事实', () => {
  const { ledger } = buildLedgerWithFacts();
  const fact = ledger.facts.find((f) => f.category === 'ablation');
  // 只有泛化句（没有术语、没有数字）→ 判 unwritten，而不是 counted covered
  const vague = assessFactInText(fact, '本文还讨论了正则化与训练细节，效果不错。');
  assert.equal(vague.status, 'unwritten', `泛化句不能算覆盖（${vague.status}）`);
});

// ============ 8–10：数字覆盖 ============

test('8. exact number coverage', () => {
  const fact = { id: 'F-N1', category: 'main_result', priority: 'high', claim: 'AIME 79.8', mustUseTerms: ['AIME'], mustUseNumbers: [{ value: '79.8', term: 'AIME', chunkIds: ['c1'] }], chunkIds: ['c1'], sourceNumbers: ['79.8'] };
  assert.equal(assessFactInText(fact, 'AIME 上达到 79.8。').status, 'covered');
  assert.equal(assessFactInText(fact, 'AIME 上达到 79.80。').status, 'covered', '尾零等价');
  assert.equal(assessFactInText(fact, 'AIME 表现很好。').status, 'unwritten');
});

test('9. normalized number coverage：10.6 万 ≡ 106,000', () => {
  assert.equal(normalizeNumberToken('10.6万'), '106000');
  assert.equal(normalizeNumberToken('106,000'), '106000');
  const fact = {
    id: 'F-N2',
    category: 'method',
    priority: 'high',
    claim: '106,000 prompts 数据集',
    mustUseTerms: ['prompts'],
    mustUseNumbers: [{ value: '106000', term: 'prompts', chunkIds: ['c2'] }],
    chunkIds: ['c2'],
    sourceNumbers: ['106000'],
  };
  const verdict = assessFactInText(fact, '数据集包含 10.6 万条 prompts。');
  assert.equal(verdict.status, 'covered', verdict.reason);
});

test('10. derived number coverage：计算出来的数字必须标 derived', () => {
  const fact = {
    id: 'F-N3',
    category: 'derived',
    priority: 'medium',
    claim: '每帧 token 预算',
    mustUseTerms: [],
    mustUseNumbers: [],
    chunkIds: ['c3'],
    sourceNumbers: ['16384'],
  };
  assert.equal(assessFactInText(fact, '16384 是 token 上限（原文）。').status, 'covered');
  assert.equal(assessFactInText(fact, '按论文数据计算，每帧不足 7 个 token。').status, 'derived');
});

// ============ 11–12：unwritten / unsupported ============

test('11. unwritten fact detection：证据在上下文但没写', () => {
  const { ledger } = buildLedgerWithFacts();
  const fact = ledger.facts.find((f) => f.category === 'ablation');
  const coverage = checkSectionFactCoverage({
    ledger,
    markdownBySection: { [fact.writerSections[0]]: '## 消融与配方\n\n我们做了不少实验，结论是这些设计都有用。' },
    structure: null,
  });
  const entry = coverage.byFact[fact.id];
  assert.equal(entry.status, 'unwritten');
  assert.ok(coverage.stats.unwritten >= 1);
  assert.ok(coverage.stats.unwrittenFactRate > 0);
});

test('12. unsupported fact detection：写了但原文无法支持', () => {
  const { ledger } = buildLedgerWithFacts();
  const fact = ledger.facts.find((f) => f.category === 'ablation');
  const numbers = (fact.mustUseNumbers || []).map((n) => n.value);
  const body = `## 消融与配方\n\n${(fact.mustUseTerms || []).join('、')} 都做过消融（${numbers.join('、')}），但 BLEU 变成 99.9。`;
  const coverage = checkSectionFactCoverage({ ledger, markdownBySection: { [fact.writerSections[0]]: body }, structure: null });
  const entry = coverage.byFact[fact.id];
  assert.equal(entry.status, 'unsupported', JSON.stringify(entry));
  assert.ok(entry.unsupportedNumbers.includes('99.9'));
  assert.ok(coverage.stats.unsupportedFactRate > 0);
});

// ============ 13–14：Repair v2 ============

test('13. repair input：只包含没写出来 / 不支持的事实，且带证据与数字', () => {
  const { ledger } = buildLedgerWithFacts();
  const unwrittenSection = ledger.facts.find((f) => f.category === 'ablation').writerSections[0];
  const coverage = checkSectionFactCoverage({
    ledger,
    markdownBySection: { [unwrittenSection]: '## 消融与配方\n\n略。' },
    structure: null,
  });
  const targets = repairTargetsFromCoverage(ledger, coverage);
  assert.ok(targets.length >= 1);
  const t = targets.find((x) => x.section === unwrittenSection);
  assert.ok(t, '消融小节应进入修复目标');
  assert.ok(t.claim && t.factId);
  assert.ok(Array.isArray(t.chunkIds));
  assert.ok(Array.isArray(t.mustUseNumbers));
  // 已经 covered 的事实不应出现在修复输入里
  assert.equal(targets.some((x) => x.section && x.status === 'covered'), false);
});

test('14. repair 只动目标小节，其它小节逐字不变', () => {
  const md = [
    '# LoopFormer',
    '',
    '## 实验结果',
    '',
    '原有结果段。',
    '',
    '## 失败边界',
    '',
    '原有边界段。',
  ].join('\n');
  const patched = replaceSection(md, '实验结果', '## 实验结果\n\n补写的实验结果。');
  assert.match(patched, /补写的实验结果/);
  assert.match(patched, /原有边界段。/, '其它小节必须保持原样');
  const before = splitMarkdownSections(md).filter((s) => s.level === 2).map((s) => s.heading);
  const after = splitMarkdownSections(patched).filter((s) => s.level === 2).map((s) => s.heading);
  assert.deepEqual(after, before, '不得增删小节');
});

test('14b. repair 后重新判定：补上事实即从 unwritten 变 covered', () => {
  const { ledger } = buildLedgerWithFacts();
  const fact = ledger.facts.find((f) => f.category === 'ablation');
  const section = fact.writerSections[0];
  const before = checkSectionFactCoverage({ ledger, markdownBySection: { [section]: '## 消融与配方\n\n略。' }, structure: null });
  assert.equal(before.byFact[fact.id].status, 'unwritten');
  const fixedBody =
    `## 消融与配方\n\n${fact.claim}。` +
    `本节覆盖 ${(fact.mustUseTerms || []).join('、')}；` +
    `对应数字：${(fact.mustUseNumbers || []).map((n) => `${n.term || ''} ${n.value}`).join('、')}。`;
  const after = checkSectionFactCoverage({ ledger, markdownBySection: { [section]: fixedBody }, structure: null });
  assert.equal(after.byFact[fact.id].status, 'covered', JSON.stringify(after.byFact[fact.id]));
});

// ============ 15：Review 回归护栏 ============

test('15. review fact regression guard：删事实 / 增删小节都会被拦下', () => {
  const { ledger } = buildLedgerWithFacts();
  const fact = ledger.facts.find((f) => f.category === 'ablation');
  const section = fact.writerSections[0];
  const numbers = (fact.mustUseNumbers || []).map((n) => n.value).join('、');
  const good =
    `# T\n\n## ${section}\n\n${fact.claim}。覆盖 ${(fact.mustUseTerms || []).join('、')}，数字 ${numbers}。\n\n## 实验结果\n\n41.8 BLEU。`;
  const removedFact = `# T\n\n## ${section}\n\n这节先不写细节。\n\n## 实验结果\n\n41.8 BLEU。`;
  const addedSection = `${good}\n\n## 核心公式\n\n补充一节。`;
  const droppedSection = `# T\n\n## ${section}\n\n${fact.claim}。`;

  assert.equal(checkReviewFactRegression({ before: good, after: `${good}\n\n（审校润色。）`, ledger }).ok, true);
  const r1 = checkReviewFactRegression({ before: good, after: removedFact, ledger });
  assert.equal(r1.ok, false, '删掉事实必须被拦下');
  const r2 = checkReviewFactRegression({ before: good, after: addedSection, ledger });
  assert.equal(r2.ok, false, '新增小节必须被拦下');
  assert.match(r2.reason, /小节结构/);
  const r3 = checkReviewFactRegression({ before: good, after: droppedSection, ledger });
  assert.equal(r3.ok, false, '删除小节必须被拦下');
  // 没有台账时不阻断（兼容旧流程）
  assert.equal(checkReviewFactRegression({ before: good, after: removedFact, ledger: null }).skipped, true);
});

// ============ 16–24：四组核心 probe（2501 / 1706 / 2406 / 2409） ============

test('16–18. 2501：AIME / MATH-500 / Codeforces（含数字 79.8 / 97.3 / 2029）', () => {
  const text = [
    '## Abstract\nDeepSeek-R1 reaches 79.8 on AIME 2024 and 97.3 on MATH-500.',
    '## 1 Experiments\nTable 2 reports AIME accuracy 79.8, MATH-500 accuracy 97.3 and Codeforces rating 2029 for DeepSeek-R1.',
    '## 2 Limitations\nUnsuccessful attempts remain on tasks requiring parallel tool use.',
  ].join('\n\n');
  const structure = buildPaperStructure({ kind: 'tex', text });
  const filled = `## 主结果\n\nDeepSeek-R1 在 AIME 2024 上 79.8，MATH-500 上 97.3，Codeforces 评分 2029。`;
  const probes = retrievalProbeResults({
    probes: ['AIME', 'MATH-500', 'Codeforces', '79.8', '97.3', '2029'],
    structure,
    evidence: [{ section: '主结果', role: 'results', chunkIds: structure.chunks.map((c) => c.id) }],
    markdown: filled,
  });
  for (const p of probes) assert.equal(p.status, 'covered', `${p.term} 应为 covered（实际 ${p.status}）`);
  // 没写出来的情况必须判 unwritten
  const empty = retrievalProbeResults({
    probes: ['79.8'],
    structure,
    evidence: [{ section: '主结果', role: 'results', chunkIds: structure.chunks.map((c) => c.id) }],
    markdown: '## 主结果\n\n模型表现很好。',
  });
  assert.equal(empty[0].status, 'unwritten');
});

test('19–20. 1706：label smoothing / residual dropout 的生命周期判定', () => {
  const structure = buildPaperStructure({ kind: 'tex', text: PAPER });
  const md = '## 消融与配方\n\n论文用了 label smoothing 与 residual dropout，去掉后 BLEU 变差。';
  const probes = retrievalProbeResults({
    probes: ['label smoothing', 'residual dropout', 'Regularization'],
    structure,
    evidence: [{ section: '消融与配方', role: 'ablation', chunkIds: structure.chunks.filter((c) => /Regularization/.test(c.sectionTitle)).map((c) => c.id) }],
    markdown: md,
  });
  assert.equal(probes[0].status, 'covered');
  assert.equal(probes[1].status, 'covered');
  const notRetrieved = retrievalProbeResults({
    probes: ['label smoothing'],
    structure,
    evidence: [{ section: '消融与配方', role: 'ablation', chunkIds: [] }],
    markdown: '## 消融与配方\n\n这节没写消融细节。',
  });
  assert.equal(notRetrieved[0].status, 'missing_evidence', '证据没进检索 → missing_evidence');
});

test('21–22. 2406：failure / partial success 不能靠泛化句冒充覆盖', () => {
  const text = [
    '## Abstract\nWe present Atlas, an agent that improves success rate.',
    '## 1 Failure Cases\nFailure cases are dominated by partial success on long-horizon tasks.',
  ].join('\n\n');
  const structure = buildPaperStructure({ kind: 'tex', text });
  const evidence = [{ section: '边界', role: 'limitation', chunkIds: structure.chunks.map((c) => c.id) }];
  const vague = retrievalProbeResults({ probes: ['failure', 'partial success'], structure, evidence, markdown: '## 边界\n\n模型仍有一定局限，还有改进空间。' });
  assert.ok(vague.every((p) => p.status !== 'covered'), `泛化句不能算 covered：${JSON.stringify(vague.map((p) => p.status))}`);
  const specific = retrievalProbeResults({
    probes: ['failure', 'partial success'],
    structure,
    evidence,
    markdown: '## 边界\n\n失败案例里 failure cases 主要集中在长任务上的 partial success。',
  });
  assert.ok(specific.every((p) => p.status === 'covered'));
});

test('23–24. 2409：min_pixels / 16384 source 与 2400 derived 要分开', () => {
  const text = [
    '## Abstract\nQwen2-VL 支持任意分辨率。',
    '## 1 Dynamic Resolution\nWe use dynamic resolution with a 16384 visual token cap; min_pixels controls the lower bound.',
  ].join('\n\n');
  const structure = buildPaperStructure({ kind: 'tex', text });
  const evidence = [{ section: '消融', role: 'ablation', chunkIds: structure.chunks.map((c) => c.id) }];
  const probes = retrievalProbeResults({
    probes: ['min_pixels', '16384', '2400'],
    structure,
    evidence,
    markdown: '## 消融\n\nmin_pixels 与 16384 token 上限来自论文；按论文数据计算，20 分钟 × 2fps = 2400 帧。',
  });
  assert.equal(probes.find((p) => p.term === 'min_pixels').status, 'covered');
  assert.equal(probes.find((p) => p.term === '16384').status, 'covered');
  assert.equal(probes.find((p) => p.term === '2400').status, 'derived', '推导数字必须是 derived，不能算 source');
});

// ============ 25：旧 Plan 兼容 ============

test('25. old Plan compatibility：没有 criticalFacts 也能建台账、不报错', () => {
  const { structure } = setup();
  const ledger = buildEvidenceLedger({
    paperId: 'legacy',
    researchMap: null,
    criticalFacts: [],
    plan: [{ title: '旧小节', note: '旧要点' }],
    retrievalResults: [{ chunkIds: ['c1'] }],
    structure,
  });
  assert.equal(ledger.facts.length, 0);
  assert.deepEqual(ledger.bySection, {});
  const coverage = checkSectionFactCoverage({ ledger, markdownBySection: { 旧小节: '正文' } });
  assert.equal(coverage.stats.assigned, 0);
  assert.equal(coverageStats([], []).coverage, null);
});

test('附带：extractFactNumbers 只认原文出现过的数字', () => {
  const { structure } = setup();
  const regChunk = structure.chunks.find((c) => /label smoothing/.test(c.text));
  const nums = extractFactNumbers(
    { claim: '标签平滑 ϵ_ls', mustUseTerms: ['label smoothing'], chunkIds: [regChunk.id] },
    { structure },
  );
  assert.ok(nums.some((n) => n.value === '0.1'), JSON.stringify(nums));
  assert.ok(nums.every((n) => (n.chunkIds || []).includes(regChunk.id)));
});
