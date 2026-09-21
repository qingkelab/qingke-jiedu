/**
 * Fact Localization（事实定位）—— Research Map 可靠性的保险层
 *
 * 背景：Research Map 在长论文上会被 `max_tokens` 截断（`finish_reason=length`）→ 落兜底地图 →
 * Critical Fact 的 `sourceSectionIds` 为空 → 候选发现没有输入 → 事实在 Plan 阶段就丢了
 * （2501 的 97.3 / Unsuccessful、2406 的 failure）。
 *
 * 本轮把两件事解耦：
 *   Layer A  Source Section Inventory —— **完全确定性**，直接来自 chunker/parser，不问模型；
 *   Layer B  Fact Localization        —— 对**已存在**的事实，用严格匹配在原文里定位它所属的小节。
 *
 * 严格性（不做语义猜测）：
 *   - 只允许 exact_term / exact_phrase / exact_number / normalized_number；
 *   - 只使用「稀有针尖」（数字/术语在全篇出现 ≤ MAX_DF 次），避免 1 / 2 / 3 这类噪声把事实绑到任意小节；
 *   - 数字按 audit 的归一化比较（97.3 ≡ 97.30 ≡ 97.3%，但 97.3 ≠ 9.73 ≠ 197.3）；
 *   - 术语只做大小写归一，不做词形/语义扩展（failure ≠ fails/failed）；
 *   - **不发明事实**：只给已有 fact 补 sourceSectionIds。
 */

import { extractNumberTokens, normalizeNumberToken } from './audit.js';
import { tokenize } from './chunker.js';

/**
 * 针尖的最大 document frequency。放宽到 6 是因为 `failure`(5) / `partial success`(4) /
 * `79.8`(5) 这类针尖全篇出现 4–6 次仍然高度specific；真正要挡的是 1/2/3 这种到处都是的数字
 * （由「数字至少 3 位」和「术语至少 4 字符」两条规则负责）。
 */
export const MAX_NEEDLE_DF = 6;

/** 顺序固定、可复现的 source section 清单（不依赖模型输出）。 */
export function buildSourceSectionInventory(structure, sourceIndex = null) {
  const chunks = structure?.chunks || [];
  const bySection = new Map();
  for (const c of chunks) {
    const key = c.sectionId || 'unknown';
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push(c);
  }
  const sections = (sourceIndex?.sections || []).length
    ? sourceIndex.sections
    : [...bySection.keys()].map((id, i) => ({
        id,
        title: bySection.get(id)[0]?.sectionTitle || `section-${i + 1}`,
        order: i,
        level: 1,
        chunkIds: (bySection.get(id) || []).map((c) => c.id),
      }));
  return sections.map((s) => {
    const ids = s.chunkIds || (bySection.get(s.id) || []).map((c) => c.id);
    const first = chunks.find((c) => c.id === ids[0]);
    const last = chunks.find((c) => c.id === ids[ids.length - 1]);
    return {
      id: s.id,
      title: s.title || '正文',
      level: s.level || 1,
      order: s.order ?? 0,
      chunkIds: ids,
      startChunkId: ids[0] || '',
      endChunkId: ids[ids.length - 1] || '',
      chars: ids.reduce((n, id) => n + (chunks.find((c) => c.id === id)?.text.length || 0), 0),
      firstIndex: first?.index ?? 0,
      lastIndex: last?.index ?? 0,
    };
  });
}

/** 语料索引：全篇文本 / 每个 chunk 的小写文本 / 数字 df / 术语 df。 */
export function buildLocalizationIndex(structure, inventory = null) {
  const chunks = structure?.chunks || [];
  const texts = new Map(chunks.map((c) => [c.id, String(c.text || '').toLowerCase()]));
  const dfCache = new Map();
  const df = (needle) => {
    const key = String(needle || '').toLowerCase();
    if (!key) return 0;
    if (dfCache.has(key)) return dfCache.get(key);
    let n = 0;
    for (const t of texts.values()) if (t.includes(key)) n += 1;
    dfCache.set(key, n);
    return n;
  };
  return { chunks, texts, df, inventory: inventory || buildSourceSectionInventory(structure) };
}

/** 数字命中：exact（字面）或 normalized（97.3 ≡ 97.30 ≡ 97.3%），不允许 9.73 / 197.3。 */
export function matchNumberStrict(value, chunkText) {
  const needleKey = normalizeNumberToken(value);
  const needleNum = (needleKey.match(/^-?\d+(?:\.\d+)?/) || [])[0];
  if (!needleNum) return '';
  for (const token of extractNumberTokens(chunkText)) {
    const key = normalizeNumberToken(token);
    if (key === needleKey) return 'exact_number';
    const num = (key.match(/^-?\d+(?:\.\d+)?/) || [])[0];
    // 归一化相等：仅当整数部分完全一致（97.3 ≡ 97.30 / 97.3%），排除 9.73 / 197.3
    if (num && num === needleNum) return 'normalized_number';
  }
  return '';
}

/** 术语命中：大小写归一 + 词边界，只做 exact_term / exact_phrase，不做词形扩展。 */
export function matchTermStrict(term, chunkText) {
  const needle = String(term || '').trim().toLowerCase();
  if (needle.length < 3) return '';
  const hay = String(chunkText || '').toLowerCase();
  if (!hay.includes(needle)) return '';
  if (needle.includes(' ')) return 'exact_phrase';
  // 单词术语：要求前后不是字母数字（避免 failure 命中 failures 之外的怪情况）
  const idx = hay.indexOf(needle);
  const before = idx === 0 ? '' : hay[idx - 1];
  const after = hay[idx + needle.length] || '';
  const boundary = (ch) => !ch || !/[a-z0-9]/.test(ch);
  if (boundary(before) && boundary(after)) return 'exact_term';
  // 允许复数这类轻微差异只作为 exact_term 的放宽？—— 明确不做：返回空
  return '';
}

/** 从 fact 里挑出「针尖」：稀有的数字与术语（按 §十 的优先级）。 */
export function needlesOf(fact, index) {
  const numbers = [];
  const terms = [];
  const seenN = new Set();
  const seenT = new Set();
  const addNumber = (v) => {
    const s = String(v == null ? '' : v);
    if (!s || seenN.has(s)) return;
    // 数字针尖：至少 3 位有效数字（97.3 / 79.8 / 16384 ✓；1 / 21 / 0.1 ✗）
    if (s.replace(/[^\d]/g, '').length < 3) return;
    if (index.df(s) > MAX_NEEDLE_DF) return;
    seenN.add(s);
    numbers.push(s);
  };
  const addTerm = (t) => {
    const s = String(t || '').trim();
    // 术语针尖：单词至少 4 字符，或多词短语（failure / partial success / MATH-500 ✓；use / non ✗）
    if (s.length < 4 && !s.includes(' ')) return;
    if (seenT.has(s.toLowerCase())) return;
    if (index.df(s) > MAX_NEEDLE_DF) return;
    seenT.add(s.toLowerCase());
    terms.push(s);
  };
  for (const n of fact.mustUseNumbers || []) addNumber(n.value);
  for (const n of extractNumberTokens(fact.claim || '')) addNumber(n);
  for (const t of fact.mustUseTerms || []) addTerm(t);
  for (const t of tokenize(fact.claim || '')) if (!/^\d+$/.test(t)) addTerm(t);
  return { numbers, terms };
}

/**
 * 把一条**已存在**的事实定位到 source section（严格匹配、可解释）。
 * @returns {{sourceSectionIds:string[], matches:Array, matchTypes:string[], confidence:string, needles:object}}
 */
export function localizeFactToSourceSections({ fact, structure, inventory = null, index = null } = {}) {
  const idx = index || buildLocalizationIndex(structure, inventory);
  const needles = needlesOf(fact, idx);
  const matches = [];
  for (const section of idx.inventory) {
    const chunkIds = [];
    const matchTypes = new Set();
    for (const cid of section.chunkIds) {
      const text = idx.texts.get(cid) || '';
      for (const n of needles.numbers) {
        const m = matchNumberStrict(n, text);
        if (m) {
          chunkIds.push(cid);
          matchTypes.add(m);
          break;
        }
      }
      if (matchTypes.size) continue;
      for (const t of needles.terms) {
        const m = matchTermStrict(t, text);
        if (m) {
          chunkIds.push(cid);
          matchTypes.add(m);
          break;
        }
      }
    }
    if (chunkIds.length) matches.push({ sectionId: section.id, sectionTitle: section.title, chunkIds: [...new Set(chunkIds)], matchTypes: [...matchTypes] });
  }
  const sourceSectionIds = matches.map((m) => m.sectionId);
  const matchTypes = [...new Set(matches.flatMap((m) => m.matchTypes))];
  const confidence = matchTypes.includes('exact_number') || matchTypes.includes('exact_term') ? 'high' : matchTypes.length ? 'medium' : 'none';
  return { sourceSectionIds, matches, matchTypes, confidence, needles };
}

/**
 * 给一批事实补 sourceSectionIds（**只补空的，不发明事实**）。
 * @returns {{facts:Array, localized:number, unmatched:string[]}}
 */
export function localizeFacts(facts = [], { structure, inventory = null, index = null } = {}) {
  const idx = index || buildLocalizationIndex(structure, inventory);
  const out = facts.map((f) => {
    const already = (f.sourceSectionIds || []).length || (f.sourceSectionTitles || []).length;
    if (already) {
      return {
        ...f,
        localization: { ...(f.localization || {}), method: 'already_bound', confidence: 'high' },
      };
    }
    const loc = localizeFactToSourceSections({ fact: f, structure, index: idx });
    return {
      ...f,
      sourceSectionIds: loc.sourceSectionIds,
      sourceSectionTitles: loc.matches.map((m) => m.sectionTitle),
      localization: {
        method: loc.confidence === 'none' ? 'no_candidate_source_section' : 'deterministic',
        confidence: loc.confidence,
        matchTypes: loc.matchTypes,
        needles: { numbers: loc.needles.numbers.slice(0, 6), terms: loc.needles.terms.slice(0, 6) },
        matches: loc.matches.slice(0, 8),
      },
    };
  });
  const unmatched = out.filter((f) => !(f.sourceSectionIds || []).length && !(f.sourceSectionTitles || []).length).map((f) => f.id);
  return { facts: out, localized: out.filter((f) => (f.sourceSectionIds || []).length).length, unmatched };
}
