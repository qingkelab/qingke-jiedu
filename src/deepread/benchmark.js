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

export const BENCHMARK_VERSION = 'v1';

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
};

/** 越低越好的指标。 */
const LOWER_IS_BETTER = new Set(['auditMissingRate']);

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
  lines.push('');
  for (const key of [
    'sourceCoverage',
    'latePaperCoverage',
    'numberEvidenceCoverage',
    'figureCoverage',
    'formulaCoverage',
    'ablationCoverage',
    'limitationCoverage',
    'auditMissingRate',
    'sectionCompleteness',
    'lengthStability',
  ]) {
    const v = summary.metrics?.[key];
    lines.push(`${METRIC_LABELS[key]}: ${typeof v === 'number' ? `${(v * 100).toFixed(0)}%` : 'n/a'}`);
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
  lines.push('| 指标 | 数值 |');
  lines.push('| --- | --- |');
  for (const key of Object.keys(METRIC_LABELS)) {
    const v = summary.metrics?.[key];
    lines.push(`| ${METRIC_LABELS[key]} | ${typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : 'n/a'} |`);
  }
  lines.push('');
  lines.push('## 逐篇结果');
  lines.push('');
  lines.push('| 论文 | 分类 | 状态 | sourceCoverage | latePaper | numbers | figures | formulas | ablation | limitation | auditMissing | 耗时 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const pct = (v) => (typeof v === 'number' ? `${(v * 100).toFixed(0)}%` : 'n/a');
  for (const p of summary.papers || []) {
    if (p.status !== 'completed') {
      lines.push(`| ${p.id} | ${p.category || '-'} | ${p.status} | - | - | - | - | - | - | - | - | ${p.reason || ''} |`);
      continue;
    }
    const m = p.metrics || {};
    lines.push(
      `| ${p.id} | ${p.category || '-'} | completed | ${pct(m.sourceCoverage)} | ${pct(m.latePaperCoverage)} | ${pct(
        m.numberEvidenceCoverage,
      )} | ${pct(m.figureCoverage)} | ${pct(m.formulaCoverage)} | ${pct(m.ablationCoverage)} | ${pct(m.limitationCoverage)} | ${pct(
        m.auditMissingRate,
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
      return key === 'auditMissingRate' ? v > 0.05 : v < lowThreshold;
    });
    if (weak.length) {
      notes.push(`${p.id}：${weak.map((k) => `${METRIC_LABELS[k]}=${(m[k] * 100).toFixed(0)}%`).join('、')}`);
    }
    if (p.lengthStability === 0) notes.push(`${p.id}：终稿疑似截断（lengthStability=0）`);
    if (p.degraded) notes.push(`${p.id}：走了降级流程（legacy fallback）`);
    // 静默降级比失败更危险：research map 没生效时，检索加权与消融/局限识别都退化成关键词匹配，
    // 覆盖率却可能看起来正常，所以必须显式报到 summary 里。
    if (p.researchMapStatus === 'fallback') {
      notes.push(`${p.id}：research map 未产出模型地图（本地关键词兜底）——证据定位、消融/局限识别的精度会下降`);
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
