/**
 * 头图内容提炼（cover distill）
 *
 * 目标：把一篇解读稿压缩成「一张手绘研究笔记」需要的元素，并**自动决定视觉结构**，
 * 而不是让调用方手写布局。全部确定性，不调用模型。
 *
 * 提炼出的元素：
 *   title/subtitle  标题与一句话结论
 *   numbers         带条件的核心数字（用于坐标轴 / 数据图 / 批注）
 *   formula         关键公式（LaTeX 原样，用于公式面板）
 *   steps           章节骨架（用于流程图 / 决策树）
 *   claims          归因句（论文称 / 实验显示，用于手写批注）
 *   tags            术语标签（用于页眉术语带）
 */

import { extractNumberTokens, normalizeNumberToken, numberValue, splitMarkdownSections } from '../deepread/audit.js';

/** 结果类小节：数字主要从这里取，避免把「6 层 / 512 维」这类结构参数当成结论。 */
const RESULT_SECTION_RE =
  /结果|实验|评测|消融|效果|性能|对比|证据|主榜|榜单|分数|表现|result|experiment|ablation|benchmark|evaluation|leaderboard/i;
/** 结构参数：这些数字不进数据图（它们是配置，不是结论）。 */
const CONFIG_UNIT_RE = /^(层|块|维|个|张|head|l|d|h|n|dim)$/i;
/**
 * 结论性单位 / 量级：出现这些才算「结论数字」。
 * 刻意**不收**裸字母 h / B / 帧：它们会命中 hidden、Batch 之类的普通词。
 */
const RESULT_UNIT_RE =
  /%|％|倍|百分点|pp\b|BLEU|ROUGE|accuracy|准确率|成功率|通过率|吞吐|GB|MB|TOPS|FPS|ms\b|FLOPs?|小时|天\b|\d\s*h\b|\bdays?\b/i;
/** 指标类标签：命中才当数字标签，否则用小节标题（避免整列都是 model / only 这类泛词）。 */
const METRIC_LABEL_RE = /^(BLEU|ROUGE|accuracy|acc|FPS|TOPS|ms|GB|MB|FLOPs|days?|hours?|params?|%)/i;
const ATTRIBUTION_RE = /(论文称|论文报告|作者报告|作者称|实验显示|结果显示|报告称)/;

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 去掉 emoji / 图形符号：海报走「手绘铅笔记事」路线，标题里的 emoji 不画。 */
export function stripDecorative(s) {
  return String(s ?? '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const STOP_LATIN = new Set(['The', 'We', 'On', 'In', 'Our', 'Table', 'Figure', 'This', 'It', 'They', 'English', 'and']);

/**
 * 判断一段 `$…$` 里到底是不是公式。
 *
 * 为什么需要：正文里 `$h_t$` 这类行内公式一旦配对错位（少一个 `$`），
 * 正则会把中间的中文当成「公式」塞进面板，KaTeX 会以 warn 形式抱怨
 * Unicode text character used in math mode，图上就会出现一段乱码。
 * 这里只认「含 LaTeX 命令或数学符号」的片段，中文散文一律淘汰。
 */
export function looksLikeMath(tex) {
  const s = String(tex || '').trim();
  if (!s || s.length > 240) return false;
  if (/[\u3400-\u9fff]/.test(s)) return false; // 中文散文不是公式
  if (!/[\\^_{}=<>]|∈|×|⊙|∑|√|≤|≥|±|→/.test(s)) return false;
  return true;
}

/**
 * 数字的上下文：取数字**后面紧跟**的那个词作为单位/指标（"28.4 BLEU" → BLEU、"3.5 days" → days），
 * 后面没有就回退到前面最近的拉丁术语。比「整句里第一个大写词」准得多。
 */
export function numberContext(sentence, token) {
  const s = String(sentence || '');
  const digits = (String(token).match(/\d+(?:[.,]\d+)?/) || [])[0] || String(token);
  const at = s.indexOf(digits);
  if (at < 0) return { digits, wordAfter: '', label: '' };
  const after = s.slice(at + digits.length, at + digits.length + 16);
  const before = s.slice(Math.max(0, at - 22), at);
  const wordAfter = (after.match(/^\s*([A-Za-z][A-Za-z0-9%.-]{0,11})/) || [])[1] || '';
  const symbolAfter = (after.match(/^\s*(%|％|pp\b)/) || [])[1] || '';
  const beforeWords = (before.match(/\b[A-Za-z][A-Za-z0-9-]{1,12}\b/g) || []).filter((w) => !STOP_LATIN.has(w));
  // 只有 % 这种纯符号时，用前面的术语当标签（否则整列都是「%」，等于没标签）
  const label = wordAfter && !STOP_LATIN.has(wordAfter) ? wordAfter : beforeWords.at(-1) || '';
  const unitWord = wordAfter || symbolAfter;
  return { digits, wordAfter, unitWord, label };
}

/** 去掉 markdown 行内标记与图片，只留文字。 */
function plainLine(line) {
  return String(line || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 句子切分（中英混排，保留数字条件句）。 */
export function sentences(text) {
  return String(text || '')
    .split(/(?<=[。！？!?;；])\s*|(?<=\.)\s+(?=[A-Z(\u4e00-\u9fff])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 从终稿 markdown 提炼头图元素。 */
export function distillCoverContent({ markdown = '', meta = null, title = '', sourceUrl = '' } = {}) {
  const md = String(markdown || '');
  const sections = splitMarkdownSections(md).filter((s) => s.level <= 2 && s.heading);
  const h1 = sections.find((s) => s.level === 1);
  const h2 = sections.filter((s) => s.level === 2).map((s) => plainLine(s.heading));

  const coverTitle = plainLine(title) || plainLine(h1?.heading) || '论文深度解读';

  // 副标题：标题之后第一段可读文字（不是图片/引用/代码）
  const prelude = (h1?.body || '')
    .split('\n')
    .map(plainLine)
    .find((l) => l.length >= 12 && !/^(作者|机构|时间|Paper|arXiv|Code)[：:]/.test(l));
  const firstBody = h2.length
    ? sentences(sections.find((s) => s.level === 2)?.body || '')[0] || ''
    : '';
  const subtitle = (prelude || plainLine(firstBody)).slice(0, 54);

  // 结果类小节（取不到就退回全部二级小节）——带上小节标题，作为数字的兜底标签
  const h2Sections = sections.filter((s) => s.level === 2);
  const resultSections = h2Sections.filter((s) => RESULT_SECTION_RE.test(s.heading));
  const scanSections = resultSections.length ? resultSections : h2Sections;

  // 关键数字：带结论性单位、按数值去重、保留承载它的句子作为条件。
  // 先扫结果类小节；不够 3 个就扩到全文（有些稿子的主结果写在「主榜/证据」这类小节里）。
  const seen = new Set();
  const collectNumbers = (sectionList, out) => {
    for (const section of sectionList) {
      const sectionLabel = stripDecorative(section.heading).replace(/^[^：:]*[：:]\s*/, '').slice(0, 12) || '结果';
      for (const sentence of sentences(section.body)) {
      for (const token of extractNumberTokens(sentence)) {
        if (out.length >= 5) return out;
        const unit = String(token).replace(/^[\d.,]+/, '').trim();
        // 用整句判断（不要截断成 60 字：截断会把句尾的字母凑成 `\bh\b` 这类假单位）
        const hasResult = RESULT_UNIT_RE.test(token) || RESULT_UNIT_RE.test(sentence);
        if (!hasResult) continue;
        if (unit && CONFIG_UNIT_RE.test(unit)) continue;
        const key = numberValue(token) != null ? `v:${numberValue(token)}` : normalizeNumberToken(token);
        if (seen.has(key)) continue;
        seen.add(key);
        const ctx = numberContext(sentence, token);
        const label = ctx.label || sectionLabel || unit || '结果';
        // 打分：直接带单位/指标词的优先；小整数、条件句过长的排后面（海报只要最硬的几个数）
        const directUnit = /[a-z%]/.test(String(token).replace(/^[\d.,]+/, ''));
        const metricWord = /^(BLEU|ROUGE|accuracy|FPS|TOPS|ms|GB|MB|FLOPs|days?|hours?)/i.test(ctx.wordAfter || '');
        const score =
          (directUnit ? 2 : 0) +
          (metricWord ? 2 : 0) +
          (/\d\.\d/.test(String(token)) ? 1 : 0) +
          (/论文称|实验显示|结果显示|报告|结果/.test(sentence) ? 1 : 0);
        if (score < 3) continue;
        // 展示值：数字 + 它后面真正的单位/指标词（token 自带的 b/x 只是「紧跟字母」的产物）
        const display = `${ctx.digits}${ctx.unitWord ? ` ${ctx.unitWord}` : ''}`.slice(0, 18);
        out.push({
          value: display,
          label: String(label).slice(0, 16),
          condition: sentence.replace(/[*_`#|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 72),
          score,
        });
      }
      }
    }
    return out;
  };
  const numbers = collectNumbers(scanSections, []);
  if (numbers.length < 3) {
    collectNumbers([{ heading: '全文', body: md.replace(/```[\s\S]*?```/g, ' ') }], numbers);
  }
  numbers.sort((a, b) => b.score - a.score);

  // 公式：第一个块级公式
  const formulaMatch = md.match(/\$\$([\s\S]{4,240}?)\$\$/) || [null, [...md.matchAll(/\$([^$\n]{4,120})\$/g)].map((m) => m[1]).find(looksLikeMath) || ''];
  const formula = formulaMatch
    ? { latex: String(formulaMatch[1]).replace(/\s+/g, ' ').trim().slice(0, 90), caption: '核心公式' }
    : null;

  // 归因句 → 手写批注
  const claims = [];
  for (const sentence of sentences(md)) {
    if (claims.length >= 3) break;
    if (!ATTRIBUTION_RE.test(sentence)) continue;
    const clean = sentence.replace(/[*_`#|]/g, '').replace(/\s+/g, ' ').trim();
    if (clean.length < 12) continue;
    claims.push(clean.slice(0, 78));
  }

  // 术语标签：拉丁大写词 / 驼峰词，按出现次数排序
  const tagCount = new Map();
  for (const m of md.matchAll(/\b([A-Z][A-Za-z0-9][A-Za-z0-9-]{1,14})\b/g)) {
    const w = m[1];
    if (/^(The|We|On|In|Our|Table|Figure|This|It|They)$/.test(w)) continue;
    tagCount.set(w, (tagCount.get(w) || 0) + 1);
  }
  const tags = [...tagCount.entries()]
    .filter(([w, n]) => (n >= 2 || /^[A-Z]{2,}$/.test(w)) && w.length >= 3 && !w.endsWith('-'))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([w]) => w);

  return {
    title: coverTitle,
    subtitle,
    numbers,
    formula,
    steps: h2.slice(0, 6),
    claims,
    tags,
    sourceUrl: sourceUrl || meta?.source?.url || '',
    sections: h2.length,
  };
}

/**
 * 自动决定视觉结构（确定性）：
 *   主结构：有 ≥3 个结论数字 → 数据图（坐标轴 + 折线）；否则 ≥3 个小节 → 流程图；否则概念放射图。
 *   辅助模块：公式 / 决策树（有消融·对比·选择·边界类小节）/ 代码结构（有代码块）/ 时间轴（出现 ≥2 个年份）。
 */
export function chooseCoverStructure(content = {}) {
  const steps = content.steps || [];
  const numbers = content.numbers || [];
  const text = `${steps.join(' ')} ${(content.claims || []).join(' ')}`;
  const years = new Set((String(text).match(/\b(19|20)\d{2}\b/g) || []));

  // 主结构只有三种：数据条 / 流程链路 / 概念放射。
  // 数字不够多、而小节本身就构成一条链路时，流程比「三根柱子」更像在研究一篇论文。
  const manyNumbers = numbers.length >= 4 || (numbers.length >= 3 && steps.length < 4);
  const primary = manyNumbers ? 'curve' : steps.length >= 3 ? 'pipeline' : numbers.length ? 'curve' : 'concept';
  const modules = [];
  if (content.formula) modules.push('formula');
  if (/消融|对比|变体|选择|取舍|边界|ablation/i.test(text)) modules.push('tree');
  if (/```/.test(String(content.markdown || '')) || /代码|实现|伪代码|算法/i.test(steps.join(' '))) modules.push('code');
  if (years.size >= 2) modules.push('timeline');
  if ((content.claims || []).length) modules.push('annotation');
  if (numbers.length) modules.push('axes');

  const reason =
    primary === 'curve'
      ? `有 ${numbers.length} 个结论数字 → 以坐标轴/数据图为中心`
      : primary === 'pipeline'
        ? `${steps.length} 个小节 → 以流程链路为中心`
        : '结论数字与小节都不足 → 以概念结构为中心';

  return { primary, modules, reason };
}

/**
 * 单节配图提炼：把一个小节压成「一张手绘重述图」需要的元素。
 *
 * 与整篇头图的区别：
 *   - 数字只看这一节（阈值放宽到 2 个），小节里往往只报一个结论；
 *   - 流程节点从这一节的短句里取（每句截断成 12~30 字的「动作」），最多 4 个；
 *   - 批注只取这一节的归因句（论文称/实验显示）。
 */
export function distillSectionFigure({ heading = '', body = '', tags = [] } = {}) {
  const title = stripDecorative(plainLine(heading)).replace(/^[^：:]*[：:]\s*/, '').slice(0, 40);
  const clean = String(body || '').replace(/```[\s\S]*?```/g, ' ');
  const section = { heading: heading || '本节', body: clean };

  const seen = new Set();
  const numbers = [];
  const pushNumber = (sentence, token) => {
    if (numbers.length >= 3) return;
    const unit = String(token).replace(/^[\d.,]+/, '').trim();
    if (unit && CONFIG_UNIT_RE.test(unit)) return;
    // 小节配图不要「1 个 / 2 个」这类没信息量的计数（三位以上的配置数字仍保留）
    if (!unit && /^\d{1,2}$/.test(String(token))) return;
    if (!(RESULT_UNIT_RE.test(token) || RESULT_UNIT_RE.test(sentence))) return;
    const key = numberValue(token) != null ? `v:${numberValue(token)}` : normalizeNumberToken(token);
    if (seen.has(key)) return;
    seen.add(key);
    const ctx = numberContext(sentence, token);
    // 小节配图的标签：只有指标词（BLEU / accuracy / %）才用，
    // 像 model / only / low-rank 这种泛词一律换成小节标题，否则整列标签没信息量
    // 指标词才当标签；泛词（model / only）宁可不写，条件句里已经有上下文了
    const label = METRIC_LABEL_RE.test(ctx.label || '') ? ctx.label : '';
    const condition = sentence.replace(/[*_`#|]/g, '').replace(/\s+/g, ' ').trim();
    numbers.push({
      value: `${ctx.digits}${ctx.unitWord ? ` ${ctx.unitWord}` : ''}`.slice(0, 18),
      label: String(label).slice(0, 14),
      // 条件句按词/标点边界截断，别把「同样 51」这种半截数字留在图上
      condition: condition.length > 64 ? `${condition.slice(0, 62).replace(/[\s，,。.;；:：]\S*$/, '')}…` : condition,
    });
  };
  for (const sentence of sentences(clean)) {
    for (const token of extractNumberTokens(sentence)) pushNumber(sentence, token);
    if (numbers.length >= 3) break;
  }

  // 流程节点：取本节里最像「动作/结论」的短句，压到 30 字以内
  const steps = [];
  for (const sentence of sentences(clean)) {
    if (steps.length >= 4) break;
    const t = sentence.replace(/[*_`#>|]/g, '').replace(/\s+/g, ' ').trim();
    if (t.length < 8) continue;
    steps.push(t.length > 30 ? `${t.slice(0, 29)}…` : t);
  }

  const blockFormula = clean.match(/\$\$([\s\S]{4,240}?)\$\$/);
  const inlineFormula = [...clean.matchAll(/\$([^$\n]{4,120})\$/g)].map((m) => m[1]).find(looksLikeMath);
  const latex = blockFormula ? blockFormula[1].trim() : inlineFormula || '';
  const formula = latex ? { latex, caption: '本节公式' } : null;

  const claims = [];
  for (const sentence of sentences(clean)) {
    if (claims.length >= 2) break;
    if (!ATTRIBUTION_RE.test(sentence)) continue;
    const t = sentence.replace(/[*_`#>|]/g, '').replace(/\s+/g, ' ').trim();
    if (t.length >= 12) claims.push(t.slice(0, 70));
  }

  const primary = numbers.length >= 2 ? 'curve' : steps.length >= 2 ? 'pipeline' : 'concept';
  const modules = [];
  if (formula) modules.push('formula');
  if (/消融|对比|变体|取舍|边界/.test(clean)) modules.push('tree');
  if (claims.length) modules.push('annotation');

  return {
    title: title || '本节',
    numbers,
    steps,
    formula,
    claims,
    tags: (tags || []).slice(0, 4),
    primary,
    modules,
  };
}
