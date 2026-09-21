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
import { alignSourceSections, buildSourceSectionIndex, sourceNeighborhood } from './sourceSections.js';

/**
 * 角色词汇表：每个角色的「领域内必现词」。
 *
 * 这是跨语言失配的补偿手段之一：中文大纲词命中不了英文原文，但角色词汇表里的
 * ablation / variant / w/o / failure / broader impacts 这类词是**论文原文的英文用法**，
 * 能直接在英文 chunk 上命中。
 */
export const ROLE_VOCAB = {
  method:
    'method approach architecture model component module algorithm framework implementation formulation objective loss training inference input output',
  results:
    'result table benchmark dataset metric baseline comparison outperform improvement accuracy score success rate evaluation main results',
  ablation:
    'ablation ablations variant variants model variations component removal remove removing without w/o with sensitivity comparison table figure baseline hyperparameter dropout smoothing scaling parameter study analysis',
  limitation:
    'limitation limitations failure failure case failure cases unsuccessful weakness constraint caveat ethics ethical broader impacts risk future work discussion appendix partial success assumption',
  discussion:
    'discussion conclusion reproducible reproducibility community takeaway judgement open question limitation',
  formula: 'equation formula derivation loss objective gradient notation symbol',
  intro: 'motivation problem challenge gap background introduction prior work',
  general: '',
};

/** 角色 → 中文辅助词（只作辅助，不替代英文术语）。 */
const ROLE_VOCAB_ZH = {
  ablation: '消融 变体 敏感性 去掉 移除 对比',
  limitation: '局限 失败 失败案例 风险 约束 未来工作 边界',
  results: '结果 实验 指标 表格 基线 提升',
  method: '方法 机制 架构 组件 公式',
  discussion: '讨论 结论 复现 社区',
  formula: '公式 推导 目标函数',
  intro: '背景 动机 问题',
  general: '',
};

/** 解析 mustUseTerms 里的结构化引用：Table 3 / Figure 5 / Eq. 4（含中文「表 3」「图 5」）。 */
export function parseReferenceTerms(terms = []) {
  const tables = new Set();
  const figures = new Set();
  const equations = new Set();
  for (const raw of terms || []) {
    const s = String(raw || '');
    let m = s.match(/\b(?:table|tab\.)\s*\.?\s*(\d{1,2})/i) || s.match(/表\s*(\d{1,2})/);
    if (m) tables.add(Number(m[1]));
    m = s.match(/\b(?:fig(?:ure)?\.?)\s*(\d{1,2})/i) || s.match(/图\s*(\d{1,2})/);
    if (m) figures.add(Number(m[1]));
    m = s.match(/\b(?:eq(?:uation)?|formula)\s*\.?\s*(\d{1,2})/i) || s.match(/式\s*(\d{1,2})/);
    if (m) equations.add(Number(m[1]));
  }
  return { tables, figures, equations };
}

/**
 * 证据槽位分配：把 maxChunks 按「来源类别」切分，而不是无脑 top-N。
 * 默认 12 槽 = 3 source-local + 3 must-use/evidence + 2 role-specific + 2 diverse + 2 lexical。
 * 某类没有候选时，额度自动让给 lexical，不会浪费预算。
 */
export function allocateEvidenceSlots({
  maxChunks = 12,
  hasSourceLocal = false,
  hasMustUse = false,
  hasEvidence = false,
} = {}) {
  const total = Math.max(1, Number(maxChunks) || 1);
  const base = [
    ['sourceLocal', 3],
    ['mustUse', 3],
    ['roleSpecific', 2],
    ['diverse', 2],
    ['lexical', 2],
  ];
  const scale = total / 12;
  const slots = {};
  let sum = 0;
  for (const [key, value] of base) {
    const n = total >= 5 ? Math.max(1, Math.round(value * scale)) : key === 'sourceLocal' || key === 'mustUse' ? 1 : 0;
    slots[key] = n;
    sum += n;
  }
  const shrinkOrder = ['lexical', 'diverse', 'roleSpecific', 'mustUse'];
  let guard = 0;
  while (sum > total && guard < 50) {
    guard += 1;
    for (const key of shrinkOrder) {
      if (sum <= total) break;
      if (slots[key] > 0) {
        slots[key] -= 1;
        sum -= 1;
      }
    }
    if (Object.values(slots).every((v) => v === 0)) break;
  }
  while (sum < total) {
    slots.lexical += 1;
    sum += 1;
  }
  if (!hasSourceLocal && slots.sourceLocal) {
    slots.lexical += slots.sourceLocal;
    slots.sourceLocal = 0;
  }
  if (!hasMustUse && !hasEvidence && slots.mustUse) {
    slots.roleSpecific += slots.mustUse;
    slots.mustUse = 0;
  }
  return slots;
}

/**
 * 证据类别：给「主结果 / 消融 / 局限 / 失败案例 / 伦理 / broader impacts / 附录」建独立召回规则。
 *
 * 动机（Benchmark v1 实测）：论文真正值钱的内容常常在**后半篇**——失败案例、消融变体、局限、
 * ethics / broader impacts 附录。只看小节标题做词法召回时这些片段容易整段缺席，
 * 于是终稿看起来结构完整，却漏掉了论文的边界结论。
 *
 * 规则只有正则，不引入 embedding / 向量库，保持确定性。
 */
export const EVIDENCE_CATEGORIES = {
  main_results: /result|results|table|table\s*\d|benchmark|leaderboard|score|accuracy|bleu|f1|sota|state[- ]of[- ]the[- ]art|结果|实验|指标|得分|表格|准确率/i,
  ablations:
    /ablation|ablate|variant|variation|model variations|component analysis|component removal|w\/o|without\s+the|sensitivity|comparison|compare|参数|变体|组件分析|消融|去掉|移除|不加|对比/i,
  limitations: /limitation|limitations|boundary|caveat|constraint|局限|边界|失效|限制/i,
  failure_cases: /failure case|failure mode|failed to|fails to|behavior analysis|error analysis|taxonomy|失败案例|失败模式|失败原因|失效案例/i,
  ethics: /ethic|ethics|ethical|misuse|malicious|harmful|safety|harm\b|伦理|滥用|安全|有害/i,
  broader_impacts: /broader impact|broader impacts|societal|social impact|impact statement|更广泛的影响|社会影响|影响声明/i,
  appendix: /\bappendix\b|appendix\s+[a-z]|附录|^[a-z]\.\d|[a-z]\.\d+\s/i,
  future_work: /future work|future direction|open question|unsuccessful|attempts|limitations and future|后续工作|未来工作|开放问题|失败的尝试/i,
  discussion: /discussion|conclusion|结论|讨论|分析/i,
};

/** 判断 chunk 命中的证据类别集合。 */
export function chunkCategories(chunk) {
  const hay = `${chunk?.sectionTitle || ''} ${chunk?.sectionPath || ''} ${chunk?.text || ''}`;
  const out = new Set();
  for (const [name, re] of Object.entries(EVIDENCE_CATEGORIES)) {
    if (re.test(hay)) out.add(name);
  }
  return out;
}

/** 各章节角色对证据类别的偏好权重（结果 / 消融 / 局限各自的召回重点）。 */
const ROLE_CATEGORY_BOOST = {
  results: { main_results: 1.2, ablations: 0.8, appendix: 0.4 },
  ablation: { ablations: 1.6, main_results: 0.9, appendix: 0.5 },
  limitation: { limitations: 1.4, failure_cases: 1.3, ethics: 1.2, broader_impacts: 1.1, future_work: 0.9, appendix: 0.8 },
  discussion: { discussion: 1.0, limitations: 0.8, future_work: 0.6 },
  method: { appendix: 0.2 },
  intro: { main_results: 0.6, limitations: 0.4 },
  formula: { main_results: 0.2 },
  general: {},
};

/** 需要「后半篇最低召回保障」的角色：方法与公式节不做，避免把机制解释挤掉。 */
const LATE_GUARANTEE_ROLES = new Set(['results', 'limitation', 'ablation', 'discussion', 'general', 'intro']);

/** 后半篇 bonus 只给这些角色，且必须「相关」才给（见 scoreChunk）。 */
const LATE_BONUS_ROLES = new Set(['results', 'limitation', 'ablation']);

const NOISE_SECTION_RE = /references|bibliography|acknowledg|参考文献|致谢/i;

function positionRatio(chunk, total) {
  if (!total || total <= 1) return 0;
  return chunk.index / (total - 1);
}

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
  // 消融是独立角色：它有自己的一套词汇（variant / w\/o / sensitivity / dropout），
  // 和「主结果」不是一回事，混用会导致 1706 这类论文的 label smoothing 消融整段进不来。
  ablation: {
    keys: /消融|ablation|ablations|variant|variations?|变体|敏感性|sensitivity|去掉|移除|组件分析/i,
    sectionHints: /ablation|variations?|variant|analysis|sensitivity|experiment|消融|变体|分析|实验/i,
    types: { table: 3.0, figure: 1.8, paragraph: 1.1, formula: 0.9, list: 1.0, abstract: 0.4 },
    keywords:
      /ablation|variant|w\/o|without|remove|removal|sensitivity|dropout|smoothing|hyperparameter|scaling|baseline|消融|变体|去掉|移除|敏感性|参数量|对比/i,
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
  discussion: {
    keys: /社区|讨论|结论|复现|可复现|怎么看|判断|discussion|conclusion|reproducib|takeaway|community/i,
    sectionHints: /discussion|conclusion|reproducib|community|limitation|讨论|结论|复现|社区/i,
    types: { paragraph: 1.2, list: 1.1, table: 0.9, figure: 0.9, formula: 0.6, abstract: 0.5 },
    keywords: /reproducib|open[- ]source|code|community|conclusion|limitation|结论|复现|开源|社区|局限/i,
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
  // 顺序有讲究：
  //  - 先判方法/结果（「关键实验结果与消融」这类混合标题仍按 results，保持既有行为）；
  //  - 再判 ablation（只有真正以消融/变体/敏感性为主的小节才落到这里）；
  //  - 然后局限 → 公式 → 讨论 → 导语。
  for (const role of ['method', 'results', 'ablation', 'limitation', 'formula', 'discussion', 'intro']) {
    if (SECTION_ROLES[role].keys.test(s)) return role;
  }
  return 'general';
}

/** 研究地图里与当前角色相关的条目文本。 */
function mapItemsForRole(researchMap, role) {
  if (!researchMap) return [];
  const pick = (arr) => (arr || []).map((x) => (typeof x === 'string' ? x : x?.text || x?.claim || '')).filter(Boolean);
  if (role === 'method') return [...pick(researchMap.method_components), ...pick(researchMap.equations), ...pick(researchMap.key_claims)];
  if (role === 'results') {
    return [...pick(researchMap.main_results), ...pick(researchMap.datasets), ...pick(researchMap.benchmarks), ...pick(researchMap.baselines)];
  }
  if (role === 'ablation') return [...pick(researchMap.ablations), ...pick(researchMap.main_results), ...pick(researchMap.benchmarks), ...pick(researchMap.baselines)];
  if (role === 'limitation') return [...pick(researchMap.limitations), ...pick(researchMap.ablations)];
  if (role === 'discussion') return [...pick(researchMap.limitations), ...pick(researchMap.key_claims)];
  if (role === 'formula') return [...pick(researchMap.equations), ...pick(researchMap.method_components)];
  return [...pick(researchMap.key_claims), researchMap.problem || ''].filter(Boolean);
}

/**
 * 结构化 query：**不再把标题/要点/地图拼成一个字符串**，而是按来源分组，分别评分。
 * 优先级：sourceSections > mustUseTerms > 研究地图证据 > 原文标题 > 角色词 > 中文标题/要点。
 */
export function buildSectionQuery({ section = {}, role = 'general', researchMap = null, sourceMatch = null, index = null } = {}) {
  const matchedTitles = (sourceMatch?.matched || []).map((m) => m.title);
  const matchedPaths =
    index && sourceMatch?.sectionIds?.length
      ? index.sections.filter((s) => sourceMatch.sectionIds.includes(s.id)).map((s) => s.path)
      : [];
  const sourceSectionTerms = tokenize([...matchedTitles, ...matchedPaths].join(' '));

  const mustUseTerms = (section.mustUseTerms || []).map((t) => String(t || '').trim()).filter(Boolean);
  const mustUseTermTokens = tokenize(mustUseTerms.join(' '));

  const evidenceTexts = mapItemsForRole(researchMap, role);
  const evidenceTerms = tokenize(evidenceTexts.join(' '));

  const roleTerms = tokenize(`${ROLE_VOCAB[role] || ''} ${ROLE_VOCAB_ZH[role] || ''}`);
  const purposeTerms = tokenize([section.purpose, section.note, section.title].filter(Boolean).join(' '));
  // 中文标题/要点只作为辅助信号（权重最低，且不参与 sourceSection 评分）
  const titleTerms = tokenize(String(section.title || ''));

  const all = [...new Set([...sourceSectionTerms, ...mustUseTermTokens, ...evidenceTerms, ...roleTerms, ...purposeTerms, ...titleTerms])];
  return {
    sourceSectionTerms,
    mustUseTerms,
    mustUseTermTokens,
    evidenceTerms,
    roleTerms,
    purposeTerms,
    titleTerms,
    all,
    matchedTitles,
  };
}

/** 兼容旧的内部调用（queryTerms 只被本模块与测试间接使用）。 */
function queryTerms(section, researchMap) {
  const role = section.role || sectionRole(section.title, section.note);
  return buildSectionQuery({ section, role, researchMap }).all;
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
 * @param {object} ctx
 *   {queryTerms, sourceTerms, mustUseTokens, mustUseHits, role, evidenceIds, figureIds, categories,
 *    totalChunks, sourceSectionIds, neighborhoodIds, usedBefore, refs, tableOrdinal, figureOrdinal, formulaOrdinal}
 */
export function scoreChunk(chunk, ctx) {
  const role = SECTION_ROLES[ctx.role] || SECTION_ROLES.general;
  let score = 0;

  // 1) 多源 lexical：全量 query 打底，source section 词再单独加权
  score += 2.0 * termScore(chunk.terms || [], ctx.queryTerms);
  if (ctx.sourceTerms?.length) score += 2.4 * termScore(chunk.terms || [], ctx.sourceTerms);
  if (ctx.mustUseTokens?.length) score += 1.2 * termScore(chunk.terms || [], ctx.mustUseTokens);

  if (role.sectionHints.test(chunk.sectionTitle || '')) score += 1.6;
  if (role.sectionHints.test(chunk.sectionPath || '')) score += 0.6;
  score += (role.types[chunk.type] ?? 1) - 1;
  if (role.keywords.test(chunk.text)) score += 0.9;

  // 2) mustUseTerms 字面命中（论文术语/表号/图号直接出现在 chunk 文本里）
  const mustHits = ctx.mustUseHits?.get(chunk.id) || 0;
  if (mustHits > 0) score += 1.0 + 1.2 * Math.min(3, mustHits);

  // 3) source section 归属（本次最关键的新信号）与 source-local 邻域
  if (ctx.sourceSectionIds?.size && ctx.sourceSectionIds.has(chunk.sectionId)) score += 3.0;
  if (ctx.neighborhoodIds?.has(chunk.id)) score += 2.0;

  // 4) 图/表/公式的结构化绑定（Table 3 → 第 3 个 table chunk，而不是只看字符串）
  if (ctx.refs) {
    if (chunk.type === 'table' && ctx.refs.tables?.has(ctx.tableOrdinal?.get(chunk.id))) score += 2.5;
    if (chunk.type === 'figure' && ctx.refs.figures?.has(ctx.figureOrdinal?.get(chunk.id))) score += 2.5;
    if (chunk.type === 'formula' && ctx.refs.equations?.has(ctx.formulaOrdinal?.get(chunk.id))) score += 2.2;
    if (ctx.refs.captionRe && ctx.refs.captionRe.test(chunk.text)) score += 1.2;
  }

  // 结果节：数字越多越可能承载实验结论
  if (ctx.role === 'results') score += 1.1 * numberDensity(chunk);
  if (ctx.role === 'ablation') score += 0.8 * numberDensity(chunk);
  if ((ctx.role === 'method' || ctx.role === 'formula') && chunk.type === 'formula') score += 0.8;

  // 研究地图里点名的证据 chunk 直接加权
  if (ctx.evidenceIds?.has(chunk.id)) score += 2.2;
  // 图注与当前节要引用的图相关时加权
  if (ctx.figureIds?.has(chunk.id)) score += 1.2;
  // 证据类别加权：结果节偏主结果/表格，局限节偏局限/失败案例/伦理/broader impacts/附录
  const categories = ctx.categories?.get(chunk.id);
  if (categories) {
    const boost = ROLE_CATEGORY_BOOST[ctx.role] || {};
    for (const [name, weight] of Object.entries(boost)) if (categories.has(name)) score += weight;
  }
  // 后半篇 bonus：**必须相关才给**（命中本节 source section / mustUse / 地图证据 / 词法），
  // 不是「后半篇无脑优先」。
  if (ctx.totalChunks && LATE_BONUS_ROLES.has(ctx.role)) {
    const pos = positionRatio(chunk, ctx.totalChunks);
    const relevant =
      mustHits > 0 ||
      ctx.neighborhoodIds?.has(chunk.id) ||
      ctx.evidenceIds?.has(chunk.id) ||
      (ctx.sourceSectionIds?.size && ctx.sourceSectionIds.has(chunk.sectionId)) ||
      termScore(chunk.terms || [], ctx.queryTerms) >= 0.12;
    if (pos >= 0.5 && relevant) score += ctx.role === 'ablation' ? 0.8 : 0.6;
  }

  // 跨节多样性惩罚：同一 chunk 被前面小节用过 → 降分（关键证据豁免）
  const usedBefore = ctx.usedBefore?.get(chunk.id) || 0;
  if (usedBefore > 0) {
    const critical =
      mustHits > 0 ||
      ctx.neighborhoodIds?.has(chunk.id) ||
      ctx.evidenceIds?.has(chunk.id) ||
      (ctx.sourceSectionIds?.size && ctx.sourceSectionIds.has(chunk.sectionId));
    if (!critical) score -= usedBefore === 1 ? 0.6 : 1.5;
  }
  // 参考文献 / 致谢这类噪声降权
  if (NOISE_SECTION_RE.test(chunk.sectionTitle || '')) score -= 3;

  return score;
}

/**
 * 为某小节召 evidence。
 *
 * Retrieval v2：**每个小节独立检索**，query 由「source section + mustUseTerms + 研究地图证据 +
 * 角色词 + 中文要点」五路构成；选片按证据槽位分配（source-local / must-use / role / diverse / lexical），
 * 并对「前面小节已用过的 chunk」施加多样性惩罚（关键证据豁免）。
 *
 * @returns {{evidence:Array, chunkIds:string[], figureNums:number[], roles:string, chars:number,
 *   uniqueChunkCount:number, reusedChunkCount:number, newChunkCount:number,
 *   query:object, sourceSectionMatch:object, slots:object, mustUseTermHits:number, mustUseTermTotal:number}}
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
  lateQuota = null,
  previousSectionChunkIds = [],
  sourceMatch = null,
  sourceIndex = null,
  criticalFacts = [],
  guaranteedAllocation = null,
} = {}) {
  const chunks = structure?.chunks || [];
  if (!chunks.length) {
    return {
      evidence: [],
      chunkIds: [],
      figureNums: [],
      roles: 'none',
      chars: 0,
      uniqueChunkCount: 0,
      reusedChunkCount: 0,
      newChunkCount: 0,
      query: null,
      sourceSectionMatch: null,
      slots: {},
      mustUseTermHits: 0,
      mustUseTermTotal: 0,
      criticalFactIds: [],
      criticalFactTotal: 0,
      criticalFactHitCount: 0,
      criticalFactMissCount: 0,
      criticalFactHitRate: null,
      guaranteedSlots: 0,
      guaranteedSections: [],
      supportedFactIds: [],
      allocationOverflow: [],
    };
  }

  const role = section.role || sectionRole(section.title, section.note);
  const index = sourceIndex || buildSourceSectionIndex(structure);
  const match =
    sourceMatch ||
    alignSourceSections({ requested: section.sourceSections || [], index, mustUseTerms: section.mustUseTerms || [] });
  const query = buildSectionQuery({ section, role, researchMap, sourceMatch: match, index });
  const terms = query.all;
  const evidenceIds = new Set();
  for (const item of researchMap?.evidence || []) {
    for (const id of item?.chunkIds || []) evidenceIds.add(id);
  }
  const categories = new Map();
  for (const c of chunks) categories.set(c.id, chunkCategories(c));

  // source-local：命中原文小节的 chunk（v2 的主通道）
  const sourceSectionIds = new Set(match.sectionIds || []);
  const neighborhoodIds = new Set(
    sourceNeighborhood({ index, structure, sectionIds: [...sourceSectionIds], maxPerSection: 6 }),
  );
  // 标题模糊匹配（v1 的「本节原文优先」，中文标题下多半命不中，保留作为兜底）
  const sameSection = chunks.filter((c) => matchesSection(c, section));

  // mustUseTerms 命中（字面、大小写不敏感；术语/表号/图号都算）
  const mustTerms = query.mustUseTerms;
  const mustUseHits = new Map();
  const mustUseHitTerms = new Set();
  if (mustTerms.length) {
    for (const c of chunks) {
      const lower = String(c.text || '').toLowerCase();
      let hits = 0;
      for (const t of mustTerms) {
        if (lower.includes(String(t).toLowerCase())) {
          hits += 1;
          mustUseHitTerms.add(t);
        }
      }
      if (hits) mustUseHits.set(c.id, hits);
    }
  }
  const refs = parseReferenceTerms(mustTerms);
  refs.captionRe = buildCaptionRefRegex(mustTerms);

  // 结构化序号：Table 3 → 文档里第 3 个 table chunk
  const tableOrdinal = new Map();
  const figureOrdinal = new Map();
  const formulaOrdinal = new Map();
  let tn = 0;
  let fn = 0;
  let en = 0;
  for (const c of chunks) {
    if (c.type === 'table') tableOrdinal.set(c.id, ++tn);
    else if (c.type === 'figure') figureOrdinal.set(c.id, ++fn);
    else if (c.type === 'formula') formulaOrdinal.set(c.id, ++en);
  }

  const figureIds = new Set();
  const figureNums = [];
  for (const f of figures || []) {
    if (matchesSectionText(section, f.sectionTitle || '') || matchesSectionText(section, f.caption || '')) {
      figureIds.add(f.chunkId || '');
      if (f.num) figureNums.push(f.num);
    }
  }

  const usedBefore = new Map();
  for (const id of previousSectionChunkIds || []) usedBefore.set(id, (usedBefore.get(id) || 0) + 1);

  // ===== Guaranteed Allocation（Plan Coverage v2）=====
  // 高优先级关键事实对应的 source section **先拿槽位**，再去跑 Retrieval v2 的正常排序。
  // 只做分配，不改打分：排序逻辑（token overlap / sourceSectionScore / diversity / rare term）一行未动。
  const garant = guaranteedAllocation || section.guaranteedAllocation || null;
  const picked = [];
  let chars = 0;
  const slotOf = new Map(); // chunkId → 槽位归类（用于 meta）
  const guaranteedTaken = [];
  const supportedFactIds = [];
  if (garant?.sections?.length) {
    const factList = garant.facts || [];
    const hitCount = (chunk) => {
      const lower = String(chunk.text || '').toLowerCase();
      let hits = 0;
      for (const f of factList) {
        for (const t of f.terms || []) if (t && lower.includes(String(t).toLowerCase())) hits += 2;
        for (const n of f.numbers || []) if (n != null && lower.includes(String(n))) hits += 1;
      }
      return hits;
    };
    const perSection = Math.max(1, Math.ceil((Number(garant.quota) || 2) / garant.sections.length));
    const takeChunk = (chunk) => {
      if (picked.length >= maxChunks) return false;
      if (picked.some((p) => p.chunk.id === chunk.id)) return false;
      const size = chunk.text.length;
      if (chars + size > budgetChars && picked.length >= 1) return false;
      picked.push({ chunk, score: hitCount(chunk) });
      chars += size;
      return true;
    };
    // ① 先放「明确承载 requiredNumbers / requiredTerms 的 chunk」——按「能覆盖多少个不同针尖」贪心排序，
    //    让 4 个保障槽尽量覆盖更多关键数字（97.3 / 2029 / 79.8 各自只出现在少数 chunk 里）。
    const requiredChunkIds = (garant.requiredChunks || []).filter((cid) => chunks.some((c) => c.id === cid));
    const needleScore = (id) => {
      const chunk = chunks.find((c) => c.id === id);
      if (!chunk) return 0;
      const lower = String(chunk.text || '').toLowerCase();
      const covered = new Set();
      for (const f of factList) {
        for (const t of f.terms || []) if (t && lower.includes(String(t).toLowerCase())) covered.add(`t:${String(t).toLowerCase()}`);
        for (const n of f.numbers || []) if (n != null && lower.includes(String(n))) covered.add(`n:${n}`);
      }
      return covered.size;
    };
    const orderedRequired = [...requiredChunkIds].sort((a, b) => needleScore(b) - needleScore(a) || a.localeCompare(b));
    for (const id of orderedRequired) {
      // 保障槽上限就是配额本身（默认由调用方按 spec 计算，通常是 4）
      if (guaranteedTaken.length >= Math.max(2, Number(garant.quota) || 4)) break;
      const chunk = chunks.find((c) => c.id === id);
      if (takeChunk(chunk)) {
        slotOf.set(chunk.id, 'guaranteed');
        guaranteedTaken.push(chunk.id);
      }
    }
    // ② 再按小节补足保障额度
    for (const title of garant.sections) {
      const zone = chunks
        .filter((c) => matchesSectionText({ title }, c.sectionTitle || '') || String(c.sectionTitle || '') === String(title))
        .map((c) => ({ c, hits: hitCount(c) }))
        .sort((a, b) => b.hits - a.hits || a.c.index - b.c.index);
      let added = 0;
      for (const item of zone) {
        if (added >= perSection) break;
        if (takeChunk(item.c)) {
          slotOf.set(item.c.id, 'guaranteed');
          guaranteedTaken.push(item.c.id);
          added += 1;
        }
      }
    }
    for (const f of factList) {
      const text = picked.map((p) => String(p.chunk.text || '').toLowerCase()).join('\n');
      const termOk = (f.terms || []).some((t) => t && text.includes(String(t).toLowerCase()));
      const numberOk = (f.numbers || []).some((n) => n != null && text.includes(String(n)));
      if (termOk || numberOk) supportedFactIds.push(f.id);
    }
  }

  const scored = chunks
    .map((c) => ({
      chunk: c,
      score:
        scoreChunk(c, {
          queryTerms: terms,
          sourceTerms: query.sourceSectionTerms,
          mustUseTokens: query.mustUseTermTokens,
          mustUseHits,
          role,
          evidenceIds,
          figureIds,
          categories,
          totalChunks: chunks.length,
          sourceSectionIds,
          neighborhoodIds,
          usedBefore,
          refs,
          tableOrdinal,
          figureOrdinal,
          formulaOrdinal,
        }) +
        (sameSection.includes(c) ? 1.4 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.chunk.index - b.chunk.index);

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

  // —— 证据槽位分配：不再是无脑 top-12 ——
  const byId = new Map(scored.map((s) => [s.chunk.id, s]));
  // chunkId → 槽位归类（guaranteed 已在保障分配阶段写入）
  const sourceLocalList = [];
  for (const id of neighborhoodIds) if (byId.has(id)) sourceLocalList.push(byId.get(id));
  for (const c of sameSection) if (byId.has(c.id) && !neighborhoodIds.has(c.id)) sourceLocalList.push(byId.get(c.id));

  const mustUseList = scored.filter((s) => mustUseHits.has(s.chunk.id) || evidenceIds.has(s.chunk.id));
  const roleBoost = ROLE_CATEGORY_BOOST[role] || {};
  const roleList = scored.filter((s) => {
    if (role === 'general' || role === 'none') return false;
    const cats = categories.get(s.chunk.id);
    // 只有「角色真正在意的类别」才算 role-specific（0.2 这种陪跑权重不算）
    if (cats && Object.entries(roleBoost).some(([name, weight]) => weight >= 0.5 && cats.has(name))) return true;
    return !!SECTION_ROLES[role]?.sectionHints?.test(s.chunk.sectionTitle || '');
  });
  const diverseList = scored.filter((s) => !usedBefore.has(s.chunk.id));
  const slots = allocateEvidenceSlots({
    maxChunks,
    hasSourceLocal: sourceLocalList.length > 0,
    hasMustUse: mustUseList.some((s) => mustUseHits.has(s.chunk.id)),
    hasEvidence: mustUseList.some((s) => evidenceIds.has(s.chunk.id)),
  });
  const takeSlot = (list, n, label) => {
    let added = 0;
    for (const item of list) {
      if (added >= n) break;
      const before = picked.length;
      take([item]);
      if (picked.length > before) {
        slotOf.set(item.chunk.id, label);
        added += 1;
      }
    }
    return added;
  };

  // 顺序：source-local → must-use/地图证据 → role → diverse → lexical
  takeSlot(sourceLocalList, slots.sourceLocal, 'sourceLocal');
  takeSlot(mustUseList, slots.mustUse, 'mustUse');
  takeSlot(roleList, slots.roleSpecific, 'roleSpecific');
  takeSlot(diverseList, slots.diverse, 'diverse');
  takeSlot(scored, slots.lexical, 'lexical');

  // 后半篇最低召回保障（相关者优先，噪声小节排除）
  const quota =
    lateQuota != null
      ? Math.max(0, Number(lateQuota) || 0)
      : LATE_GUARANTEE_ROLES.has(role)
        ? Math.min(2, Math.max(1, Math.floor(maxChunks / 6)))
        : 0;
  if (quota > 0 && chunks.length > 1) {
    const backHalf = scored.filter((s) => {
      if (positionRatio(s.chunk, chunks.length) < 0.5) return false;
      if (NOISE_SECTION_RE.test(s.chunk.sectionTitle || '')) return false;
      return (
        mustUseHits.has(s.chunk.id) ||
        neighborhoodIds.has(s.chunk.id) ||
        evidenceIds.has(s.chunk.id) ||
        Object.keys(roleBoost).some((name) => categories.get(s.chunk.id)?.has(name)) ||
        termScore(s.chunk.terms || [], terms) >= 0.1
      );
    });
    takeSlot(backHalf, quota, 'late');
  }
  // 还有预算就按分数补满
  takeSlot(scored, maxChunks - picked.length, 'lexical');

  const ordered = picked.map((p) => p.chunk).sort((a, b) => a.index - b.index);
  const backHalf = ordered.filter((c) => positionRatio(c, chunks.length) >= 0.5);
  const previous = new Set(previousSectionChunkIds || []);
  const reused = ordered.filter((c) => previous.has(c.id));
  // mustUseTerms 命中要看「选中的证据里有没有」，而不是「全文里有没有」
  const selectedText = ordered.map((c) => String(c.text || '').toLowerCase()).join('\n');
  const selectedHitTerms = mustTerms.filter((t) => selectedText.includes(String(t).toLowerCase()));

  // 关键事实命中：只看元数据（哪条 fact 的证据真的进了本节上下文），不参与打分
  const factList = (criticalFacts || []).filter(Boolean);
  const selectedIds = new Set(ordered.map((c) => c.id));
  const factResults = factList.map((f) => {
    const terms = (f.mustUseTerms || []).map((t) => String(t).toLowerCase()).filter(Boolean);
    const termHit = terms.filter((t) => selectedText.includes(t));
    const chunkHit = (f.evidence?.chunkIds || []).filter((id) => selectedIds.has(id));
    const hit = termHit.length > 0 || chunkHit.length > 0;
    return { id: f.id, hit, termHit, chunkHit };
  });
  const criticalHitCount = factResults.filter((r) => r.hit).length;
  return {
    evidence: ordered.map((c) => ({
      id: c.id,
      sectionTitle: c.sectionTitle,
      type: c.type,
      text: c.text,
      score: Number((scored.find((s) => s.chunk.id === c.id)?.score || 0).toFixed(3)),
      slot: slotOf.get(c.id) || 'lexical',
      sourceSection: c.sectionTitle,
      mustUseHits: mustUseHits.get(c.id) || 0,
    })),
    chunkIds: ordered.map((c) => c.id),
    figureNums,
    roles: role,
    chars,
    backHalfChunks: backHalf.length,
    lateQuota: quota,
    uniqueChunkCount: ordered.length,
    reusedChunkCount: reused.length,
    newChunkCount: ordered.length - reused.length,
    query: {
      sourceSectionTerms: query.sourceSectionTerms.slice(0, 16),
      mustUseTerms: query.mustUseTerms.slice(0, 12),
      evidenceTerms: query.evidenceTerms.slice(0, 12),
      roleTerms: query.roleTerms.slice(0, 12),
      purposeTerms: query.purposeTerms.slice(0, 12),
      matchedTitles: query.matchedTitles,
    },
    sourceSectionMatch: match,
    slots,
    mustUseTermHits: selectedHitTerms.length,
    mustUseTermTotal: mustTerms.length,
    mustUseHitTerms: selectedHitTerms.slice(0, 12),
    mustUseTermCandidates: mustUseHitTerms.size,
    guaranteedSlots: guaranteedTaken.length,
    guaranteedSections: garant?.sections || [],
    supportedFactIds,
    allocationOverflow: garant?.overflow || [],
    criticalFactIds: factList.map((f) => f.id),
    criticalFactTotal: factList.length,
    criticalFactHitCount: criticalHitCount,
    criticalFactMissCount: factList.length - criticalHitCount,
    criticalFactHitRate: factList.length ? Number((criticalHitCount / factList.length).toFixed(4)) : null,
    criticalFactResults: factResults,
  };
}

/** 把 mustUseTerms 里的表号/图号/式号编成正则，用于图注/表注命中。 */
function buildCaptionRefRegex(terms = []) {
  const parts = [];
  for (const raw of terms || []) {
    const s = String(raw || '');
    const m = s.match(/\b(?:table|tab\.|fig(?:ure)?\.?|eq(?:uation)?)\s*\.?\s*(\d{1,2})/i);
    if (m) parts.push(m[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  if (!parts.length) return null;
  return new RegExp(parts.join('|'), 'i');
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
