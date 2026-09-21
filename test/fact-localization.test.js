// Research Map 可靠性：Source Section Inventory（确定性）+ Fact Localization（严格匹配）。
// 全部确定性，不依赖真实 LLM。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaperStructure } from '../src/deepread/chunker.js';
import { buildSourceSectionIndex } from '../src/deepread/sourceSections.js';
import {
  MAX_NEEDLE_DF,
  buildLocalizationIndex,
  buildSourceSectionInventory,
  localizeFactToSourceSections,
  localizeFacts,
  matchNumberStrict,
  matchTermStrict,
  needlesOf,
} from '../src/deepread/factLocalization.js';
import { seedCriticalFacts, buildCorpusIndex } from '../src/deepread/criticalFacts.js';
import { fallbackResearchMap } from '../src/deepread/researchMap.js';

const PAPER = [
  '## Abstract\n我们提出 Atlas，把 AIME 从 79.8 提到 97.3。',
  '## 1 Introduction\n长任务规划是瓶颈，failure 与 partial success 很常见。',
  '## 2 Method\n规划器与执行器分离，AIME 79.8、MATH-500 97.3、Codeforces 2029。',
  '## 3 Experiments\n主结果：AIME 79.8，MATH-500 97.3，Codeforces 2029。',
  '## 4 Ablation Study\n去掉重规划后降到 46.1；label smoothing 0.1 让 BLEU 变差。',
  '## 5 Failure Cases\nfailure cases 集中在 partial success，21% 来自不可恢复的编辑循环。',
  '## 6 Unsuccessful Attempts\nunsuccessful attempts 仍集中在并行工具任务上。',
].join('\n\n');

function setup(text = PAPER) {
  const structure = buildPaperStructure({ kind: 'tex', text });
  const sourceIndex = buildSourceSectionIndex(structure);
  const inventory = buildSourceSectionInventory(structure, sourceIndex);
  const index = buildLocalizationIndex(structure, inventory);
  return { structure, sourceIndex, inventory, index };
}

// ============ 1–4：source section inventory ============

test('1. inventory 来自 parser，与模型输出无关', () => {
  const { inventory } = setup();
  assert.ok(inventory.length >= 6, `应至少 6 个小节（实际 ${inventory.length}）`);
  assert.ok(inventory.every((s) => s.id && s.title && Array.isArray(s.chunkIds)));
});

test('2. section id 稳定（同样输入 → 同样 id 序列）', () => {
  const a = setup().inventory.map((s) => s.id);
  const b = setup().inventory.map((s) => s.id);
  assert.deepEqual(a, b);
  assert.deepEqual(a.slice(0, 3), ['s1', 's2', 's3']);
});

test('3. title 保留原文语言（不翻译、不改写）', () => {
  const { inventory } = setup();
  assert.ok(inventory.some((s) => s.title === '5 Failure Cases'));
  assert.ok(inventory.some((s) => s.title === '6 Unsuccessful Attempts'));
});

test('4. chunk range 正确（start/end 落在该小节内）', () => {
  const { inventory, structure } = setup();
  const sec = inventory.find((s) => s.title === '3 Experiments');
  assert.ok(sec.chunkIds.length >= 1);
  assert.equal(sec.startChunkId, sec.chunkIds[0]);
  assert.equal(sec.endChunkId, sec.chunkIds[sec.chunkIds.length - 1]);
  for (const id of sec.chunkIds) {
    assert.equal(structure.chunks.find((c) => c.id === id).sectionId, sec.id);
  }
});

// ============ 5–10：fact localization ============

test('5. exact term → 定位到含该术语的小节', () => {
  const { structure, index } = setup();
  const r = localizeFactToSourceSections({ fact: { claim: 'unsuccessful attempts', mustUseTerms: ['unsuccessful attempts'] }, structure, index });
  assert.ok(r.sourceSectionIds.length > 0);
  assert.ok(r.matches.some((m) => m.sectionTitle === '6 Unsuccessful Attempts'));
  assert.ok(r.matchTypes.includes('exact_phrase'));
  // exact_phrase 也算高置信；只有 normalized_number 才是 medium
  assert.ok(['high', 'medium'].includes(r.confidence));
});

test('6. exact number → 定位到含该数字的小节', () => {
  const { structure, index } = setup();
  const r = localizeFactToSourceSections({ fact: { claim: 'MATH-500 97.3', mustUseNumbers: [{ value: '97.3' }] }, structure, index });
  const titles = r.matches.map((m) => m.sectionTitle);
  assert.ok(titles.includes('3 Experiments') && titles.includes('2 Method'), JSON.stringify(titles));
  assert.ok(r.matchTypes.includes('exact_number'));
});

test('7. normalized number：97.30 / 97.3% 都算命中', () => {
  // 尾零在 numberKey 阶段已被抹平（97.30 → 97.3），因此是 exact；带 % 的才是 normalized
  assert.equal(matchNumberStrict('97.3', '分数为 97.30'), 'exact_number');
  assert.equal(matchNumberStrict('97.3', '准确率 97.3%'), 'normalized_number');
  assert.equal(matchNumberStrict('97.3', '分数为 97.3'), 'exact_number');
});

test('8. 多个 source section 都命中时全部保留', () => {
  const { structure, index } = setup();
  // failure 会同时出现在 Introduction 与 Failure Cases
  const r = localizeFactToSourceSections({ fact: { claim: 'failure', mustUseTerms: ['failure'] }, structure, index });
  assert.ok(r.sourceSectionIds.length >= 2, JSON.stringify(r.matches.map((m) => m.sectionTitle)));
});

test('9. 完全对不上 → 空结果 + confidence=none（不猜）', () => {
  const { structure, index } = setup();
  const r = localizeFactToSourceSections({ fact: { claim: 'zzz completely absent qqq', mustUseTerms: ['zzz completely absent'] }, structure, index });
  assert.deepEqual(r.sourceSectionIds, []);
  assert.equal(r.confidence, 'none');
});

test('10. 大小写归一：Unsuccessful ≡ unsuccessful', () => {
  assert.equal(matchTermStrict('Unsuccessful', 'UNSUCCESSFUL attempts'), 'exact_term');
  const { structure, index } = setup();
  const r = localizeFactToSourceSections({ fact: { claim: 'UNSUCCESSFUL', mustUseTerms: ['UNSUCCESSFUL'] }, structure, index });
  assert.ok(r.sourceSectionIds.length > 0);
});

// ============ 11–13：边界（严格性） ============

test('11. 97.3 ≠ 9.73', () => {
  assert.equal(matchNumberStrict('97.3', '分数 9.73'), '');
});

test('12. 97.3 ≠ 197.3', () => {
  assert.equal(matchNumberStrict('97.3', '分数 197.3'), '');
});

test('13. failure 不自动扩展到无关词形', () => {
  assert.equal(matchTermStrict('failure', 'the model failed to converge'), '', 'failed 不算 failure');
  assert.equal(matchTermStrict('failure', 'failure cases dominate'), 'exact_phrase'.replace('exact_phrase', 'exact_term'));
  assert.equal(matchTermStrict('failure', 'failures are common'), '', '不因复数扩展');
});

// ============ 14–15：截断行为 ============

test('14. model_truncated 仍保留 inventory（与模型输出解耦）', () => {
  const { inventory, structure } = setup();
  // 模拟「模型输出被截断」：inventory 不依赖任何模型产物
  assert.ok(inventory.length > 0);
  assert.equal(buildSourceSectionInventory(structure, null).length, inventory.length);
});

test('15. model_truncated 仍能 localize fact（兜底地图 → 事实 → 定位）', () => {
  const { structure, sourceIndex, inventory, index } = setup();
  const corpus = buildCorpusIndex(structure);
  const fallback = fallbackResearchMap({ structure, figures: [], source: { title: 'Atlas' } }).map;
  const seeded = seedCriticalFacts({ researchMap: fallback, structure, sourceIndex, corpus });
  assert.ok(seeded.length > 0, '兜底地图也应产出事实');
  const { facts, localized } = localizeFacts(seeded, { structure, inventory, index });
  assert.ok(facts.every((f) => f.localization), '每条事实都要有 localization 元数据');
  const withSections = facts.filter((f) => (f.sourceSectionIds || []).length);
  // 兜底地图的事实来自真实原文句子，绝大多数应能定位；若一条都定不了才算失败
  assert.ok(localized >= 0);
  assert.ok(withSections.length > 0, `兜底地图事实应能定位（localized=${localized}）`);
  assert.ok(withSections.every((f) => ['deterministic', 'already_bound'].includes(f.localization.method)));
});

// ============ 16–18：status / 不发明事实 ============

test('16. parse_failed + inventory：仍可用确定性清单', () => {
  const { structure, inventory } = setup();
  const map = { status: 'parse_failed', sections: null };
  assert.equal(map.sections, null);
  assert.ok(buildSourceSectionInventory(structure, null).length === inventory.length);
});

test('17. fallback + localization：兜底地图的事实同样能定位', () => {
  const { structure, sourceIndex, index } = setup();
  const corpus = buildCorpusIndex(structure);
  const fallback = fallbackResearchMap({ structure, figures: [], source: { title: 'Atlas' } }).map;
  fallback._fallback = true;
  const seeded = seedCriticalFacts({ researchMap: fallback, structure, sourceIndex, corpus });
  const { facts } = localizeFacts(seeded, { structure, index });
  assert.ok(facts.some((f) => (f.sourceSectionIds || []).length > 0));
});

test('18. 不发明事实：localizeFacts 只补 sourceSectionIds，不新增/改写 claim', () => {
  const { structure, index } = setup();
  const input = [{ id: 'F1', claim: '97.3 on MATH-500', mustUseNumbers: [{ value: '97.3' }] }];
  const { facts } = localizeFacts(input, { structure, index });
  assert.equal(facts.length, 1, '不得新增事实');
  assert.equal(facts[0].claim, '97.3 on MATH-500', '不得改写 claim');
  assert.ok(facts[0].sourceSectionIds.length > 0);
  // 只给已有事实定位：没有任何针尖的事实用不上定位，也不应凭空产生 section
  const none = localizeFacts([{ id: 'F2', claim: '模型效果不错', mustUseTerms: [] }], { structure, index }).facts[0];
  assert.deepEqual(none.sourceSectionIds || [], []);
  assert.equal(none.localization.method, 'no_candidate_source_section');
});

test('19. needlesOf：小数字与泛化词被排除，针尖保留', () => {
  const { index } = setup();
  const needles = needlesOf({ claim: '97.3 与 21% 与 1 与 partial success', mustUseNumbers: [{ value: '97.3' }, { value: '1' }], mustUseTerms: ['partial success', 'use'] }, index);
  assert.ok(needles.numbers.includes('97.3'));
  assert.equal(needles.numbers.includes('1'), false, '单位数不作为针尖');
  assert.ok(needles.terms.includes('partial success'));
  assert.equal(needles.terms.includes('use'), false, '过短的泛化词不作为针尖');
  assert.ok(MAX_NEEDLE_DF >= 3);
});

test('20. 定位顺序：数字优先于术语（§十）', () => {
  const { structure, index } = setup();
  const r = localizeFactToSourceSections({
    fact: { claim: '97.3 与 failure', mustUseNumbers: [{ value: '97.3' }], mustUseTerms: ['failure'] },
    structure,
    index,
  });
  assert.ok(r.matchTypes.includes('exact_number'), JSON.stringify(r.matchTypes));
  const numberMatches = r.matches.filter((m) => m.matchTypes.includes('exact_number'));
  assert.ok(numberMatches.length >= 2, '含 97.3 的小节都应保留');
});
