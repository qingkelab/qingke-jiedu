import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditDraft,
  auditSummary,
  extractNumberTokens,
  formulaOverlap,
  matchNumberToken,
  normalizeNumberToken,
  numberUnit,
  numberValue,
  pickSectionForRole,
  replaceSection,
  splitMarkdownSections,
} from '../src/deepread/audit.js';
import { buildPaperStructure } from '../src/deepread/chunker.js';
import { fallbackResearchMap } from '../src/deepread/researchMap.js';
import { longPaperText, reliabilityPaperText } from './fixtures.js';

function setup(markdown) {
  const structure = buildPaperStructure({ kind: 'tex', text: longPaperText() });
  const figures = [{ num: 1, caption: 'LoopFormer 整体架构：循环状态更新与窗口注意力' }];
  const { map } = fallbackResearchMap({ structure, figures, source: { title: 'LoopFormer' } });
  return { structure, figures, map, audit: auditDraft({ markdown, structure, researchMap: map, figures, source: { title: 'LoopFormer' } }) };
}

const GOOD = `# LoopFormer

## 为什么长上下文需要循环状态

问题在于注意力开销。请看（图1）。

## 状态更新怎么从输入走到输出

状态更新算子是 $h_t = \\alpha \\odot h_{t-1} + (1-\\alpha) \\odot W e_t$，其中 alpha 是门控。

## 41.8 BLEU 与消融说明了什么

WMT14 上 BLEU 41.8，去掉循环状态后掉到 39.1，显存 18.6 GB。

## 只在文本模态验证

局限是只在文本模态验证，窗口大小需要按任务调参。
`;

test('数字审计：终稿里的数字能在原文定位', () => {
  const { audit } = setup(GOOD);
  const check = audit.checks.find((c) => c.name === 'numbers');
  assert.equal(check.status, 'pass', `数字审计应通过：${JSON.stringify(check)}`);
  assert.ok(audit.stats.numbers >= 3);
});

test('数字审计：编造的数字被抓出来并定位到小节', () => {
  const bad = GOOD.replace('BLEU 41.8', 'BLEU 47.9');
  const { audit } = setup(bad);
  const check = audit.checks.find((c) => c.name === 'numbers');
  assert.notEqual(check.status, 'pass', '编造数字应被发现');
  assert.ok(check.missing.includes('47.9'), `缺失列表应含 47.9：${JSON.stringify(check.missing)}`);
  assert.ok(audit.repairTargets.some((t) => /41\.8 BLEU|消融/.test(t.heading)), '应定位到出问题的小节');
});

test('覆盖率审计：缺少消融与局限会被标记，并给出定点修复建议', () => {
  const bad = `# LoopFormer

## 为什么值得读

这篇论文提出 LoopFormer，BLEU 41.8。
`;
  const { audit } = setup(bad);
  const abla = audit.checks.find((c) => c.name === 'ablation');
  const lim = audit.checks.find((c) => c.name === 'limitation');
  assert.equal(abla.status, 'fail');
  assert.equal(lim.status, 'fail');
  assert.ok(audit.serious.length >= 2);
  assert.ok(audit.repairTargets.length >= 1, '应给出修复目标小节');
  assert.match(auditSummary(audit), /未通过/);
});

test('公式审计：丢失公式 / 改写公式都会被标记', () => {
  const noFormula = GOOD.replace('$h_t = \\alpha \\odot h_{t-1} + (1-\\alpha) \\odot W e_t$', '（公式见原文）');
  const a1 = setup(noFormula).audit;
  assert.equal(a1.checks.find((c) => c.name === 'formula').status, 'fail');

  const rewritten = GOOD.replace(
    '$h_t = \\alpha \\odot h_{t-1} + (1-\\alpha) \\odot W e_t$',
    '$h_t = 0.5 \\cdot h_{t-1} + 3x$',
  );
  const a2 = setup(rewritten).audit;
  assert.equal(a2.checks.find((c) => c.name === 'formula').status, 'warn', '被改写的公式应给出提示');
});

test('图审计：图号越界 / 与图注不符会被标记', () => {
  const bad = GOOD.replace('（图1）', '（图7）');
  const { audit } = setup(bad);
  const fig = audit.checks.find((c) => c.name === 'figures');
  assert.equal(fig.status, 'fail');
  assert.ok(fig.badRefs.includes(7));

  const mismatch = GOOD.replace(
    '问题在于注意力开销。请看（图1）。',
    '这段讲数据集与评测协议，请看（图1）。',
  );
  const a2 = setup(mismatch).audit;
  assert.ok(
    a2.issues.some((i) => i.check === 'figures' && /不符/.test(i.detail)),
    `应报告图文错配：${JSON.stringify(a2.issues)}`,
  );
});

test('主结果覆盖：缺关键数字时给出修复提示', () => {
  const bad = GOOD.replace('41.8 BLEU 与消融说明了什么', '关键结果与消融说明了什么').replace(
    'WMT14 上 BLEU 41.8，去掉循环状态后掉到 39.1，显存 18.6 GB。',
    '结果很好，模型更快。',
  );
  const { audit } = setup(bad);
  const main = audit.checks.find((c) => c.name === 'main_result');
  assert.equal(main.status, 'fail');
  assert.ok(audit.repairTargets.some((t) => t.hints.some((h) => /主要结果/.test(h))));
});

test('审计对异常输入不抛错', () => {
  const structure = buildPaperStructure({ kind: 'tex', text: longPaperText() });
  const audit = auditDraft({ markdown: '', structure, researchMap: null, figures: null });
  assert.ok(Array.isArray(audit.checks));
  assert.ok(Array.isArray(audit.issues));
  // 空稿只允许「公式缺失」这类事实性失败，不应出现其它崩溃式问题
  assert.ok(audit.serious.every((i) => i.check === 'formula'));
});

test('小节拆分与定点替换只动目标小节', () => {
  const sections = splitMarkdownSections(GOOD);
  assert.ok(sections.length >= 4);
  const patched = replaceSection(GOOD, '41.8 BLEU 与消融说明了什么', '## 41.8 BLEU 与消融说明了什么\n\n修订后的内容 BLEU 41.8。');
  assert.match(patched, /修订后的内容/);
  assert.match(patched, /局限是只在文本模态验证/, '其它小节保持不变');
  assert.equal(replaceSection(GOOD, '不存在的小节', 'x'), null);
});

test('辅助函数：数字抽取与公式相似度', () => {
  const nums = extractNumberTokens('提升至 73.2%，比基线高 6.4 个百分点，训练 3.5 天，2026 年发表');
  assert.ok(nums.includes('73.2%'));
  assert.ok(nums.includes('6.4'));
  assert.ok(!nums.includes('2026'), '年份不算实验数字');
  assert.equal(formulaOverlap('a = b + c', 'a = b + c'), 1);
  assert.ok(formulaOverlap('h_t = \\alpha h_{t-1}', 'h_t = \\alpha h_{t-1} + \\beta x') > 0.5);
  assert.ok(formulaOverlap('x = 1', 'y = \\sum_i z_i') < 0.4);
});

test('pickSectionForRole 能定位结果/局限/方法小节', () => {
  assert.equal(pickSectionForRole(GOOD, 'results'), '41.8 BLEU 与消融说明了什么');
  assert.equal(pickSectionForRole(GOOD, 'limitation'), '只在文本模态验证');
  assert.equal(pickSectionForRole(GOOD, 'method'), '状态更新怎么从输入走到输出');
});

// ============ 数字格式归一化（表格展平 / 千分位 / 尾零） ============

test('数字归一化：只做有明确规则的格式归一化', () => {
  assert.equal(normalizeNumberToken('01.30%'), '1.3%');
  assert.equal(normalizeNumberToken('05.19%'), '5.19%');
  assert.equal(normalizeNumberToken('4,200'), '4200');
  assert.equal(normalizeNumberToken('41.80'), '41.8');
  assert.equal(normalizeNumberToken('41.8 %'), '41.8%');
  assert.equal(normalizeNumberToken('10 ×'), '10x');
  assert.equal(normalizeNumberToken('\u22121.2'), '-1.2');
  assert.equal(normalizeNumberToken('0.80'), '0.8');
  assert.equal(normalizeNumberToken('0.00'), '0');
  // 不越界：不要把「0.8」当成「8」，也不要把「10.4」和「1.04」混为一谈
  assert.equal(normalizeNumberToken('0.8'), '0.8');
  assert.notEqual(normalizeNumberToken('10.4'), normalizeNumberToken('1.04'));
  assert.equal(numberValue('01.30%'), 1.3);
  assert.equal(numberUnit('01.30%'), '%');
  assert.equal(numberUnit('4200'), '');
});

test('数字匹配：先精确，再归一化，最后才是数值近似', () => {
  const index = {
    exact: new Map([['41.8', 'c1']]),
    normalized: new Map([['1.3%', 'c2'], ['4200', 'c3']]),
    numeric: new Map([[1.3, 'c2'], [4200, 'c3']]),
  };
  assert.equal(matchNumberToken('41.8', index).method, 'exact');
  assert.equal(matchNumberToken('1.30%', index).method, 'normalized', '01.30% / 1.3% / 1.30% 归一化后等价');
  assert.equal(matchNumberToken('4,200', index).method, 'normalized');
  assert.equal(matchNumberToken('4200%', index).method, 'approximate', '数值相同、单位写法不同 → 近似');
  assert.equal(matchNumberToken('47.9', index), null, '查不到就是查不到（编造数字仍会被抓）');
});

test('表格展平、千分位与尾零不再被误判成「原文查不到」', () => {
  const text = reliabilityPaperText();
  const structure = buildPaperStructure({ kind: 'tex', text });
  const { map } = fallbackResearchMap({ structure, source: { title: 'Atlas' } });
  // 原文表格里是 01.30% / 05.19%（列粘连），终稿写 1.30% / 5.19%
  const audit = auditDraft({
    markdown: '## 主结果\n\nToolBench 上 1.30% 与 5.19% 的两档结果，成功率 52.4%。',
    structure,
    researchMap: map,
    figures: [],
    researchMapMeta: { status: 'model_success', source: 'model' },
  });
  const check = audit.checks.find((c) => c.name === 'numbers');
  assert.equal(check.status, 'pass', `归一化后应通过：${JSON.stringify(check)}`);
  assert.ok(check.methods.normalized >= 1, '应通过归一化匹配命中表格数字');
  assert.ok(check.matched.some((m) => m.value === '1.30%' && m.method === 'normalized'));
  assert.ok(audit.stats.numberMatchMethods.normalized >= 1);
});

// ============ 上游地图可信度 ============

test('地图被截断时 audit 给出 research_map_unavailable，且结论降级为 passed_with_warning', () => {
  const structure = buildPaperStructure({ kind: 'tex', text: longPaperText() });
  const { map } = fallbackResearchMap({ structure, source: { title: 'LoopFormer' } });
  const audit = auditDraft({
    markdown: GOOD,
    structure,
    researchMap: map,
    figures: [{ num: 1, caption: 'LoopFormer 整体架构：循环状态更新与窗口注意力' }],
    researchMapMeta: { status: 'model_truncated', source: 'local', finishReason: 'length', fallbackReason: '模型输出被截断（finish_reason=length）' },
  });
  assert.equal(audit.researchMapSource, 'local');
  assert.equal(audit.researchMapStatus, 'model_truncated');
  assert.ok(audit.warnings.some((w) => w.code === 'research_map_unavailable'));
  assert.match(audit.warnings.find((w) => w.code === 'research_map_unavailable').detail, /不能当作高可信通过/);
  assert.equal(audit.verdict, 'passed_with_warning', '上游不可信时不能算「高可信通过」');
  assert.equal(audit.serious.length, 0, '审计本身仍然照跑（没有事实性失败）');
  assert.match(auditSummary(audit), /可信度/);
});

test('地图来自本地兜底时 audit 标记 research_map_local_fallback', () => {
  const structure = buildPaperStructure({ kind: 'tex', text: longPaperText() });
  const { map } = fallbackResearchMap({ structure, source: { title: 'LoopFormer' } });
  const audit = auditDraft({
    markdown: GOOD,
    structure,
    researchMap: map,
    figures: [{ num: 1, caption: 'LoopFormer 整体架构：循环状态更新与窗口注意力' }],
    researchMapMeta: { status: 'fallback', source: 'local' },
  });
  assert.ok(audit.warnings.some((w) => w.code === 'research_map_local_fallback'));
  assert.equal(audit.verdict, 'passed_with_warning');

  // 模型地图生效时：没有告警、结论是干净的 passed
  const ok = auditDraft({
    markdown: GOOD.replace('请看（图1）。', '请看正文。'),
    structure,
    researchMap: map,
    figures: [],
    researchMapMeta: { status: 'model_success', source: 'model' },
  });
  assert.deepEqual(ok.warnings, []);
  assert.equal(ok.issues.length, 0);
  assert.equal(ok.verdict, 'passed');
});

test('缺少地图 / 缺少地图元数据都会被标注，且审计不关闭', () => {
  const structure = buildPaperStructure({ kind: 'tex', text: longPaperText() });
  const noMap = auditDraft({ markdown: GOOD, structure, researchMap: null, figures: [] });
  assert.ok(noMap.warnings.some((w) => w.code === 'research_map_unavailable'));
  assert.ok(noMap.checks.length >= 5, '没有地图也要照跑确定性检查');

  const { map } = fallbackResearchMap({ structure, source: {} });
  const noMeta = auditDraft({ markdown: GOOD, structure, researchMap: map, figures: [] });
  assert.ok(noMeta.warnings.some((w) => w.code === 'research_map_source_unknown'));

  // 事实性问题依旧判 failed（上游告警不能掩盖失败）
  const bad = auditDraft({ markdown: GOOD.replace('BLEU 41.8', 'BLEU 47.9'), structure, researchMap: map, figures: [], researchMapMeta: { status: 'fallback', source: 'local' } });
  assert.equal(bad.verdict, 'failed');
});
