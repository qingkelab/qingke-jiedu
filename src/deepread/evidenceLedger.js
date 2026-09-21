/**
 * Evidence Ledger（证据台账）—— Evidence/Writer v3
 *
 * 上一轮（Plan Coverage v1）之后，检索侧的 Recall 已经基本够用，但出现了一个新的断点：
 * **证据进了上下文，Writer 没有稳定地把它写进终稿**（2501 的主结果数字、1706 的 label smoothing、
 * 2406 的 failure/partial success）。而且这个断点此前不可观测——没人记录「这条事实有没有被写」。
 *
 * 本模块把「论文级事实」变成一份可审计的台账：
 *   Research Map + Critical Facts + Plan + Retrieval evidence  →  事实（事实/证据/数字/来源）
 * 并在写作后逐节做 Fact Coverage，把每条事实判成：
 *   covered        写了，且能在原文定位
 *   derived        写了，是「按论文数据计算」的推导（必须在正文里明确标注）
 *   unsupported    写了，但原文找不到、也没标成推导（可能是编造）
 *   unwritten      证据在上下文里，但这一节没写
 *   missing_evidence 证据根本没能进入任何一节
 *
 * provenance 三分：source（原文可定位）/ derived（基于 source 的计算）/ interpretation（作者判断）。
 * 事实 ID 一律来自 Research Map / Critical Facts / 确定性抽取，**不允许 Writer 自造**。
 */

import { extractNumberTokens, normalizeNumberToken, numberValue, splitMarkdownSections } from './audit.js';
import { tokenize } from './chunker.js';

export const FACT_CATEGORIES = [
  'main_result',
  'ablation',
  'limitation',
  'failure',
  'method',
  'comparison',
  'formula',
  'figure',
];

export const FACT_PROVENANCE = ['source', 'derived', 'interpretation'];

export const FACT_STATUS = ['missing_evidence', 'unwritten', 'unsupported', 'derived', 'covered'];

/** 明确标注「这是计算/换算」的措辞（决定 derived 还是 unsupported）。 */
const DERIVED_MARKER =
  /按论文数据|按原文|换算|推算|折算|计算得|计算出来|两者相除|差值|由此可得|derived|per second|per frame|即\s*\d|＝\s*\d|=\s*\d/i;

const STOP_CLAIM = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'our', 'are', 'was', 'were', 'has', 'have',
  'can', 'not', 'but', 'its', 'their', '论文', '结果', '方法', '我们', '说明', '显示', '提出',
]);

/** 从 claim 里取「技术性词」（英文词/带数字/大写）——用于判断 claim 是否真的被表达。 */
export function technicalTerms(claim, limit = 8) {
  const out = new Set();
  for (const raw of String(claim || '').match(/[A-Za-z][A-Za-z0-9+#_.\-]{2,}/g) || []) {
    const t = raw.replace(/^[._-]+|[._-]+$/g, '').toLowerCase();
    if (t.length >= 3 && !STOP_CLAIM.has(t)) out.add(t);
  }
  for (const n of extractNumberTokens(claim)) out.add(n);
  return [...out].slice(0, limit);
}

/** chunkId → 文本（小写）索引。 */
function buildChunkIndex(structure) {
  const map = new Map();
  for (const c of structure?.chunks || []) map.set(c.id, String(c.text || ''));
  return map;
}

/** 某个数字是否能在给定 chunk 集合里定位（exact / normalized）。 */
export function numberLocatableIn(value, chunkIds, chunkIndex) {
  const key = normalizeNumberToken(value);
  for (const id of chunkIds || []) {
    const text = chunkIndex.get(id) || '';
    for (const t of extractNumberTokens(text)) {
      if (t === value || normalizeNumberToken(t) === key) return id;
    }
  }
  return '';
}

/**
 * 从事实的证据 chunk 里抽「必须保留的数字」：带 mustUseTerm 的句子里出现的数字。
 * 只认原文真实出现过的数字（source provenance）。
 */
export function extractFactNumbers(fact, { structure, limitPerTerm = 2, maxTotal = 8 } = {}) {
  const chunkIndex = buildChunkIndex(structure);
  const out = [];
  const seen = new Set();
  const terms = (fact.mustUseTerms || []).filter(Boolean);
  const chunkIds = fact.evidence?.chunkIds?.length ? fact.evidence.chunkIds : fact.chunkIds || [];
  for (const id of chunkIds) {
    const text = chunkIndex.get(id) || '';
    if (!text) continue;
    const sentences = text.split(/(?<=[。！？!?;；])\s*|(?<=\.)\s+(?=[A-Z(])/);
    for (const sentence of sentences) {
      const lowered = sentence.toLowerCase();
      const hitTerm = terms.find((t) => lowered.includes(String(t).toLowerCase()));
      if (!hitTerm && terms.length) continue;
      let taken = 0;
      for (const value of extractNumberTokens(sentence)) {
        const key = `${value}@${id}`;
        if (seen.has(key)) continue;
        if (out.filter((n) => n.value === value).length >= 2) continue;
        if (taken >= limitPerTerm) break;
        seen.add(key);
        taken += 1;
        out.push({ value, term: hitTerm || '', chunkIds: [id], sourceValue: value, relation: 'exact' });
        if (out.length >= maxTotal) return out;
      }
    }
  }
  return out;
}

/** 把 Research Map 里没被 criticalFacts 覆盖的公式/图补成事实。 */
function factsFromMapExtras({ researchMap, structure }) {
  const out = [];
  const push = (field, category) => {
    for (const raw of researchMap?.[field] || []) {
      const text = String((typeof raw === 'string' ? raw : raw?.text) || '').replace(/\s+/g, ' ').trim();
      if (text.length < 6) continue;
      out.push({
        category,
        claim: text,
        provenance: 'source',
        priority: 'medium',
        chunkIds: Array.isArray(raw?.chunkIds) ? raw.chunkIds : [],
        mustUseTerms: [],
        origin: `research_map.${field}`,
      });
    }
  };
  push('equations', 'formula');
  push('figures', 'figure');
  if (!out.length) return [];
  // 只保留能在原文定位的条目
  const chunkIndex = buildChunkIndex(structure);
  return out.filter((f) => (f.chunkIds || []).some((id) => chunkIndex.has(id)));
}

/**
 * 构建论文级 Evidence Ledger。
 * @returns {{paperId:string, facts:Array, bySection:Object, stats:Object}}
 */
export function buildEvidenceLedger({
  paperId = '',
  researchMap = null,
  criticalFacts = [],
  plan = [],
  retrievalResults = [],
  structure = null,
} = {}) {
  const chunkIndex = buildChunkIndex(structure);
  // 全篇数字集合：判断「这个数字能不能在原文找到」时以整篇为准（而不是只看该事实绑定的 chunk），
  // 否则研究地图退化成兜底时，文章里合法的原文数字会被误判成 unsupported。
  const paperNumbers = new Set();
  const paperValues = new Set();
  for (const text of chunkIndex.values()) {
    for (const t of extractNumberTokens(text)) {
      paperNumbers.add(normalizeNumberToken(t));
      const v = (normalizeNumberToken(t).match(/^-?\d+(?:\.\d+)?/) || [])[0];
      if (v) paperValues.add(v);
    }
  }
  const facts = [];
  const seen = new Set();

  const addFact = (f) => {
    const key = String(f.claim || '').slice(0, 60).toLowerCase();
    if (!f.claim || seen.has(key)) return;
    seen.add(key);
    const id = f.id || `F${String(facts.length + 1).padStart(3, '0')}`;
    const evidenceChunkIds = [...new Set([...(f.chunkIds || []), ...(f.evidence?.chunkIds || [])])];
    const fact = {
      id,
      category: FACT_CATEGORIES.includes(f.category) ? f.category : 'method',
      claim: String(f.claim).replace(/\s+/g, ' ').trim(),
      provenance: FACT_PROVENANCE.includes(f.provenance) ? f.provenance : 'source',
      priority: f.priority === 'high' ? 'high' : 'medium',
      sourceSectionIds: f.sourceSectionIds || [],
      sourceSections: f.sourceSections || f.sourceSectionTitles || [],
      chunkIds: evidenceChunkIds,
      mustUseTerms: (f.mustUseTerms || []).map(String).filter(Boolean),
      mustUseNumbers: f.mustUseNumbers || [],
      planSections: [],
      writerSections: [],
      origin: f.origin || 'critical_facts',
      status: 'missing_evidence',
      reason: '',
      sourceNumbers: [],
    };
    fact.mustUseNumbers = fact.mustUseNumbers.length
      ? fact.mustUseNumbers
      : extractFactNumbers(fact, { structure });
    // 该事实绑定的 chunk 里出现过的所有数字（归一化）——用于判断「写出来的数字能不能回溯到原文」，
    // 这样 Fact Coverage 不再依赖 structure（Review 阶段也能独立复检）。
    const nums = new Set();
    for (const id of fact.chunkIds) {
      for (const t of extractNumberTokens(chunkIndex.get(id) || '')) nums.add(normalizeNumberToken(t));
    }
    fact.sourceNumbers = [...nums];
    facts.push(fact);
  };

  for (const f of criticalFacts || []) {
    addFact({
      id: f.id,
      category: f.category,
      claim: f.fact || f.claim,
      provenance: 'source',
      priority: f.priority,
      sourceSectionIds: f.sourceSectionIds || [],
      sourceSections: f.sourceSectionTitles || [],
      chunkIds: f.evidence?.chunkIds || [],
      mustUseTerms: f.mustUseTerms || [],
      origin: f.provenance || 'critical_facts',
    });
  }
  for (const f of factsFromMapExtras({ researchMap, structure })) addFact(f);

  // fact → plan section（来自 Plan Coverage 的分发结果）+ 该节实际用了哪些 chunk
  const sectionByIdx = plan.map((s, i) => ({ ...s, index: i }));
  const retrievalByIdx = new Map(retrievalResults.map((r, i) => [i, r]));
  for (const f of facts) {
    const owners = [];
    for (const s of sectionByIdx) {
      if ((s.criticalFactIds || []).includes(f.id)) owners.push(s);
    }
    f.planSections = owners.map((s) => s.title);
    const used = new Set();
    for (const s of owners) {
      const r = retrievalByIdx.get(s.index);
      for (const id of r?.chunkIds || []) if (f.chunkIds.includes(id)) used.add(id);
    }
    f.retrievedChunkIds = [...used];
    f.writerSections = owners.map((s) => s.title);
    f.status = f.chunkIds.length ? (used.size ? 'unwritten' : 'missing_evidence') : 'missing_evidence';
    if (!f.chunkIds.length) f.reason = '事实没有绑定到任何原文 chunk';
    else if (!used.size) f.reason = '绑定的 chunk 没有进入任何写作小节的证据';
  }

  const bySection = {};
  for (const f of facts) {
    for (const title of f.writerSections) {
      if (!bySection[title]) bySection[title] = [];
      bySection[title].push(f.id);
    }
  }

  return { paperId, facts, bySection, paperNumbers: [...paperNumbers], paperValues: [...paperValues], stats: ledgerStats(facts) };
}

/** 台账的确定性统计。 */
export function ledgerStats(facts = []) {
  const count = (list, fn) => list.filter(fn).length;
  return {
    total: facts.length,
    byCategory: facts.reduce((acc, f) => {
      acc[f.category] = (acc[f.category] || 0) + 1;
      return acc;
    }, {}),
    withEvidence: count(facts, (f) => (f.chunkIds || []).length > 0),
    retrievedIntoSection: count(facts, (f) => (f.retrievedChunkIds || []).length > 0),
    highPriority: count(facts, (f) => f.priority === 'high'),
  };
}

/** 小节标题 → 正文（H2 切分）。 */
export function sectionsFromMarkdown(markdown) {
  const out = {};
  for (const sec of splitMarkdownSections(markdown)) {
    if (sec.heading && sec.level === 2) out[sec.heading.trim()] = sec.body || '';
  }
  return out;
}

/** 关掉中文/英文标点差异，做包含判定。 */
function looseIncludes(haystack, needle) {
  const a = String(haystack || '').toLowerCase();
  const b = String(needle || '').toLowerCase().trim();
  if (!b) return false;
  if (a.includes(b)) return true;
  const stripped = (s) => s.replace(/[\s，,。.、；;：:（）()【】\[\]"'“”]/g, '');
  return stripped(a).includes(stripped(b));
}

/** 数字等价判定：字面 / 归一化 / 数值相等（与 audit 的 exact-normalized-approximate 同口径）。 */
export function numberEquivalent(value, writtenTokens = []) {
  const key = normalizeNumberToken(value);
  const numOf = (s) => {
    const m = normalizeNumberToken(s).match(/^-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  const target = numOf(value);
  return writtenTokens.some((t) => {
    if (t === value || normalizeNumberToken(t) === key) return true;
    const other = numOf(t);
    return target != null && other != null && target === other;
  });
}

/** 关键词命中比例（与 benchmark 的 matchKeywords 同口径，本地实现避免循环依赖）。 */
export function termHitsOf(terms = [], text = '') {
  const list = (terms || []).filter(Boolean);
  return list.filter((t) => looseIncludes(text, t));
}

/**
 * 判断一条事实在某段文本里是否被写出来（strict 模式用于 high priority）。
 * @returns {{status:string, termHits:number, termTotal:number, numberHits:number, numberTotal:number, unsupportedNumbers:string[], derivedNumbers:string[], reason:string}}
 */
export function assessFactInText(fact, text, { structure, chunkIndex, paperNumbers = null, paperValues = null } = {}) {
  const idx = chunkIndex || buildChunkIndex(structure);
  const md = String(text || '');
  const termList = (fact.mustUseTerms || []).filter(Boolean);
  const claimTerms = technicalTerms(fact.claim);
  // 「要写成什么样才算覆盖」的术语集合：
  //  ① claim 自带的技术词/数字（Transformer、WMT、AIME、28.4…）
  //  ② 挖掘出来的术语里**可能出现在中文文章里的**（≤3 词且含拉丁字母/数字，如 label smoothing）
  // 像 `new single-model state-of-the-art` 这种超长短语是中国文章永远不会照写的，只作检索提示，不作硬门槛。
  const minedTerms = termList.filter(
    (t) => String(t).trim().split(/\s+/).length <= 3 && /[A-Za-z0-9]/.test(String(t)),
  );
  const requiredTerms = [...new Set([...claimTerms, ...minedTerms])];
  const termHits = termHitsOf(requiredTerms, md);
  const claimOk = requiredTerms.length ? termHits.length >= 1 : true;

  const numberValues = (fact.mustUseNumbers || []).map((n) => n.value);
  const writtenTokens = extractNumberTokens(md);
  const matchedNumbers = numberValues.length ? numberValues.filter((v) => numberEquivalent(v, writtenTokens)) : [];
  const strict = fact.priority === 'high';
  // 术语门槛：high 要求覆盖 40% 的关键词，medium 30%（claim 里常含中英混排，不能按字面全中要求）；
  // 数字门槛仍是主要判据（有数字的事实用数字说话）。
  const termOk = !requiredTerms.length || termHits.length >= Math.max(1, Math.ceil(requiredTerms.length * (strict ? 0.4 : 0.3)));
  const numberOk =
    !numberValues.length || matchedNumbers.length >= Math.max(1, Math.ceil(numberValues.length * (strict ? 0.6 : 0.5)));

  // 正文里出现的数字：能定位到 source 的是合法，带推导标记的归 derived，其它归 unsupported
  const writtenNumbers = [...new Set(writtenTokens)];
  const sourceNumberSet = new Set([
    ...(fact.sourceNumbers || []),
    ...(fact.mustUseNumbers || []).map((n) => normalizeNumberToken(n.value)),
    ...(paperNumbers || []),
  ]);
  const sourceValues = new Set([
    ...[...sourceNumberSet]
      .map((s) => (String(s).match(/^-?\d+(?:\.\d+)?/) || [])[0])
      .filter(Boolean),
    ...(paperValues || []),
  ]);
  // 数值等价集合：终稿 token 常带单位后缀（写「41.0 BLEU」→ token 41.0b），
  // 而 paperNumbers 里存的是归一化后的 41（尾零被吃掉），字符串比对会双双落空。
  // 这里补一层**数值**比较（41.0b ≡ 41.0 ≡ 41），口径与 audit 的数字匹配一致。
  const sourceNumerics = new Set();
  for (const raw of [...sourceNumberSet, ...(paperNumbers || []), ...(paperValues || [])]) {
    const v = numberValue(raw);
    if (v != null) sourceNumerics.add(v);
  }
  const numericOf = (raw) => numberValue(raw);
  const locatable = (value) =>
    sourceNumberSet.has(normalizeNumberToken(value)) ||
    sourceValues.has((String(value).match(/^-?\d+(?:\.\d+)?/) || [])[0]) ||
    (() => {
      const v = numericOf(value);
      return v != null && sourceNumerics.has(v);
    })() ||
    numberLocatableIn(value, fact.chunkIds, idx);
  const unsupportedNumbers = [];
  const derivedNumbers = [];
  for (const value of writtenNumbers) {
    if (locatable(value)) continue;
    const sentences = md.split(/[。！？!?\n]/);
    const sentence = sentences.find((s) => s.includes(value)) || '';
    if (DERIVED_MARKER.test(sentence)) derivedNumbers.push(value);
    else unsupportedNumbers.push(value);
  }

  if (termOk && numberOk && claimOk) {
    if (unsupportedNumbers.length) {
      return {
        status: 'unsupported',
        termHits: termHits.length,
        termTotal: termList.length,
        numberHits: matchedNumbers.length,
        numberTotal: numberValues.length,
        unsupportedNumbers,
        derivedNumbers,
        reason: `写出的数字里 ${unsupportedNumbers.join('、')} 无法在原文定位，也没有标注为推导`,
      };
    }
    if (derivedNumbers.length) {
      return {
        status: 'derived',
        termHits: termHits.length,
        termTotal: termList.length,
        numberHits: matchedNumbers.length,
        numberTotal: numberValues.length,
        unsupportedNumbers,
        derivedNumbers,
        reason: `包含基于原文的推导数字：${derivedNumbers.slice(0, 4).join('、')}`,
      };
    }
    return {
      status: 'covered',
      termHits: termHits.length,
      termTotal: termList.length,
      numberHits: matchedNumbers.length,
      numberTotal: numberValues.length,
      unsupportedNumbers,
      derivedNumbers,
      reason: '',
    };
  }

  const missingBits = [];
  if (!termOk) missingBits.push(`术语 ${termHits.length}/${requiredTerms.length}`);
  if (!numberOk) missingBits.push(`数字 ${matchedNumbers.length}/${numberValues.length}`);
  if (!claimOk) missingBits.push('claim 未表达');
  return {
    status: 'unwritten',
    termHits: termHits.length,
    termTotal: termList.length,
    numberHits: matchedNumbers.length,
    numberTotal: numberValues.length,
    unsupportedNumbers,
    derivedNumbers,
    reason: `证据已在上下文，但本节没写出来（${missingBits.join('，')}）`,
  };
}

/**
 * 逐节 Fact Coverage：对每个写作小节，检查它负责的每条事实。
 * @param {object} args
 * @param {object} args.ledger buildEvidenceLedger 的结果
 * @param {object} args.markdownBySection { sectionTitle: body }
 */
export function checkSectionFactCoverage({ ledger, markdownBySection = {}, structure = null } = {}) {
  const chunkIndex = buildChunkIndex(structure);
  const paperNumbers = ledger?.paperNumbers || null;
  const paperValues = ledger?.paperValues || null;
  const results = [];
  const byFact = {};
  for (const fact of ledger?.facts || []) {
    const owners = (fact.writerSections || []).filter((t) => markdownBySection[t] != null);
    if (!owners.length) {
      // 还没写到这一节：保持台账里的状态（missing_evidence / unwritten）
      byFact[fact.id] = { factId: fact.id, status: fact.status, section: '', ...emptyAssessment(fact) };
      results.push(byFact[fact.id]);
      continue;
    }
    let best = null;
    for (const title of owners) {
      const assessed = assessFactInText(fact, markdownBySection[title], { structure, chunkIndex, paperNumbers, paperValues });
      const entry = { factId: fact.id, section: title, ...assessed };
      if (!best || statusRank(assessed.status) < statusRank(best.status)) best = entry;
      results.push(entry);
    }
    if (best) byFact[fact.id] = best;
  }
  return { results, byFact, stats: coverageStats(Object.values(byFact), ledger?.facts || []) };
}

/** 状态优先级（越小越好），用于「一条事实只取最好的那次判定」。 */
function statusRank(status) {
  return ['covered', 'derived', 'unsupported', 'unwritten', 'missing_evidence'].indexOf(status);
}

function emptyAssessment(fact) {
  return {
    status: fact.status || 'missing_evidence',
    termHits: 0,
    termTotal: (fact.mustUseTerms || []).length,
    numberHits: 0,
    numberTotal: (fact.mustUseNumbers || []).length,
    unsupportedNumbers: [],
    derivedNumbers: [],
    reason: fact.reason || '尚未进入任何写作小节',
  };
}

/** Writer Fact Coverage 统计（benchmark 指标直接消费）。 */
export function coverageStats(assessments = [], facts = []) {
  // 分母只算「有写作小节负责」的事实：没被分配到任何小节的事实属于 Plan/Retrieval 的缺口，
  // 单独用 unassignedFactRate 报告，不混进 writerFactCoverage（否则图表/公式类事实会把分母撑大）。
  const factById = new Map((facts || []).map((f) => [f.id, f]));
  const assignedList = assessments.filter((a) => {
    const f = factById.get(a.factId);
    return f ? (f.writerSections || []).length > 0 : Boolean(a.section);
  });
  const assigned = assignedList.length;
  const unassigned = assessments.filter((a) => factById.get(a.factId) && !(factById.get(a.factId).writerSections || []).length).length;
  const byStatus = (s) => assignedList.filter((a) => a.status === s).length;
  const covered = byStatus('covered');
  const derived = byStatus('derived');
  const unsupported = byStatus('unsupported');
  const unwritten = byStatus('unwritten');
  const missing = byStatus('missing_evidence');
  const written = covered + derived + unsupported;
  const atLeastWritten = covered + derived;
  const byCategory = (category) => {
    const ids = facts.filter((f) => f.category === category).map((f) => f.id);
    if (!ids.length) return null;
    const own = assignedList.filter((a) => ids.includes(a.factId));
    if (!own.length) return null;
    const good = own.filter((a) => a.status === 'covered' || a.status === 'derived').length;
    return Number((good / own.length).toFixed(4));
  };
  const highPriority = facts.filter((f) => f.priority === 'high').map((f) => f.id);
  const highOwn = assignedList.filter((a) => highPriority.includes(a.factId));
  return {
    assigned,
    unassigned,
    unassignedFactRate: assessments.length ? Number((unassigned / assessments.length).toFixed(4)) : null,
    covered,
    derived,
    unsupported,
    unwritten,
    missingEvidence: missing,
    writtenFactCoverage: assigned ? Number((atLeastWritten / assigned).toFixed(4)) : null,
    coverage: assigned ? Number(((covered + derived) / assigned).toFixed(4)) : null,
    unsupportedFactRate: written ? Number((unsupported / written).toFixed(4)) : null,
    unwrittenFactRate: assigned ? Number((unwritten / assigned).toFixed(4)) : null,
    derivedFactRate: written ? Number((derived / written).toFixed(4)) : null,
    highPriorityCoverage: highOwn.length
      ? Number((highOwn.filter((a) => a.status === 'covered' || a.status === 'derived').length / highOwn.length).toFixed(4))
      : null,
    mainResultCoverage: byCategory('main_result'),
    ablationCoverage: byCategory('ablation'),
    limitationCoverage: byCategory('limitation'),
    failureCoverage: byCategory('failure'),
  };
}

/** 供 repair 使用：这一节还没写好的事实（unwritten / unsupported）。 */
export function repairTargetsFromCoverage(ledger, coverage, { includeUnsupported = true } = {}) {
  const out = [];
  for (const a of coverage?.results || []) {
    if (a.status !== 'unwritten' && !(includeUnsupported && a.status === 'unsupported')) continue;
    const fact = (ledger?.facts || []).find((f) => f.id === a.factId);
    if (!fact) continue;
    out.push({
      factId: fact.id,
      section: a.section,
      status: a.status,
      claim: fact.claim,
      mustUseTerms: fact.mustUseTerms,
      mustUseNumbers: fact.mustUseNumbers,
      chunkIds: fact.retrievedChunkIds?.length ? fact.retrievedChunkIds : fact.chunkIds,
      priority: fact.priority,
      reason: a.reason,
    });
  }
  return out;
}

/** 事实 ID 是否都来自台账（Review / Writer 不得自造 ID）。 */
export function isKnownFactId(ledger, id) {
  return (ledger?.facts || []).some((f) => f.id === id);
}

/** H2 小节标题序列（Review 不得增删小节）。 */
export function headingsOf(markdown) {
  return splitMarkdownSections(markdown)
    .filter((s) => s.heading && s.level === 2)
    .map((s) => s.heading.trim());
}

/** 状态好坏排序：数值越大越差。 */
function worseRank(status) {
  return ['covered', 'derived', 'unsupported', 'unwritten', 'missing_evidence'].indexOf(status);
}

/**
 * Review 回归护栏：审校不能破坏 Fact Coverage，也不能增删小节。
 * 触发条件（任一）→ 丢弃审校结果，保留原稿：
 *   1. H2 小节集合发生变化（新增/删除/改名）；
 *   2. 有任何一条事实的状态变差（covered/derived → unwritten/unsupported/missing_evidence）。
 */
export function checkReviewFactRegression({ before, after, ledger } = {}) {
  if (!ledger?.facts?.length) return { ok: true, reason: '', skipped: true };
  const headsBefore = headingsOf(before);
  const headsAfter = headingsOf(after);
  if (headsBefore.join('｜') !== headsAfter.join('｜')) {
    const added = headsAfter.filter((h) => !headsBefore.includes(h));
    const removed = headsBefore.filter((h) => !headsAfter.includes(h));
    return {
      ok: false,
      reason:
        `审校改动了小节结构（+${added.length}/-${removed.length}` +
        `${added.length ? `；新增：${added.slice(0, 3).join('、')}` : ''}` +
        `${removed.length ? `；删除：${removed.slice(0, 3).join('、')}` : ''}）`,
    };
  }
  const covBefore = checkSectionFactCoverage({ ledger, markdownBySection: sectionsFromMarkdown(before) });
  const covAfter = checkSectionFactCoverage({ ledger, markdownBySection: sectionsFromMarkdown(after) });
  const regressed = [];
  for (const [id, a] of Object.entries(covAfter.byFact)) {
    const b = covBefore.byFact[id];
    if (!b) continue;
    if (worseRank(a.status) > worseRank(b.status)) regressed.push({ id, from: b.status, to: a.status });
  }
  if (regressed.length) {
    return {
      ok: false,
      reason: `审校导致 ${regressed.length} 条事实覆盖下降（例：${regressed[0].id} ${regressed[0].from}→${regressed[0].to}）`,
      regressed,
    };
  }
  return { ok: true, reason: '', before: covBefore.stats, after: covAfter.stats };
}
