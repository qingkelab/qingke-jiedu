// 终稿审校的预算与「provider 不吃大 max_tokens」时的降级重试。
// 全部用假 fetch，不发真实网络请求；本文件需要审校开启，所以在导入 config 之前设好环境变量。
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test-key';
process.env.QUALITY_REVIEW = '1';
process.env.DEEPREAD_STRUCTURED = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { longPaperText } from './fixtures.js';

const { createProvider } = await import('../src/ai/index.js');

const DEEP_SOURCE = {
  type: 'pdf',
  kind: 'tex',
  title: 'LoopFormer',
  byline: 'Yifan Zhang',
  url: 'https://arxiv.org/abs/2601.00001',
  text: longPaperText(),
};

/** 假 chat/completions：审校请求按 max_tokens 决定「成功」还是「HTTP 400」。 */
function installFakeFetch({ reviewBudgetLimit = Infinity, onReview } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    const messages = body.messages || [];
    const sys = messages[0]?.content || '';
    const user = messages[messages.length - 1]?.content || '';
    calls.push({ sys, user, maxTokens: body.max_tokens });

    const isReview = /你是严格审校编辑/.test(sys);
    if (isReview) {
      if (onReview) {
        const override = onReview({ maxTokens: body.max_tokens, user });
        if (override) return respond(override.content ?? override, override);
      }
      if (body.max_tokens > reviewBudgetLimit) {
        // 模拟「provider 对 max_tokens 有硬上限」
        return {
          ok: false,
          status: 400,
          async text() {
            return '{"error":{"message":"max_tokens is too large: max_tokens"}}';
          },
          async json() {
            return {};
          },
        };
      }
      // 审校结果比原稿略长，且小节数不变 → 护栏应接受
      const draft = user.slice(user.indexOf('# LoopFormer'));
      return respond(`${draft}\n\n（审校补充：以上结论建立在单篇论文的证据上。）\n`);
    }

    return respond(stageResponse(sys, user));
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function respond(content) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message: { content, reasoning: '' }, finish_reason: 'stop' }] };
    },
    async text() {
      return content;
    },
  };
}

function stageResponse(sys, user) {
  if (/论文地图 JSON/.test(user)) {
    return JSON.stringify({
      problem: '长上下文注意力开销',
      key_claims: [{ text: '循环状态可替代全局注意力', chunkIds: ['c1'] }],
      main_results: [{ text: 'BLEU 41.8' }],
      ablations: [{ text: '去掉循环状态掉到 39.1' }],
      limitations: [{ text: '只在文本模态验证' }],
      evidence: [{ text: '41.8 BLEU', chunkIds: ['c1'] }],
    });
  }
  if (/请给出大纲/.test(user)) {
    return ['## 为什么值得读这篇论文？｜导语', '## 状态更新怎么从输入走到输出｜机制', '## 实验结果与消融｜证据', '## 失效边界｜局限'].join('\n');
  }
  if (/请撰写第/.test(user)) {
    const m = sys.match(/作为本节的 Markdown H2）：##\s*(.+)/);
    const title = m ? m[1].trim() : '小节';
    return `## ${title}\n\nBLEU 41.8，去掉循环状态掉到 39.1，显存 18.6 GB，只在文本模态验证。\n`;
  }
  if (/只重写这一节|修订编辑/.test(`${sys}\n${user}`)) {
    return '## 实验结果与消融\n\n修订：BLEU 41.8，去掉循环状态掉到 39.1。\n';
  }
  return '';
}

test('终稿审校：预算按「正文 + reasoning 余量」给足，且拿到的稿子被护栏接受', async () => {
  const fake = installFakeFetch();
  try {
    const provider = createProvider('deepseek');
    const res = await provider.deepRead({ source: DEEP_SOURCE, figures: [], onProgress: () => {} });
    const reviewCall = fake.calls.find((c) => /你是严格审校编辑/.test(c.sys));
    assert.ok(reviewCall, '应该真的调用了审校');
    assert.ok(reviewCall.maxTokens >= 30000, `审校预算要留出 reasoning 余量（实际 ${reviewCall.maxTokens}）`);
    assert.equal(res.meta.stages.review.status, 'model_success');
    assert.equal(res.meta.stages.review.parsed, true);
    assert.equal(res.meta.stages.review.smallerBudgetRetry, false);
    assert.equal(res.meta.stages.review.budgetTokens, reviewCall.maxTokens);
    assert.match(res.markdown, /审校补充/, '审校结果应被采纳');
  } finally {
    fake.restore();
  }
});

test('终稿审校：provider 拒绝大 max_tokens（HTTP 400）时退一档重试，而不是让审校变成死阶段', async () => {
  const fake = installFakeFetch({ reviewBudgetLimit: 20000 });
  try {
    const provider = createProvider('deepseek');
    const res = await provider.deepRead({ source: DEEP_SOURCE, figures: [], onProgress: () => {} });
    const reviewCalls = fake.calls.filter((c) => /你是严格审校编辑/.test(c.sys));
    assert.equal(reviewCalls.length, 2, '应先试大预算、被拒后退一档重试');
    assert.ok(reviewCalls[0].maxTokens > reviewCalls[1].maxTokens);
    assert.ok(reviewCalls[1].maxTokens <= 16000, `退档用保守预算（旧行为，实际 ${reviewCalls[1].maxTokens}）`);
    assert.equal(res.meta.stages.review.status, 'model_success');
    assert.equal(res.meta.stages.review.smallerBudgetRetry, true);
    assert.match(res.markdown, /审校补充/);
  } finally {
    fake.restore();
  }
});

test('终稿审校：返回空稿时护栏丢弃并记为 warn（保留原稿，不静默）', async () => {
  const fake = installFakeFetch({ onReview: () => ({ content: '' }) });
  try {
    const provider = createProvider('deepseek');
    const res = await provider.deepRead({ source: DEEP_SOURCE, figures: [], onProgress: () => {} });
    assert.equal(res.meta.stages.review.status, 'warn');
    assert.match(res.meta.stages.review.reason, /护栏丢弃/);
    assert.match(res.meta.stages.review.reason, /空内容/);
    assert.match(res.markdown, /BLEU 41\.8/, '原稿必须保留');
    assert.equal(res.meta.stages.review.rawContentLength, 0);
  } finally {
    fake.restore();
  }
});
