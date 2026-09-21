/**
 * Plan Coverage v1：论文级关键事实（critical facts）的抽取、绑定与分发
 *
 * 动机（上一轮 Retrieval v2 之后的验收结论）：检索机制修好之后，瓶颈上移到 **Plan 覆盖度**——
 *   ① 研究地图里明明有的事实，计划没请求对应原文小节（1706 的 label smoothing / residual dropout
 *      位于 `Regularization`，计划请求了 19 个小节但没有它）→ 检索再怎么改也找不到；
 *   ② 单个小节请求十几个原文小节（2406 的 results 请求 11 个、2501 全篇 53 个），
 *      12 个证据槽位被摊薄，关键事实挤不进去；
 *   ③ mustUseTerms 先到先得，普通术语把 3 个 must-use 槽占满。
 *
 * 本模块只做**确定性**的三件事（不调用模型、不发明 chunkId、不改 Retrieval 评分）：
 *   1. 从 Research Map（main_results / ablations / limitations / key_claims / method_components）
 *      种出 5–8 条关键事实，并绑定到**真实 source section**；
 *   2. 把事实分发到最相关的计划小节（含「计划漏掉整个关键小节」时的自动补入）；
 *   3. 对 sourceSections（每节 ≤3）与 mustUseTerms（稀有关键术语优先）做预算与排序。
 */

import { tokenize } from './chunker.js';
import { normalizeSectionName } from './sourceSections.js';
import { extractNumberTokens } from './audit.js';

/** 事实类别判定（按优先级从具体到宽泛）。 */
const CATEGORY_RULES = [
  { category: 'failure', re: /失败|没成功|failure|unsuccessful|partial success|部分成功|错误案例|error case/i },
  { category: 'ablation', re: /消融|ablation|variant|变体|敏感性|sensitivity|去掉|移除|不加|w\/o|dropout|smoothing|weight decay|超参|hyperparameter/i },
  { category: 'limitation', re: /局限|边界|失效|限制|约束|假设|未验证|limitation|boundary|caveat|constraint|assumption/i },
  { category: 'comparison', re: /对比|比较|基线|优于|超过|提升|comparison|baseline|outperform|improv|gap/i },
  { category: 'main_result', re: /结果|指标|准确率|得分|success rate|bleu|accuracy|score|sota|pass@|f1|resolve rate/i },
  { category: 'method', re: /方法|机制|组件|架构|method|mechanism|component|architecture/i },
];

const HIGH_PRIORITY_CATEGORIES = new Set(['main_result', 'ablation', 'limitation', 'failure']);

/** 只出现很少次数的术语 = 论文里的「针尖」（AIME / MATH-500 / label smoothing）。 */
export const RARE_DF_THRESHOLD = 2;

/**
 * 受控术语表：论文里真正值得当「针尖」的消融变量 / 局限词 / 失败模式。
 * 只在文本里真实出现过才会被采用（df > 0），所以不会引入论文没有的说法。
 * 相比自由挖掘短语，这张表能稳定产出 `label smoothing` / `residual dropout` /
 * `failure cases` / `partial success` 这类术语，而不是 `size d_k` 这种拼接噪声。
 */
export const CURATED_TERMS = [
  'label smoothing',
  'residual dropout',
  'weight decay',
  'drop path',
  'layer normalization',
  'positional encoding',
  'attention heads',
  'beam search',
  'sensitivity',
  'robustness',
  'ablation study',
  'model variations',
  'component analysis',
  'low-rank adaptation',
  'quantization',
  'distillation',
  'cold start',
  'reward hacking',
  'language mixing',
  'overthinking',
  'hallucination',
  'failure cases',
  'failure case',
  'failure modes',
  'failure mode',
  'partial success',
  'unsuccessful attempts',
  'error analysis',
  'broader impacts',
  'ethics statement',
  'caveats',
  'future work',
];

const CURATED_SET = new Set(CURATED_TERMS);

/** 单词术语的最低门槛：短小的普通词（before / types / three）不算术语。 */
const SINGLE_WORD_TECH = /(?:\d|[-_/.]|[A-Z])/;
const KNOWN_TERM = /^(dropout|smoothing|perplexity|attention|encoder|decoder|beam|token|prompt|reward|verifier|distillation|quantization|latency|throughput|baseline|ablation|hallucination|overthinking)$/i;

export function isUsefulSingleTerm(term) {
  const t = String(term || '');
  if (t.includes(' ')) return true;
  if (t.length < 5) return false;
  return t.length >= 7 || SINGLE_WORD_TECH.test(t) || KNOWN_TERM.test(t);
}

const STOP_TERM = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'our', 'are', 'was', 'were', 'has', 'have',
  'can', 'not', 'but', 'its', 'their', '表', '图', '论文', '结果', '方法', '我们', '说明', '显示',
]);

/** 短语里的「功能词」：出现就说明这不是一个干净的术语短语（`we employ label smoothing` ✗）。 */
const PHRASE_STOP = new Set([
  ...STOP_TERM,
  'each', 'which', 'while', 'when', 'than', 'then', 'only', 'more', 'most', 'much', 'many',
  'some', 'any', 'all', 'both', 'such', 'same', 'other', 'there', 'here', 'about', 'over',
  'under', 'between', 'during', 'after', 'before', 'value', 'using', 'use', 'used', 'apply',
  'applied', 'employ', 'employed', 'show', 'shows', 'shown', 'report', 'reports', 'propose',
  'proposed', 'present', 'presented', 'paper', 'work', 'works', 'also', 'however', 'therefore',
  'obtain', 'obtained', 'achieve', 'achieved', 'reach', 'reaches', 'give', 'gives', 'given',
  'result', 'results', 'score', 'scores', 'setting', 'settings', 'case', 'cases',
  'hurts', 'improves', 'varies', 'needs', 'makes', 'takes', 'leads', 'comes', 'goes',
  'gets', 'keeps', 'grows', 'falls', 'rises', 'drops', 'reaches', 'remains', 'stays',
]);

/** 短语是否「干净」：多词短语里不能有功能词，单词长度 ≥3。 */
export function isCleanPhrase(phrase) {
  const words = String(phrase || '').trim().split(/\s+/);
  if (words.length < 2) return true;
  return words.every((w) => w.length >= 3 && !PHRASE_STOP.has(w.toLowerCase()));
}

/** 判定事实类别。 */
export function classifyFact(text) {
  const s = String(text || '');
  for (const rule of CATEGORY_RULES) if (rule.re.test(s)) return rule.category;
  return 'method';
}

/** 事实优先级：关键类别 + 带数字/技术词 → high。 */
export function factPriority(category, text) {
  if (!HIGH_PRIORITY_CATEGORIES.has(category)) return 'medium';
  const hasNumber = /\d/.test(String(text || ''));
  const hasTech = /[A-Za-z]{3,}/.test(String(text || ''));
  return hasNumber || hasTech ? 'high' : 'medium';
}

/** 词形候选：单词、连字符词、带数字/大写的术语、相邻 2–3 词短语。 */
export function candidateTerms(text) {
  const s = String(text || '');
  const out = new Set();
  for (const raw of tokenize(s)) {
    const t = raw.replace(/^[._-]+|[._-]+$/g, '');
    if (t.length >= 3 && !STOP_TERM.has(t)) out.add(t);
  }
  for (const m of s.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:[-/.][A-Za-z0-9]+)*\b/g)) {
    const t = m[0];
    if (t.length >= 3 && !STOP_TERM.has(t.toLowerCase())) out.add(t);
  }
  for (const m of s.matchAll(/\b(?:Table|Tab\.?|Figure|Fig\.?|Eq\.?|Equation)\s*\.?\s*\d{1,2}\b/gi)) {
    out.add(m[0].replace(/\s+/g, ' '));
  }
  const words = (s.match(/[A-Za-z][A-Za-z0-9+#_.-]{1,}/g) || [])
    .map((w) => w.toLowerCase().replace(/^[._-]+|[._-]+$/g, ''))
    .filter(Boolean);
  for (let i = 0; i + 1 < words.length; i += 1) {
    const bigram = `${words[i]} ${words[i + 1]}`;
    if (isCleanPhrase(bigram)) out.add(bigram);
    if (i + 2 < words.length) {
      const trigram = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
      if (isCleanPhrase(trigram)) out.add(trigram);
    }
  }
  return [...out];
}

/** 建立语料索引（小写 chunk 文本 + 术语→document frequency 的惰性缓存）。 */
export function buildCorpusIndex(structure) {
  const chunks = structure?.chunks || [];
  const texts = chunks.map((c) => ({ id: c.id, sectionId: c.sectionId, text: String(c.text || '').toLowerCase() }));
  const joined = texts.map((t) => t.text).join('\n');
  const dfCache = new Map();
  const df = (term) => {
    const key = String(term || '').toLowerCase();
    if (dfCache.has(key)) return dfCache.get(key);
    let n = 0;
    for (const t of texts) if (t.text.includes(key)) n += 1;
    dfCache.set(key, n);
    return n;
  };
  return { chunks, texts, joined, df, byId: new Map(texts.map((t) => [t.id, t])) };
}

/** 术语分层（数字越小越优先）。 */
export function termTier(term, { criticalTerms = new Set(), df = () => 0 } = {}) {
  const t = String(term || '').toLowerCase();
  if (criticalTerms.has(t)) return 1;
  const freq = df(term);
  if (freq > 0 && freq <= RARE_DF_THRESHOLD) return 2;
  if (/\d/.test(term) || /(bleu|accuracy|score|success rate|pass@|f1|resolve|aime|math-\d|gsm|humaneval|sota)/i.test(term)) return 3;
  if (/(dropout|smoothing|scaling|weight decay|learning rate|batch size|rank|temperature|variant|w\/o|hyperparameter|ablation)/i.test(term)) return 4;
  if (/(limitation|failure|unsuccessful|caveat|constraint|risk|ethic|broader impact|future work|boundary)/i.test(term)) return 5;
  return 6;
}

/**
 * 术语排序（deterministic）：层 → 稀有度(df 升序) → 长度降序 → 字典序。
 * @returns {Array<{term:string, tier:number, df:number}>}
 */
export function rankTerms(terms, { corpus, criticalTerms = new Set() } = {}) {
  const unique = [...new Set((terms || []).map((t) => String(t || '').trim()).filter(Boolean))];
  return unique
    .map((term) => ({ term, tier: termTier(term, { criticalTerms, df: corpus?.df }), df: corpus ? corpus.df(term) : 0 }))
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      // 同层内：两词短语（`label smoothing` / `residual dropout`）优先，其次单词，最后长短语。
      // 两词短语是论文里最典型的「针尖」，长短语往往是噪声组合。
      const rankGroup = (t) => {
        const term = String(t).trim();
        const words = term.split(/\s+/).length;
        const curated = CURATED_SET.has(term.toLowerCase());
        // 受控的两词术语（label smoothing / failure cases）最像「针尖」，其次受控单词，
        // 再次带数字/大写/连字符的专名（AIME / MATH-500 / Table 3 / p_drop），最后才是自由挖掘的短语
        if (curated && words >= 2) return 0;
        if (curated) return 1;
        if (/[A-Z]|\d|[-_/.]/.test(term)) return 2;
        if (words === 2) return 3;
        if (words === 1) return 4;
        return 5;
      };
      const ga = rankGroup(a.term);
      const gb = rankGroup(b.term);
      if (ga !== gb) return ga - gb;
      if (a.df !== b.df) return a.df - b.df;
      // 同组同频：越短越像「规范术语」（`failure cases` 优于 `unsuccessful attempts remain`）
      if (a.term.length !== b.term.length) return a.term.length - b.term.length;
      return a.term < b.term ? -1 : a.term > b.term ? 1 : 0;
    });
}

/**
 * 从一个 chunk 集合里抽「稀有术语」（用于把研究地图里的中文事实落成原文英文术语）。
 * 只保留语料里真实出现、且出现次数 ≤ 阈值的术语。
 */
export function rareTermsFromChunks(chunkIds, { structure, corpus, limit = 8, criticalTerms = new Set() } = {}) {
  const idx = corpus || buildCorpusIndex(structure);
  const ids = chunkIds?.length ? chunkIds : [];
  const text = ids.map((id) => idx.byId.get(id)?.text || '').join('\n');
  // 受控术语（文本里真实出现）+ 通用候选（长度/短语过滤）
  const curated = CURATED_TERMS.filter((t) => text.includes(t.toLowerCase()));
  const candidates = [...new Set([...curated, ...candidateTerms(text)])].filter(
    (t) => t.length >= 3 && !STOP_TERM.has(t.toLowerCase()) && isCleanPhrase(t),
  );
  const ranked = rankTerms(candidates, { corpus: idx, criticalTerms });
  // 同层同频时：多词术语优先（`label smoothing` 比 `before`/`sums` 这类孤立词更有信息量）
  const phrasesFirst = [...ranked].sort((a, b) => {
    // 只在「同层同频」内部调整，跨层顺序不变（稳定排序）
    if (a.tier !== b.tier || a.df !== b.df) return 0;
    const wa = a.term.trim().includes(' ') ? 0 : 1;
    const wb = b.term.trim().includes(' ') ? 0 : 1;
    if (wa !== wb) return wa - wb;
    return 0;
  });
  return phrasesFirst
    .filter((r) => r.df > 0 && isUsefulSingleTerm(r.term))
    .slice(0, limit)
    .map((r) => r.term);
}

/**
 * 把一条事实绑定到真实 source section：
 *   ① 研究地图给的 chunkIds（校验后映射到 section）
 *   ② 否则用「数字 + 英文术语」在全文里扫描最匹配的 chunk
 * 绝不发明 chunkId；绑定不上就如实记 unmatched。
 */
export function bindFactToSections(fact, { structure, sourceIndex, corpus } = {}) {
  const idx = corpus || buildCorpusIndex(structure);
  const chunks = structure?.chunks || [];
  const sectionOf = (chunkId) => chunks.find((c) => c.id === chunkId)?.sectionId || '';
  const titleOf = (sectionId) => sourceIndex?.sections.find((s) => s.id === sectionId)?.title || '';

  const fromMap = [...new Set((fact.chunkIds || []).map((id) => sectionOf(id)).filter(Boolean))];
  if (fromMap.length) {
    return {
      method: 'research_map_chunks',
      sectionIds: fromMap,
      sectionTitles: fromMap.map(titleOf).filter(Boolean),
      chunkIds: fact.chunkIds || [],
      primarySectionId: fromMap[0],
      primarySectionTitle: titleOf(fromMap[0]),
      unmatched: [],
    };
  }

  // 关键词扫描：事实里的数字与英文术语在哪些 chunk 里同时出现
  const numbers = [...new Set((String(fact.text || '').match(/\d+(?:\.\d+)?/g) || []))].slice(0, 6);
  // 只有「稀有」才作为定位信号：`bleu`、`3` 这类到处都有的词会把绑定打散
  const terms = candidateTerms(fact.text)
    .filter((t) => /[a-z]/i.test(t))
    .filter((t) => {
      const f = idx.df(t);
      return f > 0 && f <= RARE_DF_THRESHOLD;
    })
    .slice(0, 20);
  const scored = [];
  for (const c of chunks) {
    const lower = String(c.text || '').toLowerCase();
    let score = 0;
    for (const n of numbers) {
      // 小数（0.1）比整数（3）更有区分度：整数太容易撞上页码/表号
      if (!lower.includes(n)) continue;
      if (n.includes('.')) score += 3;
      else {
        const df = idx.df(n);
        if (df >= 1 && df <= 8) score += 2;
      }
    }
    for (const t of terms) if (lower.includes(t.toLowerCase())) score += 1.5;
    if (score > 0) scored.push({ chunk: c, score });
  }
  scored.sort((a, b) => b.score - a.score || a.chunk.index - b.chunk.index);
  const top = scored.slice(0, 3);
  const sectionIds = [...new Set(top.map((s) => s.chunk.sectionId).filter(Boolean))].slice(0, 2);
  const primary = top[0]?.chunk;
  return {
    method: top.length ? 'keyword_scan' : 'unmatched',
    sectionIds,
    sectionTitles: sectionIds.map(titleOf).filter(Boolean),
    chunkIds: top.map((s) => s.chunk.id),
    primarySectionId: primary?.sectionId || '',
    primarySectionTitle: primary ? titleOf(primary.sectionId) : '',
    unmatched: top.length ? [] : [String(fact.text || '').slice(0, 40)],
  };
}

const MAP_SOURCES = [
  { field: 'main_results', category: 'main_result', provenance: 'research_map.main_results' },
  { field: 'ablations', category: 'ablation', provenance: 'research_map.ablations' },
  { field: 'limitations', category: 'limitation', provenance: 'research_map.limitations' },
  { field: 'key_claims', category: 'comparison', provenance: 'research_map.key_claims' },
  { field: 'method_components', category: 'method', provenance: 'research_map.method_components' },
];

/**
 * 从 Research Map 种出论文级关键事实（5–8 条）。
 * 优先级顺序：main_results → ablations → limitations → key_claims → method_components，
 * 每类内部按地图顺序取，去重后截断到 maxFacts。
 */
export function seedCriticalFacts({ researchMap, structure, sourceIndex, corpus, maxFacts = 8 } = {}) {
  const idx = corpus || buildCorpusIndex(structure);
  const facts = [];
  const seen = new Set();
  if (!researchMap) return facts;

  for (const source of MAP_SOURCES) {
    if (facts.length >= maxFacts) break;
    const items = researchMap[source.field];
    if (!Array.isArray(items)) continue;
    for (const raw of items) {
      if (facts.length >= maxFacts) break;
      const text = String((typeof raw === 'string' ? raw : raw?.text) || '').replace(/\s+/g, ' ').trim();
      if (text.length < 6) continue;
      const key = normalizeSectionName(text).slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);
      // 地图字段本身决定了主类别；limitations 里写失败模式的记为 failure
      const guessed = classifyFact(text);
      const category =
        source.category === 'limitation' && guessed === 'failure'
          ? 'failure'
          : source.category === 'comparison'
            ? guessed === 'ablation'
              ? 'ablation'
              : 'comparison'
            : source.category;
      const binding = bindFactToSections(
        { text, chunkIds: Array.isArray(raw?.chunkIds) ? raw.chunkIds : [] },
        { structure, sourceIndex, corpus: idx },
      );
      // 术语来源：事实最可能落点的 1–2 个 chunk + 该小节自己的 chunk（最多再取 2 个），
      // 这样「事实在小节正文里、而命中 chunk 只覆盖前半段」时也不会漏掉术语。
      const primaryChunks = binding.primarySectionId
        ? (sourceIndex?.sections.find((s) => s.id === binding.primarySectionId)?.chunkIds || []).slice(0, 3)
        : [];
      const termSourceChunks = [...new Set([...binding.chunkIds.slice(0, 2), ...primaryChunks])].slice(0, 4);
      const terms = rareTermsFromChunks(termSourceChunks, { structure, corpus: idx, limit: 6 });
      facts.push({
        id: `cf-${facts.length + 1}`,
        fact: text,
        category,
        provenance: source.provenance,
        priority: factPriority(category, text),
        sourceSectionIds: binding.sectionIds,
        sourceSectionTitles: binding.sectionTitles,
        primarySectionId: binding.primarySectionId || '',
        primarySectionTitle: binding.primarySectionTitle || '',
        mustUseTerms: terms,
        evidence: { chunkIds: binding.chunkIds.slice(0, 4), mapping: binding.method },
        mapping: { method: binding.method, unmatched: binding.unmatched },
      });
    }
  }
  return facts;
}
/** 类别 → 期望的小节角色（分发时的先验）。 */
/** 论文小节名的类别（用于覆盖兜底：Regularization / Limitations / Experiments …）。 */
const SECTION_KIND_RULES = [
  { kind: 'ablation', re: /ablation|variations?|regularization|robustness|sensitivity|variant|hyper[- ]?parameter|component analysis/i },
  // 失败案例/未成功尝试也属于「边界」，要被 coverage 兜底捞到（2501 的 G.2 Unsuccessful Attempts）
  { kind: 'limitation', re: /limitation|discussion|failure|error analysis|ethic|broader impact|caveat|threat|unsuccessful|failed attempts/i },
  { kind: 'results', re: /experiment|results?|evaluation|benchmark|comparison|analysis|ablation study|main results/i },
  { kind: 'appendix', re: /(^|\b)appendix|additional (analysis|experiments)/i },
];

export function sectionKind(title) {
  const s = String(title || '');
  for (const rule of SECTION_KIND_RULES) if (rule.re.test(s)) return rule.kind;
  return '';
}

const CATEGORY_ROLE_PRIOR = {
  main_result: { results: 3, ablation: 2.5, discussion: 1, general: 0.5 },
  ablation: { ablation: 3.5, results: 2.5, method: 1 },
  limitation: { limitation: 3.5, discussion: 3, results: 1 },
  failure: { limitation: 3, discussion: 2.5, results: 1 },
  comparison: { results: 2.5, ablation: 2, discussion: 1 },
  method: { method: 3, formula: 2.5, intro: 1 },
};

const CATEGORY_TITLE_HINT = {
  main_result: /评测|实验|结果|主结果|数字|result|experiment|eval|score|benchmark/i,
  ablation: /消融|变体|ablation|variant|sensitivity|敏感性/i,
  limitation: /边界|局限|失效|风险|追问|limitation|boundary|caveat/i,
  failure: /失败|failure|错误|error|失败案例/i,
  comparison: /对比|比较|基线|comparison|baseline/i,
  method: /机制|组件|架构|method|architecture|component/i,
};

/** 每个类别的「本命角色」：满足时给强加成，压过「只是恰好请求到同一个小节」的邻居。 */
const CANONICAL_ROLE = {
  main_result: 'results',
  ablation: 'ablation',
  limitation: 'limitation',
  failure: 'limitation',
  comparison: 'results',
  method: 'method',
};

/**
 * 事实 → 小节亲和度（deterministic）。
 * 角色先验 + 标题提示 + 已请求的 source section 是否覆盖该事实。
 */
export function sectionAffinity(section, fact, { sourceIndex } = {}) {
  const role = section.role || 'general';
  const title = String(section.title || '');
  let score = (CATEGORY_ROLE_PRIOR[fact.category]?.[role] || 0) * 2;
  if (CANONICAL_ROLE[fact.category] === role) score += 3;
  if (CATEGORY_TITLE_HINT[fact.category]?.test(title)) score += 2;
  const factTitles = new Set((fact.sourceSectionTitles || []).map((t) => String(t)));
  const requested = new Set(section.sourceSections || []);
  for (const t of factTitles) if (requested.has(t)) score += 2;
  if (fact.primarySectionTitle && requested.has(fact.primarySectionTitle)) score += 2;
  if (sourceIndex && factTitles.size && requested.size) {
    // 请求的 source section 与事实绑定的 section 在文档顺序上相邻 → 略有加成（同一片实验区）
    const factOrders = (fact.sourceSectionIds || [])
      .map((id) => sourceIndex.sections.find((s) => s.id === id)?.order)
      .filter((n) => Number.isFinite(n));
    const reqOrders = [...requested]
      .map((t) => sourceIndex.sections.find((s) => s.title === t)?.order)
      .filter((n) => Number.isFinite(n));
    if (factOrders.length && reqOrders.length) {
      const dist = Math.min(...factOrders.map((a) => Math.min(...reqOrders.map((b) => Math.abs(a - b)))));
      if (dist <= 2) score += 1;
    }
  }
  return score;
}

/**
 * 把关键事实分发到计划小节，并把「地图里已存在、但计划没请求的原文小节」自动补入。
 *
 * 规则（与验收要求一致）：
 *   - 每条 high-priority 事实至少落到一个最相关小节；落不下就选最近的小节并记 reason；
 *   - main_result → Results/Experiment 类；ablation → Ablation/Experiment 类；
 *     limitation/failure → Limitation/Discussion/Failure 类；
 *   - 每节最终 sourceSections ≤ maxSourceSections（默认 3），事实要求的优先，其余进 deferred；
 *   - mustUseTerms 按「关键术语 → 稀有 → 指标 → 消融变量 → 局限词 → 普通词」排序后截断，
 *     被截断的进 mustUseTermsDeferred。
 *
 * @returns {{plan:Array, facts:Array, coverage:object}}
 */
export function distributeCriticalFacts({
  plan = [],
  facts = [],
  sourceIndex,
  structure,
  corpus,
  maxSourceSections = 3,
  // must-use slot 只有 3 个，但候选术语多一点没坏处：术语本身不占上下文，只是给槽位排队
  maxTermsPerSection = 8,
  maxCoverageAdditions = null,
} = {}) {
  const idx = corpus || buildCorpusIndex(structure);
  const sections = plan.map((s) => ({ ...s }));
  if (!sections.length) {
    return { plan: sections, facts, coverage: emptyCoverage(facts) };
  }

  // 1) 事实 → 小节
  const assignments = new Map(); // factId → [sectionIndex]
  const reasonById = new Map();
  const ordered = [...facts].sort((a, b) => (a.priority === b.priority ? 0 : a.priority === 'high' ? -1 : 1));
  for (const fact of ordered) {
    const scored = sections
      .map((s, i) => ({ i, score: sectionAffinity(s, fact, { sourceIndex }) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.i - b.i);
    if (scored.length) {
      // high 事实落到最相关的一个小节；medium 允许落到前两个（覆盖更稳）
      const take = fact.priority === 'high' ? scored.slice(0, 1) : scored.slice(0, 2);
      assignments.set(fact.id, take.map((x) => x.i));
      reasonById.set(fact.id, `affinity=${take[0].score.toFixed(1)}${scored[0].score < 3 ? '（弱匹配）' : ''}`);
    } else {
      // 没有任何相关小节 → 选距离事实绑定 section 最近的小节
      const factOrder = (fact.sourceSectionIds || [])
        .map((id) => sourceIndex?.sections.find((s) => s.id === id)?.order)
        .filter((n) => Number.isFinite(n));
      let pick = 0;
      if (factOrder.length) {
        const target = factOrder[0];
        const reqOrders = sections.map((s) =>
          Math.min(
            ...(s.sourceSections || [])
              .map((t) => sourceIndex?.sections.find((x) => x.title === t)?.order)
              .filter((n) => Number.isFinite(n)),
            Infinity,
          ),
        );
        let best = Infinity;
        reqOrders.forEach((o, i) => {
          const d = Number.isFinite(o) ? Math.abs(o - target) : Infinity;
          if (d < best) {
            best = d;
            pick = i;
          }
        });
      }
      assignments.set(fact.id, [pick]);
      reasonById.set(fact.id, 'nearest_section（没有明显对应小节）');
    }
  }

  // 2) 每节：事实要求的 source section 优先，其次模型请求，超预算进 deferred
  const titleOf = (id) => sourceIndex?.sections.find((s) => s.id === id)?.title || '';
  const addedByFacts = new Map(); // sectionIndex → [title]
  const factTermsBySection = new Map(); // sectionIndex → [term]
  const factIdsBySection = new Map(); // sectionIndex → [factId]
  // 事实驱动的 source section 优先级：**primary（定位置信最高的那个小节）优先**，
  // 其次 high priority 事实带来的小节，最后才是普通事实。这样 ≤3 预算不会把
  // 稀有事实（97.3 / Unsuccessful / failure）的小节挤到 deferred。
  const sectionRank = new Map(); // title → 排序键
  const bumpRank = (title, fact) => {
    // 排序键：① 事实优先级 ② 定位置信（exact_number > exact_term > exact_phrase）
    // ③ 是否 primary。数字类针尖（97.3 / 16384）最保守，优先占预算。
    const types = fact.localization?.matchTypes || [];
    const matchRank = types.includes('exact_number')
      ? 0
      : types.includes('exact_term')
        ? 1
        : types.includes('exact_phrase')
          ? 2
          : 3;
    const key = [fact.priority === 'high' ? 0 : 1, matchRank, fact.primarySectionTitle === title ? 0 : 1];
    const prev = sectionRank.get(title);
    if (!prev || key[0] < prev[0] || (key[0] === prev[0] && (key[1] < prev[1] || (key[1] === prev[1] && key[2] < prev[2])))) {
      sectionRank.set(title, key);
    }
  };
  for (const fact of ordered) {
    for (const i of assignments.get(fact.id) || []) {
      if (!factIdsBySection.has(i)) factIdsBySection.set(i, []);
      factIdsBySection.get(i).push(fact.id);
      if (!addedByFacts.has(i)) addedByFacts.set(i, []);
      for (const t of fact.sourceSectionTitles || []) {
        if (!t) continue;
        bumpRank(t, fact);
        if (!addedByFacts.get(i).includes(t)) addedByFacts.get(i).push(t);
      }
      if (!factTermsBySection.has(i)) factTermsBySection.set(i, []);
      factTermsBySection.get(i).push(...(fact.mustUseTerms || []));
    }
  }

  // 每节的 final sourceSections 预算：候选 = 事实绑定 + 覆盖兜底 + 模型请求，
  // 统一按「与本节事实类别的匹配度」排序后取前 maxSourceSections——不是先到先得。
  const orderOf = (title) => sourceIndex?.sections.find((s) => s.title === title)?.order ?? 999;
  const kindScore = (title, cats) => {
    const kind = sectionKind(title);
    let score = kind ? 1 : 0;
    if (kind === 'ablation' && cats.has('ablation')) score += 3;
    if (kind === 'results' && (cats.has('main_result') || cats.has('comparison'))) score += 3;
    if (kind === 'limitation' && (cats.has('limitation') || cats.has('failure'))) score += 3;
    if (kind === 'appendix') score += 1;
    // 「背景 / 结论 / 摘要」这类通用小节会占掉预算但价值低
    if (/^(?:\d+\.?\s*)?(introduction|conclusion|abstract|background|related work)/i.test(String(title))) score -= 2;
    return score;
  };

  // 覆盖兜底候选：论文自己写了 Regularization / Limitations / Experiments 这类小节时，
  // 按其类别补进对应角色的小节（与事实是否提到无关，防止地图这一轮没提到就整节漏读）。
  // 预算随论文规模自适应：长论文（50+ 小节）里的 Experiment / Appendix 子节同样要覆盖到。
  const coverageBudgetTotal =
    maxCoverageAdditions == null
      ? Math.max(4, Math.min(12, Math.ceil((sourceIndex?.sections?.length || 0) / 6)))
      : maxCoverageAdditions;
  const targetForKind = (kind) => {
    const roleOrder =
      kind === 'ablation'
        ? ['ablation', 'results', 'method']
        : kind === 'limitation'
          ? ['limitation', 'discussion', 'results']
          : kind === 'results'
            ? ['results', 'ablation']
            : ['limitation', 'discussion', 'results'];
    for (const role of roleOrder) {
      const i = sections.findIndex((s) => (s.role || '') === role);
      if (i >= 0) return i;
    }
    return sections.length - 1;
  };
  const kindTargets = new Map(
    ['ablation', 'limitation', 'results', 'appendix'].map((kind) => [kind, targetForKind(kind)]),
  );
  const coverageBySection = new Map();
  const coverageTermsBySection = new Map();
  let coverageBudget = coverageBudgetTotal;
  // 候选排序：**按信息量**（数字密度 + 稀有术语）而不是文档顺序——
  // 长论文（2501 有 54 个小节）里附录结果表才是 benchmark 数字的家，按顺序取会全部错过。
  const chunkTextOf = (id) => structure?.chunks?.find((c) => c.id === id)?.text || '';
  // 边界类小节（limitation / failure / unsuccessful / ethics）数量少、信息密度高、最容易被漏读，
  // 给更高的选择权重，保证它们稳定进入覆盖兜底。
  const kindBonus = { results: 1.2, ablation: 1, limitation: 2.4, appendix: 0.5 };
  const candidates = [];
  for (const sec of sourceIndex?.sections || []) {
    if (!sec.title || /references|bibliography|acknowledg|参考文献|致谢/i.test(sec.title)) continue;
    const kind = sectionKind(sec.title);
    if (!kind) continue;
    if ((kind === 'results' || kind === 'ablation') && (sec.chunkIds || []).length < 2) continue;
    const i = kindTargets.get(kind);
    if (!Number.isInteger(i) || i < 0) continue;
    const sample = (sec.chunkIds || []).slice(0, 6);
    const numbers = sample.reduce((n, id) => n + extractNumberTokens(chunkTextOf(id)).length, 0);
    const density = numbers / Math.max(1, sample.length);
    const terms = rareTermsFromChunks((sec.chunkIds || []).slice(0, 4), { structure, corpus: idx, limit: 6 });
    // 「稀有针尖」比「数字密度」更能说明这个section值不值得读：
    // 2406 的 B.1.1 含 failure（全篇 5 处）、2501 的 G.2 含 unsuccessful（全篇 1 处）、
    // Appendix F/E.1 含 97.3（全篇 ≤3 处）——这些恰恰是纯密度排序会漏掉的。
    const score = density * 2 + terms.length * 0.5 + (kindBonus[kind] || 0);
    candidates.push({ sec, i, kind, terms, score, density });
  }
  candidates.sort((a, b) => b.score - a.score || (a.sec.order ?? 0) - (b.sec.order ?? 0));
  // 边界类小节（limitation / failure / unsuccessful / ethics）单独给 3 个保底名额：
  // 它们数量少、正文短、数字密度低，按纯信息量排序会被附录大表挤掉，但恰恰是最该读到的部分。
  const boundaryQuota = 5;
  let boundaryUsed = 0;
  for (const cand of candidates) {
    const isBoundary = cand.kind === 'limitation';
    if (coverageBudget <= 0) break;
    if (isBoundary) {
      if (boundaryUsed >= boundaryQuota) continue;
      boundaryUsed += 1;
    }
    const i = cand.i;
    if (!coverageBySection.has(i)) coverageBySection.set(i, []);
    coverageBySection.get(i).push(cand.sec.title);
    if (cand.terms.length) {
      if (!coverageTermsBySection.has(i)) coverageTermsBySection.set(i, []);
      coverageTermsBySection.get(i).push(...cand.terms);
    }
    coverageBudget -= 1;
  }

  let overflowCount = 0;
  const finalPlan = sections.map((s, i) => {
    const requested = [...new Set([...(s.sourceSections || []).map(String).filter(Boolean)])];
    const fromFacts = [...new Set(addedByFacts.get(i) || [])].sort((a, b) => {
      const ra = sectionRank.get(a) || [1, 3, 1];
      const rb = sectionRank.get(b) || [1, 3, 1];
      return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] || orderOf(a) - orderOf(b);
    });
    const coverageCandidates = coverageBySection.get(i) || [];
    const cats = new Set((factIdsBySection.get(i) || []).map((id) => facts.find((f) => f.id === id)?.category).filter(Boolean));
    const candidates = new Map();
    const addCandidate = (title, bonus, source) => {
      if (!title) return;
      const score = kindScore(title, cats) + bonus;
      const prev = candidates.get(title);
      if (!prev || score > prev.score) candidates.set(title, { title, score, source });
    };
    // Layer 1（critical fact backed）：事实绑定的 source section 是最高层，
    // 不允许因为 kindScore 低（例如附录里的 "B.1.1 … Evaluation Tasks"）就被 Layer 3 挤掉。
    for (const t of fromFacts) addCandidate(t, 100, 'criticalFact');
    for (const t of coverageCandidates) addCandidate(t, 2, 'coverage');
    for (const t of requested) addCandidate(t, 0, 'requested');
    const orderedCandidates = [...candidates.values()].sort(
      (a, b) => b.score - a.score || orderOf(a.title) - orderOf(b.title),
    );
    const kept = orderedCandidates.slice(0, maxSourceSections).map((c) => c.title);
    const deferred = orderedCandidates.slice(maxSourceSections).map((c) => c.title);
    const addedByFactsKept = fromFacts.filter((t) => kept.includes(t));
    const addedByCoverageKept = coverageCandidates.filter((t) => kept.includes(t));
    overflowCount += deferred.length;

    const coverageTerms = coverageTermsBySection.get(i) || [];
    // 本节要覆盖的每个 source section，也把它自己的稀有术语交给 mustUseTerms：
    // source-local 只有 3 个槽位，小节第 4 块之后的「针尖」（label smoothing）就靠 must-use 通道带进来。
    const keptSectionTerms = [];
    for (const title of kept) {
      const entry = sourceIndex?.sections.find((x) => x.title === title);
      if (!entry) continue;
      keptSectionTerms.push(...rareTermsFromChunks((entry.chunkIds || []).slice(0, 4), { structure, corpus: idx, limit: 5 }));
    }
    // 「针尖」= 关键事实 + 覆盖补入小节 + 本节要覆盖的原文小节带来的稀有术语
    const needleTerms = [...(factTermsBySection.get(i) || []), ...coverageTerms, ...keptSectionTerms];
    const criticalTerms = new Set(needleTerms.map((t) => String(t).toLowerCase()));
    const ranked = rankTerms(
      [...(s.mustUseTerms || []), ...needleTerms, ...keptSectionTerms],
      { corpus: idx, criticalTerms },
    );
    const terms = ranked.slice(0, maxTermsPerSection).map((r) => r.term);
    const termsDeferred = ranked.slice(maxTermsPerSection).map((r) => r.term);

    return {
      ...s,
      // retrieval 只看到 ≤3 个已对齐的真实原文小节
      sourceSections: kept,
      sourceSectionsRequested: requested,
      sourceSectionsAddedByFacts: addedByFactsKept,
      sourceSectionsAddedByCoverage: addedByCoverageKept,
      sourceSectionsDeferred: deferred,
      mustUseTerms: terms,
      mustUseTermsDeferred: termsDeferred,
      mustUseTermRanking: ranked.slice(0, 12).map((r) => ({ term: r.term, tier: r.tier, df: r.df })),
      criticalFactIds: factIdsBySection.get(i) || [],
    };
  });

  const finalFacts = facts.map((f) => {
    const idxs = assignments.get(f.id) || [];
    return {
      ...f,
      planSections: idxs.map((i) => finalPlan[i]?.title).filter(Boolean),
      assignmentReason: reasonById.get(f.id) || '',
    };
  });

  // 覆盖兜底实际生效的部分（进了 final sourceSections 的才算）
  const coverageAdditions = finalPlan.flatMap((s) =>
    (s.sourceSectionsAddedByCoverage || []).map((title) => ({
      planSection: s.title,
      added: title,
      kind: sectionKind(title),
    })),
  );

  const allKeptSections = new Set(finalPlan.flatMap((s) => s.sourceSections));
  const allRequestedSections = new Set([
    ...finalPlan.flatMap((s) => s.sourceSectionsRequested || []),
    ...finalPlan.flatMap((s) => s.sourceSectionsAddedByFacts || []),
  ]);
  const mapped = finalFacts.filter((f) => (f.sourceSectionIds || []).length);
  const high = finalFacts.filter((f) => f.priority === 'high');
  const coverage = {
    criticalFactCount: finalFacts.length,
    criticalFactMappedCount: mapped.length,
    criticalFactUnmappedCount: finalFacts.length - mapped.length,
    criticalFactAssignedCount: finalFacts.filter((f) => (f.planSections || []).length).length,
    highPriorityFactCount: high.length,
    highPriorityFactAssignedCount: high.filter((f) => (f.planSections || []).length).length,
    planSourceSectionCoverage: allRequestedSections.size
      ? Number(([...allRequestedSections].filter((t) => allKeptSections.has(t)).length / allRequestedSections.size).toFixed(4))
      : null,
    sourceSectionOverflowCount: overflowCount,
    coverageAddedCount: coverageAdditions.length,
    coverageAdditions,
    sourceSectionsKept: allKeptSections.size,
    sourceSectionsRequested: allRequestedSections.size,
  };
  return { plan: finalPlan, facts: finalFacts, coverage };
}

function emptyCoverage(facts = []) {
  return {
    criticalFactCount: facts.length,
    criticalFactMappedCount: 0,
    criticalFactUnmappedCount: facts.length,
    criticalFactAssignedCount: 0,
    highPriorityFactCount: facts.filter((f) => f.priority === 'high').length,
    highPriorityFactAssignedCount: 0,
    planSourceSectionCoverage: null,
    sourceSectionOverflowCount: 0,
    sourceSectionsKept: 0,
    sourceSectionsRequested: 0,
  };
}
