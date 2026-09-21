// Plan Coverage v2：Evidence Requirements + Guaranteed Allocation + lifecycle 诊断。
// 全部确定性，不依赖真实 LLM。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaperStructure } from '../src/deepread/chunker.js';
import { buildSourceSectionIndex } from '../src/deepread/sourceSections.js';
import { buildCorpusIndex } from '../src/deepread/criticalFacts.js';
import {
  MAX_GUARANTEED_SLOTS,
  allocationModeOf,
  buildEvidenceRequirements,
  criticalityOf,
  packEvidenceRequirements,
  requirementCoverage,
  requiredChunksOf,
} from '../src/deepread/evidenceRequirements.js';
import { retrieveForSection } from '../src/deepread/retrieval.js';
import { retrievalProbeResults } from '../src/deepread/benchmark.js';

const PAPER = [
  '## Abstract\n我们提出 Atlas。',
  '## 1 Introduction\n长任务规划是瓶颈。',
  '## 2 Method\n规划器与执行器分离，失败后重新规划。',
  '## 3 Experiments\nTable 2: AIME 79.8, MATH-500 97.3, Codeforces 2029.',
  '## 4 Ablation Study\n去掉重规划后成功率掉到 46.1；label smoothing 0.1 让 BLEU 变差。',
  '## 5 Failure Cases\nfailure cases 集中在长任务上的 partial success，21% 来自不可恢复的编辑循环。',
  '## 6 Conclusion\nAtlas 是强基线，但 unsuccessful attempts 仍集中在并行工具任务。',
].join('\n\n');

function setup() {
  const structure = buildPaperStructure({ kind: 'tex', text: PAPER });
  const sourceIndex = buildSourceSectionIndex(structure);
  const corpus = buildCorpusIndex(structure);
  return { structure, sourceIndex, corpus };
}

const FACT = (over = {}) => ({
  id: 'cf-x',
  category: 'main_result',
  priority: 'high',
  claim: 'AIME 79.8',
  sourceSections: ['3 Experiments'],
  sourceSectionIds: [],
  mustUseTerms: ['AIME'],
  mustUseNumbers: [{ value: '79.8', term: 'AIME', chunkIds: [] }],
  chunkIds: [],
  retrievedChunkIds: [],
  writerSections: ['实验结果'],
  ...over,
});

function planOf({ sections = ['3 Experiments'], title = '实验结果', added = [] } = {}) {
  return [{ title, role: 'results', sourceSections: sections, sourceSectionsAddedByCoverage: added, mustUseTerms: [] }];
}

// ============ A. requirement construction ============

test('A1. high priority → guaranteed', () => {
  assert.equal(allocationModeOf({ priority: 'high', category: 'main_result' }), 'guaranteed');
  assert.equal(allocationModeOf({ priority: 'high', category: 'method' }), 'guaranteed');
});

test('A2. medium → preferred', () => {
  assert.equal(allocationModeOf({ priority: 'medium', category: 'method' }), 'opportunistic');
  assert.equal(allocationModeOf({ priority: 'medium', category: 'comparison' }), 'preferred');
  assert.equal(allocationModeOf({ priority: 'medium', category: 'ablation', mustUseNumbers: [{ value: '1' }] }), 'guaranteed');
});

test('A3. common topic → opportunistic', () => {
  assert.equal(allocationModeOf({ priority: 'medium', category: 'figure' }), 'opportunistic');
  assert.equal(allocationModeOf({ priority: 'medium', category: 'formula' }), 'opportunistic');
});

test('A4. buildEvidenceRequirements 产出 schema 字段', () => {
  const { structure, sourceIndex } = setup();
  const built = buildEvidenceRequirements({ plan: planOf(), sourceIndex, structure, facts: [FACT()] });
  assert.equal(built.requirements.length, 1);
  const r = built.requirements[0];
  for (const key of ['factId', 'priority', 'category', 'allocationMode', 'sourceSectionIds', 'requiredTerms', 'requiredNumbers', 'targetPlanSections', 'allocationReason']) {
    assert.ok(key in r, `requirement 缺少 ${key}`);
  }
  assert.equal(r.allocationMode, 'guaranteed');
  assert.ok(r.sourceSectionTitles.includes('3 Experiments'));
  assert.match(r.allocationReason, /high|关键/);
});

// ============ B. packing ============

test('B1. 多 fact 同 source section → 合成一个保障组（一份额度服务多条事实）', () => {
  const { structure, sourceIndex } = setup();
  const facts = [
    FACT({ id: 'cf-1', claim: 'AIME 79.8' }),
    FACT({ id: 'cf-2', claim: 'MATH-500 97.3', mustUseTerms: ['MATH-500'], mustUseNumbers: [{ value: '97.3', term: 'MATH-500' }] }),
    FACT({ id: 'cf-3', claim: 'Codeforces 2029', mustUseTerms: ['Codeforces'], mustUseNumbers: [{ value: '2029', term: 'Codeforces' }] }),
  ];
  const built = buildEvidenceRequirements({ plan: planOf(), sourceIndex, structure, facts });
  const packed = packEvidenceRequirements({ requirements: built.requirements });
  assert.equal(packed.groups.length, 1, '同一小节只应产生 1 个组');
  assert.deepEqual(packed.groups[0].factIds.sort(), ['cf-1', 'cf-2', 'cf-3']);
  assert.equal(packed.groups[0].allocationMode, 'guaranteed');
  assert.equal(packed.stats.guaranteedGroups, 1, '三个 fact 只吃 1 个保障额度');
});

test('B2. 多 fact 同 chunk：requiredChunks 会去重', () => {
  const { structure, sourceIndex } = setup();
  const facts = [
    FACT({ id: 'cf-1', claim: 'AIME 79.8' }),
    FACT({ id: 'cf-2', claim: 'MATH-500 97.3' }),
  ];
  const built = buildEvidenceRequirements({ plan: planOf(), sourceIndex, structure, facts });
  const packed = packEvidenceRequirements({ requirements: built.requirements });
  const chunks = packed.groups[0].requiredChunkIds;
  assert.equal(new Set(chunks).size, chunks.length, 'requiredChunks 不应重复');
});

test('B3. 4 个 benchmark 数字共用一个 source section', () => {
  const { structure, sourceIndex } = setup();
  const facts = ['79.8', '97.3', '2029', '46.1'].map((v, i) =>
    FACT({ id: `cf-${i + 1}`, claim: `指标 ${v}`, mustUseNumbers: [{ value: v, term: '', chunkIds: [] }], mustUseTerms: [] }),
  );
  const built = buildEvidenceRequirements({ plan: planOf(), sourceIndex, structure, facts });
  const packed = packEvidenceRequirements({ requirements: built.requirements });
  assert.equal(packed.groups.length, 1);
  assert.equal(packed.stats.guaranteedGroups, 1);
  assert.ok(packed.groups[0].requiredNumbers.length >= 3, JSON.stringify(packed.groups[0].requiredNumbers));
});

test('B4. guaranteed requirement 不会被普通 evidence 淘汰（分配在排序之前）', () => {
  const { structure, sourceIndex } = setup();
  const facts = [FACT({ id: 'cf-1', claim: 'AIME 79.8', mustUseNumbers: [{ value: '79.8', term: 'AIME' }] })];
  const built = buildEvidenceRequirements({ plan: planOf(), sourceIndex, structure, facts });
  const packed = packEvidenceRequirements({ requirements: built.requirements });
  const r = retrieveForSection({
    structure,
    section: {
      title: '实验结果',
      role: 'results',
      sourceSections: ['3 Experiments'],
      guaranteedAllocation: {
        sections: ['3 Experiments'],
        quota: MAX_GUARANTEED_SLOTS,
        facts: [{ id: 'cf-1', terms: ['AIME'], numbers: ['79.8'] }],
        requiredChunks: packed.groups[0].requiredChunkIds,
        overflow: [],
      },
    },
    sourceIndex,
    budgetChars: 1500,
    maxChunks: 3,
  });
  const text = r.evidence.map((e) => e.text).join('\n');
  assert.match(text, /79\.8/, '保障槽必须把承载 79.8 的 chunk 放进来');
  assert.ok(r.guaranteedSlots >= 1);
  assert.ok(r.evidence.some((e) => e.slot === 'guaranteed'));
  assert.ok(r.supportedFactIds.includes('cf-1'));
});

// ============ C. overflow ============

test('C1. guaranteed 超额度 → 显式记录 overflow，不静默丢弃', () => {
  const { structure, sourceIndex } = setup();
  const sections = ['1 Introduction', '2 Method', '3 Experiments', '4 Ablation Study', '5 Failure Cases', '6 Conclusion'];
  const facts = sections.map((sec, i) =>
    FACT({
      id: `cf-${i + 1}`,
      claim: `事实 ${i + 1}`,
      sourceSections: [sec],
      mustUseNumbers: [{ value: String(i + 1), term: '' }],
    }),
  );
  const built = buildEvidenceRequirements({ plan: planOf({ sections }), sourceIndex, structure, facts });
  const packed = packEvidenceRequirements({ requirements: built.requirements, maxGuaranteedSlots: 2 });
  assert.equal(packed.groups.length, 6, '6 个不同小节 = 6 个组');
  assert.ok(packed.stats.guaranteedGroups <= 2, `同一个写作小节最多 2 个保障组（实际 ${packed.stats.guaranteedGroups}）`);
  assert.ok(packed.stats.overflow > 0, '超额度必须记录');
  for (const o of packed.overflow) {
    assert.ok(o.sourceSection && o.reason && Array.isArray(o.factIds));
    assert.match(o.reason, /额度已满/);
  }
  // 被 overflow 的组仍在 groups 里（只是不再享受保障）
  assert.ok(packed.groups.length > packed.stats.guaranteedGroups);
});

test('C2. criticality 排序：事实更多 / 稀有数字更多的小节优先', () => {
  const base = { facts: [{ id: 'a', priority: 'high', category: 'main_result' }] };
  const more = { facts: [{ id: 'a', priority: 'high', category: 'main_result' }, { id: 'b', priority: 'high', category: 'ablation' }] };
  assert.ok(criticalityOf(more) > criticalityOf(base));
  assert.ok(criticalityOf(base, { numberCount: 3 }) > criticalityOf(base, { numberCount: 0 }));
});

// ============ D. plan ============

test('D1. plan 未请求 source section → 自动产生 evidence requirement（不新增 H2）', () => {
  const { structure, sourceIndex } = setup();
  const facts = [FACT({ id: 'cf-1', claim: 'unsuccessful attempts', sourceSections: ['6 Conclusion'] })];
  const plan = planOf({ sections: ['3 Experiments'] });
  const built = buildEvidenceRequirements({ plan, sourceIndex, structure, facts });
  assert.equal(built.additions.length, 1, '未被请求的小节应产生补入需求');
  assert.equal(built.additions[0].sourceSection, '6 Conclusion');
  assert.equal(built.additions[0].planSection, '实验结果');
  assert.equal(built.additions[0].reason, 'fact_source_section_not_requested');
  assert.equal(plan.length, 1, '不得新增文章小节');
  assert.equal(plan[0].sourceSections.length, 1, 'plan 本身不被这里改写（由调用方决定）');
});

test('D2. 覆盖度指标：critical / highPriority / factBacked', () => {
  const { structure, sourceIndex } = setup();
  const facts = [
    FACT({ id: 'cf-1', claim: 'AIME 79.8', sourceSections: ['3 Experiments'] }),
    FACT({ id: 'cf-2', claim: 'failure cases', category: 'failure', sourceSections: ['5 Failure Cases'] }),
  ];
  const plan = planOf({ sections: ['3 Experiments'], title: '实验结果' });
  const built = buildEvidenceRequirements({ plan, sourceIndex, structure, facts });
  const packed = packEvidenceRequirements({ requirements: built.requirements });
  const cov = requirementCoverage({ requirements: built.requirements, plan, packed });
  assert.equal(cov.criticalSourceSectionCoverage, 0.5, '2 个关键小节里只请求了 1 个');
  assert.equal(cov.factBackedSourceSectionCoverage, 0.5);
  assert.equal(cov.highPrioritySourceSectionCoverage, 0.5);
  assert.ok(cov.guaranteedSourceSections >= 2);
});

// ============ E. lifecycle 诊断 ============

test('E1. plan_did_not_request_section / slot_competition / term_not_in_source 可区分', () => {
  const { structure, sourceIndex } = setup();
  const evidence = [{ section: '实验结果', role: 'results', chunkIds: [structure.chunks.find((c) => /Experiments/.test(c.sectionTitle)).id] }];
  // 计划请求了 Failure Cases（所以不是「没请求」），但证据里只有 Experiments 的 chunk → slot competition
  const plan = [{ title: '实验结果', sourceSections: ['3 Experiments', '5 Failure Cases'], mustUseTerms: ['AIME'] }];
  const probes = retrievalProbeResults({
    probes: ['AIME', 'partial success', 'nonexistent-xyz'],
    structure,
    evidence,
    plan,
    markdown: '## 实验结果\n\nAIME 79.8。',
  });
  const aime = probes.find((p) => p.term === 'AIME');
  assert.equal(aime.status, 'covered');
  assert.equal(aime.reason, 'retrieved');
  assert.equal(aime.requested, true);
  const ps = probes.find((p) => p.term === 'partial success');
  assert.equal(ps.status, 'missing_evidence');
  assert.equal(ps.reason, 'slot_competition', '源里有、计划请求了、但没进检索');
  assert.ok(ps.retrievalCandidates > 0);
  assert.equal(ps.allocatedCandidates, 0);
  const none = probes.find((p) => p.term === 'nonexistent-xyz');
  assert.equal(none.reason, 'term_not_in_source');
});

test('E2. 未被请求的事实 → plan_did_not_request_section', () => {
  const { structure } = setup();
  const probes = retrievalProbeResults({
    probes: ['partial success'],
    structure,
    evidence: [],
    plan: [{ title: '实验结果', sourceSections: ['3 Experiments'], mustUseTerms: ['AIME'] }],
    markdown: '## 实验结果\n\nAIME 79.8。',
  });
  assert.equal(probes[0].status, 'missing_evidence');
  assert.equal(probes[0].reason, 'plan_did_not_request_section');
  assert.equal(probes[0].requested, false);
});

test('E3. 保障标记会出现在探针里（guaranteed flag）', () => {
  const { structure } = setup();
  const probes = retrievalProbeResults({
    probes: ['partial success'],
    structure,
    evidence: [{ section: '边界', role: 'limitation', chunkIds: structure.chunks.filter((c) => /Failure Cases/.test(c.sectionTitle)).map((c) => c.id) }],
    plan: [{ title: '边界', sourceSections: ['5 Failure Cases'], mustUseTerms: [] }],
    markdown: '## 边界\n\nfailure cases 与 partial success。',
    guaranteedSections: ['5 Failure Cases'],
  });
  assert.equal(probes[0].guaranteed, true);
  assert.equal(probes[0].status, 'covered');
});

test('E4. requiredChunksOf：只挑含针尖的 chunk', () => {
  const { structure } = setup();
  const expChunks = structure.chunks.filter((c) => /Experiments/.test(c.sectionTitle)).map((c) => c.id);
  const picked = requiredChunksOf({ chunkIds: expChunks, numbers: ['79.8'], structure });
  assert.equal(picked.length, 1);
  assert.match(structure.chunks.find((c) => c.id === picked[0]).text, /79\.8/);
});

// ============ F. 回归（四组 probe） ============

function runAllocation({ facts, plan, structure, sourceIndex }) {
  const built = buildEvidenceRequirements({ plan, sourceIndex, structure, facts });
  const packed = packEvidenceRequirements({ requirements: built.requirements, maxGuaranteedSlots: MAX_GUARANTEED_SLOTS });
  const used = [];
  for (const s of plan) {
    const alloc = packed.byPlanSection?.[s.title] || null;
    const groups = packed.guaranteedGroups.filter((g) => (g.targetPlanSections || []).includes(s.title));
    const allocFacts = built.requirements
      .filter((r) => (r.targetPlanSections || []).includes(s.title))
      .map((r) => ({ id: r.factId, terms: r.requiredTerms, numbers: r.requiredNumbers }));
    const guaranteedAllocation = alloc?.guaranteed?.length
      ? {
          sections: alloc.guaranteed,
          quota: MAX_GUARANTEED_SLOTS,
          facts: allocFacts,
          requiredChunks: [...new Set(groups.flatMap((g) => g.requiredChunkIds || []))],
          overflow: [],
        }
      : null;
    const r = retrieveForSection({
      structure,
      section: { ...s, guaranteedAllocation },
      sourceIndex,
      budgetChars: 4000,
      maxChunks: 12,
      previousSectionChunkIds: used,
    });
    used.push(...r.chunkIds);
  }
  return { built, packed, used: new Set(used) };
}

test('F1. 2501 场景：MATH-500 / 79.8 / 97.3 / 2029 进入 evidence（不再是 missing_evidence）', () => {
  const { structure, sourceIndex } = setup();
  const facts = [
    FACT({ id: 'cf-1', claim: 'AIME 79.8', mustUseTerms: ['AIME'], mustUseNumbers: [{ value: '79.8', term: 'AIME' }] }),
    FACT({ id: 'cf-2', claim: 'MATH-500 97.3', mustUseTerms: ['MATH-500'], mustUseNumbers: [{ value: '97.3', term: 'MATH-500' }] }),
    FACT({ id: 'cf-3', claim: 'Codeforces 2029', mustUseTerms: ['Codeforces'], mustUseNumbers: [{ value: '2029', term: 'Codeforces' }] }),
  ];
  facts[0].sourceSections = facts[1].sourceSections = facts[2].sourceSections = ['3 Experiments'];
  // 计划只请求了 Experiments；结论小节（unsuccessful）没请求 → 走 addition
  const plan = planOf({ sections: ['3 Experiments'], title: '实验结果' });
  const { used } = runAllocation({ facts, plan, structure, sourceIndex });
  for (const probe of ['MATH-500', '79.8', '97.3', '2029']) {
    const hit = structure.chunks.filter((c) => (c.sectionTitle + ' ' + c.text).toLowerCase().includes(probe.toLowerCase()) && used.has(c.id));
    assert.ok(hit.length, `${probe} 应进入 evidence`);
  }
});

test('F2. 2501 场景：Unsuccessful 所在小节未请求 → addition 后进入 evidence', () => {
  const { structure, sourceIndex } = setup();
  const facts = [FACT({ id: 'cf-9', claim: 'unsuccessful attempts 仍存在', category: 'limitation', sourceSections: ['6 Conclusion'] })];
  const plan = planOf({ sections: ['3 Experiments'], title: '实验结果' });
  const built = buildEvidenceRequirements({ plan, sourceIndex, structure, facts });
  assert.equal(built.additions.length, 1);
  // 应用 addition（与 index.js 相同的语义：只补 requirement 的 sourceSections）
  plan[0].sourceSections = [...plan[0].sourceSections, built.additions[0].sourceSection];
  plan[0].sourceSectionsAddedByRequirements = [built.additions[0].sourceSection];
  const { used } = runAllocation({ facts, plan, structure, sourceIndex });
  const hit = structure.chunks.filter((c) => (c.sectionTitle + ' ' + c.text).toLowerCase().includes('unsuccessful') && used.has(c.id));
  assert.ok(hit.length, 'Unsuccessful 应进入 evidence');
});

test('F3. 2406 场景：failure / partial success 进入 evidence', () => {
  const { structure, sourceIndex } = setup();
  const facts = [
    FACT({ id: 'cf-1', claim: 'failure cases 集中在长任务', category: 'failure', sourceSections: ['5 Failure Cases'], mustUseTerms: ['failure cases'], mustUseNumbers: [] }),
    FACT({ id: 'cf-2', claim: 'partial success 是主要失败模式', category: 'failure', sourceSections: ['5 Failure Cases'], mustUseTerms: ['partial success'], mustUseNumbers: [] }),
  ];
  const plan = [{ title: '边界与失败', role: 'limitation', sourceSections: ['5 Failure Cases'], sourceSectionsAddedByCoverage: ['5 Failure Cases'], mustUseTerms: [] }];
  const { used } = runAllocation({ facts, plan, structure, sourceIndex });
  for (const probe of ['failure cases', 'partial success']) {
    const hit = structure.chunks.filter((c) => (c.sectionTitle + ' ' + c.text).toLowerCase().includes(probe) && used.has(c.id));
    assert.ok(hit.length, `${probe} 应进入 evidence`);
  }
});

test('F4. 1706 场景：label smoothing / residual dropout / Regularization 不退化', () => {
  const { structure, sourceIndex } = setup();
  const facts = [FACT({ id: 'cf-1', claim: 'label smoothing 0.1', category: 'ablation', sourceSections: ['4 Ablation Study'], mustUseTerms: ['label smoothing'], mustUseNumbers: [{ value: '0.1', term: 'label smoothing' }] })];
  const plan = [{ title: '消融与配方', role: 'ablation', sourceSections: ['4 Ablation Study'], sourceSectionsAddedByCoverage: ['4 Ablation Study'], mustUseTerms: ['label smoothing'] }];
  const { used } = runAllocation({ facts, plan, structure, sourceIndex });
  for (const probe of ['label smoothing', 'Ablation Study']) {
    const hit = structure.chunks.filter((c) => (c.sectionTitle + ' ' + c.text).toLowerCase().includes(probe.toLowerCase()) && used.has(c.id));
    assert.ok(hit.length, `${probe} 应进入 evidence`);
  }
});

test('F5. guaranteed 与普通槽位共享预算：总 chunk 数不超过 maxChunks', () => {
  const { structure, sourceIndex } = setup();
  const facts = [FACT({ id: 'cf-1', claim: 'AIME 79.8', mustUseNumbers: [{ value: '79.8', term: 'AIME' }] })];
  const built = buildEvidenceRequirements({ plan: planOf(), sourceIndex, structure, facts });
  const packed = packEvidenceRequirements({ requirements: built.requirements });
  const r = retrieveForSection({
    structure,
    section: {
      title: '实验结果',
      role: 'results',
      sourceSections: ['3 Experiments'],
      guaranteedAllocation: { sections: ['3 Experiments'], quota: MAX_GUARANTEED_SLOTS, facts: [{ id: 'cf-1', terms: ['AIME'], numbers: ['79.8'] }], requiredChunks: packed.groups[0].requiredChunkIds, overflow: [] },
    },
    sourceIndex,
    budgetChars: 4200,
    maxChunks: 6,
  });
  assert.ok(r.chunkIds.length <= 6, `不得超过 maxChunks（实际 ${r.chunkIds.length}）`);
  assert.ok(r.chars <= 4200 * 1.5);
});
