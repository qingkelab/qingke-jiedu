/**
 * 终稿审校的安全护栏。
 *
 * 审校是「把整篇 Markdown 交给模型改写再拿回来」，长文很容易撞上 max_tokens：
 * 模型从开头重写，写到一半被截断，回来的是半篇稿子（实测 13k 字报告被砍到 7.9k）。
 * 所以这里统一做两件事：
 *   1. 按原稿长度推算审校调用的 token 预算（中文约 1 字 ≈ 1 token，留足余量）；
 *   2. 审校结果必须「够长 + 小节数不减少 + 收尾完整」，否则丢弃，保留原稿。
 */

/**
 * 审校调用的 token 预算。
 *
 * 审校是「把整篇稿子交给模型改写再拿回来」，所以预算必须同时覆盖两部分：
 *   ① 改写后的正文（≈ 原稿字数 × factor）
 *   ② reasoning 模型的思考 token——这部分**也算进 max_tokens**
 *
 * 实测（deepseek-v4-flash，12.6k 字终稿）：只给 32000 时思考吃掉全部预算，
 * 返回 finish_reason=length、正文反而更短（11373 字）→ 被护栏丢弃，审校等于没跑；
 * 给到 48000 才 finish_reason=stop、正文 14062 字（比原稿长，护栏接受）。
 *
 * 所以这里显式留出 reasoning 余量，并按原稿长度放大正文预算（上限 48000，
 * 实测该 provider 接受这个值；对上限更小的 provider，调用方会在 4xx 时退一档重试）。
 */
export function reviewBudgetTokens(
  markdown,
  { min = 12000, max = 48000, factor = 1.3, reasoningAllowance = 30000 } = {},
) {
  const chars = String(markdown || '').length;
  const body = Math.ceil(chars * factor);
  return Math.min(max, Math.max(min, body + reasoningAllowance));
}

/** 统计 Markdown 里的二级小节数量。 */
export function countSections(markdown) {
  return (String(markdown || '').match(/^##\s+/gm) || []).length;
}

/**
 * 是否接受审校结果。
 * @returns {{ok:boolean, reason?:string}}
 */
export function acceptReview(original, reviewed) {
  const before = String(original || '');
  const after = String(reviewed || '');
  if (!after.trim()) return { ok: false, reason: '审校返回空内容' };

  // 1) 长度：审校只应做局部修改，明显变短说明被截断或删了大段
  const ratio = after.length / Math.max(1, before.length);
  if (ratio < 0.9) return { ok: false, reason: `审校稿明显变短（${before.length} → ${after.length} 字符）` };

  // 2) 结构：小节不能减少
  const secBefore = countSections(before);
  const secAfter = countSections(after);
  if (secAfter < secBefore) return { ok: false, reason: `审校稿少了小节（${secBefore} → ${secAfter}）` };

  // 3) 收尾：最后一节不能停在半句上（截断的典型特征）
  const tail = after.trimEnd();
  const lastLine = tail.split('\n').filter((l) => l.trim()).pop() || '';
  if (/[，,、:：；;（(]$/.test(lastLine) || /一$|，$/.test(lastLine)) {
    return { ok: false, reason: '审校稿收尾像是被截断' };
  }

  return { ok: true };
}
