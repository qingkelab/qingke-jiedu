// 覆盖「provider 兼容 + 普通 /api/copy 不受影响」：全部用假 fetch，不发真实网络请求。
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
process.env.QUALITY_REVIEW = '0'; // 关掉生成后审校，专注主链路断言

import test from 'node:test';
import assert from 'node:assert/strict';
import { longPaperText } from './fixtures.js';

// 注意：配置在模块加载时读取 .env / process.env，所以必须动态导入（静态 import 会被提升到赋值之前）
const { createProvider } = await import('../src/ai/index.js');
const { config } = await import('../src/config.js');

/** 假 chat/completions：按最后一条 user 消息决定返回内容，并记录所有请求。 */
function installFakeFetch({ onRequest } = {}) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    const messages = body.messages || [];
    const sys = messages[0]?.content || '';
    const user = messages[messages.length - 1]?.content || '';
    requests.push({ url: String(url), system: sys, user, maxTokens: body.max_tokens, model: body.model });
    const override = onRequest?.({ sys, user, messages, body });
    const content = override ?? respond(sys, user);
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content, reasoning: '' } }] };
      },
      async text() {
        return content;
      },
    };
  };
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function respond(sys, user) {
  // —— 图文解读（/api/copy）——
  if (/爆款标题/.test(sys) && /严格输出 JSON/.test(sys)) {
    return JSON.stringify({
      title: '循环状态替代全局注意力',
      titles: ['循环状态替代全局注意力', '省一半显存的长上下文', 'BLEU 41.8 的新架构'],
      copy: '## 一句话总结\n\n用循环状态替代全局注意力，显存降到 18.6 GB。\n\n## 背景\n\n…\n\n## 核心方法\n\n…\n\n## 结果\n\nBLEU 41.8。\n\n## 局限与结论\n\n只在文本模态验证。',
    });
  }
  // —— 深度解读各阶段 ——
  if (/论文地图 JSON/.test(user)) {
    return JSON.stringify({
      problem: '长上下文注意力开销',
      key_claims: [{ text: '循环状态可替代全局注意力', chunkIds: ['c1'] }],
      method_components: [{ text: '状态更新算子', chunkIds: ['c2'] }],
      equations: [{ text: 'h_t = \\alpha \\odot h_{t-1}', chunkIds: ['c2'] }],
      datasets: [{ text: 'WMT14' }],
      benchmarks: [{ text: 'BLEU' }],
      baselines: [{ text: 'Transformer-base' }],
      main_results: [{ text: 'BLEU 41.8' }],
      ablations: [{ text: '去掉循环状态掉到 39.1' }],
      limitations: [{ text: '只在文本模态验证' }],
      figures: [],
      evidence: [{ text: '41.8 BLEU', chunkIds: ['c3'] }],
    });
  }
  if (/请给出大纲/.test(user)) {
    return ['## 为什么长上下文需要循环状态｜导语', '## 状态更新怎么从输入走到输出｜机制', '## 41.8 BLEU 与消融说明了什么｜结果'].join('\n');
  }
  if (/请撰写第/.test(user)) {
    const m = sys.match(/作为本节的 Markdown H2）：##\s*(.+)/);
    return `## ${m ? m[1].trim() : '小节'}\n\n机制：输入 $h_t = \\alpha \\odot h_{t-1}$，输出是更新后的状态。结果 BLEU 41.8，消融掉到 39.1，只在文本模态验证。`;
  }
  if (/只重写这一节|修订编辑/.test(`${sys}\n${user}`)) {
    return '## 关键结果与消融\n\n修订：BLEU 41.8，去掉循环状态掉到 39.1。';
  }
  // —— 旧流程：整篇一次生成（回退路径）——
  if (/直接输出 Markdown 报告/.test(sys)) {
    return [
      '# LoopFormer',
      '',
      '## 为什么长上下文需要循环状态',
      '',
      '问题在于注意力开销。',
      '',
      '## 状态更新怎么从输入走到输出',
      '',
      '输入是上一时刻状态，输出是更新后的状态，公式 $h_t = \\alpha \\odot h_{t-1}$。',
      '',
      '## 41.8 BLEU 与消融说明了什么',
      '',
      'WMT14 上 BLEU 41.8，去掉循环状态掉到 39.1。',
      '',
      '## 边界与结论',
      '',
      '局限是只在文本模态验证。',
    ].join('\n');
  }
  return '';
}

function deepSource() {
  return {
    kind: 'tex',
    title: 'LoopFormer',
    byline: 'Yifan Zhang',
    date: '2026-09',
    url: 'https://arxiv.org/abs/2601.00001',
    text: longPaperText(),
    terms: ['LoopFormer', 'BLEU'],
  };
}

for (const providerName of ['deepseek', 'openai', 'ollama']) {
  test(`${providerName} provider：深度解读走结构化流程且不抛错`, async () => {
    const fake = installFakeFetch();
    try {
      const provider = createProvider(providerName);
      const stages = [];
      const res = await provider.deepRead({
        source: deepSource(),
        figures: [{ num: 1, caption: 'LoopFormer 架构' }],
        onProgress: (p) => stages.push(p),
      });
      assert.ok(res.markdown.length > 200, `${providerName} 应产出报告`);
      assert.equal(res.meta?.pipeline, 'structured');
      const names = [...new Set(stages.map((s) => s.stage))];
      assert.ok(names.includes('chunking') && names.includes('research_map') && names.includes('audit'));
      assert.ok(fake.requests.length >= 4, '应发生多次模型调用（地图/大纲/逐节）');
    } finally {
      fake.restore();
    }
  });
}

test('普通 /api/copy（provider.generate）不受本次改动影响', async () => {
  const fake = installFakeFetch();
  try {
    const provider = createProvider('deepseek');
    const result = await provider.generate({
      source: { type: 'pdf', title: 'LoopFormer', text: 'BLEU 41.8', terms: ['BLEU'] },
      limits: { maxCopyChars: 1000, maxTitleChars: 20 },
    });
    assert.ok(result.copy.includes('一句话总结'), '文案应正常解析');
    assert.equal(result.titles.length, 3);
    assert.ok(result.titles.every((t) => t.length <= 20));
    const first = fake.requests[0];
    assert.match(first.system, /深度解读|文案/);
    assert.ok(!/论文地图/.test(first.system), 'copary 流程不应触发深度解读阶段');
    assert.equal(fake.requests.length, 1, '关掉审校后只应有一次调用');
  } finally {
    fake.restore();
  }
});

test('provider.deepRead 在结构化流程整体不可用时回退旧流程', async () => {
  const fake = installFakeFetch({
    onRequest: ({ user }) => {
      // 逐节写作全部失败 → provider 应回退 multipass / 整篇生成
      if (/请撰写第/.test(user)) throw new Error('写作模型挂了');
      return null;
    },
  });
  try {
    const provider = createProvider('deepseek');
    const res = await provider.deepRead({ source: deepSource(), figures: [], onProgress: () => {} });
    assert.ok(res.markdown.length > 100, '回退路径也应产出内容');
    assert.equal(res.degraded, true, '回退时标记 degraded');
  } finally {
    fake.restore();
  }
});

test('模型不可用时 provider.deepRead 抛出可读错误（不静默失败）', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('fetch failed');
  };
  try {
    const provider = createProvider('deepseek');
    await assert.rejects(
      () => provider.deepRead({ source: deepSource(), figures: [], onProgress: () => {} }),
      (err) => /无法连接|fetch failed/.test(err.message),
    );
  } finally {
    globalThis.fetch = original;
  }
});
