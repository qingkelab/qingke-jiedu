/**
 * Evidence Retrieval（轻量词法检索）
 *
 * 逐节写作时不再喂「正文前 16000 字」，而是按当前小节的语义，从全文 chunks 里召回最相关的
 * 证据片段（保留 chunk id），再补少量全局上下文（摘要 / 研究地图 / 前文）。
 *
 * 排序 = 章节角色先验（方法/结果/局限各有偏好）+ 与当前节标题/要点的词法重合（lexical overlap）
 *        + 关键词命中（数据集/指标/消融/失败案例）+ 数字密度。
 *
 * 不引入 embedding / 向量库：中文用 2-gram，英文用词干化到小写词，够用且零依赖。
 */

import { tokenize } from './chunker.js';

/** 章节角色：决定召回偏好。 */
export const SECTION_ROLES = {
  method: {
    keys: /方法|机制|模型|架构|算法|训练|实现|组件|算子|从输入|输入到输出|method|approach|model|architecture|algorithm|training|framework|implementation/i,
    sectionHints: /method|approach|model|architecture|algorithm|framework|implementation|formulation|方法|模型|架构|算法|训练|实现|公式/i,
    types: { formula: 3.2, figure: 2.2, paragraph: 1, table: 0.8, list: 1.1, abstract: 0.6 },
    keywords: /architecture|overview|pipeline|component|algorithm|objective|loss|训练|架构|组件|算法|损失|目标函数/i,
  },
  results: {
    keys: /结果|实验|评测|性能|证据|对比|result|experiment|evaluation|benchmark|performance|comparison/i,
    sectionHints: /experiment|evaluation|result|benchmark|analysis|ablation|实验|评估|结果|分析|消融/i,
    types: { table: 3.0, figure: 2.0, paragraph: 1.1, formula: 0.8, list: 1.0, abstract: 0.5 },
    keywords: /BLEU|accuracy|F1|score|SOTA|baseline|对比|基线|提升|达到|超过|表格|Table|Figure/i,
  },
  limitation: {
    keys: /局限|边界|失效|风险|讨论|未来|失败|limitation|boundary|failure|discussion|future|threat/i,
    sectionHints: /limitation|discussion|conclusion|future|failure|ablation|局限|讨论|结论|失败|消融|未来/i,
    types: { paragraph: 1.2, table: 1.0, list: 1.0, formula: 0.5, figure: 0.8, abstract: 0.5 },
    keywords: /limitation|only|however|fail|failure|degrade|constrain|assume|boundary|not|局限|仅在|失败|退化|假设|未验证/i,
  },
  formula: {
    keys: /公式|推导|损失|目标函数|equation|formula|derivation|loss|objective/i,
    sectionHints: /method|approach|formulation|derivation|公式|推导|方法/i,
    types: { formula: 4.0, paragraph: 1.0, figure: 1.0, table: 0.5, list: 0.8, abstract: 0.4 },
    keywords: /\\frac|\\sum|\\theta|\\alpha|\\beta|loss|objective|gradient|estimate|公式|损失|目标/i,
  },
  intro: {
    keys: /导语|背景|动机|问题|为什么|introduction|motivation|background|problem/i,
    sectionHints: /introduction|background|motivation|abstract|related|引言|背景|动机|摘要|相关/i,
    types: { abstract: 2.8, paragraph: 1.1, figure: 1.2, list: 1.0, formula: 0.6, table: 0.6 },
    keywords: /motivation|problem|challenge|gap|prior|we study|问题|挑战|动机|缺口|既有/i,
  },
  general: {
    keys: /.*/,
    sectionHints: /.*/,
    types: { paragraph: 1.2, table: 1.1, figure: 1.1, formula: 1.0, list: 1.0, abstract: 1.2 },
    keywords: /.*/,
  },
};

/** 根据小节标题/要点判断章节角色，供召回偏好与提示词使用。 */
export function sectionRole(title, note = '') {
  const s = `${title} ${note}`;
  // 顺序有讲究：先判方法/结果，再判局限（「结果与局限」这类混合标题优先按后者覆盖正文）
  for (const role of ['method', 'results', 'limitation', 'formula', 'intro']) {
    if (SECTION_ROLES[role].keys.test(s)) return role;
  }
  return 'general';
}

/** 查询词：小节标题、要点、研究地图相关信息。 */
function queryTerms(section, researchMap) {
  const parts = [section.title, section.note || ''];
  const role = section.role || sectionRole(section.title, section.note);
  if (researchMap) {
    const push = (arr) => {
      for (const item of arr || []) parts.push(typeof item === 'string' ? item : item?.text || '');
    };
    if (role === 'method') {
      push(researchMap.method_components);
      push(researchMap.equations);
      push(researchMap.key_claims);
    } else if (role === 'results') {
      push(researchMap.main_results);
      push(researchMap.datasets);
      push(researchMap.benchmarks);
      push(researchMap.baselines);
      push(researchMap.ablations);
    } else if (role === 'limitation') {
      push(researchMap.limitations);
      push(researchMap.ablations);
    } else {
      push(researchMap.key_claims);
      if (researchMap.problem) parts.push(researchMap.problem);
    }
  }
  return tokenize(parts.join(' '));
}

function termScore(chunkTerms, query) {
  if (!query.length) return 0;
  const set = new Set(chunkTerms);
  let hits = 0;
  for (const q of query) if (set.has(q)) hits += 1;
  return hits / Math.sqrt(query.length);
}

/** 数字密度：含具体数字的 chunk 在结果节更值钱。 */
function numberDensity(chunk) {
  const n = (chunk.numbers || []).length;
  return n === 0 ? 0 : Math.min(1, n / 6);
}

/**
 * 给单个 chunk 打分。
 * @param {object} chunk
 * @param {object} ctx {queryTerms, role, researchMap, figureIds}
 */
export function scoreChunk(chunk, ctx) {
  const role = SECTION_ROLES[ctx.role] || SECTION_ROLES.general;
  let score = 0;

  score += 2.4 * termScore(chunk.terms || [], ctx.queryTerms);
  if (role.sectionHints.test(chunk.sectionTitle || '')) score += 1.6;
  if (role.sectionHints.test(chunk.sectionPath || '')) score += 0.6;
  score += (role.types[chunk.type] ?? 1) - 1;
  if (role.keywords.test(chunk.text)) score += 0.9;

  // 结果节：数字越多越可能承载实验结论
  if (ctx.role === 'results') score += 1.1 * numberDensity(chunk);
  if (ctx.role === 'method' && chunk.type === 'formula') score += 0.8;

  // 研究地图里点名的证据 chunk 直接加权
  if (ctx.evidenceIds?.has(chunk.id)) score += 2.2;
  // 图注与当前节要引用的图相关时加权
  if (ctx.figureIds?.has(chunk.id)) score += 1.2;
  // 参考文献 / 致谢这类噪声降权
  if (/references|bibliography|acknowledg|参考文献|致谢/i.test(chunk.sectionTitle || '')) score -= 3;

  return score;
}

/**
 * 为某小节召 evidence。
 * @returns {{evidence:Array, chunkIds:string[], figureNums:number[], roles:string, chars:number}}
 */
export function retrieveForSection({
  structure,
  section,
  researchMap = null,
  figures = [],
  figureIndex = null,
  budgetChars = 6000,
  maxChunks = 12,
  minChunks = 4,
} = {}) {
  const chunks = structure?.chunks || [];
  if (!chunks.length) return { evidence: [], chunkIds: [], figureNums: [], roles: 'none', chars: 0 };

  const role = section.role || sectionRole(section.title, section.note);
  const terms = queryTerms(section, researchMap);
  const evidenceIds = new Set();
  for (const item of researchMap?.evidence || []) {
    for (const id of item?.chunkIds || []) evidenceIds.add(id);
  }

  // 当前小节附近（按标题匹配）的 chunk 优先：先保证「本节原文」在场
  const sameSection = chunks.filter((c) => matchesSection(c, section));
  const figureIds = new Set();
  const figureNums = [];
  for (const f of figures || []) {
    if (matchesSectionText(section, f.sectionTitle || '') || matchesSectionText(section, f.caption || '')) {
      figureIds.add(f.chunkId || '');
      if (f.num) figureNums.push(f.num);
    }
  }

  const scored = chunks
    .map((c) => ({ chunk: c, score: scoreChunk(c, { queryTerms: terms, role, evidenceIds, figureIds }) + (sameSection.includes(c) ? 1.4 : 0) }))
    .sort((a, b) => b.score - a.score || a.chunk.index - b.chunk.index);

  const picked = [];
  let chars = 0;
  // 预算小时至少保 1 条证据；预算充足时至少保 minChunks 条（避免只剩零散片段）
  const minTake = Math.min(minChunks, Math.max(1, Math.floor(budgetChars / 1500)));
  const take = (list) => {
    for (const item of list) {
      if (picked.length >= maxChunks) return;
      if (picked.some((p) => p.chunk.id === item.chunk.id)) continue;
      const size = item.chunk.text.length;
      if (chars + size > budgetChars && picked.length >= minTake) continue;
      picked.push(item);
      chars += size;
    }
  };
  // 先放本节原文，再按得分补全（保持原文档顺序输出，方便模型理解）
  take(sameSection.map((c) => ({ chunk: c, score: 99 })));
  take(scored);

  const ordered = picked.map((p) => p.chunk).sort((a, b) => a.index - b.index);
  return {
    evidence: ordered.map((c) => ({
      id: c.id,
      sectionTitle: c.sectionTitle,
      type: c.type,
      text: c.text,
      score: Number((scored.find((s) => s.chunk.id === c.id)?.score || 0).toFixed(3)),
    })),
    chunkIds: ordered.map((c) => c.id),
    figureNums,
    roles: role,
    chars,
  };
}

/** chunk 是否属于小节（按标题模糊匹配）。 */
function matchesSection(chunk, section) {
  return matchesSectionText(section, chunk.sectionTitle || '') || matchesSectionText(section, chunk.sectionPath || '');
}

function matchesSectionText(section, text) {
  const a = normalizeKey(section.title || '');
  const b = normalizeKey(text || '');
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  // 取中文/英文关键词重合
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  let hits = 0;
  for (const t of ta) if (tb.has(t)) hits += 1;
  return hits >= 2;
}

function normalizeKey(s) {
  return String(s || '').toLowerCase().replace(/[\s\-_：:，,。.、（）()【】\[\]]+/g, '');
}

/**
 * 全局上下文：摘要/导语 + 研究地图要点 + 关键图注。
 * 逐节写作时都会带上，保证「研究主线」不断。
 */
export function buildGlobalContext({
  structure,
  researchMap,
  figures = [],
  maxChars = 2600,
} = {}) {
  const parts = [];
  const abs = (structure?.chunks || []).filter((c) => c.type === 'abstract').slice(0, 2);
  const intro = (structure?.chunks || []).filter((c) => /introduction|引言|背景/i.test(c.sectionTitle)).slice(0, 1);
  for (const c of [...abs, ...intro]) parts.push(`【${c.sectionTitle}】${c.text}`);

  if (researchMap) {
    const rs = [];
    if (researchMap.problem) rs.push(`问题：${researchMap.problem}`);
    for (const claim of (researchMap.key_claims || []).slice(0, 4)) rs.push(`主张：${asText(claim)}`);
    for (const r of (researchMap.main_results || []).slice(0, 5)) rs.push(`主要结果：${asText(r)}`);
    for (const a of (researchMap.ablations || []).slice(0, 3)) rs.push(`消融：${asText(a)}`);
    for (const l of (researchMap.limitations || []).slice(0, 3)) rs.push(`局限：${asText(l)}`);
    if (rs.length) parts.push(`【研究地图】\n${rs.join('\n')}`);
  }

  const figLines = (figures || [])
    .slice(0, 12)
    .map((f) => `图${f.num}：${(f.caption || '').slice(0, 90)}${f.sectionTitle ? `（对应 ${f.sectionTitle}）` : ''}`);
  if (figLines.length) parts.push(`【图片索引】\n${figLines.join('\n')}`);

  let out = parts.join('\n\n');
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}…`;
  return out;
}

function asText(item) {
  if (item == null) return '';
  if (typeof item === 'string') return item;
  return item.text || item.claim || item.value || JSON.stringify(item);
}

/**
 * 把 evidence 渲染成提示词里的证据块（带 chunk id，便于模型与审计引用）。
 */
export function renderEvidence(evidence) {
  return (evidence || [])
    .map((e) => `[${e.id}]（${e.sectionTitle}·${e.type}）${e.text}`)
    .join('\n\n');
}
