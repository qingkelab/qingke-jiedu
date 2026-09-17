import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaperStructure } from '../src/deepread/chunker.js';
import { buildGlobalContext, retrieveForSection, sectionRole, renderEvidence } from '../src/deepread/retrieval.js';
import { fallbackResearchMap } from '../src/deepread/researchMap.js';
import { longPaperText } from './fixtures.js';

function setup() {
  const text = longPaperText();
  const structure = buildPaperStructure({ kind: 'tex', text });
  const figures = [
    { num: 1, caption: 'LoopFormer 整体架构：循环状态更新与窗口注意力' },
    { num: 2, caption: '不同窗口大小下的 BLEU 曲线' },
  ];
  return { text, structure, figures };
}

test('后半篇实验数字能被检索到（不再受前 16k 截断影响）', () => {
  const { structure } = setup();
  // 确认关键数字确实只出现在论文后半部分
  const all = structure.chunks.map((c) => c.text).join('\n');
  const idx = all.indexOf('18.6 GB');
  assert.ok(idx > 16000, `显存数字应位于后半篇（位置 ${idx}）`);

  const r = retrieveForSection({
    structure,
    section: { title: '关键实验结果与消融说明了什么', note: '主结果数字、消融、效率' },
    budgetChars: 6000,
  });
  const text = r.evidence.map((e) => e.text).join('\n');
  assert.match(text, /41\.8/, '主结果 BLEU 41.8 应被召回');
  assert.match(text, /18\.6 GB/, '后半篇的效率数字应被召回');
  assert.ok(r.chunkIds.length >= 3, '应给出 chunk ids');
  assert.ok(r.chunkIds.every((id) => /^c\d+$/.test(id)));
});

test('消融与局限能被检索到，且角色判定正确', () => {
  const { structure } = setup();
  assert.equal(sectionRole('关键实验结果与消融说明了什么'), 'results');
  assert.equal(sectionRole('哪里有失效边界与局限'), 'limitation');
  assert.equal(sectionRole('状态更新怎么从输入走到输出'), 'method');

  const abla = retrieveForSection({ structure, section: { title: '消融实验说明了什么', note: 'ablation' }, budgetChars: 6000 });
  assert.match(abla.evidence.map((e) => e.text).join('\n'), /39\.1|消融/, '消融结论应被召回');

  const lim = retrieveForSection({ structure, section: { title: '失效边界与局限', note: 'limitation' }, budgetChars: 6000 });
  assert.match(lim.evidence.map((e) => e.text).join('\n'), /只在文本模态|未在语音/, '局限段落应被召回');
});

test('方法节优先召回方法/公式 chunk', () => {
  const { structure } = setup();
  const r = retrieveForSection({
    structure,
    section: { title: '核心机制：状态更新怎么从输入走到输出', note: '方法 机制 公式' },
    budgetChars: 6000,
  });
  const types = r.evidence.map((e) => e.type);
  assert.ok(types.includes('formula'), `方法节应召回公式 chunk（实际 ${types.join(',')}）`);
  const top = r.evidence.slice(0, 4).map((e) => e.sectionTitle).join(' | ');
  assert.match(top, /Method|方法|3\.1|3\.2/, `方法节应优先召回方法章节：${top}`);
});

test('全局上下文包含摘要与研究地图要点', () => {
  const { structure, figures } = setup();
  const map = fallbackResearchMap({ structure, figures, source: { title: 'LoopFormer' } }).map;
  const ctx = buildGlobalContext({ structure, researchMap: map, figures });
  assert.match(ctx, /摘要|Introduction/, '全局上下文应含摘要/引言');
  assert.match(ctx, /研究地图/, '全局上下文应含研究地图');
  assert.match(ctx, /图1/, '全局上下文应含图片索引');
});

test('证据渲染带 chunk id，检索预算可控', () => {
  const { structure } = setup();
  const r = retrieveForSection({
    structure,
    section: { title: '结果', note: '结果' },
    budgetChars: 1800,
    maxChunks: 4,
  });
  assert.ok(r.chars <= 2400, `证据体量应受预算约束（实际 ${r.chars}）`);
  assert.ok(r.evidence.length <= 4);
  const rendered = renderEvidence(r.evidence);
  assert.match(rendered, /\[c\d+\]/);
});

test('检索异常时回退本节 chunks（不会抛错）', () => {
  const { structure } = setup();
  const broken = { ...structure, chunks: structure.chunks.map((c) => ({ ...c, terms: null })) };
  const r = retrieveForSection({ structure: broken, section: { title: '结果', note: '' }, budgetChars: 4000 });
  assert.ok(Array.isArray(r.evidence));
});
