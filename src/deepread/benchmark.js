/**
 * DeepRead Benchmark v1 —— 确定性质量指标
 *
 * 目标：把「功能测试通过」升级为「可以持续衡量真实论文解读质量」。
 * 衡量的是**证据覆盖与结构完整性**，不是文学质量评分：全部指标来自
 *   - 人工定义的「关键事实锚点」（benchmark/papers/*.json 里的 expected*）
 *   - DeepRead 自身的产出（final markdown / research map / audit / structure / plan）
 * 用确定性字符串与数字匹配实现，不调用 LLM judge，不引入外部服务。
 *
 * 指标（10 项）：
 *   sourceCoverage          终稿命中的 expected evidence / 总数
 *   latePaperCoverage       只看「证据在原文后半篇」的锚点覆盖率（验证没有只看前半篇）
 *   numberEvidenceCoverage  期望数字在终稿出现、且能被 audit 在原文定位的比例
 *   figureCoverage          期望图的覆盖情况（图号引用或图注关键词）
 *   formulaCoverage         期望公式的覆盖情况（LaTeX 指纹/关键词）
 *   ablationCoverage        期望消融点的覆盖情况
 *   limitationCoverage      期望局限点的覆盖情况
 *   auditMissingRate        audit 里 unresolved/missing 证据占比（越低越好）
 *   sectionCompleteness     计划章节与终稿章节的一致性
 *   lengthStability         终稿是否完整（没有明显截断）
 *
 * 本模块只做「读 + 算」，不碰 DeepRead 核心逻辑，也不写文件；文件 IO 在 scripts/deepread-benchmark.js。
 */

import fs from 'node:fs';
import path from 'node:path';
import { extractNumberTokens, numberKey, splitMarkdownSections } from './audit.js';
import { tokenize } from './chunker.js';
import { summarizeStages } from './stages.js';

export const BENCHMARK_VERSION = 'v1';

/**
 * 检索探针（diagnostics，不是 expected evidence）：只用来回答「这篇论文的关键事实到底进没进检索」。
 * 命中判定是确定性的字符串包含（大小写不敏感），不改动任何锚点、不改动指标口径。
 */
export const DEFAULT_RETRIEVAL_PROBES = {
  '1706.03762': ['label smoothing', 'residual dropout', 'Regularization'],
  '2406.09246': ['failure', 'partial success', 'co-training'],
  '2501.12948': ['AIME', 'MATH-500', 'Codeforces', 'Unsuccessful', '79.8', '97.3', '2029'],
  '2409.12191': ['min_pixels', '16384', '2400'],
};

/**
 * 计划覆盖度诊断（全部确定性）：
 *   criticalFact*：研究地图种出的关键事实有没有绑定到原文小节、有没有真的进检索；
 *   planSourceSectionCoverage / sourceSectionOverflowCount：计划请求的原文小节落地/溢出情况；
 *   mustUseRareTermCoverage：稀有术语（tier ≤2）有没有进检索。
 */
export function planCoverageDiagnostics({ facts = [], plan = [], evidence = [], structure = null } = {}) {
  const byId = new Map((structure?.chunks || []).map((c) => [c.id, c]));
  const retrieved = new Set((evidence || []).flatMap((e) => e.chunkIds || []));
  const retrievedText = [...retrieved].map((id) => byId.get(id)?.text || '').join('\n').toLowerCase();
  const kept = new Set((plan || []).flatMap((s) => s.sourceSections || []));
  const requestedAll = new Set([
    ...(plan || []).flatMap((s) => s.sourceSectionsRequested || []),
    ...(plan || []).flatMap((s) => s.sourceSectionsAddedByFacts || []),
  ]);
  const deferredCount = (plan || []).reduce((n, s) => n + (s.sourceSectionsDeferred || []).length, 0);
  const ratioOf = (hit, total) => (total ? Number((hit / total).toFixed(4)) : null);

  const factCovered = (f) => {
    const terms = (f.mustUseTerms || []).map((t) => String(t).toLowerCase()).filter(Boolean);
    if (terms.some((t) => retrievedText.includes(t))) return true;
    return (f.evidence?.chunkIds || []).some((id) => retrieved.has(id));
  };
  const factSectionCovered = (f) => (f.sourceSectionTitles || []).some((t) => kept.has(t));
  const mapped = facts.filter((f) => (f.sourceSectionIds || []).length);
  const high = facts.filter((f) => f.priority === 'high');

  const rareTerms = new Set();
  for (const s of plan || []) {
    for (const r of s.mustUseTermRanking || []) if (r.tier <= 2) rareTerms.add(String(r.term).toLowerCase());
  }
  const rareHit = [...rareTerms].filter((t) => retrievedText.includes(t)).length;

  return {
    criticalFactCount: facts.length,
    criticalFactMappedCount: mapped.length,
    criticalFactUnmappedCount: facts.length - mapped.length,
    criticalFactCoverage: ratioOf(facts.filter(factCovered).length, facts.length),
    criticalFactSectionCoverage: ratioOf(facts.filter(factSectionCovered).length, facts.length),
    highPriorityFactCoverage: ratioOf(high.filter(factCovered).length, high.length),
    planSourceSectionCoverage: ratioOf([...requestedAll].filter((t) => kept.has(t)).length, requestedAll.size),
    sourceSectionOverflowCount: deferredCount,
    mustUseRareTermCoverage: ratioOf(rareHit, rareTerms.size),
  };
}

/**
 * 逐节 evidence 的检索诊断（全部来自 result.meta.evidence，确定性计算）。
 * @returns {{uniqueEvidencePerPaper:number, evidenceReuseRate:number|null, sameRoleOverlap:number|null,
 *   sourceSectionHitRate:number|null, mustUseTermHitRate:number|null, slots:number, reusedSlots:number,
 *   sectionsWithSourceMatch:number, sectionsRequestingSource:number}}
 */
export function retrievalDiagnostics({ evidence = [], structure = null } = {}) {
  const sections = (evidence || []).filter(Boolean);
  const slots = sections.flatMap((s) => s.chunkIds || []);
  const unique = [...new Set(slots)];
  const evidenceReuseRate = slots.length ? Number((1 - unique.length / slots.length).toFixed(4)) : null;

  const byRole = new Map();
  for (const s of sections) {
    const role = s.role || 'general';
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role).push(new Set(s.chunkIds || []));
  }
  const overlaps = [];
  for (const list of byRole.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const inter = [...list[i]].filter((x) => list[j].has(x)).length;
        const union = new Set([...list[i], ...list[j]]).size;
        overlaps.push(union ? inter / union : 0);
      }
    }
  }
  const sameRoleOverlap = overlaps.length ? Number((overlaps.reduce((a, b) => a + b, 0) / overlaps.length).toFixed(4)) : null;

  const requesting = sections.filter((s) => (s.sourceSections || []).length);
  const matched = requesting.filter((s) => (s.sourceSectionMatch?.sectionIds || []).length);
  const sourceSectionHitRate = requesting.length ? Number((matched.length / requesting.length).toFixed(4)) : null;

  // mustUseTerms 是否真的进了「本节选中的 evidence」（而不是只在全文里出现过）
  const byId = new Map((structure?.chunks || []).map((c) => [c.id, c]));
  let termTotal = 0;
  let termHit = 0;
  for (const s of sections) {
    const terms = (s.mustUseTerms || []).map((t) => String(t || '').toLowerCase()).filter(Boolean);
    if (!terms.length) continue;
    const text = (s.chunkIds || [])
      .map((id) => byId.get(id)?.text || '')
      .join('\n')
      .toLowerCase();
    for (const t of terms) {
      termTotal += 1;
      if (text.includes(t)) termHit += 1;
    }
  }
  const mustUseTermHitRate = termTotal ? Number((termHit / termTotal).toFixed(4)) : null;

  return {
    uniqueEvidencePerPaper: unique.length,
    evidenceReuseRate,
    sameRoleOverlap,
    sourceSectionHitRate,
    mustUseTermHitRate,
    slots: slots.length,
    reusedSlots: slots.length - unique.length,
    sectionsRequestingSource: requesting.length,
    sectionsWithSourceMatch: matched.length,
    mustUseTermsTotal: termTotal,
    mustUseTermsHit: termHit,
  };
}

/**
 * 探针命中详情：不仅回答「进没进检索」，还要回答「为什么没进」。
 * reason ∈ retrieved | term_not_in_source | plan_did_not_request_section | slot_competition
 */
export function retrievalProbeResults({
  probes = [],
  structure = null,
  evidence = [],
  plan = [],
  facts = [],
  markdown = '',
  guaranteedSections = [],
} = {}) {
  const chunks = structure?.chunks || [];
  const usedBy = new Map();
  for (const s of evidence || []) {
    for (const id of s.chunkIds || []) {
      if (!usedBy.has(id)) usedBy.set(id, []);
      if (s.section) usedBy.get(id).push(s.section);
    }
  }
  return (probes || []).map((term) => {
    const needle = String(term || '').toLowerCase();
    // 同时看正文与小节名：`Regularization` 这类 probe 检验的是「这个小节有没有被读到」
    const inSource = chunks.filter((c) => `${c.sectionTitle || ''} ${c.text || ''}`.toLowerCase().includes(needle));
    const retrieved = inSource.filter((c) => usedBy.has(c.id));
    const sourceSections = [...new Set(inSource.map((c) => c.sectionTitle))];
    const requestedBy = (plan || [])
      .filter((s) => (s.sourceSections || []).some((t) => sourceSections.includes(t)))
      .map((s) => s.title);
    const guaranteed = sourceSections.some((t) => (guaranteedSections || []).includes(t));
    const listedInTerms = (plan || [])
      .filter((s) => (s.mustUseTerms || []).some((t) => String(t).toLowerCase().includes(needle)))
      .map((s) => s.title);
    const criticalFactIds = (facts || [])
      .filter(
        (f) =>
          (f.mustUseTerms || []).some((t) => String(t).toLowerCase().includes(needle)) ||
          (f.evidence?.chunkIds || []).some((id) => inSource.some((c) => c.id === id)),
      )
      .map((f) => f.id);
    // 该 probe 关联的关键事实有没有绑定到 chunk（没有就是 no_matching_chunk，而不是「原文没有」）
    const criticalFactHasChunks = (facts || [])
      .filter((f) => criticalFactIds.includes(f.id))
      .some((f) => (f.evidence?.chunkIds || f.chunkIds || []).length > 0);
    const hit = retrieved.length > 0;
    let reason;
    if (hit) reason = 'retrieved';
    // 事实/术语在原文里、但**没有任何 chunk 承载它**（切片丢失或事实没绑定到 chunk）
    else if (!inSource.length && criticalFactIds.length && !criticalFactHasChunks) reason = 'no_matching_chunk';
    else if (!inSource.length) reason = 'term_not_in_source';
    else if (!requestedBy.length && !listedInTerms.length) reason = 'plan_did_not_request_section';
    else reason = 'slot_competition';
    // 生命周期状态：missing_evidence → unwritten → unsupported/derived → covered
    const md = String(markdown || '');
    const inMarkdown = md.toLowerCase().includes(needle);
    let status;
    if (inMarkdown && /\d/.test(String(term))) {
      const sentence = md.split(/[。！？!?\n]/).find((x) => x.toLowerCase().includes(needle)) || '';
      const derivedMarked = /按论文数据|换算|推算|折算|计算得|derived|per second|per frame/.test(sentence);
      status = inSource.length ? 'covered' : derivedMarked ? 'derived' : 'unsupported';
    } else if (inMarkdown) status = 'covered';
    else if (!inSource.length || !hit) status = 'missing_evidence';
    else status = 'unwritten';
    return {
      term,
      matched: hit,
      status,
      sourceChunks: inSource.length,
      retrievedChunks: retrieved.length,
      hit,
      sourceSections: sourceSections.slice(0, 4),
      criticalFactIds: criticalFactIds.slice(0, 4),
      planSection: hit ? [...new Set(retrieved.flatMap((c) => usedBy.get(c.id) || []))].slice(0, 2).join(' / ') : requestedBy.slice(0, 2).join(' / '),
      requestedBy: requestedBy.slice(0, 4),
      // Plan Coverage v2：这个事实所在的 source section 有没有拿到保障额度
      guaranteed,
      retrievalCandidates: inSource.length,
      allocatedCandidates: retrieved.length,
      requested: requestedBy.length > 0 || listedInTerms.length > 0,
      listedInMustUseTermsBy: listedInTerms.slice(0, 4),
      mustUseTerms: listedInTerms.length
        ? (plan || []).find((s) => s.title === listedInTerms[0])?.mustUseTerms?.slice(0, 6) || []
        : [],
      reason,
      lifecycle: { retrieved: hit, written: inMarkdown, status },
      examples: retrieved.slice(0, 3).map((c) => ({
        chunkId: c.id,
        sourceSection: c.sectionTitle,
        usedBy: [...new Set(usedBy.get(c.id) || [])].slice(0, 2),
        snippet: String(c.text || '').slice(0, 110),
      })),
    };
  });
}

/**
 * 从 result.meta 里取某阶段的元数据，兼容 v1 旧字段
 * （旧记录只有 researchMapStatus: 'model'|'fallback'，没有统一 stages）。
 */
export function stageMetaOf(result, name) {
  const stage = result?.meta?.stages?.[name];
  if (stage) return stage;
  if (name === 'research_map') {
    const legacy = result?.meta?.researchMapStatus;
    if (legacy === 'model') {
      return { stage: 'research_map', status: 'model_success', source: 'model', fallback: false, warning: false };
    }
    if (legacy === 'fallback') {
      return { stage: 'research_map', status: 'fallback', source: 'local', fallback: true, warning: true };
    }
    return null;
  }
  if (name === 'plan') {
    const legacy = result?.meta?.planStatus;
    if (!legacy) return null;
    return {
      stage: 'plan',
      status: legacy,
      source: result?.meta?.planSource || null,
      fallback: legacy !== 'model_success',
      warning: legacy !== 'model_success',
    };
  }
  return null;
}

/**
 * 审计可信度：把「上游地图是否生效」和「审计自身结论」合成一个 0~1 的确定性指标。
 *   地图系数：model_success 1.0 / 截断·解析失败·调用失败 0.5 / 本地兜底 0.4
 *   结论系数：passed 1.0 / passed_with_warning 0.8 / failed 0.5
 * auditConfidence = 地图系数 × 结论系数（越低说明「审计通过」越不可信）。
 */
export function auditConfidenceOf({ researchMapStatus = null, researchMapSource = null, verdict = null } = {}) {
  if (!researchMapStatus && !verdict) return null;
  const mapFactor =
    researchMapStatus === 'model_success'
      ? 1
      : researchMapStatus === 'fallback' || researchMapSource === 'local'
        ? 0.4
        : researchMapStatus
          ? 0.5
          : 0.6;
  const verdictFactor = verdict === 'passed' ? 1 : verdict === 'passed_with_warning' ? 0.8 : verdict === 'failed' ? 0.5 : 0.6;
  return Number((mapFactor * verdictFactor).toFixed(4));
}

// ============ 元数据解析与校验 ============

const REQUIRED_FIELDS = ['id', 'title', 'url'];
const LIST_FIELDS = [
  'expectedSections',
  'expectedEvidence',
  'expectedFigures',
  'expectedFormulas',
  'expectedAblations',
  'expectedLimitations',
];

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}

/** 归一化一个事实锚点（expectedEvidence / expectedAblations / expectedLimitations 通用）。 */
export function normalizeAnchor(raw, fallbackType = 'evidence') {
  if (typeof raw === 'string') return { type: fallbackType, text: raw.trim(), keywords: [], numbers: [] };
  if (!raw || typeof raw !== 'object') return null;
  const text = String(raw.text ?? raw.claim ?? raw.value ?? '').trim();
  const keywords = asArray(raw.keywords).map((k) => String(k).trim()).filter(Boolean);
  const numbers = asArray(raw.numbers).map((n) => String(n).trim()).filter(Boolean);
  if (!text && !keywords.length && !numbers.length) return null;
  return {
    type: String(raw.type || fallbackType),
    text,
    keywords,
    numbers,
    strict: raw.strict === true,
  };
}

/** 归一化 figma/picture 期望。 */
export function normalizeFigure(raw, index) {
  if (typeof raw === 'number') return { num: raw, captionKeywords: [] };
  if (typeof raw === 'string') return { num: null, captionKeywords: [raw] };
  if (!raw || typeof raw !== 'object') return null;
  const num = Number.isFinite(Number(raw.num)) && raw.num != null ? Number(raw.num) : null;
  const captionKeywords = asArray(raw.captionKeywords ?? raw.keywords).map((k) => String(k).trim()).filter(Boolean);
  if (num == null && !captionKeywords.length && !raw.caption) return null;
  if (!captionKeywords.length && raw.caption) captionKeywords.push(...String(raw.caption).split(/[\s,，。:：]+/).filter((w) => w.length >= 2).slice(0, 4));
  return { num, captionKeywords, fallbackIndex: index + 1 };
}

/** 校验并归一化一篇论文记录；非法记录返回 ok:false + errors（不抛错，交由 runner 标记 skipped）。 */
export function validatePaperRecord(record) {
  const errors = [];
  const warnings = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, errors: ['记录不是对象'], warnings, paper: null };
  }
  for (const f of REQUIRED_FIELDS) {
    if (!record[f] || typeof record[f] !== 'string') errors.push(`缺少必填字段 ${f}`);
  }
  if (record.url && !/^https?:\/\//.test(record.url)) errors.push(`url 不是 http(s) 链接：${record.url}`);
  for (const f of LIST_FIELDS) {
    if (record[f] != null && !Array.isArray(record[f])) warnings.push(`${f} 不是数组，已按单元素处理`);
  }

  const paper = {
    id: String(record.id || '').trim(),
    title: String(record.title || '').trim(),
    category: String(record.category || 'uncategorized').trim(),
    url: String(record.url || '').trim(),
    notes: typeof record.notes === 'string' ? record.notes : '',
    expectedSections: asArray(record.expectedSections).map((s) => String(s).trim()).filter(Boolean),
    expectedEvidence: [],
    expectedFigures: [],
    expectedFormulas: [],
    expectedAblations: [],
    expectedLimitations: [],
  };

  const anchorFields = [
    ['expectedEvidence', 'evidence'],
    ['expectedAblations', 'ablation'],
    ['expectedLimitations', 'limitation'],
  ];
  for (const [field, type] of anchorFields) {
    for (const raw of asArray(record[field])) {
      const anchor = normalizeAnchor(raw, type);
      if (anchor) paper[field].push(anchor);
      else warnings.push(`${field} 中有一个无法解析的条目已跳过`);
    }
  }
  paper.expectedFigures = asArray(record.expectedFigures)
    .map((raw, i) => normalizeFigure(raw, i))
    .filter(Boolean);
  paper.expectedFormulas = asArray(record.expectedFormulas)
    .map((raw) => normalizeAnchor(raw, 'formula'))
    .filter(Boolean);

  if (errors.length) return { ok: false, errors, warnings, paper: null };
  if (!paper.expectedEvidence.length && !paper.expectedAblations.length && !paper.expectedLimitations.length) {
    warnings.push('没有任何 expected 锚点，该论文的覆盖率指标会全部为空');
  }
  return { ok: true, errors, warnings, paper };
}

/** 读取一篇论文 JSON（文件损坏时返回 ok:false 而不是抛错）。 */
export function readPaperFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { ok: false, errors: [`读取失败：${err.message}`], warnings: [], paper: null, file: filePath };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, errors: [`JSON 解析失败：${err.message}`], warnings: [], paper: null, file: filePath };
  }
  const result = validatePaperRecord(parsed);
  return { ...result, file: filePath };
}

/** 读取 benchmark/papers 下的全部论文（按文件名排序，保证顺序稳定）。 */
export function loadPapers(dir) {
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    : [];
  const papers = [];
  const invalid = [];
  for (const f of files) {
    const res = readPaperFile(path.join(dir, f));
    if (res.ok) papers.push({ ...res.paper, __file: res.file, __warnings: res.warnings });
    else invalid.push({ file: res.file, errors: res.errors });
  }
  return { papers, invalid, files };
}

/** 归一化锚点快照（写入 benchmark/expected/<id>.json，供人阅读与 diff）。 */
export function expectedSnapshot(paper) {
  return {
    id: paper.id,
    title: paper.title,
    category: paper.category,
    url: paper.url,
    expectedSections: paper.expectedSections,
    expectedEvidence: paper.expectedEvidence,
    expectedFigures: paper.expectedFigures,
    expectedFormulas: paper.expectedFormulas,
    expectedAblations: paper.expectedAblations,
    expectedLimitations: paper.expectedLimitations,
  };
}

// ============ 匹配（确定性） ============

function textOf(markdown) {
  return String(markdown || '');
}

/** 关键词命中：返回命中数 / 比例 / 未命中列表。 */
export function matchKeywords(keywords, text) {
  const list = (keywords || []).filter(Boolean);
  const hay = textOf(text).toLowerCase();
  const hits = [];
  const missing = [];
  for (const kw of list) {
    if (hay.includes(String(kw).toLowerCase())) hits.push(kw);
    else missing.push(kw);
  }
  return { hits, missing, ratio: list.length ? hits.length / list.length : 0, total: list.length };
}

/** 数字命中：按 numberKey 归一化比较（28.4 ≡ 28.40、41.8% ≡ 41.8）。 */
export function matchNumbers(numbers, text, { locatedNumbers = null } = {}) {
  const bareOf = (n) => numberKey(n).replace(/[^\d.]/g, '');
  const parsedOf = (n) => {
    const bare = bareOf(n);
    return /^\d+(\.\d+)?$/.test(bare) ? Number(bare) : null;
  };
  const haveBare = new Set(extractNumberTokens(text).map(bareOf).filter(Boolean));
  const haveNums = new Set(extractNumberTokens(text).map(parsedOf).filter((v) => v != null));
  const located = locatedNumbers ? new Set([...locatedNumbers].map((n) => numberKey(n).replace(/[^\d.]/g, ''))) : null;
  const hits = [];
  const missing = [];
  const unlocated = [];
  for (const raw of numbers || []) {
    const key = numberKey(raw);
    const bare = bareOf(raw);
    const num = parsedOf(raw);
    // 命中判定：字面一致，或数值等价（28.4 ≡ 28.40）
    const hit = (bare && haveBare.has(bare)) || (num != null && haveNums.has(num));
    if (hit) {
      hits.push(raw);
      const locatedHit = !located || located.has(bare) || (num != null && [...located].some((l) => Number(l) === num));
      if (!locatedHit) unlocated.push(raw);
    } else {
      missing.push(raw);
    }
  }
  return {
    hits,
    missing,
    unlocated,
    ratio: (numbers || []).length ? hits.length / numbers.length : 0,
    total: (numbers || []).length,
  };
}

/** 匹配一条锚点：数字优先（有 numbers 时必须命中），关键词按比例。 */
export function matchAnchor(anchor, markdown) {
  const md = textOf(markdown);
  const kw = matchKeywords(anchor.keywords, md);
  const num = matchNumbers(anchor.numbers, md);
  const hasNumbers = (anchor.numbers || []).length > 0;
  const hasKeywords = (anchor.keywords || []).length > 0;
  // 只有关键词时：命中比例 ≥ 0.5（至少 1 个）即算覆盖；同时有数字时数字必须齐
  const keywordsOk = !hasKeywords || kw.ratio >= (anchor.strict ? 1 : 0.5);
  const numbersOk = !hasNumbers || num.ratio >= (anchor.strict ? 1 : 0.5);
  return {
    ok: keywordsOk && numbersOk,
    keywordHits: kw.hits,
    missingKeywords: kw.missing,
    numberHits: num.hits,
    missingNumbers: num.missing,
  };
}

/** 匹配期望公式：LaTeX 指纹/关键词命中。 */
export function matchFormula(anchor, markdown) {
  const md = textOf(markdown);
  const kw = matchKeywords(anchor.keywords, md);
  const hasFormula = /\$[^$\n]+\$|\$\$[\s\S]+?\$\$/.test(md);
  const keywordsOk = (anchor.keywords || []).length ? kw.ratio >= 0.5 : hasFormula;
  return { ok: keywordsOk && hasFormula, keywordHits: kw.hits, missingKeywords: kw.missing, hasFormula };
}

/** 匹配期望图：优先图号（终稿出现「图N」或 _arxivsrc 链接），退化到图注关键词。 */
export function matchFigure(figure, markdown) {
  const md = textOf(markdown);
  if (figure.num != null) {
    const numHit = new RegExp(`图\\s*${figure.num}(?![0-9])`).test(md);
    if (numHit) return { ok: true, by: 'num', num: figure.num };
  }
  const kw = matchKeywords(figure.captionKeywords, md);
  if (kw.total) return { ok: kw.ratio >= 0.5, by: 'caption', keywordHits: kw.hits, missingKeywords: kw.missing };
  return { ok: false, by: 'none' };
}

// ============ late-paper 检测 ============

/**
 * 锚点在原文中的位置：取「命中关键词最多」的 chunk，除以总 chunk 数。
 * 用 chunk 而不是全文字符位置，是因为文档被结构化切片后，chunk 顺序即原文顺序。
 */
export function anchorPosition(anchor, structure) {
  const chunks = structure?.chunks || [];
  if (!chunks.length) return { ratio: null, chunkId: null, sectionTitle: '', hits: 0 };
  let best = { hits: -1, chunk: null };
  for (const c of chunks) {
    const lower = c.text.toLowerCase();
    let hits = 0;
    for (const kw of anchor.keywords || []) if (lower.includes(String(kw).toLowerCase())) hits += 2;
    for (const n of anchor.numbers || []) {
      if (extractNumberTokens(c.text).map((t) => t.replace(/[^\d.]/g, '')).includes(numberKey(n).replace(/[^\d.]/g, ''))) hits += 1;
    }
    if (hits > best.hits) best = { hits, chunk: c };
  }
  if (!best.chunk || best.hits <= 0) return { ratio: null, chunkId: null, sectionTitle: '', hits: 0 };
  return {
    ratio: best.chunk.index / Math.max(1, chunks.length - 1),
    chunkId: best.chunk.id,
    sectionTitle: best.chunk.sectionTitle,
    hits: best.hits,
  };
}

export const LATE_THRESHOLD = 0.5;

/** 判定锚点是否属于「后半篇证据」。 */
export function isLateAnchor(anchor, structure, threshold = LATE_THRESHOLD) {
  const pos = anchorPosition(anchor, structure);
  return { late: pos.ratio != null && pos.ratio >= threshold, ...pos };
}

/** 汇总一篇论文的所有锚点 → 含 late 标记的清单。 */
export function classifyAnchors(paper, structure) {
  const all = [];
  const push = (anchor, kind) => {
    const pos = anchorPosition(anchor, structure);
    all.push({ kind, anchor, ...pos, late: pos.ratio != null && pos.ratio >= LATE_THRESHOLD });
  };
  (paper.expectedEvidence || []).forEach((a) => push(a, 'evidence'));
  (paper.expectedAblations || []).forEach((a) => push(a, 'ablation'));
  (paper.expectedLimitations || []).forEach((a) => push(a, 'limitation'));
  return all;
}

// ============ 指标计算 ============

function ratio(hit, total) {
  if (!total) return null;
  return Number((hit / total).toFixed(4));
}

/** audit → unresolved / total 证据项。 */
export function auditMissingRate(audit) {
  if (!audit || !Array.isArray(audit.checks)) return null;
  const stats = audit.stats || {};
  const missingNumbers = stats.missingNumbers ?? (audit.checks.find((c) => c.name === 'numbers')?.missing?.length || 0);
  const unknownEntities = audit.checks.find((c) => c.name === 'entities')?.unknown?.length || 0;
  const badFigures = audit.checks.find((c) => c.name === 'figures')?.badRefs?.length || 0;
  const formulaBad = (audit.checks.find((c) => c.name === 'formula')?.status || '') === 'fail' ? 1 : 0;
  const unresolved = missingNumbers + unknownEntities + badFigures + formulaBad;
  const total =
    (stats.numbers || 0) + (stats.entities || 0) + (stats.figureRefs || 0) + (stats.formulas || 0);
  if (!total) return null;
  return Number((unresolved / total).toFixed(4));
}

/** 章节一致性：计划章节（research map / plan）与终稿 H2 的匹配比例。 */
export function sectionCompleteness(result) {
  const markdown = result?.markdown || '';
  const finalSections = splitMarkdownSections(markdown).filter((s) => s.heading && s.level === 2);
  const planned = (result?.meta?.plan || []).map((p) => p.title).filter(Boolean);
  const finalTitles = finalSections.map((s) => s.heading);
  if (!planned.length && !finalTitles.length) return { ratio: null, planned: 0, final: 0, missing: [] };
  const missing = planned.filter((title) => {
    const key = title.toLowerCase().replace(/[\s\-_：:，,。.、（）()【】\[\]]+/g, '');
    return !finalTitles.some((h) => {
      const hk = h.toLowerCase().replace(/[\s\-_：:，,。.、（）()【】\[\]]+/g, '');
      if (!key || !hk) return false;
      if (hk.includes(key) || key.includes(hk)) return true;
      const a = new Set(tokenize(hk));
      const b = new Set(tokenize(key));
      let hits = 0;
      for (const t of a) if (b.has(t)) hits += 1;
      return hits >= 2;
    });
  });
  const denom = Math.max(planned.length, finalTitles.length);
  const matched = denom - missing.length - Math.abs(planned.length - finalTitles.length);
  return {
    ratio: denom ? Number((Math.max(0, matched) / denom).toFixed(4)) : null,
    planned: planned.length,
    final: finalTitles.length,
    missing: missing.slice(0, 6),
  };
}

/** 终稿是否完整（没有明显截断）。 */
export function lengthStability(result) {
  const markdown = String(result?.markdown || '');
  const sections = splitMarkdownSections(markdown).filter((s) => s.heading && s.level === 2).length;
  const planned = (result?.meta?.plan || []).length;
  const tail = markdown.trimEnd();
  const lastLine = tail.split('\n').filter((l) => l.trim()).pop() || '';
  const endsComplete = /[。！？.!?）)】」』"']$/.test(lastLine) || /```$/.test(lastLine) || /^>/.test(lastLine);
  const chars = markdown.replace(/\s/g, '').length;
  // 判据只看「结构是否完整 + 是否停在半句」：真实截断的典型特征是少小节或收尾悬空，
  // 绝对字数由 chars 单独上报，不参与判定（短论文本身就该短）。
  const stable = sections >= Math.min(3, planned || 3) && endsComplete && chars >= 120;
  return {
    stable,
    score: stable ? 1 : 0,
    sections,
    planned,
    chars,
    endsComplete,
    degraded: result?.degraded === true,
  };
}

/**
 * 计算一篇论文的全部指标。
 * @param {object} args
 * @param {object} args.paper 归一化后的论文（含 expected*）
 * @param {object} args.result provider.deepRead 的返回值
 * @param {object} args.structure 论文结构（含 chunks），用于 late 检测
 * @returns {object} metrics
 */
export function computeMetrics({ paper, result, structure }) {
  const markdown = result?.markdown || '';
  const audit = result?.audit || null;
  const anchors = classifyAnchors(paper, structure);
  const evidenceAnchors = anchors.filter((a) => a.kind === 'evidence');
  const ablationAnchors = anchors.filter((a) => a.kind === 'ablation');
  const limitationAnchors = anchors.filter((a) => a.kind === 'limitation');

  const matchedOf = (list) =>
    list.map((item) => ({
      text: item.anchor.text,
      late: item.late,
      section: item.sectionTitle,
      ...matchAnchor(item.anchor, markdown),
    }));

  const evidence = matchedOf(evidenceAnchors);
  const ablations = matchedOf(ablationAnchors);
  const limitations = matchedOf(limitationAnchors);
  const lateAll = anchors.filter((a) => a.late).map((a) => ({ ...a, match: matchAnchor(a.anchor, markdown) }));

  const expectedNumbers = [
    ...paper.expectedEvidence.flatMap((a) => a.numbers),
    ...paper.expectedAblations.flatMap((a) => a.numbers),
    ...paper.expectedLimitations.flatMap((a) => a.numbers),
  ];
  // audit 里「能在原文定位」的数字集合 = 终稿数字 - audit.missing
  const auditNumberCheck = audit?.checks?.find((c) => c.name === 'numbers');
  const locatedFromAudit = auditNumberCheck
    ? extractNumberTokens(markdown).filter((n) => !(auditNumberCheck.missing || []).includes(n))
    : null;
  const numbers = matchNumbers(expectedNumbers, markdown, { locatedNumbers: locatedFromAudit });
  // 「覆盖」要求终稿写了这个数字、且 audit 能在原文找到它：终稿里出现但 audit 判为原文查不到的数字
  // （可能是编造或改写）不计入覆盖，只在 detail.unlocated 里单独列出。没有 audit 时退化为「出现即覆盖」。
  const locatedHits = numbers.hits.length - numbers.unlocated.length;

  const figures = paper.expectedFigures.map((f) => ({ num: f.num, keywords: f.captionKeywords, ...matchFigure(f, markdown) }));
  const formulas = paper.expectedFormulas.map((f) => ({ text: f.text, ...matchFormula(f, markdown) }));
  const sections = sectionCompleteness(result);
  const stability = lengthStability(result);
  const auditRate = auditMissingRate(audit);

  // ===== 检索质量诊断（Retrieval v2）=====
  const retrievalDiag = retrievalDiagnostics({ evidence: result?.meta?.evidence, structure });
  const planDiag = planCoverageDiagnostics({
    facts: result?.meta?.criticalFacts || [],
    plan: result?.meta?.plan || [],
    evidence: result?.meta?.evidence,
    structure,
  });
  // 写作层事实覆盖（Evidence Ledger 判定，见 evidenceLedger.js）
  const factStats = result?.meta?.factCoverageStats || result?.meta?.writerCoverage?.stats || null;
  // 数字核验表（见 factCheck.js）：终稿数字里有多少能在原文定位到承载它的句子。
  // 全部是确定性回查结果，不引用 LLM judge，也不改上面的覆盖口径。
  const factCheckStats = result?.meta?.factCheckStats || result?.meta?.factCheck?.stats || null;
  // 人声/去 AI 味指标（见 styleCheck.js）：AI 腔标记密度，越低越好，用来衡量提示词规则有没有生效。
  const styleMetrics = result?.style?.metrics || null;
  const allocation = result?.meta?.allocation || null;
  const guaranteedSections = [...new Set(Object.values(allocation?.byPlanSection || {}).flatMap((v) => v.guaranteed || []))];
  const probes = retrievalProbeResults({
    probes: DEFAULT_RETRIEVAL_PROBES[paper.id] || [],
    structure,
    evidence: result?.meta?.evidence,
    plan: result?.meta?.plan || [],
    facts: result?.meta?.criticalFacts || [],
    markdown: result?.markdown || '',
    guaranteedSections,
  });
  const probeHit = probes.filter((p) => p.hit).length;
  const retrievalProbeRate = probes.length ? Number((probeHit / probes.length).toFixed(4)) : null;
  const retrievedIds = new Set((result?.meta?.evidence || []).flatMap((e) => e.chunkIds || []));
  const lateAnchors = anchors.filter((a) => a.late);
  const lateHit = lateAnchors.filter((a) => a.chunkId && retrievedIds.has(a.chunkId));
  const lateEvidenceHitRate = lateAnchors.length ? Number((lateHit.length / lateAnchors.length).toFixed(4)) : null;

  // ===== 阶段可靠性指标（来自真实调用状态，不来自结果猜�测） =====
  const researchMapStage = stageMetaOf(result, 'research_map');
  const planStage = stageMetaOf(result, 'plan');
  const stageSummary = result?.meta?.stageSummary || summarizeStages(result?.meta?.stages || {});
  const usedEvidenceIds = new Set((result?.meta?.evidence || []).flatMap((e) => e.chunkIds || []));
  const modelMapIds = new Set(result?.meta?.researchMapEvidenceIds || []);
  const modelMapHits = [...usedEvidenceIds].filter((id) => modelMapIds.has(id)).length;
  const auditVerdict = audit?.verdict || result?.meta?.auditVerdict || null;
  const researchMapStatus = researchMapStage?.status || null;
  const researchMapSource = researchMapStage?.source || null;

  const metrics = {
    sourceCoverage: ratio(evidence.filter((e) => e.ok).length, evidence.length),
    latePaperCoverage: ratio(lateAll.filter((a) => a.match.ok).length, lateAll.length),
    numberEvidenceCoverage: ratio(Math.max(0, locatedHits), numbers.total),
    figureCoverage: ratio(figures.filter((f) => f.ok).length, figures.length),
    formulaCoverage: ratio(formulas.filter((f) => f.ok).length, formulas.length),
    ablationCoverage: ratio(ablations.filter((a) => a.ok).length, ablations.length),
    limitationCoverage: ratio(limitations.filter((a) => a.ok).length, limitations.length),
    auditMissingRate: auditRate,
    sectionCompleteness: sections.ratio,
    lengthStability: stability.score,
    // 阶段可靠性
    researchMapModelSuccess: researchMapStage ? (researchMapStatus === 'model_success' ? 1 : 0) : null,
    researchMapFallbackRate: researchMapStage ? (researchMapStage.fallback ? 1 : 0) : null,
    planModelSuccess: planStage ? (planStage.status === 'model_success' ? 1 : 0) : null,
    planFallbackRate: planStage ? (planStage.fallback ? 1 : 0) : null,
    stagesWithWarnings: Object.keys(result?.meta?.stages || {}).length ? stageSummary.withWarnings : null,
    evidenceFromModelMapRate: usedEvidenceIds.size ? Number((modelMapHits / usedEvidenceIds.size).toFixed(4)) : null,
    // 审计可信度
    auditConfidence: auditConfidenceOf({ researchMapStatus, researchMapSource, verdict: auditVerdict }),
    // 检索质量
    uniqueEvidencePerPaper: retrievalDiag.uniqueEvidencePerPaper || null,
    evidenceReuseRate: retrievalDiag.evidenceReuseRate,
    sameRoleOverlap: retrievalDiag.sameRoleOverlap,
    sourceSectionHitRate: retrievalDiag.sourceSectionHitRate,
    mustUseTermHitRate: retrievalDiag.mustUseTermHitRate,
    lateEvidenceHitRate,
    retrievalProbeRate,
    // 计划覆盖度（Plan Coverage v1）
    criticalFactCount: planDiag.criticalFactCount,
    criticalFactMappedCount: planDiag.criticalFactMappedCount,
    criticalFactUnmappedCount: planDiag.criticalFactUnmappedCount,
    criticalFactCoverage: planDiag.criticalFactCoverage,
    criticalFactSectionCoverage: planDiag.criticalFactSectionCoverage,
    highPriorityFactCoverage: planDiag.highPriorityFactCoverage,
    planSourceSectionCoverage: planDiag.planSourceSectionCoverage,
    sourceSectionOverflowCount: planDiag.sourceSectionOverflowCount,
    mustUseRareTermCoverage: planDiag.mustUseRareTermCoverage,
    // Plan Coverage v2：source section 级别的保障覆盖
    criticalSourceSectionCoverage: allocation?.coverage?.criticalSourceSectionCoverage ?? null,
    highPrioritySourceSectionCoverage: allocation?.coverage?.highPrioritySourceSectionCoverage ?? null,
    factBackedSourceSectionCoverage: allocation?.coverage?.factBackedSourceSectionCoverage ?? null,
    guaranteedGroups: allocation?.stats?.guaranteedGroups ?? null,
    allocationOverflowCount: allocation?.stats?.overflow ?? null,
    // 写作层：事实到底有没有被写出来（Evidence Ledger 判定）
    writerFactCoverage: factStats?.coverage ?? null,
    mainResultFactCoverage: factStats?.mainResultCoverage ?? null,
    ablationFactCoverage: factStats?.ablationCoverage ?? null,
    limitationFactCoverage: factStats?.limitationCoverage ?? null,
    unwrittenFactRate: factStats?.unwrittenFactRate ?? null,
    unsupportedFactRate: factStats?.unsupportedFactRate ?? null,
    derivedFactRate: factStats?.derivedFactRate ?? null,
    // 数字核验表：终稿数字有没有被「原文句子 + 条件」兜住
    factCheckCoverage: factCheckStats?.coverage ?? null,
    factCheckUnsupportedRate: factCheckStats?.unsupportedRate ?? null,
    factCheckNumbers: factCheckStats?.numbers ?? null,
    // 人声 / 去 AI 味（见 styleCheck.js）：AI 腔标记密度
    aiTonePer1k: styleMetrics?.aiTonePer1k ?? null,
  };

  return {
    metrics,
    detail: {
      evidence,
      ablations,
      limitations,
      numbers: {
        expected: expectedNumbers,
        hits: numbers.hits,
        missing: numbers.missing,
        unlocated: numbers.unlocated,
        located: Math.max(0, locatedHits),
      },
      figures,
      formulas,
      lateAnchors: lateAll.map((a) => ({ text: a.anchor.text, ratio: a.ratio, section: a.sectionTitle, ok: a.match.ok })),
      sections,
      stability,
      auditMissingRate: auditRate,
      reliability: {
        researchMapStatus,
        researchMapSource,
        researchMapFinishReason: researchMapStage?.finishReason ?? null,
        researchMapRawContentLength: researchMapStage?.rawContentLength ?? null,
        researchMapFallbackReason: researchMapStage?.fallbackReason || '',
        planStatus: planStage?.status || null,
        planSource: planStage?.source || null,
        planFallbackReason: planStage?.fallbackReason || '',
        stagesWithWarnings: stageSummary.stagesWithWarnings,
        stageSummary,
        evidenceChunks: usedEvidenceIds.size,
        evidenceFromModelMap: modelMapHits,
      },
      audit: { verdict: auditVerdict, warnings: (audit?.warnings || []).map((w) => w.code), researchMapSource: audit?.researchMapSource || null },
      retrieval: {
        ...retrievalDiag,
        lateAnchors: lateAnchors.length,
        lateAnchorsRetrieved: lateHit.length,
        probes,
      },
      planCoverage: planDiag,
      allocation: allocation
        ? { stats: allocation.stats, coverage: allocation.coverage, overflow: allocation.overflow, guaranteedSections }
        : null,
      factCoverage: factStats,
      factCheck: factCheckStats,
      voice: styleMetrics
        ? {
            aiTonePer1k: styleMetrics.aiTonePer1k,
            voiceTotal: styleMetrics.voiceTotal,
            fakeDepth: styleMetrics.fakeDepthTotal,
            highFreq: styleMetrics.highFreqTotal,
            chatbot: styleMetrics.chatbotTotal,
            passive: styleMetrics.passiveTotal,
            aiPhraseTotal: styleMetrics.aiPhraseTotal,
            cautionPhraseTotal: styleMetrics.cautionPhraseTotal,
            boundaryPhraseTotal: styleMetrics.boundaryPhraseTotal,
          }
        : null,
      evidenceLedgerStats: result?.meta?.evidenceLedger?.stats || null,
    },
  };
}

// ============ 汇总与 baseline 对比 ============

export const METRIC_LABELS = {
  sourceCoverage: 'Source coverage',
  latePaperCoverage: 'Late-paper coverage',
  numberEvidenceCoverage: 'Number evidence',
  figureCoverage: 'Figure coverage',
  formulaCoverage: 'Formula coverage',
  ablationCoverage: 'Ablation coverage',
  limitationCoverage: 'Limitation coverage',
  auditMissingRate: 'Audit missing rate',
  sectionCompleteness: 'Section completeness',
  lengthStability: 'Length stability',
  researchMapModelSuccess: 'Research map model success',
  researchMapFallbackRate: 'Research map fallback rate',
  planModelSuccess: 'Plan model success',
  planFallbackRate: 'Plan fallback rate',
  stagesWithWarnings: 'Stages with warnings (avg/papers)',
  evidenceFromModelMapRate: 'Evidence from model map',
  auditConfidence: 'Audit confidence',
  uniqueEvidencePerPaper: 'Unique evidence / paper',
  evidenceReuseRate: 'Evidence reuse rate',
  sameRoleOverlap: 'Same-role overlap',
  sourceSectionHitRate: 'Source section hit rate',
  mustUseTermHitRate: 'Must-use term hit rate',
  lateEvidenceHitRate: 'Late evidence hit rate',
  retrievalProbeRate: 'Retrieval probe hit rate',
  criticalFactCount: 'Critical facts / paper',
  criticalFactMappedCount: 'Critical facts mapped',
  criticalFactUnmappedCount: 'Critical facts unmapped',
  criticalFactCoverage: 'Critical fact coverage',
  criticalFactSectionCoverage: 'Critical fact section coverage',
  highPriorityFactCoverage: 'High-priority fact coverage',
  planSourceSectionCoverage: 'Plan source section coverage',
  sourceSectionOverflowCount: 'Source section overflow',
  mustUseRareTermCoverage: 'Must-use rare term coverage',
  criticalSourceSectionCoverage: 'Critical source-section coverage',
  highPrioritySourceSectionCoverage: 'High-priority source-section coverage',
  factBackedSourceSectionCoverage: 'Fact-backed source-section coverage',
  guaranteedGroups: 'Guaranteed allocation groups',
  allocationOverflowCount: 'Allocation overflow',
  writerFactCoverage: 'Writer fact coverage',
  mainResultFactCoverage: 'Main-result fact coverage',
  ablationFactCoverage: 'Ablation fact coverage',
  limitationFactCoverage: 'Limitation fact coverage',
  unwrittenFactRate: 'Unwritten fact rate',
  unsupportedFactRate: 'Unsupported fact rate',
  derivedFactRate: 'Derived fact rate',
  factCheckCoverage: 'Fact-check coverage',
  factCheckUnsupportedRate: 'Fact-check unsupported rate',
  factCheckNumbers: 'Fact-check numbers / paper',
  aiTonePer1k: 'AI tone per 1k chars',
};

/**
 * 指标分三组（CLI / summary 按组展示，避免把「内容覆盖」和「阶段可靠性」混在一起读）：
 *   内容覆盖：终稿有没有讲到论文的关键事实
 *   阶段可靠性：上游阶段（研究地图 / 计划）到底有没有真的跑起来
 *   审计可信度：audit 的结论有多可信（缺失率 + 与上游可信度的合成）
 */
export const METRIC_GROUPS = [
  {
    key: 'coverage',
    label: '内容覆盖指标',
    metrics: [
      'sourceCoverage',
      'latePaperCoverage',
      'numberEvidenceCoverage',
      'figureCoverage',
      'formulaCoverage',
      'ablationCoverage',
      'limitationCoverage',
      'sectionCompleteness',
      'lengthStability',
    ],
  },
  {
    key: 'reliability',
    label: '阶段可靠性指标',
    metrics: [
      'researchMapModelSuccess',
      'researchMapFallbackRate',
      'planModelSuccess',
      'planFallbackRate',
      'stagesWithWarnings',
      'evidenceFromModelMapRate',
    ],
  },
  { key: 'audit', label: '审计可信度指标', metrics: ['auditMissingRate', 'auditConfidence'] },
  {
    key: 'retrieval',
    label: '检索质量指标',
    metrics: [
      'uniqueEvidencePerPaper',
      'evidenceReuseRate',
      'sameRoleOverlap',
      'sourceSectionHitRate',
      'mustUseTermHitRate',
      'lateEvidenceHitRate',
      'retrievalProbeRate',
    ],
  },
  {
    key: 'plan',
    label: '计划覆盖度指标',
    metrics: [
      'criticalFactCount',
      'criticalFactMappedCount',
      'criticalFactUnmappedCount',
      'criticalFactCoverage',
      'criticalFactSectionCoverage',
      'highPriorityFactCoverage',
      'planSourceSectionCoverage',
      'sourceSectionOverflowCount',
      'mustUseRareTermCoverage',
      'criticalSourceSectionCoverage',
      'highPrioritySourceSectionCoverage',
      'factBackedSourceSectionCoverage',
      'guaranteedGroups',
      'allocationOverflowCount',
    ],
  },
  {
    key: 'writer',
    label: '写作事实覆盖指标',
    metrics: [
      'writerFactCoverage',
      'mainResultFactCoverage',
      'ablationFactCoverage',
      'limitationFactCoverage',
      'derivedFactRate',
      'unsupportedFactRate',
      'unwrittenFactRate',
    ],
  },
  {
    key: 'factCheck',
    label: '数字核验指标（fact-check）',
    metrics: ['factCheckCoverage', 'factCheckUnsupportedRate', 'factCheckNumbers'],
  },
  { key: 'voice', label: '人声指标（去 AI 味）', metrics: ['aiTonePer1k'] },
];

/** 单位不是百分比的指标（按原值展示）。 */
const COUNT_METRICS = new Set([
  'stagesWithWarnings',
  'uniqueEvidencePerPaper',
  'criticalFactCount',
  'criticalFactMappedCount',
  'criticalFactUnmappedCount',
  'sourceSectionOverflowCount',
  'guaranteedGroups',
  'allocationOverflowCount',
  'factCheckNumbers',
  'aiTonePer1k',
]);

/** 把指标值格式化成 CLI/summary 用的字符串。 */
export function formatMetric(key, value) {
  if (typeof value !== 'number') return 'n/a';
  if (COUNT_METRICS.has(key)) return value.toFixed(2).replace(/\.00$/, '');
  return `${(value * 100).toFixed(0)}%`;
}

export function formatMetricPrecise(key, value) {
  if (typeof value !== 'number') return 'n/a';
  if (COUNT_METRICS.has(key)) return value.toFixed(2).replace(/\.00$/, '');
  return `${(value * 100).toFixed(1)}%`;
}

/** 越低越好的指标。 */
const LOWER_IS_BETTER = new Set([
  'auditMissingRate',
  'researchMapFallbackRate',
  'planFallbackRate',
  'stagesWithWarnings',
  'evidenceReuseRate',
  'sameRoleOverlap',
  'unwrittenFactRate',
  'unsupportedFactRate',
  'factCheckUnsupportedRate',
  'aiTonePer1k',
]);

/** 多篇论文聚合：忽略 null（该论文没有这类期望），并记录参与聚合的论文数。 */
export function aggregateMetrics(paperEntries) {
  const completed = paperEntries.filter((p) => p.status === 'completed' && p.metrics);
  const aggregate = {};
  for (const key of Object.keys(METRIC_LABELS)) {
    const values = completed.map((p) => p.metrics[key]).filter((v) => typeof v === 'number');
    aggregate[key] = values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(4)) : null;
  }
  return {
    total: paperEntries.length,
    completed: completed.length,
    skipped: paperEntries.filter((p) => p.status === 'skipped').length,
    failed: paperEntries.filter((p) => p.status === 'failed').length,
    metrics: aggregate,
  };
}

/** current vs baseline：按指标方向判定 improved / regressed / unchanged。 */
export function compareWithBaseline(current, baseline, { tolerance = 0.005 } = {}) {
  const result = { improved: [], regressed: [], unchanged: [], missing: [] };
  const baseMetrics = baseline?.metrics || {};
  for (const key of Object.keys(METRIC_LABELS)) {
    const cur = current?.metrics?.[key];
    const base = baseMetrics[key];
    if (typeof cur !== 'number' || typeof base !== 'number') {
      result.missing.push(key);
      continue;
    }
    const diff = cur - base;
    const better = LOWER_IS_BETTER.has(key) ? -diff : diff;
    const item = { metric: key, label: METRIC_LABELS[key], baseline: base, current: cur, delta: Number(diff.toFixed(4)) };
    if (Math.abs(diff) <= tolerance) result.unchanged.push(item);
    else if (better > 0) result.improved.push(item);
    else result.regressed.push(item);
  }
  return result;
}

/** CLI 文本 summary（数字全部来自真实运行结果）。 */
export function renderCliSummary(summary) {
  const lines = [];
  lines.push(`DeepRead Benchmark ${summary.version || BENCHMARK_VERSION}`);
  lines.push('');
  lines.push(`Papers: ${summary.total}`);
  lines.push(`Completed: ${summary.completed}`);
  if (summary.skipped) lines.push(`Skipped: ${summary.skipped}`);
  if (summary.failed) lines.push(`Failed: ${summary.failed}`);
  if (summary.skipped || summary.failed) {
    lines.push('');
    for (const p of summary.papers || []) {
      if (p.status === 'completed') continue;
      lines.push(`- [${p.status}] ${p.id}: ${p.reason || ''}`);
    }
  }
  for (const group of METRIC_GROUPS) {
    lines.push('');
    lines.push(`## ${group.label}`);
    for (const key of group.metrics) {
      lines.push(`${METRIC_LABELS[key]}: ${formatMetric(key, summary.metrics?.[key])}`);
    }
  }
  // 上游阶段没生效时必须显式点名（覆盖率看起来正常也不能掩盖）
  const fallbackPapers = (summary.papers || []).filter((p) => p.status === 'completed' && p.researchMapStatus && p.researchMapStatus !== 'model_success');
  const planFallback = (summary.papers || []).filter((p) => p.status === 'completed' && p.planStatus && p.planStatus !== 'model_success');
  if (fallbackPapers.length || planFallback.length) {
    lines.push('');
    lines.push('阶段降级明细：');
    for (const p of (summary.papers || []).filter((x) => x.status === 'completed')) {
      const bits = [];
      if (p.researchMapStatus && p.researchMapStatus !== 'model_success') bits.push(`research_map=${p.researchMapStatus}`);
      if (p.planStatus && p.planStatus !== 'model_success') bits.push(`plan=${p.planStatus}`);
      if (bits.length) lines.push(`  - ${p.id}: ${bits.join('、')}`);
    }
  }
  if (summary.comparison) {
    const c = summary.comparison;
    lines.push('');
    lines.push(`Baseline 对比：improved ${c.improved.length} / regressed ${c.regressed.length} / unchanged ${c.unchanged.length}`);
    for (const it of c.regressed) lines.push(`  回退 ${it.label}: ${(it.baseline * 100).toFixed(0)}% → ${(it.current * 100).toFixed(0)}%`);
    for (const it of c.improved) lines.push(`  提升 ${it.label}: ${(it.baseline * 100).toFixed(0)}% → ${(it.current * 100).toFixed(0)}%`);
  }
  return lines.join('\n');
}

/** 运行目录里的 README.md（人读版 summary）。 */
export function renderSummaryMarkdown(summary) {
  const lines = [];
  lines.push(`# DeepRead Benchmark ${summary.version || BENCHMARK_VERSION} 运行报告`);
  lines.push('');
  lines.push(`- 时间：${summary.startedAt}`);
  lines.push(`- Provider：${summary.provider || 'n/a'}${summary.model ? `（${summary.model}）` : ''}`);
  lines.push(`- 论文：${summary.total} 篇（完成 ${summary.completed} / 跳过 ${summary.skipped} / 失败 ${summary.failed}）`);
  lines.push(`- 说明：指标衡量「证据覆盖与结构完整性」，不是对文章文学质量的绝对评分。`);
  lines.push('');
  lines.push('## 汇总指标');
  lines.push('');
  lines.push('| 分组 | 指标 | 数值 |');
  lines.push('| --- | --- | --- |');
  for (const group of METRIC_GROUPS) {
    for (const key of group.metrics) {
      lines.push(`| ${group.label} | ${METRIC_LABELS[key]} | ${formatMetricPrecise(key, summary.metrics?.[key])} |`);
    }
  }
  lines.push('');
  lines.push('## 逐篇结果');
  lines.push('');
  lines.push('| 论文 | 分类 | 状态 | research_map | plan | sourceCoverage | latePaper | numbers | figures | formulas | ablation | limitation | auditMissing | auditConfidence | 耗时 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const pct = (v) => (typeof v === 'number' ? `${(v * 100).toFixed(0)}%` : 'n/a');
  for (const p of summary.papers || []) {
    if (p.status !== 'completed') {
      lines.push(`| ${p.id} | ${p.category || '-'} | ${p.status} | - | - | - | - | - | - | - | - | - | - | - | ${p.reason || ''} |`);
      continue;
    }
    const m = p.metrics || {};
    lines.push(
      `| ${p.id} | ${p.category || '-'} | completed | ${p.researchMapStatus || '-'} | ${p.planStatus || '-'} | ${pct(
        m.sourceCoverage,
      )} | ${pct(m.latePaperCoverage)} | ${pct(m.numberEvidenceCoverage)} | ${pct(m.figureCoverage)} | ${pct(
        m.formulaCoverage,
      )} | ${pct(m.ablationCoverage)} | ${pct(m.limitationCoverage)} | ${pct(m.auditMissingRate)} | ${pct(
        m.auditConfidence,
      )} | ${p.runtimeMs ? `${(p.runtimeMs / 1000).toFixed(0)}s` : '-'} |`,
    );
  }
  if (summary.comparison) {
    lines.push('');
    lines.push('## 与 baseline 对比');
    lines.push('');
    lines.push(`- 提升：${summary.comparison.improved.map((i) => `${i.label} ${(i.baseline * 100).toFixed(0)}%→${(i.current * 100).toFixed(0)}%`).join('；') || '无'}`);
    lines.push(`- 回退：${summary.comparison.regressed.map((i) => `${i.label} ${(i.baseline * 100).toFixed(0)}%→${(i.current * 100).toFixed(0)}%`).join('；') || '无'}`);
    lines.push(`- 持平：${summary.comparison.unchanged.map((i) => i.label).join('；') || '无'}`);
    if (summary.comparison.missing?.length) {
      lines.push(`- 无基线可比（新增指标或旧 baseline 未记录）：${summary.comparison.missing.map((k) => METRIC_LABELS[k] || k).join('；')}`);
    }
  }
  if (summary.notes?.length) {
    lines.push('');
    lines.push('## 备注');
    lines.push('');
    for (const n of summary.notes) lines.push(`- ${n}`);
  }
  return `${lines.join('\n')}\n`;
}

/** 汇总里出现的问题（供 CLI 报告「benchmark 暴露的实际问题」）。 */
export function collectQualityNotes(paperEntries, { lowThreshold = 0.6 } = {}) {
  const notes = [];
  for (const p of paperEntries) {
    if (p.status !== 'completed') continue;
    const m = p.metrics || {};
    const weak = Object.keys(METRIC_LABELS).filter((key) => {
      const v = m[key];
      if (typeof v !== 'number') return false;
      // 计数类指标单独在下面点名，不走「百分比弱项」扫描
      if (COUNT_METRICS.has(key)) return false;
      // 「越低越好」的指标：高了才是问题（不能把 fallback rate = 0% 当成弱项）
      const rate = LOWER_IS_BETTER.has(key) ? 1 - v : v;
      if (key === 'auditMissingRate') return v > 0.05;
      return rate < lowThreshold;
    });
    if (weak.length) {
      notes.push(`${p.id}：${weak.map((k) => `${METRIC_LABELS[k]}=${formatMetric(k, m[k])}`).join('、')}`);
    }
    if (p.lengthStability === 0) notes.push(`${p.id}：终稿疑似截断（lengthStability=0）`);
    if (p.degraded) notes.push(`${p.id}：走了降级流程（legacy fallback）`);
    // 静默降级比失败更危险：research map 没生效时，检索加权与消融/局限识别都退化成关键词匹配，
    // 覆盖率却可能看起来正常，所以必须显式报到 summary 里。
    // 注意取「统一阶段状态」：record 里的 researchMapStatus 是 v1 遗留字段（model|fallback）
    const mapStatus = p.researchMapStageStatus || p.researchMapStatus;
    // 'model' 是 v1 遗留的「模型产出」写法，等同于 model_success
    if (mapStatus && mapStatus !== 'model_success' && mapStatus !== 'model') {
      const extra =
        mapStatus === 'model_truncated'
          ? '输出被 max_tokens 截断（finish_reason=length），需提高 DEEPREAD_MAP_TOKENS 或换非 reasoning 模型'
          : mapStatus === 'fallback'
            ? '本地关键词兜底'
            : mapStatus;
      notes.push(`${p.id}：research map 未产出模型地图（${extra}）——证据定位、消融/局限识别的精度会下降`);
    }
    if (p.planStatus && p.planStatus !== 'model_success') {
      notes.push(`${p.id}：计划阶段未使用模型大纲（${p.planStatus}）——小节骨架退化为内置默认大纲`);
    }
    if (typeof p.stagesWithWarnings === 'number' && p.stagesWithWarnings > 0) {
      notes.push(`${p.id}：${p.stagesWithWarnings} 个阶段带告警（${(p.stageWarnings || []).join('、') || '见单篇记录'}）`);
    }
    if (typeof m.auditConfidence === 'number' && m.auditConfidence < 0.5) {
      notes.push(`${p.id}：审计可信度偏低（${(m.auditConfidence * 100).toFixed(0)}%）——上游地图未生效时 audit 的「通过」不能当结论`);
    }
  }
  return notes;
}

/** provider 可用性判定（runner 与测试共用，纯函数）。 */
export function resolveProviderStatus({ providerName = 'deepseek', apiKeyPresent = false, ollamaReachable = null } = {}) {
  if (providerName === 'ollama') {
    if (ollamaReachable === true) return { ok: true };
    return {
      ok: false,
      reason: 'Ollama 不可达',
      hint: '启动本地 Ollama（ollama serve），或设置 OLLAMA_BASE_URL 指向可用服务',
    };
  }
  if (apiKeyPresent) return { ok: true };
  const envName = providerName === 'openai' ? 'OPENAI_API_KEY' : 'DEEPSEEK_API_KEY';
  return {
    ok: false,
    reason: `未配置 ${envName}`,
    hint: `在 .env 里配置 ${envName}（或用 LLM_PROVIDER=ollama 跑本地模型）后再执行 npm run benchmark`,
  };
}

/**
 * 断点续跑：从上次运行目录里挑出「已完成且指标齐全」的记录复用，其余照常重跑。
 * benchmark 一轮要几十分钟，中途中断（Ctrl-C / 模型超时）不应该丢掉已完成的部分。
 *
 * @param {Array<object>} records 上次运行目录里的 papers/*.json 记录
 * @param {Iterable<string>} selectedIds 本次要跑的论文 id
 * @returns {{reusable: Array<object>, pending: string[]}}
 */
export function pickResumableRecords(records, selectedIds = []) {
  const wanted = new Set(selectedIds);
  const reusable = [];
  const covered = new Set();
  for (const r of records || []) {
    if (!r || typeof r !== 'object') continue;
    if (!wanted.has(r.id)) continue;
    if (r.status !== 'completed' || !r.metrics) continue;
    reusable.push(r);
    covered.add(r.id);
  }
  const pending = [...wanted].filter((id) => !covered.has(id));
  return { reusable, pending };
}

/** 复用记录 → 本次运行的 entry（补齐 summary 需要的字段）。 */
export function entryFromResumedRecord(record) {
  return {
    ...record,
    status: 'completed',
    resumed: true,
    lengthStability: record.metrics?.lengthStability ?? null,
  };
}
