// 「去 AI 味」规则集（整理自社区流传的去 AI 味提示词）的接线测试：
// 提示词层要逐条下达，检查层要能数出来，且不能把正常行文误判。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_TONE_MIN_CHARS,
  AI_TONE_PER_1K_LIMIT,
  VOICE_LISTS,
  VOICE_PHRASE_LIMIT,
  checkStyle,
  styleMetrics,
} from '../src/styleCheck.js';
import {
  buildDeepReadMessages,
  buildDeepReviewMessages,
  deepReadSectionRules,
  humanVoiceRules,
} from '../src/deepread/prompts.js';
import { aggregateMetrics, collectQualityNotes, compareWithBaseline, computeMetrics } from '../src/deepread/benchmark.js';

// ============ 提示词层：规则要真的进到各阶段的 system prompt ============

test('写作规则：逐节提示词包含「删 AI 模式 + 注入人声」两半', () => {
  const rules = deepReadSectionRules();
  // 删模式：10 类里的关键几条
  for (const key of ['里程碑意义', '动名词假深度', '广告腔与模糊归因', '滥用系动词', '被动与幽灵主语']) {
    assert.match(rules, new RegExp(key), `缺少「${key}」`);
  }
  for (const key of ['三段式与同义轮换', '抽象名词空转', '客服与聊天机器人套话', '过度谨慎的「可能」']) {
    assert.match(rules, new RegExp(key), `缺少「${key}」`);
  }
  // 注入人声
  for (const key of ['节奏错落', '给出反应', '允许不确定与矛盾', '第一人称', '保留一点不整齐']) {
    assert.match(rules, new RegExp(key), `缺少「${key}」`);
  }
  // 原有的去 AI 味规则不能被替换掉
  assert.match(rules, /不是A而是B/);
  assert.match(rules, /不排比三连/);
});

test('人声规则保留本项目自己的版式选择（不照抄「禁用 emoji / 破折号」）', () => {
  const rules = humanVoiceRules();
  assert.equal(/禁止.*emoji|不加表情/i.test(rules), false, '不该把 emoji 一刀禁掉');
  assert.equal(/不加长破折号/.test(rules), false, '破折号由 styleCheck 的用量上限管，不用一刀禁');
});

test('审校提示词：包含人声检查 + 交付前自检，且只输出最终稿', () => {
  const sys = buildDeepReviewMessages({ title: 't', text: '' }, '# T\n\n正文')[0].content;
  assert.match(sys, /人声检查/);
  assert.match(sys, /动名词假深度/);
  assert.match(sys, /交付前自检/);
  assert.match(sys, /只输出最终 Markdown，不要输出自检过程/);
});

test('单篇兜底提示词（legacy）：同样带整套人声规则', () => {
  const sys = buildDeepReadMessages({ title: 't', text: 'x' }, [])[0].content;
  assert.match(sys, /逐条删模式/);
  assert.match(sys, /客服与聊天机器人套话/);
});

// ============ 检查层：四类模式可数、只提示不阻断 ============

test('styleMetrics：四类 AI 腔模式分别计数，并给「每千字」密度', () => {
  const text = '这被视为至关重要的一步，突出了模型的贡献，希望对你有帮助。该设计被认为是必要的。';
  const m = styleMetrics(text);
  assert.equal(m.fakeDepthTotal, 1, '突出了');
  assert.equal(m.highFreqTotal, 1, '至关重要');
  assert.equal(m.chatbotTotal, 1, '希望对你有帮助');
  assert.equal(m.passiveTotal, 2, '被视为 / 被认为是');
  assert.equal(m.voiceTotal, 5);
  assert.ok(m.aiTonePer1k > 0);
  assert.ok(VOICE_LISTS.every((l) => m.voice[l.key]));
});

test('checkStyle：命中只给 info，不把 ok 判成不通过', () => {
  const res = checkStyle('## 结果\n\n这被视为至关重要的一步，突出了模型的贡献，希望对你有帮助。', 'deepread');
  const voice = res.warnings.filter((w) => w.text.includes('AI 腔模式'));
  assert.equal(voice.length, 1);
  assert.equal(voice[0].level, 'info');
  assert.match(voice[0].text, /动名词假深度/);
  assert.match(voice[0].text, /客服套话/);
  assert.equal(res.warnings.some((w) => w.text.includes('AI 腔模式') && w.level === 'warn'), false);
});

test('checkStyle：密度指标只对成文生效（短片段不因字数少而误报）', () => {
  const short = checkStyle('## 结果\n\n被视为重要。', 'deepread');
  assert.ok(short.metrics.chars < AI_TONE_MIN_CHARS);
  assert.equal(short.warnings.some((w) => w.text.includes('AI 腔密度')), false);

  const long = `## 结果\n\n${'这是一段正常分析，用来把样本撑到阈值以上。'.repeat(30)}被视为重要。`;
  const res = checkStyle(long, 'deepread');
  assert.ok(res.metrics.chars >= AI_TONE_MIN_CHARS);
  if (res.metrics.aiTonePer1k > AI_TONE_PER_1K_LIMIT) {
    assert.ok(res.warnings.some((w) => w.text.includes('AI 腔密度')));
  }
});

test('假阳性守门：正常的技术解读不会因为「有」或普通动词就被判 AI 腔', () => {
  const clean = [
    '## 训练只用了 3.5 天',
    '',
    '论文称 base model 在 WMT 2014 英德上报告 27.3 BLEU，big model 报告 28.4。',
    '我们觉得这里的差别不在模型大小，而在于训练步数与 dropout 的搭配。',
    '表 2 把成本和分数放在同一张表里，读的时候要连着看。',
  ].join('\n');
  const res = checkStyle(clean, 'deepread');
  assert.equal(res.metrics.voiceTotal, 0, `不该命中 AI 腔：${JSON.stringify(res.metrics.voice)}`);
  assert.equal(res.warnings.some((w) => w.text.includes('AI 腔')), false);
  assert.equal(res.ok, true);
});

test('阈值常量是显式导出（便于按内容类型调）', () => {
  assert.ok(VOICE_PHRASE_LIMIT >= 1);
  assert.ok(AI_TONE_PER_1K_LIMIT > 0);
  assert.ok(AI_TONE_MIN_CHARS >= 100);
});

// ============ benchmark：密度指标可比较、方向正确 ============

const PAPER = {
  id: '1706.03762',
  category: 'LLM',
  title: 't',
  url: 'u',
  expectedSections: [],
  expectedEvidence: [{ type: 'main_result', text: 'BLEU 41.8', keywords: ['BLEU'] }],
  expectedFigures: [],
  expectedFormulas: [],
  expectedAblations: [],
  expectedLimitations: [],
};
const STRUCTURE = { chunks: [{ id: 'c1', text: 'BLEU 41.8' }], sections: [{ title: 'R', chunkIds: ['c1'] }] };

test('benchmark：aiTonePer1k 从终稿文风体检里读出（没有 style 时为 null）', () => {
  const withStyle = computeMetrics({
    paper: PAPER,
    structure: STRUCTURE,
    result: { markdown: '## R\n\n实验显示 BLEU 41.8。', meta: {}, audit: null, style: { metrics: { aiTonePer1k: 1.5, voiceTotal: 3 } } },
  });
  assert.equal(withStyle.metrics.aiTonePer1k, 1.5);
  assert.equal(withStyle.detail.voice.aiTonePer1k, 1.5);

  const without = computeMetrics({ paper: PAPER, structure: STRUCTURE, result: { markdown: '## R\n\n实验显示 BLEU 41.8。', meta: {}, audit: null } });
  assert.equal(without.metrics.aiTonePer1k, null);
  assert.equal(without.detail.voice, null);
});

test('benchmark：aiTonePer1k 越低越好，且不会被当成「弱项」刷屏', () => {
  const agg = aggregateMetrics([{ status: 'completed', metrics: { aiTonePer1k: 1.2, sourceCoverage: 1 } }]);
  assert.equal(agg.metrics.aiTonePer1k, 1.2);
  const cmp = compareWithBaseline(agg, { metrics: { aiTonePer1k: 3 } });
  assert.deepEqual(cmp.improved.map((i) => i.metric), ['aiTonePer1k'], '密度下降 = 提升');
  const notes = collectQualityNotes([{ id: 'p1', status: 'completed', metrics: { aiTonePer1k: 1.2 } }]);
  assert.equal(notes.some((n) => n.includes('AI tone')), false, '密度不该出现在弱项清单里');
});
