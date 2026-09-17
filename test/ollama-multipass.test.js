// 关掉结构化流程，验证 Ollama 的旧 multipass 路径仍然正常（降级兼容）。
process.env.DEEPREAD_STRUCTURED = '0';
process.env.QUALITY_REVIEW = '0';
process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { longPaperText } from './fixtures.js';

const { createProvider } = await import('../src/ai/index.js');
const { config } = await import('../src/config.js');

test('Ollama multipass：结构化关闭时仍按「大纲 → 逐节 → 合并」生成', async () => {
  assert.equal(config.deepreadStructured, false, '测试环境应关闭结构化流程');
  assert.equal(config.deepreadMultipass, true);

  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    const messages = body.messages || [];
    const sys = messages[0]?.content || '';
    const user = messages[messages.length - 1]?.content || '';
    requests.push({ sys, user });
    let content = '';
    if (/请给出大纲/.test(user)) {
      content = ['## 导语｜问题与价值', '## 机制｜怎么做到的', '## 证据｜结果与消融', '## 边界｜局限'].join('\n');
    } else if (/请撰写第/.test(user)) {
      const m = sys.match(/作为本节的 Markdown H2）：##\s*(.+)/);
      const body =
        '正文内容：输入是上一时刻的循环状态，输出是更新后的状态，机制上用一个门控把历史按比例带回当前计算。' +
        '结果上 BLEU 41.8，去掉循环状态后掉到 39.1，显存占用降到 18.6 GB，只在文本模态验证。';
      content = `## ${m ? m[1].trim() : '小节'}\n\n${body}`;
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }), text: async () => content };
  };

  try {
    const provider = createProvider('ollama');
    const stages = [];
    const res = await provider.deepRead({
      source: { kind: 'tex', title: 'LoopFormer', text: longPaperText() },
      figures: [],
      onProgress: (p) => stages.push(p),
    });
    assert.ok(res.markdown.includes('导语'), '应合成分节报告');
    assert.equal(res.degraded, true, '旧流程标记 degraded');
    assert.ok(requests.some((r) => /请给出大纲/.test(r.user)), '应调用大纲');
    const sectionCalls = requests.filter((r) => /请撰写第/.test(r.user));
    assert.equal(sectionCalls.length, 4, `应逐节生成 4 节（实际 ${sectionCalls.length}）`);
    assert.ok(stages.some((s) => s.stage === 'plan'));
    assert.ok(stages.some((s) => s.stage === 'section_done'));
  } finally {
    globalThis.fetch = original;
  }
});

test('Ollama multipass 逐节失败时给出可读占位，不抛错', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('fetch failed');
  };
  try {
    const provider = createProvider('ollama');
    await assert.rejects(
      () => provider.deepRead({ source: { kind: 'tex', title: 'x', text: longPaperText() }, figures: [], onProgress: () => {} }),
      (err) => /无法连接|fetch failed/.test(err.message),
    );
  } finally {
    globalThis.fetch = original;
  }
});
