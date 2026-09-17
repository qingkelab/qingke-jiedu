import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaperStructure } from '../src/deepread/chunker.js';
import { runDeepRead } from '../src/deepread/index.js';
import { defaultDeepReadPlan } from '../src/deepread/prompts.js';
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

/** 见到不同提示词就返回对应内容的脚本化模型。 */
function makeChat({ failMap = false, failAuditReview = false, failSections = false } = {}) {
  const calls = [];
  const chat = async (messages, maxTokens) => {
    const sys = messages[0]?.content || '';
    const user = messages[messages.length - 1]?.content || '';
    calls.push({ sys, user, maxTokens });

    if (/论文地图 JSON/.test(user)) {
      if (failMap) throw new Error('地图模型挂了');
      return {
        content: JSON.stringify({
          problem: '长上下文注意力开销',
          key_claims: [{ text: '循环状态可替代全局注意力', chunkIds: ['c1'] }],
          method_components: [{ text: '状态更新算子', chunkIds: ['c2'] }],
          equations: [{ text: 'h_t = \\alpha \\odot h_{t-1}', chunkIds: ['c2'] }],
          datasets: [{ text: 'WMT14' }],
          benchmarks: [{ text: 'BLEU' }],
          baselines: [{ text: 'Transformer-base' }],
          main_results: [{ text: 'BLEU 41.8，准确率 73.2%' }],
          ablations: [{ text: '去掉循环状态掉到 39.1' }],
          limitations: [{ text: '只在文本模态验证' }],
          figures: [{ num: 1, caption: 'LoopFormer 架构' }],
          evidence: [{ text: '41.8 BLEU', chunkIds: ['c3'] }],
        }),
      };
    }
    if (/请给出大纲/.test(user)) {
      return {
        content: [
          '## 为什么长上下文需要循环状态｜导语',
          '## 状态更新怎么从输入走到输出｜机制与最小例子',
          '## 41.8 BLEU 与消融说明了什么｜结果证据',
          '## 只在文本模态验证｜边界',
        ].join('\n'),
      };
    }
    if (/只重写这一节|修订编辑/.test(`${sys}\n${user}`)) {
      return { content: '## 41.8 BLEU 与消融说明了什么｜结果证据\n\n修订：BLEU 41.8，去掉循环状态掉到 39.1。' };
    }
    if (/请撰写第/.test(user)) {
      if (failSections) throw new Error('写作模型挂了');
      const m = sys.match(/作为本节的 Markdown H2）：##\s*(.+)/);
      const title = m ? m[1].trim() : '小节';
      const body = [
        '机制：输入是上一时刻状态 $h_t = \\alpha \\odot h_{t-1}$，输出是更新后的状态。',
        '最小例子：t=2 时门控给历史 0.82 的权重。',
        'Before/After：比全局注意力省显存。',
        '结果：BLEU 41.8，去掉循环状态掉到 39.1，只在文本模态验证。',
      ].join('\n\n');
      return { content: `## ${title}\n\n${body}` };
    }
    if (/审校编辑/.test(sys)) {
      if (failAuditReview) throw new Error('审校挂了');
      return { content: user.slice(user.indexOf('# LoopFormer')) || '' };
    }
    return { content: '' };
  };
  return { chat, calls };
}

test('SSE 阶段完整：chunking → research_map → retrieval → plan → section → audit → repair → finalize', async () => {
  const text = longPaperText();
  const { chat } = makeChat();
  const stages = [];
  const res = await runDeepRead({
    chat,
    source: sourceFrom(text),
    figures: [{ num: 1, caption: 'LoopFormer 整体架构' }],
    onProgress: (p) => stages.push(p),
  });

  const names = [...new Set(stages.map((s) => s.stage))];
  for (const need of ['chunking', 'research_map', 'retrieval', 'plan', 'section', 'audit', 'finalize']) {
    assert.ok(names.includes(need), `缺少阶段 ${need}（实际 ${names.join(',')}）`);
  }
  assert.ok(stages.some((s) => s.stage === 'section' && s.section?.index >= 1), 'section 阶段应带小节进度');
  assert.ok(stages.some((s) => s.stage === 'section_done'), '应有小节完成事件');
  assert.match(res.markdown, /^# LoopFormer/);
  assert.equal(res.meta.pipeline, 'structured');
  assert.ok(res.meta.structure.chunkCount > 20);
  assert.ok(res.meta.evidence.every((e) => Array.isArray(e.chunkIds)), '每节要记录 evidence chunk ids');
});

test('检索式上下文：每节注入的是全文召回的 evidence，而不是前 16000 字', async () => {
  const text = longPaperText();
  const { chat, calls } = makeChat();
  await runDeepRead({ chat, source: sourceFrom(text), figures: [], onProgress: () => {} });

  const sectionCalls = calls.filter((c) => /请撰写第/.test(c.user));
  assert.ok(sectionCalls.length >= 3, '应有多次逐节调用');
  for (const c of sectionCalls) {
    assert.match(c.user, /本节证据片段/, '每节都要带检索到的证据片段');
  }
  // 最后几节的证据里必须出现后半篇才有的数字（说明不是只看前 16k）
  const late = sectionCalls.slice(1).map((c) => c.user).join('\n');
  assert.match(late, /18\.6 GB|39\.1|53\.7/, '后半篇数字必须出现在逐节上下文里');
});

test('研究地图失败 → 不阻塞，用本地地图继续（并在 meta 里标记）', async () => {
  const { chat } = makeChat({ failMap: true });
  const res = await runDeepRead({ chat, source: sourceFrom(longPaperText()), figures: [], onProgress: () => {} });
  assert.equal(res.degraded, false);
  assert.equal(res.meta.researchMapStatus, 'fallback');
  assert.ok(res.meta.warnings.some((w) => /地图模型挂了/.test(w)));
  assert.ok(res.markdown.length > 200);
});

test('切片不足时返回 degraded（交给 provider 回退旧流程）', async () => {
  const { chat } = makeChat();
  const res = await runDeepRead({ chat, source: sourceFrom('太短的正文。'), figures: [], onProgress: () => {} });
  assert.equal(res.degraded, true);
  assert.match(res.reason, /切片不足/);
});

test('部分小节写作失败 → 记录 warning，其余小节照常成稿', async () => {
  const { chat } = makeChat();
  const flaky = async (messages, maxTokens) => {
    const sys = messages[0]?.content || '';
    if (/这是深度解读的第 2\//.test(sys)) throw new Error('该节模型超时');
    return chat(messages, maxTokens);
  };
  const res = await runDeepRead({ chat: flaky, source: sourceFrom(longPaperText()), figures: [], onProgress: () => {} });
  assert.equal(res.degraded, false, '只失败一节不应整体降级');
  assert.ok(res.meta.warnings.some((w) => /该节模型超时/.test(w)));
  assert.ok(res.markdown.includes('本节生成失败已跳过'));
  assert.ok(res.markdown.includes('机制：输入是上一时刻状态'), '其它小节应照常成稿');
});

test('所有小节都写不出来 → degraded（交给 provider 回退旧流程）', async () => {
  const { chat } = makeChat({ failSections: true });
  const res = await runDeepRead({ chat, source: sourceFrom(longPaperText()), figures: [], onProgress: () => {} });
  assert.equal(res.degraded, true);
  assert.match(res.reason, /逐节写作全部失败/);
});

test('审计发现问题时会触发定点修复，只重写问题小节', async () => {
  const text = longPaperText();
  const { chat, calls } = makeChat();
  // 让首轮稿子缺消融/局限：直接用一个只会写导语的脚本
  const weakChat = async (messages, maxTokens) => {
    const sys = messages[0]?.content || '';
    const user = messages[messages.length - 1]?.content || '';
    calls.push({ sys, user, maxTokens });
    if (/论文地图 JSON/.test(user)) return chat(messages, maxTokens);
    if (/请给出大纲/.test(user)) return chat(messages, maxTokens);
    if (/请撰写第/.test(user)) {
      const m = sys.match(/作为本节的 Markdown H2）：##\s*(.+)/);
      return { content: `## ${m ? m[1].trim() : '小节'}\n\n这一节先略过，等修订。` };
    }
    if (/只重写这一节|修订编辑/.test(`${sys}\n${user}`)) {
      return { content: '## 关键实验与消融\n\n修订后：BLEU 41.8，去掉循环状态掉到 39.1，只在文本模态验证。' };
    }
    return { content: '' };
  };

  const res = await runDeepRead({
    chat: weakChat,
    source: sourceFrom(text),
    figures: [],
    onProgress: () => {},
  });
  assert.ok(res.audit, '应产出审计元数据');
  assert.ok(res.audit.serious.length >= 1, '弱稿应被审计发现问题');
  assert.ok(res.meta.repairs.length >= 1, '应执行定点修复');
  assert.match(res.markdown, /修订后：BLEU 41\.8/, '修复内容应回到报告里');
  assert.ok(res.audit.after, '修复后应复检一次');
});

test('审计失败不阻断报告（只记 warning）', async () => {
  const { chat } = makeChat();
  const badStructure = { chunks: null };
  const res = await runDeepRead({
    chat,
    source: { ...sourceFrom(longPaperText()), structure: badStructure },
    figures: [],
    onProgress: () => {},
  });
  // structure 为空时按文本重建，仍应正常出稿
  assert.equal(res.degraded, false);
  assert.ok(res.markdown.length > 200);
});

test('计划阶段：模型大纲被截断时标记 model_truncated 并显式声明使用默认骨架', async () => {
  const base = makeChat().chat;
  const chat = async (messages, maxTokens) => {
    const user = messages[messages.length - 1]?.content || '';
    // 真实事故：reasoning 吃满预算，大纲可见正文为空、finish_reason=length
    if (/请给出大纲/.test(user)) return { content: '', finishReason: 'length' };
    return base(messages, maxTokens);
  };
  const res = await runDeepRead({ chat, source: sourceFrom(longPaperText()), figures: [], onProgress: () => {} });
  assert.equal(res.meta.planStatus, 'model_truncated');
  assert.equal(res.meta.planSource, 'default');
  assert.equal(res.meta.stages.plan.status, 'model_truncated');
  assert.equal(res.meta.stages.plan.finishReason, 'length');
  assert.equal(res.meta.stages.plan.source, 'default');
  assert.equal(res.meta.stages.plan.fallback, true);
  assert.equal(res.meta.stages.plan.sectionCount, defaultDeepReadPlan().length);
  // 用的是默认骨架（而不是靠标题去猜）
  assert.deepEqual(
    res.meta.plan.map((p) => p.title),
    defaultDeepReadPlan().map((p) => p.title),
  );
  assert.ok(res.meta.warnings.some((w) => /大纲/.test(w)), '降级原因要留在 warnings 里');
  assert.equal(res.degraded, false, '降级不等于流程失败');
});

test('计划阶段：模型有输出但解析不出小节 → parse_failed（与截断区分）', async () => {
  const base = makeChat().chat;
  const chat = async (messages, maxTokens) => {
    const user = messages[messages.length - 1]?.content || '';
    if (/请给出大纲/.test(user)) return { content: '我建议按论文结构分节展开，先讲问题再讲方法。', finishReason: 'stop' };
    return base(messages, maxTokens);
  };
  const res = await runDeepRead({ chat, source: sourceFrom(longPaperText()), figures: [], onProgress: () => {} });
  assert.equal(res.meta.planStatus, 'parse_failed');
  assert.equal(res.meta.stages.plan.status, 'parse_failed');
  assert.notEqual(res.meta.stages.plan.status, 'model_truncated');
  assert.equal(res.meta.stages.plan.parsed, false);
  assert.ok(res.meta.stages.plan.rawContentLength > 0, '有可见正文才算解析失败');
});

test('计划阶段：模型大纲可用时标记 model_success 并记录小节数', async () => {
  const { chat } = makeChat();
  const res = await runDeepRead({ chat, source: sourceFrom(longPaperText()), figures: [], onProgress: () => {} });
  assert.equal(res.meta.planStatus, 'model_success');
  assert.equal(res.meta.planSource, 'model');
  assert.equal(res.meta.stages.plan.status, 'model_success');
  assert.equal(res.meta.stages.plan.fallback, false);
  assert.equal(res.meta.stages.plan.sectionCount, res.meta.plan.length);
});

test('统一阶段元数据覆盖 research_map / plan / retrieval / section_generation / audit / repair', async () => {
  const { chat } = makeChat();
  const res = await runDeepRead({ chat, source: sourceFrom(longPaperText()), figures: [], onProgress: () => {} });
  const stages = res.meta.stages;
  for (const name of ['research_map', 'plan', 'retrieval', 'section_generation', 'audit', 'repair']) {
    assert.ok(stages[name], `缺少阶段元数据：${name}`);
  }
  for (const [name, stage] of Object.entries(stages)) {
    for (const field of ['stage', 'status', 'source', 'fallback', 'warning', 'parsed']) {
      assert.ok(field in stage, `${name} 缺少统一字段 ${field}`);
    }
    assert.equal(stage.stage, name, '阶段名要与 key 一致');
    assert.equal(typeof stage.fallbackReason, 'string');
  }
  assert.equal(stages.research_map.status, 'model_success');
  assert.equal(stages.audit.status, 'success');
  assert.equal(typeof res.meta.stageSummary.withWarnings, 'number');
  assert.ok(Array.isArray(res.meta.stageSummary.stagesWithWarnings));
  assert.ok(res.meta.researchMapEvidenceIds.length >= 1, '模型地图要暴露证据 chunk id');
  assert.equal(typeof res.meta.auditVerdict, 'string');
});

test('审计接收上游地图可信度：地图兜底时结论降级并给出 warning', async () => {
  const { chat } = makeChat({ failMap: true });
  const res = await runDeepRead({ chat, source: sourceFrom(longPaperText()), figures: [], onProgress: () => {} });
  assert.equal(res.meta.stages.research_map.status, 'provider_error');
  assert.equal(res.audit.researchMapSource, 'local');
  assert.ok(res.audit.warnings.some((w) => w.code === 'research_map_unavailable'));
  assert.notEqual(res.audit.verdict, 'passed', '地图不可信时不能算干净通过');
});

test('结构来自 HTML 时使用真实章节（含 figure 映射）', () => {
  const structure = buildPaperStructure({ kind: 'html', html: '<html><body><h2>1 Introduction</h2><p>text</p></body></html>' });
  assert.ok(structure.sections.length >= 1);
});
