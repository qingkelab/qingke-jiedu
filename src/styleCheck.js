/**
 * 文风量化自检：把"去 AI 味 / 手机可读"这类定性要求变成可统计指标。
 * 参考公众号爆款拆解的统计法（段落粒度、句长、标点密度），用于：
 *  1) 生成后给出体检报告（前端展示）
 *  2) 超限时把问题清单注入审校 prompt，让模型整改
 */

/** 各产出的文风档位（阈值可按内容类型调）。 */
export const STYLE_PROFILES = {
  copy: { label: '图文文案', maxParaChars: 150, maxAvgParaChars: 110, maxSentenceChars: 80, maxExclaim: 1, maxDash: 2, maxAiPhrases: 0 },
  deepread: { label: '深度解读', maxParaChars: 180, maxAvgParaChars: 130, maxSentenceChars: 90, maxExclaim: 2, maxDash: 3, maxAiPhrases: 1 },
  podcast: { label: '播客脚本', maxParaChars: 130, maxAvgParaChars: 120, maxSentenceChars: 70, maxExclaim: 1, maxDash: 2, maxAiPhrases: 0 },
};

/** AI 味词表（命中即提示；不含"首先/其次"这类在列表里合法的词）。 */
const AI_PHRASES = [
  '随着',
  '总而言之',
  '综上所述',
  '总的来说',
  '本质上',
  '更重要的是',
  '说白了',
  '归根结底',
  '关键在',
  '核心在',
  '具有重要意义',
  '值得关注',
  '提供新思路',
  '新方向',
  '赋能',
  '闭环',
  '抓手',
  '本文研究',
  '作者提出',
  '我们提出',
  '值得一提的是',
  '需要注意的是',
  '不是……而是',
  '不仅能',
  '更能',
];

/** 去掉 markdown 结构，便于按"人读的文字"统计。 */
function stripMarkdown(md) {
  let t = String(md || '');
  t = t.replace(/```[\s\S]*?```/g, '\n\n'); // 代码块（含出处块/公式块）
  t = t.replace(/^\s*!\[[^\]]*\]\([^)]*\)\s*$/gm, ''); // 图片行
  t = t.replace(/\$\$[\s\S]*?\$\$/g, ' '); // 块级公式
  t = t.replace(/\$[^$\n]*\$/g, ' '); // 行内公式
  t = t.replace(/^\s*#{1,6}\s+.*$/gm, ''); // 标题
  t = t.replace(/^\s*>\s?/gm, ''); // 引用符
  t = t.replace(/^\s*[-*+]\s+/gm, ''); // 列表符
  t = t.replace(/^\s*\d+[.)]\s+/gm, '');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // 链接保留文字
  t = t.replace(/\*\*|__|`/g, '');
  return t;
}

function countChars(s) {
  // 计"可见字符"：排除空白与常见 markdown 残符
  return String(s || '').replace(/[\s*_#>`~|]/g, '').length;
}

function splitParagraphs(text) {
  return String(text || '')
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => countChars(p) > 0);
}

function splitSentences(text) {
  return String(text || '')
    .split(/[。！？!?；;\n]+/)
    .map((s) => s.trim())
    .filter((s) => countChars(s) > 1);
}

/**
 * 统计文风指标。
 * @param {string} text markdown 或纯文本
 * @returns {object} metrics
 */
export function styleMetrics(text) {
  const raw = String(text || '');
  const plain = stripMarkdown(raw);
  const paragraphs = splitParagraphs(plain);
  const paraLens = paragraphs.map(countChars);
  const sentences = splitSentences(plain);
  const sentLens = sentences.map(countChars);
  const chars = countChars(plain);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const avg = (a) => (a.length ? Math.round((sum(a) / a.length) * 10) / 10 : 0);

  const count = (re) => (plain.match(re) || []).length;
  const aiHits = [];
  for (const w of AI_PHRASES) {
    const n = plain.split(w).length - 1;
    if (n > 0) aiHits.push({ word: w, count: n });
  }
  aiHits.sort((a, b) => b.count - a.count);

  const boldMatch = raw.match(/\*\*[^*\n]+\*\*/g) || [];
  return {
    chars,
    paragraphs: paragraphs.length,
    avgParaChars: avg(paraLens),
    maxParaChars: paraLens.length ? Math.max(...paraLens) : 0,
    sentences: sentences.length,
    avgSentenceChars: avg(sentLens),
    maxSentenceChars: sentLens.length ? Math.max(...sentLens) : 0,
    periods: count(/[。]/g),
    commas: count(/[，,]/g),
    exclamations: count(/[！!]/g),
    questions: count(/[？?]/g),
    dashes: count(/——|—/g),
    boldAnchors: boldMatch.length,
    firstPerson: count(/我们|我/g),
    firstPersonPer100: chars ? Math.round(((count(/我们|我/g) / chars) * 100) * 10) / 10 : 0,
    aiPhraseHits: aiHits,
    aiPhraseTotal: aiHits.reduce((s, x) => s + x.count, 0),
  };
}

/**
 * 按档位体检，返回 { metrics, warnings, ok }。
 * warnings: [{ level: 'warn'|'info', text }]
 */
export function checkStyle(text, profileName = 'deepread') {
  const profile = STYLE_PROFILES[profileName] || STYLE_PROFILES.deepread;
  const m = styleMetrics(text);
  const warnings = [];

  if (m.maxParaChars > profile.maxParaChars) {
    warnings.push({
      level: 'warn',
      text: `有段落过长（最长 ${m.maxParaChars} 字 > ${profile.maxParaChars} 字），手机上一屏塞不下，需要拆段`,
    });
  }
  if (m.avgParaChars > profile.maxAvgParaChars) {
    warnings.push({
      level: 'info',
      text: `段落偏大（平均 ${m.avgParaChars} 字），建议再碎一点（目标 ≤ ${profile.maxAvgParaChars} 字）`,
    });
  }
  if (m.avgSentenceChars > profile.maxSentenceChars) {
    warnings.push({
      level: 'info',
      text: `句子偏长（平均 ${m.avgSentenceChars} 字），长句多拆或用逗号拉开口语节奏`,
    });
  }
  if (m.exclamations > profile.maxExclaim) {
    warnings.push({
      level: 'warn',
      text: `感叹号 ${m.exclamations} 个（上限 ${profile.maxExclaim}），情绪要克制`,
    });
  }
  if (m.dashes > profile.maxDash) {
    warnings.push({
      level: 'info',
      text: `破折号 ${m.dashes} 个（上限 ${profile.maxDash}），可用句号替代`,
    });
  }
  if (m.aiPhraseTotal > profile.maxAiPhrases) {
    const top = m.aiPhraseHits.slice(0, 5).map((h) => `${h.word}×${h.count}`).join('、');
    warnings.push({
      level: 'warn',
      text: `AI 味词命中 ${m.aiPhraseTotal} 处（上限 ${profile.maxAiPhrases}）：${top}`,
    });
  }
  return { profile: profile.label, metrics: m, warnings, ok: warnings.filter((w) => w.level === 'warn').length === 0 };
}

/** 把体检问题转成给审校模型的整改清单（无问题时返回空串）。 */
export function styleWarningsForPrompt(text, profileName) {
  const { warnings } = checkStyle(text, profileName);
  if (!warnings.length) return '';
  return [
    '## 文风体检（请在本次审校中一并整改）',
    ...warnings.map((w) => `- ${w.text}`),
  ].join('\n');
}
