// DeepRead Retrieval v2：source section 对齐、多源 query、槽位分配、跨节多样性、检索诊断。
// 全部确定性，不依赖真实 LLM。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaperStructure } from '../src/deepread/chunker.js';
import {
  alignSourceSections,
  buildSourceSectionIndex,
  matchSourceSection,
  normalizeSectionName,
  sectionAcronym,
  sourceNeighborhood,
} from '../src/deepread/sourceSections.js';
import {
  allocateEvidenceSlots,
  buildSectionQuery,
  parseReferenceTerms,
  retrieveForSection,
  sectionRole,
} from '../src/deepread/retrieval.js';
import { defaultDeepReadPlan, parseDeepReadPlan } from '../src/deepread/prompts.js';
import {
  DEFAULT_RETRIEVAL_PROBES,
  retrievalDiagnostics,
  retrievalProbeResults,
} from '../src/deepread/benchmark.js';
import { retrievalV2PaperText } from './fixtures.js';

function setup() {
  const structure = buildPaperStructure({ kind: 'tex', text: retrievalV2PaperText() });
  const index = buildSourceSectionIndex(structure);
  return { structure, index };
}

const evText = (r) => r.evidence.map((e) => e.text).join('\n');
const evSections = (r) => [...new Set(r.evidence.map((e) => e.sectionTitle))];

// ============ 1–4：source section 对齐 ============

test('source section：exact / normalized / 编号 / 缩写 / 术语模糊都能对齐', () => {
  const { index } = setup();
  assert.equal(matchSourceSection('4 Ablation Study', index).method, 'exact');
  assert.equal(matchSourceSection('Ablation Study', index).method, 'normalized_exact', '原文带编号时要靠归一化对齐');
  assert.equal(matchSourceSection('ablation study', index).method, 'normalized_exact');
  assert.equal(normalizeSectionName('4 Ablation Study'), 'ablationstudy');
  assert.equal(matchSourceSection('4. Ablation Study', index).section.title, '4 Ablation Study');
  assert.equal(matchSourceSection('5 Limitations', index).section.title, '5 Limitations');
  assert.equal(sectionAcronym('The Agent-Computer Interface'), 'ACI');
  assert.equal(sectionAcronym('Scaled Dot-Product Attention'), 'SDPA');
  const fuzzy = matchSourceSection('Scaled Dot Product Attention Mechanism', index);
  assert.ok(fuzzy, '应能模糊匹配到 2.1 节');
  assert.equal(fuzzy.section.title, '2.1 Scaled Dot-Product Attention');
});

test('source section：对不上时如实记录 unmatched，并给出 fallback 手段', () => {
  const { index } = setup();
  const aligned = alignSourceSections({ requested: ['自注意力机制', 'Nonexistent Chapter'], index, mustUseTerms: ['self-attention'] });
  assert.equal(aligned.status, 'unmatched');
  assert.equal(aligned.method, 'fallback_terms');
  assert.deepEqual(aligned.matched, []);
  assert.deepEqual(aligned.unmatched, ['自注意力机制', 'Nonexistent Chapter']);
  assert.ok(aligned.fallbackUsed.includes('mustUseTerms'));
  assert.ok(aligned.fallbackUsed.includes('researchMapEvidence'));
});

test('source section：部分命中记 partial，并保留两侧信息', () => {
  const { index } = setup();
  const aligned = alignSourceSections({ requested: ['Ablation Study', '自注意力机制'], index });
  assert.equal(aligned.status, 'partial');
  assert.equal(aligned.method, 'partial');
  assert.equal(aligned.matched.length, 1);
  assert.equal(aligned.matched[0].sectionId, index.sections.find((s) => s.title === '4 Ablation Study').id);
  assert.deepEqual(aligned.unmatched, ['自注意力机制']);
});

test('英文原文 + 中文计划：靠 sourceSections 对齐，而不是靠中文词法', () => {
  const { structure, index } = setup();
  const section = {
    title: '换机器人怎么调：只调一小部分参数就够了吗',
    note: 'LoRA 微调与全量微调的差别',
    role: 'results',
    sourceSections: ['3.2 Main Results', '4 Ablation Study'],
    mustUseTerms: ['label smoothing'],
  };
  const match = alignSourceSections({ requested: section.sourceSections, index });
  assert.equal(match.status, 'matched');
  const r = retrieveForSection({ structure, section, sourceMatch: match, sourceIndex: index, budgetChars: 6000, maxChunks: 12 });
  assert.equal(r.sourceSectionMatch.sectionIds.length, 2);
  assert.ok(evSections(r).some((s) => /Main Results|Ablation Study/.test(s)), `evidence 应来自对齐到的原文小节：${evSections(r).join(' | ')}`);
  assert.ok(r.evidence.some((e) => e.slot === 'sourceLocal'), '应有 source-local 槽位的证据');
});

// ============ 5–7：多源 query / mustUseTerms / 地图证据 ============

test('mustUseTerms：术语命中进入证据（label smoothing / residual dropout）', () => {
  const { structure, index } = setup();
  const section = {
    title: '消融说明了什么',
    role: 'ablation',
    sourceSections: ['4 Ablation Study'],
    mustUseTerms: ['label smoothing', 'residual dropout'],
  };
  const r = retrieveForSection({ structure, section, sourceIndex: index, budgetChars: 6000, maxChunks: 12 });
  const text = evText(r);
  assert.match(text, /label smoothing/);
  assert.match(text, /residual dropout/);
  assert.ok(r.mustUseTermHits >= 2, `选中的证据里应命中 2 个术语（实际 ${r.mustUseTermHits}/${r.mustUseTermTotal}）`);
  assert.ok(r.mustUseHitTerms.includes('label smoothing'));

  // mustUseTerms 通道独立于 source section：术语所在 chunk 不在本节对应小节时，
  // 仍然必须靠这一通道把它拉进来（并标记为 mustUse 槽位）。
  const crossSection = retrieveForSection({
    structure,
    section: { title: '失效边界', role: 'limitation', sourceSections: ['5 Limitations'], mustUseTerms: ['label smoothing'] },
    sourceIndex: index,
    budgetChars: 6000,
    maxChunks: 12,
  });
  const mu = crossSection.evidence.find((e) => e.slot === 'mustUse');
  assert.ok(mu, '跨小节的 mustUseTerms 命中应以 mustUse 槽位进入证据');
  assert.match(mu.text, /label smoothing/);
  assert.equal(crossSection.mustUseTermHits, 1);
});

test('研究地图 evidence：点名的 chunk 直接进入证据并记入槽位', () => {
  const { structure, index } = setup();
  const target = structure.chunks.find((c) => /ablation|消融/i.test(c.sectionTitle));
  const researchMap = { evidence: [{ text: '消融结论', chunkIds: [target.id] }], key_claims: [], main_results: [] };
  const section = { title: '社区视角：值不值得跟进', role: 'discussion' };
  const r = retrieveForSection({ structure, section, researchMap, sourceIndex: index, budgetChars: 6000, maxChunks: 12 });
  assert.ok(r.chunkIds.includes(target.id), '地图点名的 chunk 必须被选中');
  assert.equal(r.evidence.find((e) => e.id === target.id).slot, 'mustUse');
});

test('query 是结构化的多来源，不是一条字符串拼接', () => {
  const { index, structure } = setup();
  const researchMap = { main_results: [{ text: 'BLEU 41.8' }], datasets: [{ text: 'WMT14' }], key_claims: [] };
  const match = alignSourceSections({ requested: ['4 Ablation Study'], index });
  const q = buildSectionQuery({
    section: { title: '消融说明了什么', purpose: '看消融怎么改变结论', mustUseTerms: ['label smoothing'] },
    role: 'ablation',
    researchMap,
    sourceMatch: match,
    index,
  });
  for (const key of ['sourceSectionTerms', 'mustUseTerms', 'mustUseTermTokens', 'evidenceTerms', 'roleTerms', 'purposeTerms', 'titleTerms', 'all']) {
    assert.ok(key in q, `query 缺少字段 ${key}`);
  }
  assert.ok(q.sourceSectionTerms.includes('ablation'), 'source section 词应进入 sourceSectionTerms');
  assert.ok(q.sourceSectionTerms.includes('study'));
  assert.deepEqual(q.mustUseTerms, ['label smoothing']);
  assert.ok(q.evidenceTerms.includes('bleu') || q.evidenceTerms.includes('wmt14'));
  assert.ok(q.roleTerms.includes('variant') || q.roleTerms.includes('sensitivity'));
  assert.ok(q.purposeTerms.length > 0);
  assert.ok(structure.chunks.length > 0);
});

// ============ 8–9：同角色多样性 / 关键证据可复用 ============

test('同角色不重合：两个 method 小节拿到不同证据，且第二次带 reused 统计', () => {
  const { structure, index } = setup();
  const a = retrieveForSection({
    structure,
    section: { title: '整体骨架怎么搭', role: 'method', sourceSections: ['2 Model Architecture'] },
    sourceIndex: index,
    budgetChars: 6000,
    maxChunks: 12,
  });
  const b = retrieveForSection({
    structure,
    section: { title: '多头注意力怎么算', role: 'method', sourceSections: ['2.2 Multi-Head Attention'], mustUseTerms: ['multi-head attention'] },
    sourceIndex: index,
    budgetChars: 6000,
    maxChunks: 12,
    previousSectionChunkIds: a.chunkIds,
  });
  const inter = a.chunkIds.filter((id) => b.chunkIds.includes(id)).length;
  const union = new Set([...a.chunkIds, ...b.chunkIds]).size;
  assert.ok(inter / union < 0.6, `同角色重合度应明显下降（实际 ${inter}/${union}）`);
  assert.ok(b.newChunkCount > 0, '第二节应包含未被第一节用过的新证据');
  assert.equal(b.reusedChunkCount, inter);
  assert.equal(b.uniqueChunkCount, b.chunkIds.length);
  assert.ok(b.evidence.some((e) => /Multi-Head Attention/.test(e.sourceSection)));
});

test('关键证据可复用：地图点名 / mustUseTerms 命中 / source-local 不受重复惩罚', () => {
  const { structure, index } = setup();
  const target = structure.chunks.find((c) => /label smoothing/.test(c.text));
  assert.ok(target, 'fixture 应包含 label smoothing chunk');
  const first = retrieveForSection({
    structure,
    section: { title: '消融一', role: 'ablation', sourceSections: ['4 Ablation Study'], mustUseTerms: ['label smoothing'] },
    sourceIndex: index,
    budgetChars: 6000,
    maxChunks: 12,
  });
  assert.ok(first.chunkIds.includes(target.id));
  const second = retrieveForSection({
    structure,
    section: { title: '消融二', role: 'ablation', sourceSections: ['4 Ablation Study'], mustUseTerms: ['label smoothing'] },
    sourceIndex: index,
    budgetChars: 6000,
    maxChunks: 12,
    previousSectionChunkIds: first.chunkIds,
  });
  assert.ok(second.chunkIds.includes(target.id), '关键证据必须允许跨节复用');
});

// ============ 10–13：各角色检索 ============

test('ablation / limitation / failure / results 角色检索各自召回对的内容', () => {
  const { structure, index } = setup();
  assert.equal(sectionRole('消融三连：min_pixels、M-RoPE 外推'), 'ablation');
  assert.equal(sectionRole('4 Ablation Study'), 'ablation');
  assert.equal(sectionRole('失败案例与局限'), 'limitation');
  assert.equal(sectionRole('主结果与基线对比'), 'results');

  const ablation = retrieveForSection({
    structure,
    section: {
      title: '消融三连：这些设计真的有用吗',
      role: 'ablation',
      sourceSections: ['4 Ablation Study'],
      mustUseTerms: ['label smoothing', 'residual dropout'],
    },
    sourceIndex: index,
    budgetChars: 6000,
    maxChunks: 12,
  });
  assert.match(evText(ablation), /39\.1|label smoothing|residual dropout/);

  const limitation = retrieveForSection({
    structure,
    section: { title: '失效边界与可以继续追的问题', role: 'limitation', sourceSections: ['5 Limitations', '6 Failure Cases'] },
    sourceIndex: index,
    budgetChars: 6000,
    maxChunks: 12,
  });
  assert.match(evText(limitation), /只在文本模态|窗口大小/);

  const failure = retrieveForSection({
    structure,
    section: { title: '失败案例说明了什么', role: 'limitation', sourceSections: ['6 Failure Cases'], mustUseTerms: ['failure cases', 'partial success'] },
    sourceIndex: index,
    budgetChars: 6000,
    maxChunks: 12,
  });
  assert.match(evText(failure), /failure cases|partial success/);

  const results = retrieveForSection({
    structure,
    section: { title: '主结果与基线对比', role: 'results', sourceSections: ['3.2 Main Results'], mustUseTerms: ['Table 1', 'BLEU'] },
    sourceIndex: index,
    budgetChars: 6000,
    maxChunks: 12,
  });
  assert.match(evText(results), /41\.8|40\.88/);
  assert.ok(results.evidence.some((e) => e.type === 'table'), '结果节应召回到表格 chunk');
});

// ============ 14–17：图 / 表 / 公式 / 后半篇 ============

test('图/表/公式按结构化绑定召回（Table 1 / Figure 1 / Eq. 1）', () => {
  const { structure, index } = setup();
  const refs = parseReferenceTerms(['Table 1', 'Figure 1', 'Eq. 1']);
  assert.deepEqual([...refs.tables], [1]);
  assert.deepEqual([...refs.figures], [1]);
  assert.deepEqual([...refs.equations], [1]);

  const byTable = retrieveForSection({
    structure,
    section: { title: '主结果表', role: 'results', sourceSections: ['3.2 Main Results'], mustUseTerms: ['Table 1'] },
    sourceIndex: index,
    budgetChars: 6000,
    maxChunks: 12,
  });
  assert.ok(byTable.evidence.some((e) => e.type === 'table'), 'Table 1 → table chunk');

  const byFigure = retrieveForSection({
    structure,
    section: { title: '主结果图', role: 'results', sourceSections: ['3.2 Main Results'], mustUseTerms: ['Figure 1'] },
    sourceIndex: index,
    budgetChars: 6000,
    maxChunks: 12,
  });
  assert.ok(byFigure.evidence.some((e) => e.type === 'figure'), 'Figure 1 → figure chunk');

  const byFormula = retrieveForSection({
    structure,
    section: { title: '核心公式', role: 'formula', sourceSections: ['2.1 Scaled Dot-Product Attention'], mustUseTerms: ['Eq. 1'] },
    sourceIndex: index,
    budgetChars: 6000,
    maxChunks: 12,
  });
  assert.ok(byFormula.evidence.some((e) => e.type === 'formula'), 'Eq. 1 → formula chunk');
});

test('source-local 邻域包含小节内的图注/表格/公式，而不是只有第一段', () => {
  const { structure, index } = setup();
  const sectionIds = [
    index.sections.find((s) => s.title === '3.2 Main Results').id,
    index.sections.find((s) => s.title === '2.1 Scaled Dot-Product Attention').id,
  ];
  const ids = sourceNeighborhood({ index, structure, sectionIds });
  const types = ids.map((id) => structure.chunks.find((c) => c.id === id)?.type);
  assert.ok(ids.length >= 2);
  assert.ok(types.includes('table') || types.includes('figure'), `邻域应包含图/表：${types.join(',')}`);
  assert.ok(types.includes('formula'), `邻域应包含公式：${types.join(',')}`);
});

test('后半篇证据会被召回（且不是无脑全后半篇）', () => {
  const { structure, index } = setup();
  const r = retrieveForSection({
    structure,
    section: { title: '失效边界与失败案例', role: 'limitation', sourceSections: ['6 Failure Cases', '7 Ethics and Broader Impacts'] },
    sourceIndex: index,
    budgetChars: 6000,
    maxChunks: 12,
  });
  assert.ok(r.backHalfChunks >= 1, '局限类小节必须带后半篇证据');
  assert.ok(r.evidence.some((e) => /Failure Cases|Ethics/.test(e.sourceSection)), '后半篇证据应来自对齐到的小节');
  assert.ok(r.lateQuota <= 2, '后半篇保障有配额上限，不会吃掉全部预算');
});

// ============ 18–23：诊断指标 ============

test('槽位分配：总量等于 maxChunks，空类别额度自动让给 lexical', () => {
  const full = allocateEvidenceSlots({ maxChunks: 12, hasSourceLocal: true, hasMustUse: true, hasEvidence: true });
  assert.equal(Object.values(full).reduce((a, b) => a + b, 0), 12);
  assert.deepEqual(full, { sourceLocal: 3, mustUse: 3, roleSpecific: 2, diverse: 2, lexical: 2 });

  const fallback = allocateEvidenceSlots({ maxChunks: 12, hasSourceLocal: false, hasMustUse: false, hasEvidence: false });
  assert.equal(fallback.sourceLocal, 0);
  assert.equal(fallback.mustUse, 0);
  assert.equal(Object.values(fallback).reduce((a, b) => a + b, 0), 12);

  const small = allocateEvidenceSlots({ maxChunks: 4, hasSourceLocal: true, hasMustUse: true, hasEvidence: true });
  assert.equal(Object.values(small).reduce((a, b) => a + b, 0), 4);
});

test('检索诊断：uniqueEvidencePerPaper / evidenceReuseRate / sameRoleOverlap', () => {
  const evidence = [
    { section: 'A', role: 'method', chunkIds: ['c1', 'c2', 'c3'], sourceSections: ['X'], sourceSectionMatch: { sectionIds: ['s1'] } },
    { section: 'B', role: 'method', chunkIds: ['c3', 'c4'], sourceSections: ['X'], sourceSectionMatch: { sectionIds: ['s1'] } },
    { section: 'C', role: 'results', chunkIds: ['c5'], sourceSections: ['自造小节'], sourceSectionMatch: { sectionIds: [] } },
  ];
  const diag = retrievalDiagnostics({ evidence, structure: null });
  assert.equal(diag.uniqueEvidencePerPaper, 5, 'c1..c5 共 5 个唯一 chunk');
  assert.equal(diag.evidenceReuseRate, 0.1667, '6 个槽位里 1 个重复');
  assert.equal(diag.sameRoleOverlap, 0.25, '两个 method 小节 Jaccard = 1/4');
  assert.equal(diag.sourceSectionHitRate, 0.6667, '3 节里 2 节请求了 sourceSections 且都对齐成功');
});

test('检索诊断：mustUseTermHitRate 看的是「选中的证据」，不是全文', () => {
  const structure = buildPaperStructure({ kind: 'tex', text: retrievalV2PaperText() });
  const withTerm = structure.chunks.find((c) => /label smoothing/.test(c.text));
  const other = structure.chunks.find((c) => /Introduction|Abstract/.test(c.sectionTitle));
  const evidence = [
    { section: 'A', role: 'ablation', chunkIds: [other.id], mustUseTerms: ['label smoothing', 'residual dropout'] },
    { section: 'B', role: 'ablation', chunkIds: [withTerm.id], mustUseTerms: ['label smoothing'] },
  ];
  const diag = retrievalDiagnostics({ evidence, structure });
  assert.equal(diag.mustUseTermsTotal, 3);
  assert.equal(diag.mustUseTermsHit, 1, '只有 B 节的 label smoothing 真的进了选中证据');
  assert.equal(diag.mustUseTermHitRate, 0.3333);
});

test('检索探针：只做诊断，能指出「源里有、但没进检索」的事实', () => {
  const structure = buildPaperStructure({ kind: 'tex', text: retrievalV2PaperText() });
  const labelChunk = structure.chunks.find((c) => /label smoothing/.test(c.text));
  const probes = retrievalProbeResults({
    probes: ['label smoothing', 'nonexistent-term-xyz'],
    structure,
    evidence: [{ section: '消融节', role: 'ablation', chunkIds: [labelChunk.id] }],
  });
  assert.equal(probes.length, 2);
  const hit = probes.find((p) => p.term === 'label smoothing');
  assert.equal(hit.hit, true);
  assert.ok(hit.retrievedChunks >= 1);
  assert.equal(hit.examples[0].chunkId, labelChunk.id);
  assert.deepEqual(hit.examples[0].usedBy, ['消融节']);
  assert.equal(hit.examples[0].sourceSection, labelChunk.sectionTitle);
  const miss = probes.find((p) => p.term === 'nonexistent-term-xyz');
  assert.equal(miss.hit, false);
  assert.equal(miss.sourceChunks, 0);
});

test('默认探针表覆盖 v2 验收里点名的关键事实', () => {
  assert.ok(DEFAULT_RETRIEVAL_PROBES['1706.03762'].includes('label smoothing'));
  assert.ok(DEFAULT_RETRIEVAL_PROBES['1706.03762'].includes('residual dropout'));
  assert.ok(DEFAULT_RETRIEVAL_PROBES['2406.09246'].includes('partial success'));
  assert.ok(DEFAULT_RETRIEVAL_PROBES['2501.12948'].includes('AIME'));
  assert.ok(DEFAULT_RETRIEVAL_PROBES['2501.12948'].includes('Unsuccessful'));
  assert.ok(DEFAULT_RETRIEVAL_PROBES['2409.12191'].includes('min_pixels'));
  assert.ok(DEFAULT_RETRIEVAL_PROBES['2409.12191'].includes('16384'));
});

// ============ Plan schema ============

test('Plan schema：新格式解析出 sourceSections / mustUseTerms / role', () => {
  const plan = parseDeepReadPlan(
    [
      '## 彻底扔掉循环｜注意力就是全部｜sections: Model Architecture; Scaled Dot-Product Attention｜terms: self-attention; Table 3｜role: method',
      '## 消融说明了什么｜看消融怎么改变结论｜sections: Ablation Study｜terms: label smoothing｜role: ablation',
      '## 失效边界｜哪些条件下失效｜sections: Limitations｜role: limitation',
    ].join('\n'),
  );
  assert.equal(plan.length, 3);
  assert.equal(plan[0].title, '彻底扔掉循环');
  assert.equal(plan[0].note, '注意力就是全部');
  assert.equal(plan[0].role, 'method');
  assert.deepEqual(plan[0].sourceSections, ['Model Architecture', 'Scaled Dot-Product Attention']);
  assert.deepEqual(plan[0].mustUseTerms, ['self-attention', 'Table 3']);
  assert.equal(plan[1].role, 'ablation');
  assert.deepEqual(plan[2].sourceSections, ['Limitations']);
  assert.deepEqual(plan[2].mustUseTerms, []);
});

test('Plan schema：中文键名与旧格式都兼容', () => {
  const zh = parseDeepReadPlan('## 主结果｜看数字｜原文小节: Experiments; Ablation Study｜术语: BLEU; Table 2｜角色: 结果');
  assert.deepEqual(zh[0].sourceSections, ['Experiments', 'Ablation Study']);
  assert.deepEqual(zh[0].mustUseTerms, ['BLEU', 'Table 2']);
  assert.equal(zh[0].role, 'results');

  const legacy = parseDeepReadPlan('## 为什么值得读｜讲背景与问题');
  assert.equal(legacy[0].title, '为什么值得读');
  assert.equal(legacy[0].note, '讲背景与问题');
  assert.equal(legacy[0].role, '');
  assert.deepEqual(legacy[0].sourceSections, []);
  assert.deepEqual(legacy[0].mustUseTerms, []);

  for (const item of defaultDeepReadPlan()) {
    assert.ok(item.role, '默认大纲也应带 role');
    assert.deepEqual(item.sourceSections, []);
    assert.deepEqual(item.mustUseTerms, []);
  }
});

test('旧计划（无 sourceSections/mustUseTerms）仍然正常工作', () => {
  const { structure, index } = setup();
  const r = retrieveForSection({
    structure,
    section: { title: '核心机制：状态更新怎么从输入走到输出', note: '机制 公式' },
    sourceIndex: index,
    budgetChars: 6000,
    maxChunks: 12,
  });
  assert.equal(r.roles, 'method');
  assert.equal(r.sourceSectionMatch.status, 'unmatched');
  assert.deepEqual(r.sourceSectionMatch.requested, []);
  assert.ok(r.evidence.length > 0, '没有 sourceSections 也要能照常检索');
  assert.ok(r.slots.lexical > 0, '空类别额度应让给 lexical');
});
