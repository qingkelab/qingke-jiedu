/**
 * Evidence Audit（证据审计）
 *
 * 终稿生成后做一次轻量审计：数字/百分比、模型与数据集名、指标、main result、ablation、
 * limitation、公式、图与正文的对应关系是否能在原文 chunks 里找到依据。
 *
 * 只产出内部 metadata（不进最终 Markdown），并根据问题给出「定点修复」建议：
 * 只重写有问题的那一节，而不是整篇重生成。
 */

/** 把 Markdown 拆成 [{heading, level, body, start, end}]（H1~H3 视作小节边界）。 */
export function splitMarkdownSections(markdown) {
  const md = String(markdown || '');
  const lines = md.split('\n');
  const sections = [];
  let cur = { heading: '', level: 0, lines: [], start: 0 };

  const close = (endIdx) => {
    if (!cur.lines.length && !cur.heading) return;
    sections.push({
      heading: cur.heading,
      level: cur.level,
      body: cur.lines.join('\n').trim(),
      start: cur.start,
      end: endIdx,
    });
  };

  lines.forEach((line, i) => {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m && m[1].length <= 3) {
      close(i);
      cur = { heading: m[2].trim(), level: m[1].length, lines: [], start: i };
    } else {
      cur.lines.push(line);
    }
  });
  close(lines.length);
  return sections;
}

/** 用新的小节内容替换旧小节（按标题精确匹配，找不到返回 null）。 */
export function replaceSection(markdown, heading, newBody) {
  const md = String(markdown || '');
  const sections = splitMarkdownSections(md).filter((s) => s.heading && s.level >= 2);
  const target = sections.find((s) => s.heading && s.heading.trim() === String(heading).trim());
  if (!target) return null;
  const lines = md.split('\n');
  const head = lines.slice(0, target.start);
  const tail = lines.slice(target.end);
  const body = String(newBody || '')
    .replace(/^#{1,6}\s+.*\n?/, '')
    .trim();
  return [...head, `## ${target.heading}`, '', body, '', ...tail]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 数字 token 归一化：去千分位、统一百分号与乘号形态。 */
export function numberKey(raw) {
  return String(raw || '')
    .replace(/\s+/g, '')
    .replace(/,/g, '')
    .replace(/％/g, '%')
    .replace(/×/g, 'x')
    .replace(/[（(]/g, '')
    .replace(/[）)]/g, '')
    .toLowerCase();
}

/** Unicode 减号 / 各种连字符统一成 ASCII '-'。 */
const DASH_RE = /[\u2212\u2010\u2011\u2012\u2013\u2014\u2015\uFE63\uFF0D]/g;

/**
 * 数字格式归一化（**只做有明确规则的格式归一化**，不做数值近似，也不删任意前导数字）：
 *   - 千位逗号：4,200 → 4200
 *   - 百分号/乘号前后空格与全角形态：41.8 % → 41.8%、10× → 10x
 *   - 整数部分前导零：01.30% → 1.30%、007 → 7（0.8 保持不变）
 *   - 小数尾零：41.80 → 41.8、0.00 → 0
 *   - Unicode 减号与连字符：−1.2 → -1.2
 *   - arXiv HTML 表格展平造成的列粘连（"01.30%"）靠上面的前导零规则覆盖
 *
 * 用途：audit 判断「终稿的数字能否在原文定位」时，先精确匹配、再走这层归一化匹配；
 * 只有两者都不中，才算「原文查不到」（避免把格式差异误判成编造，同时不影响抓真编造）。
 */
export function normalizeNumberToken(raw) {
  const s = numberKey(raw).replace(DASH_RE, '-');
  const m = s.match(/^(\d+(?:\.\d+)?)(.*)$/);
  if (!m) return s;
  const [intPart, fracPart] = m[1].split('.');
  const int = intPart.replace(/^0+(?=\d)/, '');
  const frac = (fracPart || '').replace(/0+$/, '');
  return `${int}${frac ? `.${frac}` : ''}${m[2]}`;
}

/** 归一化后的数值部分（用于「数值相同、单位写法不同」的近似匹配）。 */
export function numberValue(raw) {
  const m = normalizeNumberToken(raw).match(/^-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** 归一化后的单位后缀。 */
export function numberUnit(raw) {
  const m = normalizeNumberToken(raw).match(/^-?\d+(?:\.\d+)?(.*)$/);
  return m ? m[1] : '';
}

/**
 * 用三种方式判定「终稿数字是否能在原文定位」：
 *   exact       字面（numberKey）一致
 *   normalized  格式归一化后一致（01.30% ≡ 1.30%、4,200 ≡ 4200、41.80 ≡ 41.8）
 *   approximate 数值一致但单位写法不同（10.7 ≡ 10.7%）
 */
export function matchNumberToken(draftKey, index) {
  if (index.exact.has(draftKey)) return { method: 'exact', chunkId: index.exact.get(draftKey) };
  const norm = normalizeNumberToken(draftKey);
  if (index.normalized.has(norm)) return { method: 'normalized', chunkId: index.normalized.get(norm) };
  const value = numberValue(draftKey);
  if (value != null && index.numeric.has(value)) return { method: 'approximate', chunkId: index.numeric.get(value) };
  return null;
}

/** 从文本里抽数字 token（含小数、百分比、规模后缀）。 */
export function extractNumberTokens(text) {
  const out = [];
  const re = /\d+(?:[.,]\d+)?\s*(?:%|％|×|x|倍|万|亿|k|K|M|B|billion|million)?/g;
  for (const m of String(text || '').matchAll(re)) {
    const key = numberKey(m[0]);
    const digits = key.replace(/[^\d]/g, '');
    if (!digits) continue;
    if (/^\d{4}$/.test(digits) && /^(19|20)\d{2}$/.test(digits)) continue; // 年份不计入实验数字
    out.push(key);
  }
  return out;
}

/** 原文证据索引：数字 → chunkId（精确 / 归一化 / 数值三种索引），方便定位「终稿数字是否来自原文」。 */
function evidenceLookup(structure) {
  const chunks = structure?.chunks || [];
  const exact = new Map();
  const normalized = new Map();
  const numeric = new Map();
  for (const c of chunks) {
    for (const n of extractNumberTokens(c.text)) {
      if (!exact.has(n)) exact.set(n, c.id);
      const norm = normalizeNumberToken(n);
      if (!normalized.has(norm)) normalized.set(norm, c.id);
      const value = numberValue(n);
      if (value != null && !numeric.has(value)) numeric.set(value, c.id);
    }
  }
  const text = chunks.map((c) => c.text).join('\n').toLowerCase();
  return { chunks, numbers: exact, normalized, numeric, text };
}

const FORMULA_RE = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;

export function extractFormulas(text) {
  const out = [];
  for (const m of String(text || '').matchAll(FORMULA_RE)) out.push((m[1] || m[2] || '').trim());
  return out.filter(Boolean);
}

/** 公式指纹：去掉空白与常见排版差异，用于判断是否被改写。 */
export function formulaFingerprint(latex) {
  return String(latex || '')
    .replace(/\s+/g, '')
    .replace(/\\left|\\right|\\,|\\;|\\!/g, '')
    .replace(/[{}]/g, '')
    .toLowerCase();
}

/** 两条公式的相似度（0~1）：完全相同/包含关系为高分，否则按 3-gram 重合度。 */
export function formulaOverlap(a, b) {
  const fa = formulaFingerprint(a);
  const fb = formulaFingerprint(b);
  if (!fa || !fb) return 0;
  if (fa === fb) return 1;
  if (fa.includes(fb) || fb.includes(fa)) return 0.9;
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i + 3 <= s.length; i++) set.add(s.slice(i, i + 3));
    return set;
  };
  const ga = grams(fa);
  const gb = grams(fb);
  if (!ga.size || !gb.size) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit += 1;
  return hit / Math.min(ga.size, gb.size);
}

function contentKeywords(text, limit = 10) {
  return (String(text || '').toLowerCase().match(/[a-z][a-z0-9-]{2,}|[\u4e00-\u9fff]{2,}/g) || [])
    .filter(
      (w) =>
        !/^(the|and|for|with|from|this|that|our|are|was|were|has|have|can|not|but|its|their|图注|figure|table)$/.test(w),
    )
    .slice(0, limit);
}

const ROLE_HINT = {
  method: /方法|机制|架构|模型|训练|算法|组件|算子|从输入|输入到输出|method|approach|mechanism|architecture/i,
  // 结论句式的标题常直接带数字（如「41.8 BLEU 与消融说明了什么」），所以也认数字
  results: /结果|实验|证据|评测|性能|指标|消融|提升|result|experiment|evidence|evaluation|benchmark|ablation|\d+\.\d/,
  limitation: /局限|边界|失效|风险|讨论|结论|limitation|boundary|risk|discussion|caveat/i,
  formula: /公式|推导|损失|目标|equation|formula|loss|objective/i,
};

/** 找出最可能承载某类信息的 H2 小节标题。 */
export function pickSectionForRole(markdown, role) {
  const sections = splitMarkdownSections(markdown).filter((s) => s.heading && s.level >= 2);
  if (!sections.length) return null;
  const re = ROLE_HINT[role];
  if (re) {
    const hit = sections.find((s) => re.test(s.heading));
    if (hit) return hit.heading;
  }
  if (role === 'limitation' || role === 'formula' || role === 'results') return sections[sections.length - 1].heading;
  return sections[0].heading;
}

/** 哪些小节出现了给定文本（把数字问题定位到小节）。 */
function sectionsContaining(markdown, needle) {
  const key = numberKey(needle);
  return splitMarkdownSections(markdown)
    .filter((s) => s.heading && s.level >= 2 && numberKey(s.body).includes(key))
    .map((s) => s.heading);
}

/**
 * 审计终稿。
 * @returns {{checks:Array, issues:Array, serious:Array, repairTargets:Array, stats:Object}}
 */
export function auditDraft({ markdown, structure, researchMap, figures = [], source = {}, minFigureRefs = 3, researchMapMeta = null } = {}) {
  const md = String(markdown || '');
  const look = evidenceLookup(structure);
  const checks = [];
  const issues = [];
  const warnings = [];
  const repairTargets = new Map(); // heading -> Set(hint)

  // 0) 上游地图可信度：地图不生效时，实体 / 主结果 / 消融 / 局限 这类「依赖地图」的检查
  //    仍然照跑（确定性检查不该被关掉），但结论不能被当成高可信通过。
  const mapStatus = String(researchMapMeta?.status || (researchMap ? 'unknown' : 'none'));
  const mapSource = String(researchMapMeta?.source || (researchMap ? 'unknown' : 'none'));
  const mapReason = String(researchMapMeta?.fallbackReason || researchMapMeta?.reason || '');
  if (!researchMap) {
    warnings.push({
      code: 'research_map_unavailable',
      detail: '没有研究地图：实体 / 主要结果 / 消融 / 局限 覆盖检查退化为纯关键词匹配',
    });
  } else if (!researchMapMeta) {
    warnings.push({
      code: 'research_map_source_unknown',
      detail: '研究地图缺少阶段元数据，无法判断它来自模型还是本地兜底',
    });
  } else if (['model_truncated', 'parse_failed', 'provider_error'].includes(mapStatus)) {
    warnings.push({
      code: 'research_map_unavailable',
      detail: `研究地图未产出模型结果（${mapStatus}${mapReason ? `：${mapReason}` : ''}）：本次审计的实体 / 主要结果 / 消融 / 局限 结论基于本地关键词地图，不能当作高可信通过`,
    });
  } else if (mapSource === 'local') {
    warnings.push({
      code: 'research_map_local_fallback',
      detail: '研究地图来自本地关键词兜底：覆盖率类「通过」只说明关键词层面没发现问题，不代表模型地图生效',
    });
  }

  const addRepair = (heading, hint) => {
    if (!heading) return;
    if (!repairTargets.has(heading)) repairTargets.set(heading, new Set());
    repairTargets.get(heading).add(hint);
  };

  // 1) 数字 / 百分比
  const draftNumbers = [...new Set(extractNumberTokens(md))];
  const numberIndex = { exact: look.numbers, normalized: look.normalized, numeric: look.numeric };
  const numberMatches = [];
  const missingNumbers = [];
  const matchMethods = { exact: 0, normalized: 0, approximate: 0 };
  for (const n of draftNumbers) {
    const hit = matchNumberToken(n, numberIndex);
    if (hit) {
      numberMatches.push({ value: n, method: hit.method, chunkId: hit.chunkId });
      matchMethods[hit.method] += 1;
    } else {
      missingNumbers.push(n);
    }
  }
  const numberStatus =
    !draftNumbers.length ? 'warn' : !missingNumbers.length ? 'pass' : missingNumbers.length <= 2 ? 'warn' : 'fail';
  checks.push({
    name: 'numbers',
    status: numberStatus,
    detail:
      `终稿数字 ${draftNumbers.length} 个，原文未检到 ${missingNumbers.length} 个` +
      `（匹配方式：精确 ${matchMethods.exact} / 归一化 ${matchMethods.normalized} / 近似 ${matchMethods.approximate}）`,
    missing: missingNumbers.slice(0, 12),
    matched: numberMatches.slice(0, 40),
    methods: matchMethods,
  });
  if (numberStatus !== 'pass') {
    issues.push({
      check: 'numbers',
      severity: numberStatus,
      detail: `数字无法在原文定位：${missingNumbers.slice(0, 8).join('、') || '（终稿没有数字）'}`,
      missing: missingNumbers.slice(0, 12),
    });
    for (const n of missingNumbers.slice(0, 4)) {
      for (const h of sectionsContaining(md, n)) {
        addRepair(h, `核对数字 ${n}：原文里没有这个值，改成原文数值或补齐坐标（模型/数据集/设置/基线）`);
      }
    }
  }

  // 2) 实体（数据集 / benchmark / baseline）
  const entityNames = [];
  for (const field of ['datasets', 'benchmarks', 'baselines']) {
    for (const item of researchMap?.[field] || []) {
      const t = typeof item === 'string' ? item : item.text;
      if (t && t.length <= 40) entityNames.push(t);
    }
  }
  const unknownEntities = entityNames.filter((n) => !look.text.includes(String(n).toLowerCase()));
  const notMentioned = entityNames.filter((n) => !md.toLowerCase().includes(String(n).toLowerCase()));
  checks.push({
    name: 'entities',
    status: unknownEntities.length ? 'warn' : 'pass',
    detail: `地图实体 ${entityNames.length} 个，原文未出现 ${unknownEntities.length} 个，终稿未提及 ${notMentioned.length} 个`,
    unknown: unknownEntities.slice(0, 8),
    notMentioned: notMentioned.slice(0, 8),
  });
  if (unknownEntities.length) {
    issues.push({
      check: 'entities',
      severity: 'warn',
      detail: `地图里的实体在原文中未出现（可能被臆造）：${unknownEntities.slice(0, 6).join('、')}`,
    });
  }

  // 3) main result 覆盖
  const mainResults = (researchMap?.main_results || []).map((r) => (typeof r === 'string' ? r : r.text));
  const mainKeys = [...new Set(mainResults.flatMap((t) => extractNumberTokens(t)))];
  const draftBare = new Set(draftNumbers.map((n) => n.replace(/[^\d.]/g, '')));
  const coveredMain = mainKeys.filter((k) => draftBare.has(k.replace(/[^\d.]/g, '')));
  const mainStatus = !mainKeys.length ? 'info' : coveredMain.length >= Math.min(2, mainKeys.length) ? 'pass' : 'fail';
  checks.push({
    name: 'main_result',
    status: mainStatus,
    detail: `主要结果关键数字 ${mainKeys.length} 个，终稿覆盖 ${coveredMain.length} 个`,
    covered: coveredMain,
    missed: mainKeys.filter((k) => !coveredMain.includes(k)).slice(0, 8),
  });
  if (mainStatus === 'fail') {
    const missed = mainKeys.filter((k) => !coveredMain.includes(k)).slice(0, 6);
    issues.push({ check: 'main_result', severity: 'fail', detail: `主要结果覆盖不足，缺少：${missed.join('、')}` });
    addRepair(
      pickSectionForRole(md, 'results'),
      `补上论文主要结果的原文数字（至少 ${Math.min(2, mainKeys.length)} 个，缺：${missed.join('、')}），坐标写全`,
    );
  }

  // 4) ablation 覆盖
  const ablations = (researchMap?.ablations || []).map((a) => (typeof a === 'string' ? a : a.text)).filter(Boolean);
  const hasAblation = /消融|ablation|去掉|移除|不加|w\/o|without /i.test(md);
  const ablaStatus = !ablations.length ? 'info' : hasAblation ? 'pass' : 'fail';
  checks.push({
    name: 'ablation',
    status: ablaStatus,
    detail: ablations.length ? `原文有 ${ablations.length} 条消融信息，终稿${hasAblation ? '已覆盖' : '未覆盖'}` : '原文未见消融',
  });
  if (ablaStatus === 'fail') {
    issues.push({ check: 'ablation', severity: 'fail', detail: '终稿未覆盖论文的消融实验' });
    addRepair(pickSectionForRole(md, 'results'), `补消融结论（去掉哪个组件会发生什么，带原文数字）：${ablations.slice(0, 2).join('；')}`);
  }

  // 5) limitation 覆盖
  const limitations = (researchMap?.limitations || []).map((l) => (typeof l === 'string' ? l : l.text)).filter(Boolean);
  const hasLimitation = /局限|边界|失效|限制|limitation|caveat|仅|只有在|尚未/i.test(md);
  const limStatus = !limitations.length ? 'info' : hasLimitation ? 'pass' : 'fail';
  checks.push({
    name: 'limitation',
    status: limStatus,
    detail: limitations.length ? `原文有 ${limitations.length} 条局限，终稿${hasLimitation ? '已覆盖' : '未覆盖'}` : '原文未见明确局限',
  });
  if (limStatus === 'fail') {
    issues.push({ check: 'limitation', severity: 'fail', detail: '终稿未覆盖论文的局限/失效条件' });
    addRepair(pickSectionForRole(md, 'limitation'), `补适用边界与失效条件：${limitations.slice(0, 2).join('；')}`);
  }

  // 6) 公式保留与改写检查
  const sourceFormulas = (structure?.chunks || []).filter((c) => c.type === 'formula').map((c) => c.text);
  const draftFormulas = extractFormulas(md);
  let formulaStatus = 'info';
  let formulaDetail = '原文未检出独立公式';
  if (sourceFormulas.length) {
    const best = draftFormulas.map((f) => Math.max(...sourceFormulas.map((s) => formulaOverlap(f, s)), 0));
    const matched = best.filter((v) => v >= 0.6).length;
    formulaStatus = !draftFormulas.length ? 'fail' : matched >= Math.min(1, draftFormulas.length) ? 'pass' : 'warn';
    formulaDetail = `原文公式 ${sourceFormulas.length} 条，终稿 ${draftFormulas.length} 条，可对应 ${matched} 条`;
  } else if (draftFormulas.length) {
    formulaStatus = 'warn';
    formulaDetail = `原文未检出公式，终稿写了 ${draftFormulas.length} 条公式`;
  }
  checks.push({ name: 'formula', status: formulaStatus, detail: formulaDetail });
  if (formulaStatus === 'fail') {
    issues.push({ check: 'formula', severity: 'fail', detail: '终稿丢失论文关键公式' });
    addRepair(
      pickSectionForRole(md, 'method'),
      `补回关键公式（LaTeX 原样）+ 首次出现处解释符号：${sourceFormulas.slice(0, 2).join('；')}`,
    );
  } else if (formulaStatus === 'warn' && sourceFormulas.length) {
    issues.push({ check: 'formula', severity: 'warn', detail: '终稿公式与原文对不上（可能被改写）' });
    addRepair(pickSectionForRole(md, 'formula'), '核对公式符号与下标是否与原文一致（保留 LaTeX 原样，不改写下标/符号）');
  }

  // 7) 图与正文的对应关系
  const figCount = (figures || []).length;
  const refs = [...md.matchAll(/图\s*(\d{1,2})/g)].map((m) => Number(m[1]));
  const uniqueRefs = [...new Set(refs)];
  const badRefs = uniqueRefs.filter((n) => n < 1 || n > figCount);
  const sections = splitMarkdownSections(md).filter((s) => s.heading && s.level >= 2);
  const mismatched = [];
  for (const sec of sections) {
    for (const n of new Set([...sec.body.matchAll(/图\s*(\d{1,2})/g)].map((m) => Number(m[1])))) {
      const fig = (figures || []).find((f) => Number(f.num) === n);
      if (!fig?.caption) continue;
      const capWords = contentKeywords(fig.caption, 10);
      const overlap = capWords.filter((w) => sec.body.toLowerCase().includes(w)).length;
      if (capWords.length >= 3 && overlap === 0) mismatched.push({ section: sec.heading, num: n });
    }
  }
  const needRefs = Math.min(minFigureRefs, figCount);
  const figStatus = !figCount
    ? 'info'
    : badRefs.length
      ? 'fail'
      : uniqueRefs.length >= needRefs && !mismatched.length
        ? 'pass'
        : 'warn';
  checks.push({
    name: 'figures',
    status: figStatus,
    detail: `可用图 ${figCount} 张，终稿引用 ${uniqueRefs.length} 处${badRefs.length ? `（越界：${badRefs.join('、')}）` : ''}${mismatched.length ? `，疑似错配 ${mismatched.length} 处` : ''}`,
    refs: uniqueRefs,
    badRefs,
    mismatched,
  });
  if (badRefs.length) {
    issues.push({ check: 'figures', severity: 'fail', detail: `引用了不存在的图：${badRefs.join('、')}` });
  }
  for (const m of mismatched.slice(0, 2)) {
    issues.push({
      check: 'figures',
      severity: figStatus === 'fail' ? 'fail' : 'warn',
      detail: `第「${m.section}」节引用的图${m.num} 与图注内容不符`,
    });
    addRepair(m.section, `图 ${m.num} 与本节论述不符：改引与本节内容对应的图，或补一句它和本节的关系`);
  }
  if (figCount && uniqueRefs.length < needRefs && !badRefs.length) {
    issues.push({ check: 'figures', severity: 'warn', detail: `图片引用偏少（${uniqueRefs.length}/${needRefs}）` });
    addRepair(pickSectionForRole(md, 'method'), `在讲对应内容的小节引用关键图（至少 ${needRefs} 处，分散在不同小节）`);
  }

  const serious = issues.filter((i) => i.severity === 'fail');
  const warned = issues.filter((i) => i.severity === 'warn');
  // 三级结论：地图不生效 / 有 warning 级问题 → 不能算「高可信通过」
  const verdict = serious.length ? 'failed' : warnings.length || warned.length ? 'passed_with_warning' : 'passed';
  return {
    checks,
    issues,
    serious,
    repairTargets: [...repairTargets.entries()].map(([heading, hints]) => ({ heading, hints: [...hints] })),
    warnings,
    verdict,
    researchMapStatus: mapStatus,
    researchMapSource: mapSource,
    stats: {
      numbers: draftNumbers.length,
      missingNumbers: missingNumbers.length,
      numberMatchMethods: matchMethods,
      entities: entityNames.length,
      mainResults: mainKeys.length,
      formulas: draftFormulas.length,
      figureRefs: uniqueRefs.length,
    },
    sourceKey: source?.url || source?.title || '',
  };
}

/** 审计结果的一句话摘要（SSE detail / 日志用）。 */
export function auditSummary(audit) {
  if (!audit) return '';
  const failed = audit.checks.filter((c) => c.status === 'fail');
  const warned = audit.checks.filter((c) => c.status === 'warn');
  const mapWarnings = audit.warnings || [];
  if (!failed.length && !warned.length) {
    return mapWarnings.length ? `证据审计通过（${mapWarnings.length} 条可信度提示）` : '证据审计通过';
  }
  const parts = [];
  if (failed.length) parts.push(`未通过 ${failed.map((c) => c.name).join('/')}`);
  if (warned.length) parts.push(`提示 ${warned.map((c) => c.name).join('/')}`);
  if (mapWarnings.length) parts.push(`可信度 ${mapWarnings.map((w) => w.code).join('/')}`);
  return `证据审计：${parts.join('；')}`;
}
