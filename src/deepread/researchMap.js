/**
 * Research Map（论文地图）
 *
 * 正式写作前先做一次轻量结构化分析，产出「问题 / 主张 / 方法组件 / 公式 / 数据集 / benchmark /
 * baseline / 主要结果 / 消融 / 局限 / 图 / 证据」的结构化 JSON，并尽量把每条信息关联到 chunkIds /
 * figureIds。逐节写作与证据审计都消费这份地图。
 *
 * 可靠性：
 *   - 模型输出用 parseJsonLoose 宽松解析，字段缺失/类型不对会被 normalize 修正；
 *   - 模型给不出可用地图时，用本地关键词 + 数字抽取生成 fallback map（不阻塞主流程）。
 */

import { parseJsonLoose } from '../ai/json.js';
import { tokenize } from './chunker.js';

const MAX_ITEMS = 12;
const MAX_TEXT = 420;

const LIST_FIELDS = [
  'key_claims',
  'method_components',
  'equations',
  'datasets',
  'benchmarks',
  'baselines',
  'main_results',
  'ablations',
  'limitations',
];

export const RESEARCH_MAP_FIELDS = [
  'problem',
  ...LIST_FIELDS,
  'figures',
  'evidence',
];

/** 地图输入：目录 + 每节开头 + 代表性 chunk（方法/结果/局限/公式/图/表），控制在预算内。 */
export function buildMapInput({ structure, figures = [], maxChars = 22000 } = {}) {
  const chunks = structure?.chunks || [];
  const parts = [];
  const toc = (structure?.sections || [])
    .map((s) => `- ${s.title}（${s.chunkIds.length} chunks）`)
    .join('\n');
  if (toc) parts.push(`## 章节结构\n${toc}`);

  const pickRepresentative = (pred, limit) =>
    chunks.filter(pred).slice(0, limit);

  const groups = [
    ['方法 / 架构 / 公式', pickRepresentative((c) => c.type === 'formula' || /method|approach|model|architecture|algorithm|方法|模型|架构|算法/i.test(c.sectionTitle), 14)],
    ['实验 / 结果 / 表格', pickRepresentative((c) => c.type === 'table' || /experiment|evaluation|result|benchmark|实验|评估|结果/i.test(c.sectionTitle), 14)],
    ['消融 / 局限 / 讨论', pickRepresentative((c) => /ablation|limitation|discussion|conclusion|消融|局限|讨论|结论/i.test(c.sectionTitle), 12)],
    ['摘要 / 引言 / 其他', pickRepresentative((c) => /abstract|introduction|背景|摘要|引言|related/i.test(c.sectionTitle) || c.type === 'abstract', 8)],
  ];

  let used = parts.join('\n\n').length;
  for (const [label, list] of groups) {
    const lines = [];
    for (const c of list) {
      const text = c.text.length > 900 ? `${c.text.slice(0, 900)}…` : c.text;
      const line = `[${c.id}]（${c.sectionTitle}·${c.type}）${text}`;
      if (used + line.length > maxChars) break;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length) parts.push(`## ${label}\n${lines.join('\n\n')}`);
  }

  const figLines = (figures || []).map(
    (f) => `图${f.num}：${(f.caption || '（无图注）').slice(0, 200)}${f.sectionTitle ? `（位于 ${f.sectionTitle}）` : ''}`,
  );
  if (figLines.length) parts.push(`## 图片清单\n${figLines.join('\n')}`);

  // 没有选出代表性 chunk（极短论文）时，把全文塞进去（受预算限制）
  if (parts.length <= 1 && chunks.length) {
    let acc = '';
    for (const c of chunks) {
      if (acc.length + c.text.length > maxChars) break;
      acc += `[${c.id}]（${c.sectionTitle}·${c.type}）${c.text}\n\n`;
    }
    parts.push(`## 正文\n${acc}`);
  }

  return parts.join('\n\n').slice(0, maxChars + 2000);
}

/** Research Map 提示词。 */
export function buildResearchMapMessages({ source, structure, figures, mapInput }) {
  const sys = [
    '你是论文结构分析师。阅读给定的论文切片（每段带 chunk id，如 [c12]），抽出一份「论文地图」JSON。',
    '要求：',
    '1. 只依据给定切片，不补充外部知识，不编造数字、数据集、指标或结论；',
    '2. 每条尽量给出证据 chunkIds（切片里的 id，如 ["c3","c12"]）；没有证据就留空数组；',
    '3. main_results 必须带原文数字与坐标（模型/数据集/指标/设置）；',
    '4. ablations / limitations 只写原文真实存在的，原文没有就给空数组；',
    '5. equations 用 LaTeX（保留原文符号），并把对应 chunkIds 写上；',
    '6. figures 写 {num, caption, sectionTitle, chunkIds}，sectionTitle 用切片里出现的章节名；',
    '严格输出 JSON，不要解释、不要代码块以外文字。字段与形状：',
    '{',
    '  "problem": "论文要解决什么问题（一句话）",',
    '  "key_claims": [{"text":"作者的核心主张","chunkIds":["c1"]}],',
    '  "method_components": [{"text":"组件/步骤","chunkIds":["c2"]}],',
    '  "equations": [{"text":"LaTeX 公式","chunkIds":["c5"]}],',
    '  "datasets": [{"text":"数据集名","chunkIds":[]}],',
    '  "benchmarks": [{"text":"benchmark/指标","chunkIds":[]}],',
    '  "baselines": [{"text":"对比基线","chunkIds":[]}],',
    '  "main_results": [{"text":"结果（带数字与坐标）","chunkIds":[]}],',
    '  "ablations": [{"text":"消融发现","chunkIds":[]}],',
    '  "limitations": [{"text":"局限/失效条件","chunkIds":[]}],',
    '  "figures": [{"num":1,"caption":"图注要点","sectionTitle":"","chunkIds":[]}],',
    '  "evidence": [{"text":"关键证据", "chunkIds":["c7"]}]',
    '}',
  ].join('\n');

  const ctx = [
    `标题：${source.title || '（无）'}`,
    `作者：${source.byline || '（无）'}　时间：${source.date || '（无）'}`,
    `章节数：${structure?.sections?.length || 0}　切片数：${structure?.chunks?.length || 0}`,
    `可用图片：${(figures || []).length} 张`,
    '',
    mapInput,
  ].join('\n');

  return [
    { role: 'system', content: sys },
    { role: 'user', content: `请输出论文地图 JSON：\n\n${ctx}` },
  ];
}

function toItems(value, limit = MAX_ITEMS) {
  const arr = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = [];
  for (const raw of arr) {
    if (raw == null) continue;
    const item =
      typeof raw === 'string'
        ? { text: raw }
        : typeof raw === 'object'
          ? { ...raw, text: raw.text ?? raw.claim ?? raw.value ?? raw.caption ?? '' }
          : null;
    if (!item) continue;
    const text = String(item.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!text) continue;
    const chunkIds = Array.isArray(item.chunkIds) ? item.chunkIds.map((x) => String(x)) : [];
    out.push({ ...item, text, chunkIds });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 归一化 + 把模型没给 chunkIds 的条目按文本回填证据定位。
 */
export function normalizeResearchMap(raw, { structure, figures = [] } = {}) {
  const chunks = structure?.chunks || [];
  const validIds = new Set(chunks.map((c) => c.id));

  const repairIds = (item) => {
    const ids = (item.chunkIds || []).filter((id) => validIds.has(id));
    if (!ids.length && item.text) {
      const probe = item.text.slice(0, 40).toLowerCase();
      const hit = chunks.find((c) => c.text.toLowerCase().includes(probe));
      if (hit) ids.push(hit.id);
    }
    return { ...item, chunkIds: [...new Set(ids)] };
  };

  const map = {
    problem: typeof raw?.problem === 'string' ? raw.problem.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) : '',
  };
  for (const field of LIST_FIELDS) map[field] = toItems(raw?.[field]).map(repairIds);

  // 图片：与已知 figure 列表对齐（num/caption/sectionTitle/chunkIds）
  const figByNum = new Map((figures || []).map((f) => [Number(f.num), f]));
  map.figures = toItems(raw?.figures, 20).map((f, i) => {
    const num = Number(f.num) || figByNum.get(i + 1)?.num || i + 1;
    const known = figByNum.get(num);
    const caption = String(f.caption || known?.caption || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    const sectionTitle = String(f.sectionTitle || known?.sectionTitle || '').trim();
    return repairIds({ ...f, num, caption, sectionTitle });
  });

  // evidence：显式给的 + 各字段的聚合，便于检索加权
  const evidence = toItems(raw?.evidence, 24).map(repairIds);
  const seenIds = new Set(evidence.flatMap((e) => e.chunkIds));
  for (const field of LIST_FIELDS) {
    for (const item of map[field]) {
      if (!item.chunkIds.length || item.chunkIds.every((id) => seenIds.has(id))) continue;
      evidence.push({ text: item.text.slice(0, 160), chunkIds: item.chunkIds });
      item.chunkIds.forEach((id) => seenIds.add(id));
    }
  }
  map.evidence = evidence.slice(0, 32);

  const stats = {
    keyClaims: map.key_claims.length,
    methodComponents: map.method_components.length,
    equations: map.equations.length,
    mainResults: map.main_results.length,
    ablations: map.ablations.length,
    limitations: map.limitations.length,
    figures: map.figures.length,
    evidenceLinks: map.evidence.filter((e) => e.chunkIds.length).length,
  };
  return { map, stats };
}

const SENT_SPLIT = /(?<=[。！？!?])\s*|(?<=\.)\s+(?=[A-Z(])/;

function sentencesOf(text) {
  return String(text || '')
    .split(SENT_SPLIT)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 12 && s.length <= 400);
}

/**
 * 本地 fallback 地图：不依赖模型，用章节关键词 + 数字密度抽证据。
 * 保证「Research Map 阶段失败也不影响主流程」。
 */
export function fallbackResearchMap({ structure, figures = [], source = {} } = {}) {
  const chunks = structure?.chunks || [];
  const inSection = (re) => chunks.filter((c) => re.test(c.sectionTitle) || re.test(c.sectionPath));
  const items = (list, limit, pick = (c) => sentencesOf(c.text)) => {
    const out = [];
    for (const c of list) {
      for (const s of pick(c)) {
        if (out.length >= limit) break;
        out.push({ text: s, chunkIds: [c.id] });
      }
    }
    return out;
  };

  const abstractChunks = chunks.filter((c) => c.type === 'abstract');
  const introChunks = inSection(/abstract|introduction|背景|引言|摘要/i).filter((c) => c.type !== 'abstract');
  const methodChunks = inSection(/method|approach|model|architecture|algorithm|方法|模型|架构|算法|实现/i);
  const resultChunks = inSection(/experiment|evaluation|result|benchmark|实验|评估|结果/i);
  // 消融信息常藏在「Model Variations / 模型变体 / 组件分析」这类小节里
  const ablationChunks = inSection(/ablation|消融|variation|variant|变体|组件分析|component analysis/i);
  const limitationChunks = inSection(/limitation|discussion|conclusion|局限|讨论|结论|失败/i);
  const figureChunks = chunks.filter((c) => c.type === 'figure');
  const formulaChunks = chunks.filter((c) => c.type === 'formula');

  const problemSource = abstractChunks[0] || introChunks[0] || chunks[0];
  const problem = problemSource ? sentencesOf(problemSource.text).slice(0, 2).join(' ').slice(0, 300) : '';

  const claimsFromText = (list, limit) =>
    items(
      list,
      limit,
      (c) =>
        sentencesOf(c.text).filter((s) =>
          /propose|present|introduce|show|demonstrate|outperform|achieve|find|提出|表明|发现|证明|优于|达到|可以|能够/i.test(s),
        ),
    );

  const mainResults = items(
    resultChunks.length ? resultChunks : chunks,
    8,
    (c) => sentencesOf(c.text).filter((s) => /\d/.test(s)),
  );
  const numericAblations = items(
    ablationChunks.length ? ablationChunks : chunks.filter((c) => /ablation|消融/i.test(c.text)),
    6,
    (c) => sentencesOf(c.text),
  );
  const limitations = items(
    limitationChunks.length ? limitationChunks : chunks.filter((c) => /limitation|only|局限|仅在|失败/i.test(c.text)),
    6,
    (c) => sentencesOf(c.text).filter((s) => /limitation|only|however|fail|cannot|局限|仅在|失败|无法|未/i.test(s)),
  );

  const nameEntities = (re, limit = 8) => {
    const out = [];
    const seen = new Set();
    for (const c of chunks) {
      for (const s of sentencesOf(c.text)) {
        if (!re.test(s)) continue;
        for (const m of s.matchAll(/\b([A-Z][A-Za-z0-9\-]{2,}(?:\s?[-+]?\d{1,2}[BKM])?)\b/g)) {
          const name = m[1];
          if (seen.has(name) || /^(The|This|We|Our|In|Figure|Table|Section|However|Moreover|Figure|Using|With|For|From|Both|Each|When|While|After|Before)$/.test(name)) continue;
          seen.add(name);
          out.push({ text: name, chunkIds: [c.id] });
          if (out.length >= limit) break;
        }
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
    return out;
  };

  const raw = {
    problem,
    key_claims: claimsFromText([...abstractChunks, ...introChunks], 6),
    method_components: items(methodChunks, 8, (c) => sentencesOf(c.text).slice(0, 2)),
    equations: formulaChunks.slice(0, 8).map((c) => ({ text: c.text.slice(0, 300), chunkIds: [c.id] })),
    datasets: nameEntities(/dataset|corpus|数据集|benchmark/i, 6),
    benchmarks: nameEntities(/benchmark|metric|evaluation|指标|评测/i, 6),
    baselines: nameEntities(/baseline|compare|compared|基线|对比/i, 6),
    main_results: mainResults,
    ablations: numericAblations,
    limitations,
    figures: (figures || []).map((f) => ({
      num: f.num,
      caption: f.caption || '',
      sectionTitle: figureChunks.find((c) => /图|figure/i.test(c.text) && f.caption && c.text.includes(f.caption.slice(0, 24)))?.sectionTitle || '',
      chunkIds: figureChunks.filter((c) => f.caption && c.text.includes(f.caption.slice(0, 24))).map((c) => c.id),
    })),
    evidence: [],
  };

  const normalized = normalizeResearchMap(raw, { structure, figures });
  normalized.map.problem = raw.problem || normalized.map.problem;
  normalized.map._fallback = true;
  normalized.map._title = source.title || '';
  return normalized;
}

/**
 * 构建 Research Map。
 * @returns {{map:object, status:'model'|'fallback'|'skipped', warnings:string[], stats:object, mapInputChars:number}}
 */
export async function buildResearchMap({
  chat,
  source = {},
  structure,
  figures = [],
  onProgress,
  maxChars = 22000,
  maxTokens = 4096,
} = {}) {
  const warnings = [];
  const mapInput = buildMapInput({ structure, figures, maxChars });

  if (typeof chat === 'function' && (structure?.chunks?.length || 0) >= 3) {
    try {
      onProgress?.({ stage: 'research_map', detail: `分析 ${structure.chunks.length} 个切片` });
      const res = await chat(buildResearchMapMessages({ source, structure, figures, mapInput }), maxTokens);
      const parsed = parseJsonLoose(res?.content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const { map, stats } = normalizeResearchMap(parsed, { structure, figures });
        const filled =
          map.key_claims.length + map.method_components.length + map.main_results.length + map.limitations.length;
        if (filled > 0) {
          return { map, status: 'model', warnings, stats, mapInputChars: mapInput.length };
        }
        warnings.push('research map 解析结果为空，已用本地关键词地图兜底');
      } else {
        warnings.push('research map 输出无法解析为 JSON，已用本地关键词地图兜底');
      }
    } catch (err) {
      warnings.push(`research map 调用失败：${(err && err.message) || err}`);
    }
  } else if ((structure?.chunks?.length || 0) > 0) {
    warnings.push('未提供可用 chat，使用本地关键词地图');
  }

  const { map, stats } = fallbackResearchMap({ structure, figures, source });
  return { map, status: 'fallback', warnings, stats, mapInputChars: mapInput.length };
}

/** 地图的精简文本视图（注入逐节写作与审计提示词）。 */
export function renderResearchMap(map, { maxChars = 3000 } = {}) {
  if (!map) return '';
  const lines = [];
  const push = (label, items) => {
    const arr = (items || []).map((i) => (typeof i === 'string' ? i : i.text)).filter(Boolean).slice(0, 8);
    if (arr.length) lines.push(`${label}：\n${arr.map((t) => `- ${t}`).join('\n')}`);
  };
  if (map.problem) lines.push(`问题：${map.problem}`);
  push('核心主张', map.key_claims);
  push('方法组件', map.method_components);
  push('关键公式', map.equations);
  push('数据集', map.datasets);
  push('benchmark/指标', map.benchmarks);
  push('基线', map.baselines);
  push('主要结果', map.main_results);
  push('消融', map.ablations);
  push('局限', map.limitations);
  const figs = (map.figures || []).slice(0, 12);
  if (figs.length) {
    lines.push(
      `图片：\n${figs
        .map((f) => `- 图${f.num}：${(f.caption || '').slice(0, 80)}${f.sectionTitle ? `（对应 ${f.sectionTitle}）` : ''}`)
        .join('\n')}`,
    );
  }
  const out = lines.join('\n');
  return out.length > maxChars ? `${out.slice(0, maxChars)}…` : out;
}

/** 地图里的关键词集合（审计实体一致性时用）。 */
export function mapEntityTokens(map) {
  const tokens = new Set();
  const add = (text) => {
    for (const t of tokenize(text)) tokens.add(t);
  };
  if (!map) return tokens;
  for (const field of ['datasets', 'benchmarks', 'baselines', 'main_results', 'method_components', 'equations']) {
    for (const item of map[field] || []) add(typeof item === 'string' ? item : item.text || '');
  }
  return tokens;
}
