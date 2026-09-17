import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditDraft,
  auditSummary,
  extractNumberTokens,
  formulaOverlap,
  pickSectionForRole,
  replaceSection,
  splitMarkdownSections,
} from '../src/deepread/audit.js';
import { buildPaperStructure } from '../src/deepread/chunker.js';
import { fallbackResearchMap } from '../src/deepread/researchMap.js';
import { longPaperText } from './fixtures.js';

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
