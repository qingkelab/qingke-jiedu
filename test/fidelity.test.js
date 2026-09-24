// 保真护栏：审校（review）可以让文字变顺，但不能改意思。
// 规则来源 humanizer-zh（2026-09-23）第 1 条约束：保留事实、否定、条件、时间、归因与确定程度。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fidelityDiff, protectedCounts, semanticCounts } from '../src/deepread/fidelity.js';
import { acceptReview } from '../src/deepread/review.js';
import { computeMetrics } from '../src/deepread/benchmark.js';

const DRAFT = [
  '# 论文解读',
  '',
  '## 结果',
  '',
  '论文称在 WMT 2014 英德上报告 28.4 BLEU，可能比基线高 2.0，尚未给出方差。',
  '',
  '![架构图](https://arxiv.org/html/x/fig1.png)',
  '',
  '代码里 `train.py` 用 $E=mc^2$ 这个式子。',
  '',
].join('\n');

test('protectedCounts：图片/链接/代码/公式/表格/标题都能数出来', () => {
  const md = [
    '## A',
    '',
    '![图](a.png) 与 [链接](https://x.test/y)',
    '',
    '```js',
    'const a = 1;',
    '```',
    '',
    '行内 `code`，公式 $E=mc^2$',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
  ].join('\n');
  const c = protectedCounts(md);
  assert.equal(c.images, 1);
  assert.equal(c.links, 1);
  assert.equal(c.codeBlocks, 1);
  assert.equal(c.inlineCode, 1);
  assert.equal(c.formulas, 1);
  assert.equal(c.tableRows, 3);
  assert.equal(c.h2, 1);
});

test('semanticCounts：否定只收无歧义写法，不误伤「不仅/未来」', () => {
  const clean = semanticCounts('不仅要做完，还要做对；未来会更好。');
  assert.equal(clean.negation, 0, `「不仅/未来」不该算否定：${clean.negation}`);
  const negated = semanticCounts('并未给出结果，尚未验证，也没有对照组。');
  assert.ok(negated.negation >= 3, `实际 ${negated.negation}`);
});

test('fidelityDiff：未改动的稿子没有违规', () => {
  const d = fidelityDiff(DRAFT, DRAFT);
  assert.equal(d.ok, true);
  assert.deepEqual(d.hard, []);
  assert.deepEqual(d.soft, []);
});

test('fidelityDiff：丢掉图片/公式/代码 = hard 违规', () => {
  const reviewed = DRAFT.replace(/^!\[架构图\].*$/m, '').replace(/\$E=mc\^2\$/, '').replace(/`train\.py`/, '');
  const d = fidelityDiff(DRAFT, reviewed);
  assert.equal(d.ok, false);
  const kinds = d.hard.map((h) => h.kind).sort();
  assert.deepEqual(kinds, ['formulas', 'images', 'inlineCode']);
});

test('fidelityDiff：把「可能」写成确定、丢掉否定 = soft 违规（记录但不否决）', () => {
  const reviewed = '## 结果\n\n论文称在 WMT 2014 英德上报告 28.4 BLEU，比基线高 2.0，给出了方差。\n\n' + DRAFT.split('\n').slice(5).join('\n');
  const d = fidelityDiff(DRAFT, reviewed);
  assert.equal(d.ok, true, 'soft 违规不否决');
  const kinds = d.soft.map((s) => s.kind);
  assert.ok(kinds.includes('hedge'), `应指出限定词变少：${JSON.stringify(d.soft)}`);
  assert.ok(kinds.includes('negation'), `应指出否定变少：${JSON.stringify(d.soft)}`);
});

test('fidelityDiff：归因标记减少会被点名（论文称 → 直接断言）', () => {
  const reviewed = '## 结果\n\n在 WMT 2014 英德上报告 28.4 BLEU，可能比基线高 2.0，尚未给出方差。';
  const d = fidelityDiff('## 结果\n\n论文称在 WMT 2014 英德上报告 28.4 BLEU，可能比基线高 2.0，尚未给出方差。', reviewed);
  assert.ok(d.soft.some((s) => s.kind === 'attribution'), JSON.stringify(d.soft));
});

test('acceptReview：丢受保护内容的审校稿被丢弃（保留原稿）', () => {
  const reviewed = `${DRAFT.replace(/^!\[架构图\].*$/m, '')}${'补足长度的说明文字。'.repeat(6)}`;
  const verdict = acceptReview(DRAFT, reviewed);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /受保护内容/);
  assert.equal(verdict.fidelity.hard[0].kind, 'images');
});

test('acceptReview：只丢限定词的审校稿放行，但把保真提示带回来', () => {
  const reviewed = `${DRAFT.replace('可能比基线高 2.0，尚未给出方差', '比基线高 2.0，给出了方差')}`;
  const verdict = acceptReview(DRAFT, reviewed);
  assert.equal(verdict.ok, true);
  assert.ok(verdict.fidelity.soft.length >= 1);
});

test('acceptReview：原有的截断/空内容判定不受影响', () => {
  assert.equal(acceptReview(DRAFT, '').ok, false);
  assert.equal(acceptReview(DRAFT, DRAFT.slice(0, 20)).ok, false);
});

// ============ benchmark：审校保真违规要能进指标 ============

const PAPER = {
  id: 'x',
  category: 'LLM',
  title: 't',
  url: 'u',
  expectedSections: [],
  expectedEvidence: [],
  expectedFigures: [],
  expectedFormulas: [],
  expectedAblations: [],
  expectedLimitations: [],
};

test('benchmark：保真违规数从 meta.stages.review 读出；没有审校阶段时为 null（不假装 0）', () => {
  const withReview = computeMetrics({
    paper: PAPER,
    structure: null,
    result: {
      markdown: '## R\n\n论文称 BLEU 41.8。',
      meta: {
        stages: {
          review: {
            stage: 'review',
            status: 'model_success',
            fidelity: { violations: 2, items: [{ kind: 'hedge', detail: '限定/推测表述 3 → 2' }] },
            factGuard: 'passed',
          },
        },
      },
      audit: null,
    },
  });
  assert.equal(withReview.metrics.reviewFidelityViolations, 2);
  assert.equal(withReview.detail.review.status, 'model_success');
  assert.equal(withReview.detail.review.factGuard, 'passed');

  const withoutReview = computeMetrics({
    paper: PAPER,
    structure: null,
    result: { markdown: '## R\n\n论文称 BLEU 41.8。', meta: {}, audit: null },
  });
  assert.equal(withoutReview.metrics.reviewFidelityViolations, null);
  assert.equal(withoutReview.detail.review, null);
});
