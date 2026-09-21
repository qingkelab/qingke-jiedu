// 生成质量迁移：归因 / 数字条件 / 必写小节（「它还没有证明什么」+「技术小结」）/ 数字核验表。
// 全部确定性，不调用真实模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaperStructure } from '../src/deepread/chunker.js';
import { runDeepRead } from '../src/deepread/index.js';
import {
  buildDeepReadMessages,
  buildDeepReadSectionMessages,
  buildDeepReviewMessages,
  buildPlanMessages,
  deepReadSectionRules,
  defaultDeepReadPlan,
} from '../src/deepread/prompts.js';
import { longPaperText } from './fixtures.js';

function sourceFrom(text) {
  return {
    kind: 'tex',
    title: 'LoopFormer',
    byline: 'Yifan Zhang',
    date: '2026-09',
    url: 'https://arxiv.org/abs/2601.00001',
    text,
  };
}

test('写作规则：归因句式与「数字必须绑定条件」是硬性规则', () => {
  const rules = deepReadSectionRules();
  assert.match(rules, /论文称 \/ 作者报告/, '要有归因句式要求');
  assert.match(rules, /我们觉得 \/ 这更像是/, '要有编辑部判断的措辞要求');
  assert.match(rules, /数据集 \/ 任务 \/ 设置 \/ 基线/, '数字必须绑定条件');
  assert.match(rules, /表外（证据外）的数字一个都不写/);
  assert.match(rules, /首次 \/ 最强 \/ SOTA/, '要有研究边界词清单');
});

test('大纲提示词：明确要求保留「它还没有证明什么」与「技术小结」两节', () => {
  const msgs = buildPlanMessages({
    source: sourceFrom(longPaperText()),
    structure: buildPaperStructure(longPaperText()),
    researchMap: null,
    figures: [],
  });
  const sys = msgs[0].content;
  assert.match(sys, /两节不许省/);
  assert.match(sys, /它还没有证明什么/);
  assert.match(sys, /技术小结/);
  assert.match(sys, /broader impacts/);
});

test('兜底大纲：包含边界节与小结节（标题不同也要有对应 role）', () => {
  const plan = defaultDeepReadPlan();
  assert.ok(plan.some((s) => s.role === 'limitation' && s.title.includes('它还没有证明什么')));
  assert.ok(plan.some((s) => s.role === 'discussion' && s.title.includes('技术小结')));
});

test('逐节提示词：每节都带归因硬性要求；边界节与收尾节各自加码', () => {
  const plan = defaultDeepReadPlan();
  const base = { source: sourceFrom(longPaperText()), figures: [], plan, prevMd: '', researchMap: null };

  const method = buildDeepReadSectionMessages({ ...base, index: 2, role: 'method' });
  assert.match(method[0].content, /归因与边界（硬性）/);
  assert.match(method[0].content, /这个实验不能回答什么/);
  assert.equal(method[0].content.includes('本节定位：它还没有证明什么'), false, '机制节不应注入边界节专属要求');

  const limitIndex = plan.findIndex((s) => s.role === 'limitation');
  const limit = buildDeepReadSectionMessages({ ...base, index: limitIndex, role: 'limitation' });
  assert.match(limit[0].content, /本节定位：它还没有证明什么/);
  assert.match(limit[0].content, /不要只找「limitations」这个词/);

  const summary = buildDeepReadSectionMessages({ ...base, index: plan.length - 1, role: 'discussion' });
  assert.match(summary[0].content, /本节定位：技术小结/);
});

test('审校提示词：要求补回两节必写小节并统一归因', () => {
  const msgs = buildDeepReviewMessages(sourceFrom(longPaperText()), '# LoopFormer\n\n正文');
  const sys = msgs[0].content;
  assert.match(sys, /它还没有证明什么/);
  assert.match(sys, /技术小结/);
  assert.match(sys, /论文称\/作者报告/);
  assert.match(sys, /能删则删/);
});

test('单篇兜底提示词（legacy）：同样要求边界节与小结节', () => {
  const msgs = buildDeepReadMessages(sourceFrom(longPaperText()), []);
  const sys = msgs[0].content;
  assert.match(sys, /它还没有证明什么/);
  assert.match(sys, /技术小结/);
  assert.match(sys, /表外（证据外）的数字一个都不写/);
});

test('端到端：终稿会生成数字核验表，并落进 meta.factCheck（含 stats 与 markdown）', async () => {
  const calls = [];
  const chat = async (messages) => {
    const sys = messages[0]?.content || '';
    const user = messages[messages.length - 1]?.content || '';
    calls.push({ sys, user });
    if (/论文地图 JSON/.test(user)) {
      return {
        content: JSON.stringify({
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
          figures: [{ num: 1, caption: 'LoopFormer 架构' }],
          evidence: [{ text: '41.8 BLEU', chunkIds: ['c3'] }],
        }),
      };
    }
    if (/请给出大纲/.test(user)) {
      return { content: ['## 为什么需要循环状态｜导语', '## 它还没有证明什么｜边界', '## 技术小结｜收尾'].join('\n') };
    }
    if (/只重写这一节|修订编辑/.test(`${sys}\n${user}`)) {
      return { content: '## 为什么需要循环状态｜导语\n\n修订：BLEU 41.8。' };
    }
    if (/请撰写第/.test(user)) {
      const m = sys.match(/作为本节的 Markdown H2）：##\s*(.+)/);
      const title = m ? m[1].trim() : '小节';
      return {
        content: `## ${title}\n\n论文称 BLEU 达到 41.8（WMT14 英德，Transformer-base 基线），去掉循环状态后掉到 39.1。`,
      };
    }
    if (/审校编辑/.test(sys)) {
      const at = user.indexOf('# LoopFormer');
      return { content: at >= 0 ? user.slice(at) : user };
    }
    return { content: '' };
  };

  const res = await runDeepRead({
    chat,
    source: sourceFrom(longPaperText()),
    figures: [{ num: 1, caption: 'LoopFormer 整体架构' }],
    onProgress: () => {},
  });

  assert.ok(res.meta.factCheck, 'meta 里应带 factCheck');
  assert.ok(res.meta.factCheckStats, 'meta 里应带 factCheckStats');
  assert.equal(res.meta.factCheckStats.numbers, res.meta.factCheck.rows.length);
  assert.match(res.meta.factCheck.markdown, /数字核验表/);
  assert.ok(res.meta.factCheck.rows.some((r) => r.status === 'source'), '应有可定位到原文的数字');
  assert.ok(
    res.meta.factCheck.rows.every((r) => ['source', 'derived', 'unsupported'].includes(r.status)),
    '每个数字必须落到三态之一',
  );
});
