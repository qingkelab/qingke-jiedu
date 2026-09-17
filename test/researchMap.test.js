import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaperStructure } from '../src/deepread/chunker.js';
import {
  buildMapInput,
  buildResearchMap,
  fallbackResearchMap,
  normalizeResearchMap,
  renderResearchMap,
} from '../src/deepread/researchMap.js';
import { longPaperText } from './fixtures.js';

function setup() {
  const structure = buildPaperStructure({ kind: 'tex', text: longPaperText() });
  const figures = [
    { num: 1, caption: 'LoopFormer 整体架构：循环状态更新与窗口注意力' },
    { num: 2, caption: '不同窗口大小下的 BLEU 曲线' },
  ];
  return { structure, figures };
}

test('地图输入覆盖全文（含后半篇实验/消融/局限），而不是只看开头', () => {
  const { structure, figures } = setup();
  const input = buildMapInput({ structure, figures, maxChars: 22000 });
  assert.match(input, /章节结构/);
  assert.match(input, /Ablation|消融/, '地图输入应包含消融切片');
  assert.match(input, /Limitation|局限|Discussion/, '地图输入应包含局限切片');
  assert.ok(input.length <= 24000, `地图输入应受预算约束（实际 ${input.length}）`);
});

test('模型返回合法 JSON 时归一化出 chunkIds / figure 映射', async () => {
  const { structure, figures } = setup();
  const chat = async () => ({
    content: JSON.stringify({
      problem: '长上下文注意力开销',
      key_claims: [{ text: '循环状态可替代全局注意力', chunkIds: ['c1', 'not-exist'] }],
      method_components: ['状态更新算子'],
      equations: [{ text: 'h_t = \\alpha h_{t-1} + (1-\\alpha) W e_t', chunkIds: ['c2'] }],
      datasets: ['WMT14'],
      benchmarks: ['BLEU'],
      baselines: ['Transformer-base'],
      main_results: [{ text: 'BLEU 41.8', chunkIds: ['c3'] }],
      ablations: [{ text: '去掉循环状态掉到 39.1' }],
      limitations: [{ text: '只在文本模态验证' }],
      figures: [{ num: 1, caption: 'LoopFormer 架构', sectionTitle: '3.2 Windowed Attention' }],
      evidence: [{ text: '41.8 BLEU 主结果', chunkIds: ['c3'] }],
    }),
  });
  const res = await buildResearchMap({ chat, source: { title: 'LoopFormer' }, structure, figures });
  assert.equal(res.status, 'model');
  assert.equal(res.map.problem, '长上下文注意力开销');
  assert.deepEqual(res.map.key_claims[0].chunkIds, ['c1'], '无效 chunk id 应被过滤');
  assert.equal(res.map.method_components[0].text, '状态更新算子');
  assert.ok(res.map.main_results.length >= 1);
  assert.ok(res.map.figures[0].num === 1);
  assert.ok(res.stats.evidenceLinks >= 1, '应统计出有证据定位的条目数');
  // 没有 chunkIds 的条目应回填证据定位
  assert.ok(res.map.ablations[0].chunkIds.length >= 0);
});

test('模型输出不可解析时回退本地关键词地图', async () => {
  const { structure, figures } = setup();
  const chat = async () => ({ content: '抱歉，我无法输出 JSON。这里是一段中文解释……' });
  const res = await buildResearchMap({ chat, source: { title: 'LoopFormer' }, structure, figures });
  assert.equal(res.status, 'fallback');
  assert.ok(res.warnings.length >= 1, '应记录降级原因');
  assert.ok(res.map.problem, '兜底地图应给出问题描述');
  assert.ok(res.map.main_results.length >= 1, '兜底地图应抽到带数字的结果');
  assert.ok(res.map.equations.length >= 1, '兜底地图应保留公式');
});

test('模型调用抛错时也不阻塞（回退本地地图）', async () => {
  const { structure, figures } = setup();
  const chat = async () => {
    throw new Error('模型不可用');
  };
  const res = await buildResearchMap({ chat, source: {}, structure, figures });
  assert.equal(res.status, 'fallback');
  assert.match(res.warnings.join(' '), /模型不可用/);
  assert.ok(res.map);
});

test('本地地图包含消融与局限（供审计覆盖检查）', () => {
  const { structure, figures } = setup();
  const { map, stats } = fallbackResearchMap({ structure, figures, source: { title: 'LoopFormer' } });
  assert.ok(stats.ablations >= 1, `应抽到消融（${JSON.stringify(map.ablations).slice(0, 120)}）`);
  assert.ok(stats.limitations >= 1, '应抽到局限');
  assert.ok(map.equations.some((e) => /odot|alpha/.test(e.text)), '应保留 LaTeX 公式');
  const rendered = renderResearchMap(map);
  assert.match(rendered, /主要结果/);
  assert.match(rendered, /图片/);
});

test('normalizeResearchMap 容忍异常形状', () => {
  const { structure, figures } = setup();
  const { map } = normalizeResearchMap(
    { problem: 123, key_claims: '不是数组', main_results: [null, { text: '' }, { text: 'BLEU 41.8' }], figures: 'bad' },
    { structure, figures },
  );
  assert.equal(typeof map.problem, 'string');
  assert.ok(Array.isArray(map.key_claims));
  assert.equal(map.main_results.length, 1);
  assert.ok(Array.isArray(map.figures));
});
