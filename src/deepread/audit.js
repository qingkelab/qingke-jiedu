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

/** 原文证据索引：数字 → chunkId，方便定位「终稿数字是否来自原文」。 */
function evidenceLookup(structure) {
  const chunks = structure?.chunks || [];
  const numbers = new Map();
  for (const c of chunks) {
    for (const n of extractNumberTokens(c.text)) if (!numbers.has(n)) numbers.set(n, c.id);
  }
  const text = chunks.map((c) => c.text).join('\n').toLowerCase();
  return { chunks, numbers, text };
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
export function auditDraft({ markdown, structure, researchMap, figures = [], source = {}, minFigureRefs = 3 } = {}) {
  const md = String(markdown || '');
  const look = evidenceLookup(structure);
  const checks = [];
  const issues = [];
  const repairTargets = new Map(); // heading -> Set(hint)

  const addRepair = (heading, hint) => {
    if (!heading) return;
    if (!repairTargets.has(heading)) repairTargets.set(heading, new Set());
    repairTargets.get(heading).add(hint);
  };

  // 1) 数字 / 百分比
  const draftNumbers = [...new Set(extractNumberTokens(md))];
  const keySet = look.numbers;
  const bareSet = new Set([...keySet.keys()].map((k) => k.replace(/[^\d.]/g, '')).filter(Boolean));
  const missingNumbers = draftNumbers.filter((n) => {
    if (keySet.has(n)) return false;
    const bare = n.replace(/[^\d.]/g, '');
    if (bare && bareSet.has(bare)) return false;
    return true;
  });
  const numberStatus =
    !draftNumbers.length ? 'warn' : !missingNumbers.length ? 'pass' : missingNumbers.length <= 2 ? 'warn' : 'fail';
  checks.push({
    name: 'numbers',
    status: numberStatus,
    detail: `终稿数字 ${draftNumbers.length} 个，原文未检到 ${missingNumbers.length} 个`,
    missing: missingNumbers.slice(0, 12),
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
  return {
    checks,
    issues,
    serious,
    repairTargets: [...repairTargets.entries()].map(([heading, hints]) => ({ heading, hints: [...hints] })),
    stats: {
      numbers: draftNumbers.length,
      missingNumbers: missingNumbers.length,
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
  if (!failed.length && !warned.length) return '证据审计通过';
  const parts = [];
  if (failed.length) parts.push(`未通过 ${failed.map((c) => c.name).join('/')}`);
  if (warned.length) parts.push(`提示 ${warned.map((c) => c.name).join('/')}`);
  return `证据审计：${parts.join('；')}`;
}
