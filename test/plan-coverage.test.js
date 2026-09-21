// Plan Coverage v1：关键事实抽取 → source section 绑定 → 分发到小节 → 预算与排序。
// 全部确定性，不依赖真实 LLM。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaperStructure } from '../src/deepread/chunker.js';
import { buildSourceSectionIndex } from '../src/deepread/sourceSections.js';
import {
  bindFactToSections,
  buildCorpusIndex,
  candidateTerms,
  classifyFact,
  distributeCriticalFacts,
  factPriority,
  rankTerms,
  rareTermsFromChunks,
  seedCriticalFacts,
} from '../src/deepread/criticalFacts.js';
import { retrieveForSection } from '../src/deepread/retrieval.js';
import { planCoverageDiagnostics, retrievalProbeResults } from '../src/deepread/benchmark.js';

/** 1706 风格：关键事实（label smoothing / residual dropout）藏在计划没请求的 Regularization 小节里。 */
const TRANSFORMER_LIKE = [
  '## Abstract\n我们提出 Transformer，完全基于注意力，在 WMT 2014 英德上达到 28.4 BLEU。',
  '## 1 Introduction\n序列转导模型依赖循环或卷积，顺序计算限制并行化。',
  '## 2 Model Architecture\n编码器与解码器各堆叠 N=6 层，每个子层后接残差与 LayerNorm。',
  '## 3 Training\n我们使用 Adam 优化器，学习率按 warmup 调度，训练 100K steps。',
  '## 4 Regularization\nWe employ label smoothing of value epsilon_ls = 0.1, which hurts perplexity but improves BLEU. We also apply residual dropout with P_drop = 0.1 to each sub-layer output.',
  '## 5 Machine Translation\nTable 2 reports 28.4 BLEU on WMT 2014 English-to-German and 41.8 on English-to-French.',
  '## 6 Model Variations\nTable 3 varies the number of heads h, key size d_k and model width d_model.',
  '## 7 Conclusion\nWe presented Transformer, the first sequence transduction model based entirely on attention.',
].join('\n\n');

/** 2406 / 2501 风格：失败案例与主结果分散在正文与附录。 */
const AGENT_LIKE = [
  '## Abstract\nWe present Atlas, a planning-first agent that raises success rate from 41.8% to 52.4%.',
  '## 1 Introduction\nLong-horizon agents accumulate planning errors that cannot be rolled back.',
  '## 2 Method\nA planner decomposes the task and re-plans after each failed tool call.',
  '## 3 Experiments\nTable 2 reports AIME accuracy 79.8 and MATH-500 accuracy 97.3 for the larger model.',
  '## 4 Ablation Study\nRemoving the re-planner drops success rate to 46.1; variant without memory cache reaches 48.9.',
  '## 5 Analysis of Failure Cases\nFailure cases are dominated by partial success on long-horizon tasks; 21% come from unrecoverable edit loops.',
  '## 6 Conclusion\nAtlas is a strong baseline, but unsuccessful attempts remain concentrated on tasks requiring parallel tool use.',
].join('\n\n');

function setup(text = TRANSFORMER_LIKE) {
  const structure = buildPaperStructure({ kind: 'tex', text });
  const sourceIndex = buildSourceSectionIndex(structure);
  const corpus = buildCorpusIndex(structure);
  return { structure, sourceIndex, corpus };
}

const PLAN_1706 = [
  { title: '注意力就是全部', note: '导语', role: 'intro', sourceSections: ['1 Introduction'], mustUseTerms: ['Transformer'] },
  { title: '六层堆叠怎么搭', note: '机制', role: 'method', sourceSections: ['2 Model Architecture'], mustUseTerms: ['LayerNorm'] },
  {
    title: '换掉层数和头数之后',
    note: '消融',
    role: 'ablation',
    sourceSections: ['6 Model Variations'],
    mustUseTerms: ['Table 3', 'heads'],
  },
  { title: '28.4 与 41.8 是怎么来的', note: '主结果', role: 'results', sourceSections: ['5 Machine Translation'], mustUseTerms: ['BLEU', 'Table 2'] },
  { title: '未竟边界', note: '局限', role: 'limitation', sourceSections: ['7 Conclusion'], mustUseTerms: ['attention'] },
];

// ============ 1–4：critical facts 抽取 ============

test('Research Map main_results → criticalFacts（category=main_result，带数字记 high）', () => {
  const { structure, sourceIndex, corpus } = setup();
  const facts = seedCriticalFacts({
    researchMap: { main_results: [{ text: 'WMT 2014 英德 28.4 BLEU，英法 41.8 BLEU' }] },
    structure,
    sourceIndex,
    corpus,
  });
  assert.equal(facts.length, 1);
  assert.equal(facts[0].category, 'main_result');
  assert.equal(facts[0].priority, 'high');
  assert.match(facts[0].id, /^cf-\d+$/);
  assert.equal(facts[0].provenance, 'research_map.main_results');
  assert.ok(facts[0].sourceSectionIds.length > 0, '必须绑定到真实 source section');
  assert.ok(facts[0].sourceSectionTitles.includes('5 Machine Translation'));
});

test('Research Map ablations → criticalFacts（category=ablation）', () => {
  const { structure, sourceIndex, corpus } = setup();
  const facts = seedCriticalFacts({
    researchMap: { ablations: [{ text: '标签平滑 ε_ls=0.1：困惑度变好但 BLEU 变差（Table 3 行 D）' }] },
    structure,
    sourceIndex,
    corpus,
  });
  assert.equal(facts[0].category, 'ablation');
  assert.equal(facts[0].priority, 'high');
  assert.ok(facts[0].mustUseTerms.includes('label smoothing'), `应把中文事实落成原文术语：${JSON.stringify(facts[0].mustUseTerms)}`);
});

test('Research Map limitations → criticalFacts（写失败机制的记为 failure）', () => {
  const { structure, sourceIndex, corpus } = setup(AGENT_LIKE);
  const facts = seedCriticalFacts({
    researchMap: {
      limitations: [
        { text: 'Failure cases 集中在长任务上的 partial success（21% 来自不可恢复的编辑循环）' },
        { text: '只在文本工具上验证，未在多模态环境测试' },
      ],
    },
    structure,
    sourceIndex,
    corpus,
  });
  assert.equal(facts[0].category, 'failure');
  assert.equal(facts[1].category, 'limitation');
  assert.equal(classifyFact('去掉重规划后成功率掉到 46.1'), 'ablation');
  assert.equal(factPriority('limitation', '只在文本模态验证'), 'medium', '没有数字/技术词的局限记 medium');
});

// ============ 5–7：绑定与分发 ============

test('fact → sourceSection 映射：优先用地图 chunkIds，否则关键词扫描，绑不上如实记 unmatched', () => {
  const { structure, sourceIndex, corpus } = setup();
  const byChunks = bindFactToSections(
    { text: '随便什么文本', chunkIds: [structure.chunks[0].id] },
    { structure, sourceIndex, corpus },
  );
  assert.equal(byChunks.method, 'research_map_chunks');
  assert.equal(byChunks.unmatched.length, 0);

  const byScan = bindFactToSections(
    { text: 'label smoothing ϵ_ls = 0.1 会让 BLEU 变差', chunkIds: [] },
    { structure, sourceIndex, corpus },
  );
  assert.equal(byScan.method, 'keyword_scan');
  assert.ok(byScan.sectionTitles.includes('4 Regularization'), `应扫到 Regularization：${JSON.stringify(byScan.sectionTitles)}`);

  const unmatched = bindFactToSections(
    { text: 'zzz 完全不存在的词 qqq', chunkIds: [] },
    { structure, sourceIndex, corpus },
  );
  assert.equal(unmatched.method, 'unmatched');
  assert.equal(unmatched.sectionIds.length, 0);
  assert.equal(unmatched.unmatched.length, 1, '绑不上必须如实记录');
});

test('fact → section 分发：main_result 进 results 类，ablation 进 ablation 类，limitation 进 limitation 类', () => {
  const { structure, sourceIndex, corpus } = setup();
  const facts = seedCriticalFacts({
    researchMap: {
      main_results: [{ text: 'WMT 2014 英德 28.4 BLEU，英法 41.8 BLEU' }],
      ablations: [{ text: '标签平滑 ε_ls=0.1：困惑度变好但 BLEU 变差' }],
      limitations: [{ text: '只在文本模态验证' }],
    },
    structure,
    sourceIndex,
    corpus,
  });
  const out = distributeCriticalFacts({ plan: PLAN_1706, facts, sourceIndex, structure, corpus });
  const byCategory = Object.fromEntries(out.facts.map((f) => [f.category, f.planSections]));
  assert.ok(byCategory.main_result.some((t) => /28\.4 与 41\.8/.test(t)), `main_result 应进结果类小节：${JSON.stringify(byCategory)}`);
  assert.ok(byCategory.ablation.some((t) => /换掉层数和头数/.test(t)));
  assert.ok(byCategory.limitation.some((t) => /未竟边界/.test(t)));
  assert.equal(out.coverage.criticalFactAssignedCount, facts.length, '每条事实都必须落到小节');
  assert.equal(out.coverage.highPriorityFactAssignedCount, out.coverage.highPriorityFactCount);
});

test('high priority 优先：高分小节被 high 事实先占用，medium 事实不抢占', () => {
  const { structure, sourceIndex, corpus } = setup();
  const facts = seedCriticalFacts({
    researchMap: {
      main_results: [{ text: 'WMT 2014 英德 28.4 BLEU' }],
      method_components: [{ text: '编码器与解码器堆叠' }],
    },
    structure,
    sourceIndex,
    corpus,
  });
  const high = facts.filter((f) => f.priority === 'high');
  const out = distributeCriticalFacts({ plan: PLAN_1706, facts, sourceIndex, structure, corpus });
  assert.ok(high.every((f) => out.facts.find((x) => x.id === f.id).planSections.length > 0));
  const resultsSection = out.plan.find((s) => /28\.4 与 41\.8/.test(s.title));
  assert.ok(resultsSection.criticalFactIds.includes(high[0].id), 'high 事实必须落在结果类小节');
});

// ============ 8–10：预算、排序、溢出 ============

test('rare-term ranking：关键术语 → 稀有术语 → 指标 → 消融变量 → 局限词 → 普通词（deterministic）', () => {
  const { structure, corpus } = setup();
  const ranked = rankTerms(
    ['model', 'label smoothing', 'BLEU', 'dropout', 'limitation', 'Transformer', 'zzzgeneric'],
    { corpus, criticalTerms: new Set(['label smoothing']) },
  );
  const order = ranked.map((r) => r.term);
  assert.equal(order[0], 'label smoothing', '关键术语必须排第一');
  assert.ok(ranked.every((r) => Number.isInteger(r.tier) && r.df >= 0));
  // 同样输入必须得到同样输出
  const again = rankTerms(['zzzgeneric', 'Transformer', 'limitation', 'dropout', 'BLEU', 'label smoothing', 'model'], { corpus, criticalTerms: new Set(['label smoothing']) });
  assert.deepEqual(again.map((r) => r.term), order);
  // 层级顺序：关键术语(1) → 稀有术语(2) → 指标(3) → 消融变量(4) → 局限词(5) → 普通词(6)
  const tierOf = (t) => ranked.find((r) => r.term === t).tier;
  assert.equal(tierOf('label smoothing'), 1, '关键术语第一层');
  assert.ok(tierOf('dropout') <= 2, '稀有消融词在前两层');
  assert.equal(tierOf('BLEU'), 3, '指标词第三层');
  assert.equal(tierOf('limitation'), 5, '局限词第五层');
  assert.equal(tierOf('zzzgeneric'), 6, '普通词在最后一层');
  const idxOf = (t) => order.indexOf(t);
  assert.ok(idxOf('label smoothing') < idxOf('dropout'));
  assert.ok(idxOf('dropout') < idxOf('zzzgeneric'), '稀有词排在普通词前面');
  assert.ok(idxOf('BLEU') < idxOf('zzzgeneric'), '指标词排在普通词前面');
  assert.ok(idxOf('limitation') < idxOf('zzzgeneric'), '局限词排在普通词前面');
});

test('sourceSections 每节 ≤3，且事实要求的优先、其余进 deferred', () => {
  const { structure, sourceIndex, corpus } = setup();
  const plan = [
    {
      title: '消融与配方',
      role: 'ablation',
      sourceSections: ['1 Introduction', '2 Model Architecture', '3 Training', '5 Machine Translation', '6 Model Variations'],
      mustUseTerms: ['BLEU'],
    },
  ];
  const facts = seedCriticalFacts({
    researchMap: { ablations: [{ text: '标签平滑 ε_ls=0.1：困惑度变好但 BLEU 变差' }] },
    structure,
    sourceIndex,
    corpus,
  });
  const out = distributeCriticalFacts({ plan, facts, sourceIndex, structure, corpus, maxSourceSections: 3 });
  const section = out.plan[0];
  assert.ok(section.sourceSections.length <= 3, `每节最多 3 个（实际 ${section.sourceSections.length}）`);
  assert.ok(section.sourceSections.includes('4 Regularization'), '事实要求的 source section 必须优先占位');
  assert.ok(section.sourceSectionsAddedByFacts.includes('4 Regularization'));
  assert.ok(section.sourceSectionsDeferred.length >= 3, `超预算的请求进 deferred，不直接丢弃（实际 ${section.sourceSectionsDeferred.length}）`);
  assert.equal(out.coverage.sourceSectionOverflowCount, section.sourceSectionsDeferred.length);
  const keptOrDeferred = new Set([...section.sourceSections, ...section.sourceSectionsDeferred]);
  for (const t of section.sourceSectionsRequested) assert.ok(keptOrDeferred.has(t), `${t} 不能被丢掉`);
  assert.ok(out.coverage.planSourceSectionCoverage < 1);
});

test('mustUseTerms 截断后不丢信息：超出的进 mustUseTermsDeferred', () => {
  const { structure, sourceIndex, corpus } = setup();
  const facts = seedCriticalFacts({
    researchMap: { ablations: [{ text: '标签平滑 ε_ls=0.1：困惑度变好但 BLEU 变差' }] },
    structure,
    sourceIndex,
    corpus,
  });
  const out = distributeCriticalFacts({
    plan: [{ title: '消融', role: 'ablation', sourceSections: [], mustUseTerms: ['a term', 'another term', 'third term', 'fourth term'] }],
    facts,
    sourceIndex,
    structure,
    corpus,
    maxTermsPerSection: 3,
  });
  assert.equal(out.plan[0].mustUseTerms.length, 3);
  assert.ok(out.plan[0].mustUseTerms.includes('label smoothing'), '关键术语必须留在最终列表里');
  assert.ok(out.plan[0].mustUseTermsDeferred.length >= 1);
});

test('旧 Plan 格式兼容：没有 sourceSections / mustUseTerms 也能分发', () => {
  const { structure, sourceIndex, corpus } = setup();
  const facts = seedCriticalFacts({
    researchMap: { main_results: [{ text: 'WMT 2014 英德 28.4 BLEU' }] },
    structure,
    sourceIndex,
    corpus,
  });
  const legacy = [{ title: '主结果与消融', note: '结果' }, { title: '边界', note: '局限' }];
  const out = distributeCriticalFacts({ plan: legacy, facts, sourceIndex, structure, corpus });
  assert.equal(out.plan.length, 2);
  for (const s of out.plan) {
    assert.ok(Array.isArray(s.sourceSections));
    assert.ok(Array.isArray(s.mustUseTerms));
    assert.ok(Array.isArray(s.criticalFactIds));
  }
  assert.equal(out.coverage.criticalFactAssignedCount, 1);
});

// ============ 11–15：1706 / 2406 场景 ============

test('1706 场景：计划没请求 Regularization 时自动补入，且 label smoothing 进入 mustUseTerms', () => {
  const { structure, sourceIndex, corpus } = setup();
  const requested = new Set(PLAN_1706.flatMap((s) => s.sourceSections));
  assert.equal(requested.has('4 Regularization'), false, '前提：计划确实漏了这个关键小节');

  const facts = seedCriticalFacts({
    researchMap: { ablations: [{ text: '标签平滑 ε_ls=0.1：困惑度变好但 BLEU 变差（Table 3 行 D）' }] },
    structure,
    sourceIndex,
    corpus,
  });
  const out = distributeCriticalFacts({ plan: PLAN_1706, facts, sourceIndex, structure, corpus });
  const ablationSection = out.plan.find((s) => s.role === 'ablation');

  assert.ok(ablationSection.sourceSections.includes('4 Regularization'), 'Regularization 必须被自动补进计划');
  assert.ok(ablationSection.sourceSections.length <= 3);
  assert.ok(ablationSection.mustUseTerms.includes('label smoothing'), `mustUseTerms 应含 label smoothing：${JSON.stringify(ablationSection.mustUseTerms)}`);
  assert.ok(ablationSection.mustUseTerms.includes('residual dropout'), `mustUseTerms 应含 residual dropout：${JSON.stringify(ablationSection.mustUseTerms)}`);

  // 端到端：检索后这些事实真的进了本节证据
  const r = retrieveForSection({
    structure,
    section: ablationSection,
    sourceIndex,
    budgetChars: 6000,
    maxChunks: 12,
    criticalFacts: out.facts,
  });
  const text = r.evidence.map((e) => e.text).join('\n');
  assert.match(text, /label smoothing/);
  assert.match(text, /residual dropout/);
  assert.ok(r.criticalFactHitCount >= 1, '关键事实命中必须记入检索元数据');
});

test('2406 场景：failure / partial success 被绑定到失败案例小节并进入证据', () => {
  const { structure, sourceIndex, corpus } = setup(AGENT_LIKE);
  const plan = [
    { title: '主结果', role: 'results', sourceSections: ['3 Experiments'], mustUseTerms: ['AIME'] },
    { title: '边界与失败', role: 'limitation', sourceSections: ['6 Conclusion'], mustUseTerms: ['baseline'] },
  ];
  const facts = seedCriticalFacts({
    researchMap: {
      limitations: [{ text: 'Failure cases 集中在长任务上的 partial success（21% 来自不可恢复的编辑循环）' }],
      main_results: [{ text: 'AIME 79.8、MATH-500 97.3' }],
    },
    structure,
    sourceIndex,
    corpus,
  });
  const out = distributeCriticalFacts({ plan, facts, sourceIndex, structure, corpus });
  const limitationSection = out.plan.find((s) => s.title === '边界与失败');
  assert.ok(
    limitationSection.sourceSections.includes('5 Analysis of Failure Cases') || limitationSection.sourceSections.includes('6 Conclusion'),
    `失败案例小节应进入限制节：${JSON.stringify(limitationSection.sourceSections)}`,
  );
  assert.ok(limitationSection.mustUseTerms.some((t) => /failure|partial success/.test(t)), `应含 failure/partial success：${JSON.stringify(limitationSection.mustUseTerms)}`);

  const r = retrieveForSection({ structure, section: limitationSection, sourceIndex, budgetChars: 6000, maxChunks: 12 });
  const text = r.evidence.map((e) => e.text).join('\n');
  assert.match(text, /Failure cases|partial success/i);
});

// ============ 16–17：2501 场景 ============

test('2501 场景：MATH-500 / Unsuccessful 作为稀有术语进入 mustUseTerms 并被检索到', () => {
  const { structure, sourceIndex, corpus } = setup(AGENT_LIKE);
  const plan = [
    { title: '主结果数字', role: 'results', sourceSections: ['3 Experiments'], mustUseTerms: ['model', 'success rate', 'AIME', 'MATH-500', 'Table 2', 'benchmark', 'task'] },
    { title: '未成功尝试划出边界', role: 'limitation', sourceSections: ['6 Conclusion', '5 Analysis of Failure Cases'], mustUseTerms: ['model', 'tool'] },
  ];
  const facts = seedCriticalFacts({
    researchMap: {
      main_results: [{ text: 'AIME accuracy 79.8 and MATH-500 accuracy 97.3' }],
      limitations: [{ text: 'unsuccessful attempts remain on tasks requiring parallel tool use' }],
    },
    structure,
    sourceIndex,
    corpus,
  });
  const out = distributeCriticalFacts({ plan, facts, sourceIndex, structure, corpus, maxTermsPerSection: 5 });
  const resultsSection = out.plan.find((s) => s.title === '主结果数字');
  const limitationSection = out.plan.find((s) => s.title === '未成功尝试划出边界');

  assert.ok(resultsSection.mustUseTerms.some((t) => /math-500/i.test(t)), `MATH-500 不能被普通词挤掉：${JSON.stringify(resultsSection.mustUseTerms)}`);
  assert.ok(limitationSection.mustUseTerms.some((t) => /unsuccessful/i.test(t)), `Unsuccessful 不能被普通词挤掉：${JSON.stringify(limitationSection.mustUseTerms)}`);
  const ranked = resultsSection.mustUseTermRanking;
  assert.ok(ranked[0].tier <= 2, '排第一的应是关键/稀有术语');

  const text = out.plan
    .map((s) => retrieveForSection({ structure, section: s, sourceIndex, budgetChars: 6000, maxChunks: 12 }).evidence.map((e) => e.text).join('\n'))
    .join('\n');
  assert.match(text, /MATH-500/);
  assert.match(text, /unsuccessful attempts/i);
});

// ============ 诊断与探针 ============

test('planCoverageDiagnostics：事实覆盖 / 小节覆盖 / 稀有术语覆盖都来自真实数据', () => {
  const { structure, sourceIndex, corpus } = setup(AGENT_LIKE);
  const facts = seedCriticalFacts({
    researchMap: { main_results: [{ text: 'AIME accuracy 79.8 and MATH-500 accuracy 97.3' }] },
    structure,
    sourceIndex,
    corpus,
  });
  const plan = [
    {
      title: '主结果数字',
      role: 'results',
      sourceSections: ['3 Experiments'],
      sourceSectionsRequested: ['3 Experiments', '1 Introduction'],
      sourceSectionsAddedByFacts: [],
      sourceSectionsDeferred: ['1 Introduction'],
      mustUseTerms: ['MATH-500'],
      mustUseTermRanking: [{ term: 'MATH-500', tier: 2, df: 1 }],
    },
  ];
  const evidence = [{ section: '主结果数字', role: 'results', chunkIds: [structure.chunks.find((c) => /MATH-500/.test(c.text)).id] }];
  const diag = planCoverageDiagnostics({ facts, plan, evidence, structure });
  assert.equal(diag.criticalFactCount, 1);
  assert.equal(diag.criticalFactMappedCount, 1);
  assert.equal(diag.criticalFactUnmappedCount, 0);
  assert.equal(diag.criticalFactCoverage, 1);
  assert.equal(diag.highPriorityFactCoverage, 1);
  assert.equal(diag.criticalFactSectionCoverage, 1);
  assert.equal(diag.planSourceSectionCoverage, 0.5, '请求 2 个、落地 1 个');
  assert.equal(diag.sourceSectionOverflowCount, 1);
  assert.equal(diag.mustUseRareTermCoverage, 1);
});

test('探针诊断：能区分 retrieved / plan_did_not_request_section / slot_competition / term_not_in_source', () => {
  const { structure } = setup();
  const mathChunk = structure.chunks.find((c) => /Machine Translation/.test(c.sectionTitle));
  const probes = retrievalProbeResults({
    probes: ['BLEU', 'label smoothing', 'no-such-term-xyz'],
    structure,
    evidence: [{ section: '主结果', role: 'results', chunkIds: [mathChunk.id] }],
    plan: [{ title: '消融', role: 'ablation', sourceSections: ['4 Regularization'], mustUseTerms: ['label smoothing'] }],
    facts: [],
  });
  const bleu = probes.find((p) => p.term === 'BLEU');
  assert.equal(bleu.matched, true);
  assert.equal(bleu.reason, 'retrieved');
  assert.ok(bleu.planSection.includes('主结果'));
  const ls = probes.find((p) => p.term === 'label smoothing');
  assert.equal(ls.matched, false);
  assert.equal(ls.reason, 'slot_competition', '计划请求过但没进检索');
  assert.deepEqual(ls.requestedBy, ['消融']);
  const missing = probes.find((p) => p.term === 'no-such-term-xyz');
  assert.equal(missing.reason, 'term_not_in_source');

  const notRequested = retrievalProbeResults({
    probes: ['label smoothing'],
    structure,
    evidence: [],
    plan: [{ title: '主结果', role: 'results', sourceSections: ['5 Machine Translation'], mustUseTerms: ['BLEU'] }],
  })[0];
  assert.equal(notRequested.reason, 'plan_did_not_request_section');
});

test('rareTermsFromChunks / candidateTerms：只产出语料里真实出现过的术语', () => {
  const { structure, corpus } = setup();
  const reg = structure.chunks.find((c) => /label smoothing/.test(c.text));
  const terms = rareTermsFromChunks([reg.id], { structure, corpus, limit: 10 });
  assert.ok(terms.includes('label smoothing'), `应抽到 label smoothing：${JSON.stringify(terms)}`);
  assert.ok(terms.every((t) => corpus.df(t) > 0), '术语必须在语料里出现过');
  const candidates = candidateTerms('We employ label smoothing of value 0.1 (Table 3)');
  assert.ok(candidates.includes('label smoothing'));
  assert.ok(candidates.some((t) => /^Table 3$/i.test(t)));
});
