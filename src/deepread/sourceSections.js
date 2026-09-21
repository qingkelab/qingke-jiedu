/**
 * Source section 对齐（计划小节 ↔ 论文原文小节）
 *
 * 背景（DeepRead Retrieval v2 的 P0）：模型大纲是**中文**，论文原文小节是**英文**，
 * 两者的词法几乎不重叠——实测中文标题词在召回 chunk 里的命中率只有 0–36%（多数 0–9%）。
 * 于是「本节原文优先」形同虚设（1706/2405/2406 都是 0/12），同角色小节拿到完全相同的证据。
 *
 * 解决办法不是去猜中文标题的词义，而是**让规划阶段直接产出原文小节名**（sourceSections，
 * 必须用论文原文语言），再用确定性的对齐规则把它对到真实 section 上：
 *   exact → normalized（去编号/标点/大小写）→ 编号（3.2 / A.1）→ 术语模糊（token 覆盖）
 *   → 缩写（ACI ↔ Agent-Computer Interface）→ 父级路径（Attention ⊂ Model Architecture›Attention）
 *
 * 对不上时**不许静默**：如实记录 unmatched，由调用方退化到 mustUseTerms / 研究地图证据 /
 * 邻域 chunk / 角色先验，并把 method 记成 fallback_*。
 */

import { tokenize } from './chunker.js';

/** 编号前缀：`3.2 `、`III. `、`A.1 `、`Appendix A `、`第 3 章` 等。 */
const NUMBER_PREFIX = /^(?:appendix\s+|section\s+|chapter\s+|part\s+|第\s*)?([0-9]+(?:\.[0-9]+)*|[ivxlc]+|[a-z](?:\.[0-9]+)*)\s*[.、:：]?\s+/i;

/** 归一化 section 名：小写、去编号、去标点/空白、全角转半角。 */
export function normalizeSectionName(name) {
  return String(name || '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, ' ')
    .trim()
    .replace(NUMBER_PREFIX, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
    .trim();
}

/** 抽取 section 编号（3.2 / A.1 / A / iv）。 */
export function sectionNumber(name) {
  const m = String(name || '').match(NUMBER_PREFIX);
  if (m) return m[1].toLowerCase();
  const appendix = String(name || '').match(/^(?:appendix|附录)\s*([a-z0-9]+)/i);
  return appendix ? appendix[1].toLowerCase() : '';
}

const ACRONYM_STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'for', 'to', 'in', 'on', 'with']);

/**
 * 词形扩展：chunker 的 tokenize 会把 `dot-product`、`multi-head`、`w/o` 这类复合词保留成
 * 单个 token（对术语是好事），但计划里往往写成 `scaled dot product attention`。
 * 这里给复合词补上拆分后的子词，让两侧能在同一坐标系里比较。
 */
export function expandCompoundTokens(tokens = []) {
  const out = new Set();
  for (const t of tokens) {
    out.add(t);
    if (/[-_/.]/.test(t)) {
      for (const part of t.split(/[-_/.]/)) if (part.length >= 3) out.add(part);
    }
  }
  return out;
}

/** 标题缩写：`The Agent-Computer Interface` → `ACI`。 */
export function sectionAcronym(name) {
  const words = String(name || '')
    .replace(NUMBER_PREFIX, '')
    .split(/[\s\-_/]+/)
    .map((w) => w.replace(/[^A-Za-z0-9]/g, ''))
    .filter((w) => w && !ACRONYM_STOP.has(w.toLowerCase()));
  if (words.length < 2) return '';
  return words.map((w) => w[0].toUpperCase()).join('');
}

/**
 * 建立 source section 索引（从 chunk structure 的 sections 出发，而不是从标题文本猜）。
 * @returns {{sections:Array, byNormalized:Map, byNumber:Map, byAcronym:Map, chunkSection:Map, titles:string[]}}
 */
export function buildSourceSectionIndex(structure) {
  const rawSections = structure?.sections || [];
  const chunks = structure?.chunks || [];
  const sections = [];
  const byNormalized = new Map();
  const byNumber = new Map();
  const byAcronym = new Map();

  for (const s of rawSections) {
    const entry = {
      id: s.id,
      title: s.title || '正文',
      path: s.path || s.title || '正文',
      level: s.level || 1,
      order: s.order ?? sections.length,
      chunkIds: s.chunkIds || [],
      chars: s.charCount || 0,
      normalized: normalizeSectionName(s.title),
      number: sectionNumber(s.title),
      acronym: sectionAcronym(s.title),
      tokens: expandCompoundTokens(tokenize(`${s.title} ${s.path || ''}`)),
      pathTokens: expandCompoundTokens(tokenize(s.path || s.title || '')),
    };
    sections.push(entry);
    if (entry.normalized && !byNormalized.has(entry.normalized)) byNormalized.set(entry.normalized, entry);
    if (entry.number && !byNumber.has(entry.number)) byNumber.set(entry.number, entry);
    if (entry.acronym && !byAcronym.has(entry.acronym)) byAcronym.set(entry.acronym, entry);
  }

  // chunk → section 映射（chunk 上本来就带 sectionId）
  const chunkSection = new Map();
  for (const c of chunks) chunkSection.set(c.id, c.sectionId || '');

  // 虚拟 section：摘要常常不是独立标题（arXiv HTML 里直接挂在正文前），
  // 但计划特别喜欢请求 "Abstract"，所以按 chunk.type 补一个虚拟条目。
  const abstractChunks = chunks.filter((c) => c.type === 'abstract').map((c) => c.id);
  if (abstractChunks.length && !byNormalized.has('abstract')) {
    const virtual = {
      id: 'virtual:abstract',
      title: 'Abstract',
      path: 'Abstract',
      level: 1,
      order: -1,
      chunkIds: abstractChunks,
      chars: abstractChunks.reduce((n, id) => n + (chunks.find((c) => c.id === id)?.text.length || 0), 0),
      normalized: 'abstract',
      number: '',
      acronym: 'A',
      tokens: new Set(['abstract', '摘要']),
      pathTokens: new Set(['abstract']),
      virtual: true,
    };
    sections.unshift(virtual);
    byNormalized.set('abstract', virtual);
    byAcronym.set('A', virtual);
  }

  return { sections, byNormalized, byNumber, byAcronym, chunkSection, titles: sections.map((s) => s.title) };
}

/** 单个 requested 名的对齐：返回 {section, method} 或 null。 */
export function matchSourceSection(requested, index) {
  const raw = String(requested || '').trim();
  if (!raw || !index?.sections?.length) return null;

  // 1) 精确（原文一模一样）
  const exact = index.sections.find((s) => s.title === raw);
  if (exact) return { section: exact, method: 'exact' };

  // 2) 归一化后精确（去编号/标点/大小写）
  const norm = normalizeSectionName(raw);
  if (norm && index.byNormalized.has(norm)) return { section: index.byNormalized.get(norm), method: 'normalized_exact' };

  // 3) 编号对齐（3.2 / A.1）
  const num = sectionNumber(raw);
  if (num && index.byNumber.has(num)) return { section: index.byNumber.get(num), method: 'number' };

  // 4) 缩写（ACI ↔ The Agent-Computer Interface）
  const rawUpper = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (rawUpper.length >= 2 && rawUpper.length <= 8) {
    for (const s of index.sections) {
      if (s.acronym && (s.acronym === rawUpper || s.acronym.startsWith(rawUpper))) {
        return { section: s, method: 'acronym' };
      }
    }
  }

  // 5) 术语模糊：requested 的词被 source 标题覆盖 ≥60%
  const reqTokens = [...expandCompoundTokens(tokenize(raw))];
  if (reqTokens.length) {
    let best = null;
    for (const s of index.sections) {
      const inter = reqTokens.filter((t) => s.tokens.has(t)).length;
      const ratio = inter / reqTokens.length;
      if (inter >= 1 && ratio >= 0.6 && (!best || ratio > best.ratio)) best = { section: s, ratio, inter };
    }
    if (best) return { section: best.section, method: 'fuzzy_tokens' };
  }

  // 6) 父级路径：requested 出现在某小节的层级路径里（Attention ⊂ Model Architecture›Attention）
  if (norm) {
    const parent = index.sections.find((s) => normalizeSectionName(s.path).includes(norm));
    if (parent) return { section: parent, method: 'parent_path' };
  }

  return null;
}

/**
 * 对齐一组 sourceSections，并如实记录匹配状态。
 * @returns {{requested:string[], matched:Array, unmatched:string[], method:string, sectionIds:string[]}}
 */
export function alignSourceSections({ requested = [], index, mustUseTerms = [] } = {}) {
  const list = (Array.isArray(requested) ? requested : [requested]).map((s) => String(s || '').trim()).filter(Boolean);
  const matched = [];
  const unmatched = [];
  for (const name of list) {
    const hit = matchSourceSection(name, index);
    if (hit) matched.push({ requested: name, sectionId: hit.section.id, title: hit.section.title, method: hit.method });
    else unmatched.push(name);
  }
  const methods = [...new Set(matched.map((m) => m.method))];
  // 多个 requested 可能对到同一个 section（如 Results + Machine Translation）→ 去重，但保留别名
  const uniqueMatched = [];
  const seenSectionIds = new Set();
  for (const m of matched) {
    const hit = uniqueMatched.find((x) => x.sectionId === m.sectionId);
    if (hit) hit.aliases = [...(hit.aliases || []), m.requested];
    else {
      if (seenSectionIds.has(m.sectionId)) continue;
      seenSectionIds.add(m.sectionId);
      uniqueMatched.push({ ...m });
    }
  }
  let method;
  if (!list.length) method = 'no_request';
  else if (matched.length && !unmatched.length) method = methods.length === 1 ? methods[0] : 'mixed';
  else if (matched.length) method = 'partial';
  else method = 'fallback_terms';

  return {
    requested: list,
    matched: uniqueMatched,
    unmatched,
    method,
    sectionIds: uniqueMatched.map((m) => m.sectionId),
    status: matched.length ? (unmatched.length ? 'partial' : 'matched') : 'unmatched',
    // 对不上时必须显式告知下游：用 mustUseTerms / 地图证据 / 邻域兜底
    fallbackUsed: matched.length ? [] : ['mustUseTerms', 'researchMapEvidence', 'neighborhood', 'rolePrior'].slice(0, list.length ? 4 : 2),
    mustUseTermCount: (mustUseTerms || []).length,
  };
}

/**
 * source-local 邻域：命中 section 的正文 chunk + 边界前后 1 个 chunk（上下文衔接）。
 * 不取 heading（chunker 不把 heading 作为 chunk），但会保留 section 内的图注/表格/公式 chunk。
 */
export function sourceNeighborhood({ index, structure, sectionIds = [], maxPerSection = 6, includeBoundary = true } = {}) {
  const chunks = structure?.chunks || [];
  if (!index || !sectionIds.length) return [];
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const out = [];
  const seen = new Set();
  // 小节内部的取块顺序：首块 + 信息量高的块（数字/图注/表格/公式）+ 其余按原文顺序。
  // 只取前 N 块会让「关键事实在小节后半段」时整段读不到（1706 的 label smoothing 就在 Regularization 的第 4 块）。
  const informative = (id) => {
    const c = byId.get(id);
    if (!c) return -1;
    const typeBonus = c.type === 'table' ? 3 : c.type === 'figure' || c.type === 'formula' ? 2 : 0;
    return typeBonus + Math.min(4, (c.numbers || []).length);
  };
  const orderWithin = (ids) => {
    const head = ids.slice(0, 1);
    const rest = ids
      .slice(1)
      .sort((a, b) => informative(b) - informative(a) || (byId.get(a)?.index ?? 0) - (byId.get(b)?.index ?? 0));
    return [...head, ...rest];
  };
  for (const sid of sectionIds) {
    const sec = index.sections.find((s) => s.id === sid);
    if (!sec) continue;
    const ids = [...sec.chunkIds];
    const picked = orderWithin(ids).slice(0, maxPerSection);
    // 图注/表格/公式优先保留（它们是结果与公式的载体）
    for (const id of orderWithin(ids)) {
      const c = byId.get(id);
      if (c && (c.type === 'figure' || c.type === 'table' || c.type === 'formula') && !picked.includes(id)) {
        picked.push(id);
        if (picked.length >= maxPerSection + 3) break;
      }
    }
    for (const id of picked) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    if (includeBoundary) {
      const first = byId.get(ids[0]);
      const last = byId.get(ids[ids.length - 1]);
      for (const c of [chunks[(first?.index ?? 0) - 1], chunks[(last?.index ?? 0) + 1]]) {
        if (!c || seen.has(c.id)) continue;
        if (/references|bibliography|acknowledg|参考文献|致谢/i.test(c.sectionTitle || '')) continue;
        seen.add(c.id);
        out.push(c.id);
      }
    }
  }
  return out;
}
