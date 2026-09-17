/**
 * 结构化 + 证据驱动的深度解读主编排。
 *
 * 阶段（与 SSE 一一对应）：
 *   chunking      全文结构化切片（HTML section / TeX 章节 / PDF 编号标题）
 *   research_map  轻量结构化分析（问题 / 主张 / 方法 / 公式 / 数据 / 结果 / 消融 / 局限 / 图 + 证据定位）
 *   retrieval     按小节从全文召回 evidence chunks（词法检索，不引入向量库）
 *   plan          大纲（基于全文结构 + 研究地图）
 *   section       逐节写作（每节只看「检索到的证据 + 研究地图 + 全局上下文」）
 *   audit         终稿证据审计（数字/实体/main result/消融/局限/公式/图）
 *   repair        只重写审计不通过的个别小节
 *   finalize      合并、记录元数据
 *
 * 降级：切片不足 → 返回 degraded（由 provider 回退旧流程）；研究地图失败 → 本地关键词地图；
 * 检索失败 → 本节 chunks；审计失败 → 只记 warning，不阻断报告。
 */

import { config } from '../config.js';
import { checkStyle } from '../styleCheck.js';
import { auditDraft, auditSummary, replaceSection, splitMarkdownSections } from './audit.js';
import { buildPaperStructure, structureSummary } from './chunker.js';
import {
  buildDeepReadSectionMessages,
  buildPlanMessages,
  buildSectionRepairMessages,
  defaultDeepReadPlan,
  parseDeepReadPlan,
} from './prompts.js';
import { buildResearchMap } from './researchMap.js';
import { buildGlobalContext, retrieveForSection, sectionRole } from './retrieval.js';

/** 把 figures 与 chunks/section 关联（图注文本在哪个 chunk 出现，就归到那个 section）。 */
export function mapFiguresToChunks(figures = [], structure) {
  const chunks = structure?.chunks || [];
  return figures.map((f, i) => {
    const num = Number(f.num) || i + 1;
    const probe = String(f.caption || '').slice(0, 24).toLowerCase();
    let hit = null;
    if (probe.length >= 8) hit = chunks.find((c) => c.text.toLowerCase().includes(probe));
    if (!hit && probe.length >= 8) {
      hit = chunks.find((c) => c.type === 'figure' && c.text.toLowerCase().includes(probe.slice(0, 12)));
    }
    return {
      ...f,
      num,
      chunkId: hit?.id || '',
      sectionTitle: hit?.sectionTitle || f.sectionTitle || '',
    };
  });
}

/** 检索兜底：检索失败时至少给「本节 chunks」。 */
function localSectionChunks(structure, section) {
  const chunks = structure?.chunks || [];
  const same = chunks.filter(
    (c) => c.sectionTitle === section.title || c.sectionPath?.includes(section.title),
  );
  return same.length ? same : chunks.slice(0, 6);
}

function safeRetrieve(args) {
  try {
    return retrieveForSection(args);
  } catch {
    const same = localSectionChunks(args.structure, args.section);
    return {
      evidence: same.map((c) => ({ id: c.id, sectionTitle: c.sectionTitle, type: c.type, text: c.text, score: 0 })),
      chunkIds: same.map((c) => c.id),
      figureNums: [],
      roles: 'fallback',
      chars: same.reduce((n, c) => n + c.text.length, 0),
    };
  }
}

/**
 * 主流程。
 * @param {object} args
 * @param {(messages:Array, maxTokens:number)=>Promise<{content:string,reasoning?:string}>} args.chat
 * @param {object} args.source  { title, byline, date, url, text, textLines, html, structure, kind, memory, terms }
 * @param {Array} args.figures
 * @param {(p:object)=>void} args.onProgress
 */
export async function runDeepRead({ chat, source = {}, figures = [], onProgress = () => {}, options = {} }) {
  const emit = (p) => {
    try {
      onProgress(p);
    } catch {
      /* 进度回调失败不影响主流程 */
    }
  };
  const warnings = [];
  const maxChunkChars = options.chunkChars || config.deepreadChunkChars;
  const evidenceBudget = options.evidenceChars || config.deepreadEvidenceChars;
  const maxChunks = options.maxEvidenceChunks || config.deepreadMaxChunks;

  // 1) 全文结构化切片
  emit({ stage: 'chunking', detail: '正在结构化切片全文…' });
  const structure = buildPaperStructure({
    kind: source.kind || (source.textLines ? 'pdf' : 'html'),
    text: source.text || '',
    textLines: source.textLines || '',
    html: source.html || '',
    structure: source.structure || null,
    maxChunkChars,
  });
  const summary = structureSummary(structure);
  emit({ stage: 'chunking', detail: `全文切片完成：${summary}` });

  if ((structure.chunks || []).length < 3) {
    return { degraded: true, reason: `切片不足（${summary}）`, warnings, structure };
  }

  const figs = mapFiguresToChunks(figures, structure);

  // 2) Research Map
  let mapResult;
  try {
    mapResult = await buildResearchMap({
      chat,
      source,
      structure,
      figures: figs,
      onProgress: emit,
      maxChars: options.mapChars || config.deepreadMapChars,
    });
  } catch (err) {
    warnings.push(`research map 异常：${(err && err.message) || err}`);
    mapResult = { map: null, status: 'fallback', warnings, stats: {} };
  }
  const researchMap = mapResult.map || null;
  warnings.push(...(mapResult.warnings || []));
  emit({
    stage: 'research_map',
    detail: `研究地图：${mapResult.status === 'model' ? '模型产出' : '本地关键词兜底'}（主张 ${mapResult.stats?.keyClaims || 0} / 结果 ${mapResult.stats?.mainResults || 0} / 消融 ${mapResult.stats?.ablations || 0} / 局限 ${mapResult.stats?.limitations || 0}）`,
  });

  // 3) 大纲（基于全文结构 + 研究地图）
  emit({ stage: 'plan', detail: '正在规划大纲…' });
  let plan = [];
  try {
    const planRaw = await chat(buildPlanMessages({ source, structure, researchMap, figures: figs }), 4096);
    plan = parseDeepReadPlan(planRaw?.content);
  } catch (err) {
    warnings.push(`大纲生成失败：${(err && err.message) || err}`);
  }
  if (plan.length < 3) plan = defaultDeepReadPlan();
  plan = plan.map((s) => ({ ...s, role: sectionRole(s.title, s.note) }));
  emit({ stage: 'plan', detail: `大纲 ${plan.length} 节` });

  // 4) 逐节检索 evidence
  const globalContext = buildGlobalContext({ structure, researchMap, figures: figs });
  const retrievals = plan.map((s) => safeRetrieve({ structure, section: s, researchMap, figures: figs, budgetChars: evidenceBudget, maxChunks }));
  const evidenceCount = retrievals.reduce((n, r) => n + r.evidence.length, 0);
  emit({
    stage: 'retrieval',
    detail: `已从 ${structure.chunks.length} 个切片中为 ${plan.length} 节召回 ${evidenceCount} 条证据（覆盖 ${new Set(retrievals.flatMap((r) => r.chunkIds)).size} 个 chunk）`,
  });

  // 5) 逐节写作
  const sections = [];
  const reasoningParts = [];
  const evidenceLog = [];
  let failedSections = 0;
  let prev = '';
  for (let i = 0; i < plan.length; i++) {
    const secInfo = { index: i + 1, total: plan.length, title: plan[i].title };
    const retrieval = retrievals[i];
    emit({ stage: 'section', section: secInfo, detail: `检索到 ${retrieval.evidence.length} 条证据` });
    let content = '';
    let lastErr = null;
    for (let attempt = 0; attempt < 2 && !content; attempt++) {
      try {
        const r = await chat(
          buildDeepReadSectionMessages({
            source,
            figures: figs,
            plan,
            index: i,
            prevMd: prev,
            evidence: retrieval.evidence,
            globalContext,
            researchMap,
            role: plan[i].role,
          }),
          12000,
        );
        content = String(r?.content || '').trim();
        if (r?.reasoning) reasoningParts.push(r.reasoning);
      } catch (err) {
        lastErr = err;
      }
    }
    if (!content) {
      failedSections += 1;
      warnings.push(`第 ${i + 1} 节生成失败：${(lastErr && lastErr.message) || '未知错误'}`);
      content = `## ${plan[i].title}\n\n（本节生成失败已跳过——可重试或换更强的模型。）`;
    }
    sections.push(content);
    evidenceLog.push({ section: plan[i].title, role: plan[i].role, chunkIds: retrieval.chunkIds, figureNums: retrieval.figureNums });
    emit({ stage: 'section_done', section: secInfo });
    prev = `${prev}\n\n${content}`.slice(-9000);
  }

  // 所有小节都写不出来：交给 provider 回退旧流程（multipass / 整篇生成）再试一次
  if (failedSections >= plan.length) {
    return { degraded: true, reason: '逐节写作全部失败', warnings, structure };
  }

  let markdown = `# ${source.title || '深度解读'}\n\n${sections.join('\n\n').replace(/^(## [^\n]+)\n\n(?=## \1\n)/gm, '')}`.trim() + '\n';

  // 6) 证据审计（失败不阻断）
  let audit = null;
  if (config.deepreadAudit) {
    emit({ stage: 'audit', detail: '正在做证据审计…' });
    try {
      audit = auditDraft({ markdown, structure, researchMap, figures: figs, source });
      emit({ stage: 'audit', detail: auditSummary(audit) });
    } catch (err) {
      warnings.push(`证据审计失败（已跳过）：${(err && err.message) || err}`);
      audit = null;
    }
  }

  // 7) 定点修复：只重写有问题的个别小节
  const repairs = [];
  if (audit?.serious?.length && audit.repairTargets?.length && config.deepreadRepair) {
    const limit = options.maxRepairs || 2;
    const targets = audit.repairTargets.slice(0, limit);
    emit({ stage: 'repair', detail: `按审计结果定点修复 ${targets.length} 节…` });
    for (const target of targets) {
      try {
        const sec = splitMarkdownSections(markdown).find((s) => s.heading === target.heading && s.level >= 2);
        if (!sec) continue;
        const role = sectionRole(target.heading, '');
        const retrieval = safeRetrieve({
          structure,
          section: { title: target.heading, note: '' },
          researchMap,
          figures: figs,
          budgetChars: evidenceBudget,
          maxChunks,
        });
        const r = await chat(
          buildSectionRepairMessages({
            source,
            sectionTitle: target.heading,
            currentBody: `## ${sec.heading}\n\n${sec.body}`,
            hints: target.hints,
            evidence: retrieval.evidence,
            researchMap,
            figures: figs,
          }),
          9000,
        );
        const fixed = String(r?.content || '').trim();
        if (!fixed || !/^#{1,3}\s/.test(fixed)) continue;
        const patched = replaceSection(markdown, target.heading, fixed);
        if (patched) {
          markdown = patched.endsWith('\n') ? patched : `${patched}\n`;
          repairs.push({ heading: target.heading, role, hints: target.hints });
        }
      } catch (err) {
        warnings.push(`定点修复失败（保留原稿）：${(err && err.message) || err}`);
      }
    }
    if (repairs.length && config.deepreadAudit) {
      try {
        audit = { ...audit, after: auditDraft({ markdown, structure, researchMap, figures: figs, source }) };
      } catch {
        /* 复检失败忽略 */
      }
    }
  }

  emit({ stage: 'finalize', detail: `成稿 ${(markdown || '').replace(/\s/g, '').length} 字` });

  // 供终稿审校使用的证据文本（去重、按预算截断）：审校不再只看正文前 16000 字
  const seenEvidence = new Set();
  const evidenceLines = [];
  let evidenceChars = 0;
  for (const { evidence } of retrievals) {
    for (const e of evidence) {
      if (seenEvidence.has(e.id)) continue;
      seenEvidence.add(e.id);
      const line = `[${e.id}]（${e.sectionTitle}）${e.text}`;
      if (evidenceChars + line.length > 16000) break;
      evidenceLines.push(line);
      evidenceChars += line.length;
    }
  }

  return {
    degraded: false,
    markdown,
    reasoning: reasoningParts.join('\n\n---\n\n'),
    style: checkStyle(markdown, 'deepread'),
    audit,
    meta: {
      pipeline: 'structured',
      structure: structure.stats,
      sections: structure.sections.map((s) => ({ id: s.id, title: s.title, chunks: s.chunkIds.length })),
      researchMapStatus: mapResult.status,
      researchMapStats: mapResult.stats,
      plan: plan.map((s) => ({ title: s.title, note: s.note, role: s.role })),
      evidence: evidenceLog,
      evidenceText: evidenceLines.join('\n\n'),
      repairs,
      warnings,
    },
  };
}
