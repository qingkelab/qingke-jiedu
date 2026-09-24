/**
 * 保真护栏（fidelity guard）
 *
 * 对齐 humanizer-zh（2026-09-23 版）的第一条约束：
 *   「润色可以让文字更顺，但不能改变作者说的意思。」
 *
 * 终稿审校是「整篇交给模型重写再拿回来」，最容易出的问题不是截断，而是**改意思**：
 *   可能 → 确定；并未 → 已经；论文称 → 直接断言；丢掉数字；丢掉图片/公式/链接/代码。
 * 现有护栏只查「够不够长 / 小节数 / 收尾 / 事实覆盖」，看不出这些语义变化。
 *
 * 这里用确定性比较（不调模型）分成两类：
 *   hard：受保护内容丢失（图片 / 链接 / 代码块 / 行内代码 / 公式 / 表格行 / 标题）—— 直接否决审校稿
 *   soft：语义计数下降（数字 / 否定 / 限定 / 归因）—— 记录并回报，不自动否决
 *        （合并句子可能合法地减少计数，所以 soft 只当线索，交给人工或定向整改）
 */

import { extractFormulas, extractNumberTokens, normalizeNumberToken, numberValue } from './audit.js';

/**
 * 否定短语：只收**无歧义**的写法。
 * 刻意不收单独一个「不」（会命中「不仅/不过/不同」这类非否定用法），
 * 也不收单独一个「未」（会命中「未来」）——宁可漏数，也不制造假警报。
 */
export const NEGATION_PHRASES = [
  '并未',
  '尚未',
  '没有',
  '不能',
  '不会',
  '无法',
  '不再',
  '从未',
  '并非',
  '不等于',
  '不构成',
  '不包括',
  '不适用',
  '不足',
  '不足以',
  '未能',
  '未做',
  '未提供',
  '未给出',
  '未验证',
  '未经',
  '尚未确认',
  '尚未验证',
  '不提供',
  '不支持',
  '不区分',
  '不意味',
];

/** 限定/推测短语：这些词承载「这件事有多确定」，审校不得把它们升格成确定。 */
export const HEDGE_PHRASES = [
  '可能',
  '或许',
  '也许',
  '大概',
  '似乎',
  '恐怕',
  '未必',
  '不一定',
  '不确定',
  '推测',
  '猜测',
  '估计',
  '预计',
  '计划',
  '尚不清楚',
  '尚不确定',
  '未经验证',
  '未证实',
  '据称',
  '据悉',
  '据报道',
  '据说',
];

/** 归因标记：论文解读里「谁说的」不能丢。 */
export const ATTRIBUTION_PHRASES = [
  '论文称',
  '论文报告',
  '论文指出',
  '作者称',
  '作者报告',
  '作者指出',
  '该研究',
  '实验显示',
  '结果显示',
  '报告称',
  '官方称',
  '表明',
  '声称',
];

const countOf = (text, phrases) => {
  const s = String(text || '');
  return phrases.reduce((n, p) => n + (s.split(p).length - 1), 0);
};

/** 数字的身份键：优先按数值（41.0b ≡ 41.0 ≡ 41），否则退回归一化 token。 */
const numberKeyOf = (t) => {
  const v = numberValue(t);
  return v != null ? `v:${v}` : `t:${normalizeNumberToken(t)}`;
};

/** 受保护内容计数（审校不得丢）。 */
export function protectedCounts(text) {
  const s = String(text || '');
  return {
    images: (s.match(/!\[[^\]]*\]\([^)]*\)/g) || []).length,
    links: (s.match(/(?<!!)\[[^\]]*\]\([^)\s]+\)/g) || []).length,
    codeBlocks: Math.floor((s.match(/^```/gm) || []).length / 2),
    inlineCode: (s.match(/`[^`\n]+`/g) || []).length,
    formulas: extractFormulas(s).length,
    tableRows: (s.match(/^\s*\|.*\|\s*$/gm) || []).length,
    headings: (s.match(/^#{1,6}\s+\S/gm) || []).length,
    h2: (s.match(/^##\s+\S/gm) || []).length,
  };
}

/** 语义计数 + 数字集合。 */
export function semanticCounts(text) {
  const s = String(text || '');
  const numbers = new Set();
  for (const t of extractNumberTokens(s)) numbers.add(numberKeyOf(t));
  return {
    numbers,
    negation: countOf(s, NEGATION_PHRASES),
    hedge: countOf(s, HEDGE_PHRASES),
    attribution: countOf(s, ATTRIBUTION_PHRASES),
  };
}

/**
 * 对比「审校前 / 审校后」。
 * @returns {{ok:boolean, hard:Array, soft:Array, before:object, after:object}}
 */
export function fidelityDiff(original, reviewed) {
  const before = String(original || '');
  const after = String(reviewed || '');
  const pBefore = protectedCounts(before);
  const pAfter = protectedCounts(after);
  const sBefore = semanticCounts(before);
  const sAfter = semanticCounts(after);

  const PROTECTED_LABELS = {
    images: '图片',
    links: '链接',
    codeBlocks: '代码块',
    inlineCode: '行内代码',
    formulas: '公式',
    tableRows: '表格行',
    h2: '二级小节',
  };
  const hard = [];
  for (const [key, label] of Object.entries(PROTECTED_LABELS)) {
    if (pAfter[key] < pBefore[key]) {
      hard.push({ kind: key, detail: `${label} ${pBefore[key]} → ${pAfter[key]}` });
    }
  }

  const lostNumbers = [...sBefore.numbers].filter((n) => !sAfter.numbers.has(n)).map((n) => n.replace(/^[vt]:/, ''));
  const soft = [];
  if (lostNumbers.length) {
    soft.push({ kind: 'numbers', detail: `丢了 ${lostNumbers.length} 个数字（例：${lostNumbers.slice(0, 5).join('、')}）`, items: lostNumbers });
  }
  for (const [key, label] of [
    ['negation', '否定'],
    ['hedge', '限定/推测'],
    ['attribution', '归因'],
  ]) {
    if (sAfter[key] < sBefore[key]) {
      soft.push({ kind: key, detail: `${label}表述 ${sBefore[key]} → ${sAfter[key]}`, from: sBefore[key], to: sAfter[key] });
    }
  }

  return { ok: hard.length === 0, hard, soft, before: { ...pBefore, ...sBefore, numbers: sBefore.numbers.size }, after: { ...pAfter, ...sAfter, numbers: sAfter.numbers.size } };
}
