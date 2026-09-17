import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptReview, countSections, reviewBudgetTokens } from '../src/deepread/review.js';

const DRAFT = `# 论文

## 第一节

内容一。

## 第二节

内容二。

## 第三节

内容三。
`;

test('token 预算随稿件长度增长且有上下限', () => {
  assert.equal(reviewBudgetTokens(''), 6000);
  assert.ok(reviewBudgetTokens('字'.repeat(20000)) > 20000, '长稿要更大的预算');
  assert.equal(reviewBudgetTokens('字'.repeat(100000)), 32000, '预算有上限');
});

test('正常审校结果被接受', () => {
  const reviewed = DRAFT.replace('内容二。', '内容二（修订）。');
  const verdict = acceptReview(DRAFT, reviewed);
  assert.equal(verdict.ok, true, verdict.reason);
});

test('被截断的审校稿被拒绝（真实事故：13k 字报告被砍到 7.9k）', () => {
  const truncated = DRAFT.slice(0, Math.floor(DRAFT.length * 0.6));
  const verdict = acceptReview(DRAFT, truncated);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /变短|小节/);
});

test('少了小节的审校稿被拒绝', () => {
  const missing = DRAFT.replace(/## 第三节[\s\S]*$/, '');
  const verdict = acceptReview(DRAFT, `${missing}${'补一点内容让长度接近原稿。'.repeat(6)}`);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /小节/);
});

test('停在下半句的审校稿被拒绝', () => {
  const half = `${DRAFT.slice(0, DRAFT.indexOf('内容三。'))}内容三写到一半，`;
  const verdict = acceptReview(DRAFT, half.padEnd(Math.ceil(DRAFT.length * 0.95), '。'));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /截断/);
});

test('空审校结果被拒绝，小节计数正确', () => {
  assert.equal(acceptReview(DRAFT, '').ok, false);
  assert.equal(countSections(DRAFT), 3);
});
