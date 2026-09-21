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
import { buildFactCheck } from './factCheck.js';
import { buildGlobalContext, retrieveForSection, sectionRole } from './retrieval.js';
import { alignSourceSections, buildSourceSectionIndex } from './sourceSections.js';
import { buildCorpusIndex, distributeCriticalFacts, seedCriticalFacts } from './criticalFacts.js';
import {
  buildEvidenceLedger,
  checkSectionFactCoverage,
  repairTargetsFromCoverage,
  sectionsFromMarkdown,
} from './evidenceLedger.js';
import {
  MAX_GUARANTEED_SLOTS,
  buildEvidenceRequirements,
  packEvidenceRequirements,
  requirementCoverage,
} from './evidenceRequirements.js';
import { buildLocalizationIndex, buildSourceSectionInventory, localizeFacts } from './factLocalization.js';
import {
  STAGE_SOURCE,
  STAGE_STATUS,
  classifyModelOutput,
  fallbackStage,
  makeStage,
  summarizeStages,
} from './stages.js';

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
      uniqueChunkCount: same.length,
      reusedChunkCount: 0,
      newChunkCount: same.length,
      query: null,
      sourceSectionMatch: null,
      slots: {},
      mustUseTermHits: 0,
      mustUseTermTotal: 0,
      backHalfChunks: 0,
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
  // 统一阶段元数据：每个阶段都留一条可观测记录（status/source/finishReason/fallbackReason/duration）
  const stages = {};
  const providerName = options.providerName || null;
  const modelName = options.model || null;
  const maxChunkChars = options.chunkChars || config.deepreadChunkChars;
  const evidenceBudget = options.evidenceChars || config.deepreadEvidenceChars;
  const maxChunks = options.maxEvidenceChunks || config.deepreadMaxChunks;

  // 1) 全文结构化切片
  emit({ stage: 'chunking', detail: '正在结构化切片全文…' });
  const chunkingStartedAt = Date.now();
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
  const sourceIndex = buildSourceSectionIndex(structure);
  stages.chunking = makeStage({
    stage: 'chunking',
    status: STAGE_STATUS.SUCCESS,
    source: STAGE_SOURCE.LOCAL,
    parsed: true,
    durationMs: Date.now() - chunkingStartedAt,
    extra: { sections: structure.stats?.sectionCount || 0, chunks: structure.stats?.chunkCount || 0, chars: structure.stats?.chars || 0 },
  });

  if ((structure.chunks || []).length < 3) {
    return {
      degraded: true,
      reason: `切片不足（${summary}）`,
      warnings,
      structure,
      meta: { stages, stageSummary: summarizeStages(stages), factCheckStats: null, factCheck: null },
    };
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
      maxTokens: options.mapTokens || config.deepreadMapTokens,
      provider: providerName,
      model: modelName,
    });
  } catch (err) {
    warnings.push(`research map 异常：${(err && err.message) || err}`);
    mapResult = {
      map: null,
      status: 'fallback',
      warnings,
      stats: {},
      evidenceChunkIds: [],
      stage: fallbackStage({
        stage: 'research_map',
        reason: `research map 异常：${(err && err.message) || err}`,
        source: STAGE_SOURCE.LOCAL,
        provider: providerName,
        model: modelName,
      }),
    };
  }
  const researchMap = mapResult.map || null;
  stages.research_map = mapResult.stage || fallbackStage({ stage: 'research_map', reason: '未返回阶段元数据', source: STAGE_SOURCE.LOCAL });
  warnings.push(...(mapResult.warnings || []));
  emit({
    stage: 'research_map',
    detail: `研究地图：${mapResult.status === 'model' ? '模型产出' : `本地关键词兜底 · ${stages.research_map.status}`}（主张 ${mapResult.stats?.keyClaims || 0} / 结果 ${mapResult.stats?.mainResults || 0} / 消融 ${mapResult.stats?.ablations || 0} / 局限 ${mapResult.stats?.limitations || 0}）`,
  });

  // 3) 大纲（基于全文结构 + 研究地图）
  emit({ stage: 'plan', detail: '正在规划大纲…' });
  let plan = [];
  let planResponse = null;
  let planError = '';
  const planStartedAt = Date.now();
  try {
    planResponse = await chat(
      buildPlanMessages({ source, structure, researchMap, figures: figs }),
      options.planTokens || config.deepreadPlanTokens,
    );
    plan = parseDeepReadPlan(planResponse?.content);
  } catch (err) {
    planError = (err && err.message) || String(err);
    warnings.push(`大纲生成失败：${planError}`);
  }
  // 模型大纲只有在「真的解析出 ≥3 节」时才算生效；否则用默认骨架，并把真实调用状态记下来
  // （不能靠「标题是否等于默认大纲」反推，那是猜测不是证据）
  const planFromModel = plan.length >= 3;
  stages.plan = classifyModelOutput({
    stage: 'plan',
    response: planResponse,
    parsed: planFromModel,
    providerError: planError,
    source: planFromModel ? STAGE_SOURCE.MODEL : STAGE_SOURCE.DEFAULT,
    fallbackSource: STAGE_SOURCE.DEFAULT,
    model: modelName,
    provider: providerName,
    durationMs: Date.now() - planStartedAt,
    extra: { sectionCount: planFromModel ? plan.length : defaultDeepReadPlan().length, maxTokens: options.planTokens || config.deepreadPlanTokens },
  });
  if (!planFromModel) {
    if (!planError) {
      warnings.push(
        planResponse
          ? `大纲解析不出来（可见正文 ${String(planResponse.content || '').length} 字，finish_reason=${planResponse.finishReason || 'unknown'}），已用默认大纲`
          : '大纲未返回内容，已用默认大纲',
      );
    }
    plan = defaultDeepReadPlan();
    stages.plan = { ...stages.plan, fallbackReason: stages.plan.fallbackReason || '模型大纲不可用，使用默认大纲', reason: stages.plan.reason || '使用默认大纲' };
  }
  // 计划里的 role 优先（模型看过全文），缺失或给成 general 时用标题/要点兜底推断
  plan = plan.map((s) => ({ ...s, role: s.role && s.role !== 'general' ? s.role : sectionRole(s.title, s.note) }));

  // 3.5) Plan Coverage：从研究地图种出论文级关键事实 → 分发到小节 → 收敛 sourceSections / mustUseTerms
  //      （检索只接收更高质量的输入，评分机制不动）
  const corpus = buildCorpusIndex(structure);
  let criticalFacts = [];
  let planCoverage = null;
  // 这两个引用在 3.5 块里赋值、在最终 meta 里回填，必须**先声明再赋值**（否则 TDZ 异常会被
  // 下面的 try/catch 吞掉，表现为「事实层整块静默关闭」——20260919-062032 那轮就是这样）。
  let sourceSectionInventoryRef = null;
  let localizationStats = null;
  try {
    const seeded = seedCriticalFacts({ researchMap, structure, sourceIndex, corpus });
    // Layer A：Source Section Inventory（完全确定性，来自 parser，与模型输出无关）
    const sourceSectionInventory = buildSourceSectionInventory(structure, sourceIndex);
    // Layer B：Fact Localization —— 地图被截断/兜底时，用严格匹配给已有事实补 sourceSectionIds
    const localizationIndex = buildLocalizationIndex(structure, sourceSectionInventory);
    const localized = localizeFacts(seeded, { structure, inventory: sourceSectionInventory, index: localizationIndex });
    sourceSectionInventoryRef = sourceSectionInventory;
    localizationStats = { total: seeded.length, localized: localized.localized, unmatched: localized.unmatched.length, unmatchedIds: localized.unmatched.slice(0, 5) };
    const distributed = distributeCriticalFacts({ plan, facts: localized.facts, sourceIndex, structure, corpus });
    plan = distributed.plan;
    criticalFacts = distributed.facts;
    planCoverage = distributed.coverage;
  } catch (err) {
    warnings.push(`plan coverage 失败（不影响主流程）：${(err && err.message) || err}`);
  }
  const factsBySection = new Map();
  for (const f of criticalFacts) {
    for (const title of f.planSections || []) {
      if (!factsBySection.has(title)) factsBySection.set(title, []);
      factsBySection.get(title).push(f);
    }
  }

  // 3.6) Evidence Requirements（Plan Coverage v2）
  //   critical fact → evidence requirement → source section 保障级别。
  //   事实所在的原文小节如果没人请求，**只补 evidence requirement**（绝不新增文章 H2）；
  //   高优先级 requirement 走 guaranteed allocation，不再和普通证据抢同一组 slot。
  let requirements = [];
  let packedAllocation = null;
  let reqCoverage = null;
  try {
    const built = buildEvidenceRequirements({ plan, sourceIndex, structure, facts: criticalFacts });
    requirements = built.requirements;
    const planByTitle = new Map(plan.map((s) => [s.title, s]));
    for (const add of built.additions) {
      const target = planByTitle.get(add.planSection);
      if (!target) continue;
      const kept = target.sourceSections || [];
      if (kept.includes(add.sourceSection)) continue;
      if (kept.length >= 3) {
        // 预算满：把「模型请求但非事实驱动」的最后一项挪到 deferred，让 requirement 优先
        const factDriven = new Set([...(target.sourceSectionsAddedByFacts || []), ...(target.sourceSectionsAddedByCoverage || [])]);
        const victimIndex = [...kept].reverse().findIndex((t) => !factDriven.has(t));
        if (victimIndex >= 0) {
          const at = kept.length - 1 - victimIndex;
          const [victim] = kept.splice(at, 1);
          target.sourceSectionsDeferred = [...(target.sourceSectionsDeferred || []), victim];
        }
      }
      if ((target.sourceSections || []).length < 3) {
        target.sourceSections = [...(target.sourceSections || []), add.sourceSection];
        target.sourceSectionsAddedByRequirements = [...(target.sourceSectionsAddedByRequirements || []), add.sourceSection];
      }
    }
    packedAllocation = packEvidenceRequirements({
      requirements,
      maxGuaranteedSlots: MAX_GUARANTEED_SLOTS,
      rareTermCountOf: (g) => (g.requirements || []).reduce((n, r) => n + (r.rareTerms?.length || 0), 0),
    });
    reqCoverage = requirementCoverage({ requirements, plan, packed: packedAllocation });
  } catch (err) {
    warnings.push(`evidence requirements 失败（不影响主流程）：${(err && err.message) || err}`);
  }
  emit({
    stage: 'plan',
    detail:
      `大纲 ${plan.length} 节（${planFromModel ? '模型产出' : `默认骨架 · ${stages.plan.status}`}）` +
      (planCoverage?.criticalFactCount
        ? `；关键事实 ${planCoverage.criticalFactAssignedCount}/${planCoverage.criticalFactCount} 已落到小节，sourceSections 收敛到 ${planCoverage.sourceSectionsKept} 个（deferred ${planCoverage.sourceSectionOverflowCount}）`
        : '') +
      (packedAllocation
        ? `；证据保障：guaranteed ${packedAllocation.stats.guaranteedGroups} 组 / overflow ${packedAllocation.stats.overflow}`
        : ''),
  });

  // 4) 逐节检索 evidence
  const retrievalStartedAt = Date.now();
  const globalContext = buildGlobalContext({ structure, researchMap, figures: figs });
  emit({ stage: 'retrieval', detail: '正在按论文原文小节与关键证据检索…' });
  const usedChunkIds = [];
  const sourceMatches = [];
  const retrievals = plan.map((s) => {
    // 计划给的 sourceSections 先与论文真实小节对齐（exact → normalized → 编号 → 模糊 → 缩写 → 父级）
    const match = alignSourceSections({
      requested: s.sourceSections || [],
      index: sourceIndex,
      mustUseTerms: s.mustUseTerms || [],
    });
    sourceMatches.push(match);
    const alloc = packedAllocation?.byPlanSection?.[s.title] || null;
    const allocGroups = (packedAllocation?.guaranteedGroups || []).filter(
      (g) => (g.targetPlanSections || []).includes(s.title),
    );
    const allocFacts = requirements
      .filter((r) => (r.targetPlanSections || []).includes(s.title) && r.allocationMode !== 'opportunistic')
      .map((r) => ({ id: r.factId, terms: r.requiredTerms, numbers: r.requiredNumbers }));
    const guaranteedAllocation = alloc?.guaranteed?.length
      ? {
          sections: alloc.guaranteed,
          quota: Math.min(MAX_GUARANTEED_SLOTS, Math.max(2, alloc.guaranteed.length * 2)),
          facts: allocFacts,
          // 精确到 chunk：这些 chunk 含该 requirement 的术语/数字，必须先占位
          requiredChunks: [...new Set(allocGroups.flatMap((g) => g.requiredChunkIds || []))],
          overflow: (packedAllocation?.overflow || []).filter((o) =>
            requirements.some((r) => o.factIds?.includes(r.factId) && (r.targetPlanSections || []).includes(s.title)),
          ),
        }
      : null;
    const r = safeRetrieve({
      structure,
      section: s,
      researchMap,
      figures: figs,
      budgetChars: evidenceBudget,
      maxChunks,
      previousSectionChunkIds: usedChunkIds,
      sourceMatch: match,
      sourceIndex,
      // 只作元数据：记录本节负责的关键事实是否真的进了证据（不参与打分）
      criticalFacts: factsBySection.get(s.title) || [],
      // 保障分配（Plan Coverage v2）：只占槽位，不改 Ranking
      guaranteedAllocation,
    });
    usedChunkIds.push(...r.chunkIds);
    return r;
  });
  const evidenceCount = retrievals.reduce((n, r) => n + r.evidence.length, 0);
  const fallbackSections = retrievals.filter((r) => r.roles === 'fallback').length;
  const uniqueUsed = new Set(usedChunkIds).size;
  const sourceRequested = plan.filter((s) => (s.sourceSections || []).length).length;
  const sourceMatched = sourceMatches.filter((m) => (m.sectionIds || []).length).length;
  const mustUseTotal = plan.reduce((n, s) => n + (s.mustUseTerms || []).length, 0);
  const mustUseHit = retrievals.reduce((n, r) => n + (r.mustUseTermHits || 0), 0);
  const criticalHit = retrievals.reduce((n, r) => n + (r.criticalFactHitCount || 0), 0);
  const criticalTotal = retrievals.reduce((n, r) => n + (r.criticalFactTotal || 0), 0);
  stages.retrieval = makeStage({
    stage: 'retrieval',
    status: fallbackSections ? STAGE_STATUS.WARN : STAGE_STATUS.SUCCESS,
    source: STAGE_SOURCE.LOCAL,
    parsed: true,
    durationMs: Date.now() - retrievalStartedAt,
    reason: fallbackSections ? `${fallbackSections} 节检索异常，回退为「本节 chunks」` : '',
    extra: {
      sections: plan.length,
      evidence: evidenceCount,
      chunksCovered: uniqueUsed,
      reusedSlots: evidenceCount - uniqueUsed,
      sourceSectionsRequested: sourceRequested,
      sourceSectionsMatched: sourceMatched,
      mustUseTerms: mustUseTotal,
      mustUseTermHits: mustUseHit,
      criticalFactsInSections: criticalTotal,
      criticalFactsHit: criticalHit,
      backHalfEvidence: retrievals.flatMap((r) => r.chunkIds).filter((id) => {
        const c = structure.chunks.find((x) => x.id === id);
        return c && structure.chunks.length > 1 && c.index / (structure.chunks.length - 1) >= 0.5;
      }).length,
    },
  });
  emit({
    stage: 'retrieval',
    detail:
      `按原文小节与关键证据完成检索：${plan.length} 节 / ${evidenceCount} 条证据` +
      `（唯一 chunk ${uniqueUsed}，其中 ${evidenceCount - uniqueUsed} 条为关键证据复用）` +
      (sourceRequested ? `；原文小节对齐 ${sourceMatched}/${sourceRequested} 节` : '') +
      (mustUseTotal ? `；必用术语命中 ${mustUseHit}/${mustUseTotal}` : ''),
  });

  // 5) 逐节写作
  // Evidence Ledger：把「论文级事实」和「它是被哪一节、哪些 chunk 支撑的」记下来，
  // 写完立刻逐节做 Fact Coverage，这样「证据给了但没写」是可观测、可修复的。
  const ledger = buildEvidenceLedger({
    paperId: source.url || source.title || '',
    researchMap,
    criticalFacts,
    plan,
    retrievalResults: retrievals,
    structure,
  });
  const factsForPlanSection = (title) =>
    ledger.facts
      .filter((f) => (f.writerSections || []).includes(title))
      .map((f) => ({
        id: f.id,
        category: f.category,
        priority: f.priority,
        claim: f.claim,
        origin: f.origin,
        sourceSections: f.sourceSections,
        mustUseTerms: f.mustUseTerms,
        mustUseNumbers: f.mustUseNumbers,
      }));
  const sections = [];
  const reasoningParts = [];
  const evidenceLog = [];
  const sectionStartedAt = Date.now();
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
            facts: factsForPlanSection(plan[i].title),
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
    evidenceLog.push({
      section: plan[i].title,
      role: plan[i].role,
      chunkIds: retrieval.chunkIds,
      figureNums: retrieval.figureNums,
      // Retrieval v2 诊断信息（只进 meta，不进提示词）
      uniqueChunkCount: retrieval.uniqueChunkCount,
      reusedChunkCount: retrieval.reusedChunkCount,
      newChunkCount: retrieval.newChunkCount,
      slots: retrieval.slots,
      backHalfChunks: retrieval.backHalfChunks,
      sourceSectionMatch: retrieval.sourceSectionMatch,
      query: retrieval.query,
      mustUseTermHits: retrieval.mustUseTermHits,
      mustUseTermTotal: retrieval.mustUseTermTotal,
      criticalFactIds: retrieval.criticalFactIds,
      criticalFactHitCount: retrieval.criticalFactHitCount,
      criticalFactMissCount: retrieval.criticalFactMissCount,
      criticalFactHitRate: retrieval.criticalFactHitRate,
      sourceSections: plan[i].sourceSections || [],
      sourceSectionsRequested: plan[i].sourceSectionsRequested || [],
      sourceSectionsAddedByFacts: plan[i].sourceSectionsAddedByFacts || [],
      sourceSectionsAddedByCoverage: plan[i].sourceSectionsAddedByCoverage || [],
      sourceSectionsDeferred: plan[i].sourceSectionsDeferred || [],
      mustUseTerms: plan[i].mustUseTerms || [],
      mustUseTermRanking: plan[i].mustUseTermRanking || [],
      // Plan Coverage v2：本节拿到哪些 guaranteed source section、支撑了哪些事实
      guaranteedSlots: retrieval.guaranteedSlots || 0,
      guaranteedSections: retrieval.guaranteedSections || [],
      supportedFactIds: retrieval.supportedFactIds || [],
      allocationOverflow: retrieval.allocationOverflow || [],
    });
    emit({ stage: 'section_done', section: secInfo });
    prev = `${prev}\n\n${content}`.slice(-9000);
  }

  // 所有小节都写不出来：交给 provider 回退旧流程（multipass / 整篇生成）再试一次
  if (failedSections >= plan.length) {
    stages.section_generation = makeStage({
      stage: 'section_generation',
      status: STAGE_STATUS.FAILED,
      source: STAGE_SOURCE.MODEL,
      parsed: false,
      durationMs: Date.now() - sectionStartedAt,
      reason: '逐节写作全部失败',
      extra: { sections: plan.length, failed: failedSections },
    });
    return {
      degraded: true,
      reason: '逐节写作全部失败',
      warnings,
      structure,
      meta: { stages, stageSummary: summarizeStages(stages), factCheckStats: null, factCheck: null },
    };
  }

  stages.section_generation = makeStage({
    stage: 'section_generation',
    status: failedSections ? STAGE_STATUS.WARN : STAGE_STATUS.SUCCESS,
    source: STAGE_SOURCE.MODEL,
    parsed: true,
    durationMs: Date.now() - sectionStartedAt,
    reason: failedSections ? `${failedSections}/${plan.length} 节生成失败，已跳过` : '',
    extra: { sections: plan.length, failed: failedSections },
  });

  let markdown = `# ${source.title || '深度解读'}\n\n${sections.join('\n\n').replace(/^(## [^\n]+)\n\n(?=## \1\n)/gm, '')}`.trim() + '\n';

  // 6) 证据审计（失败不阻断）
  let audit = null;
  const auditStartedAt = Date.now();
  const researchMapMeta = {
    status: stages.research_map.status,
    source: stages.research_map.source,
    finishReason: stages.research_map.finishReason ?? null,
    fallbackReason: stages.research_map.fallbackReason || '',
  };
  if (config.deepreadAudit) {
    emit({ stage: 'audit', detail: '正在做证据审计…' });
    try {
      audit = auditDraft({ markdown, structure, researchMap, figures: figs, source, researchMapMeta });
      emit({ stage: 'audit', detail: auditSummary(audit) });
    } catch (err) {
      warnings.push(`证据审计失败（已跳过）：${(err && err.message) || err}`);
      audit = null;
    }
  }
  stages.audit = config.deepreadAudit
    ? makeStage({
        stage: 'audit',
        status: audit ? STAGE_STATUS.SUCCESS : STAGE_STATUS.FAILED,
        source: STAGE_SOURCE.LOCAL,
        parsed: !!audit,
        durationMs: Date.now() - auditStartedAt,
        reason: audit ? '' : '审计执行失败，已跳过（不阻断报告）',
        extra: audit
          ? {
              verdict: audit.verdict,
              researchMapSource: audit.researchMapSource,
              failedChecks: audit.checks.filter((c) => c.status === 'fail').map((c) => c.name),
              warnings: (audit.warnings || []).map((w) => w.code),
            }
          : null,
      })
    : makeStage({ stage: 'audit', status: STAGE_STATUS.SKIPPED, source: STAGE_SOURCE.LOCAL, parsed: null, reason: 'DEEPREAD_AUDIT=0，按配置跳过证据审计' });

  // 7) 定点修复：只重写有问题的个别小节
  const repairs = [];
  const repairStartedAt = Date.now();
  let repairErrors = 0;
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
        repairErrors += 1;
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
    stages.repair = makeStage({
      stage: 'repair',
      status: repairErrors ? STAGE_STATUS.WARN : STAGE_STATUS.SUCCESS,
      source: STAGE_SOURCE.MODEL,
      parsed: true,
      durationMs: Date.now() - repairStartedAt,
      reason: repairErrors ? `${repairErrors} 节修复失败，保留原稿` : '',
      extra: { targets: Math.min(audit.repairTargets.length, options.maxRepairs || 2), applied: repairs.length, errors: repairErrors },
    });
  } else {
    stages.repair = makeStage({
      stage: 'repair',
      status: STAGE_STATUS.SKIPPED,
      source: STAGE_SOURCE.LOCAL,
      parsed: null,
      reason: !config.deepreadRepair
        ? 'DEEPREAD_REPAIR=0，按配置跳过定点修复'
        : audit?.serious?.length
          ? '审计未通过但没有可定位的小节'
          : '审计无需修复',
      extra: { targets: 0, applied: 0 },
    });
  }

  // 7.5) Fact Coverage + 定向修复 v2
  //   「证据已经进了上下文，但这一节没写出来」以前是不可观测的；现在逐节判定，
  //   只补没写的事实（不重写整篇、不新增小节、不改数字口径）。
  const coverageStartedAt = Date.now();
  emit({ stage: 'fact_coverage', detail: '正在做逐节事实覆盖检查…' });
  let writerCoverage = checkSectionFactCoverage({
    ledger,
    markdownBySection: sectionsFromMarkdown(markdown),
    structure,
  });
  const factRepairs = [];
  const maxFactRounds = options.maxFactRepairs != null ? Math.max(0, Number(options.maxFactRepairs)) : 2;
  for (let round = 0; round < maxFactRounds; round += 1) {
    const targets = repairTargetsFromCoverage(ledger, writerCoverage)
      .filter((t) => t.section)
      .sort((a, b) => (a.priority === b.priority ? 0 : a.priority === 'high' ? -1 : 1));
    const highLeft = targets.filter((t) => t.priority === 'high').length;
    if (!targets.length) break;
    if (!highLeft && round > 0) break; // high 已清零：只再给 medium 一轮机会
    const bySection = new Map();
    for (const t of targets) {
      if (!bySection.has(t.section)) bySection.set(t.section, []);
      bySection.get(t.section).push(t);
    }
    let applied = 0;
    for (const [title, list] of [...bySection.entries()].slice(0, 2)) {
      const sec = splitMarkdownSections(markdown).find((s) => s.heading === title && s.level >= 2);
      if (!sec) continue;
      const idx = plan.findIndex((p) => p.title === title);
      const retrieval = idx >= 0 ? retrievals[idx] : null;
      try {
        const r = await chat(
          buildSectionRepairMessages({
            source,
            sectionTitle: title,
            currentBody: `## ${sec.heading}\n\n${sec.body}`,
            hints: list.map((t) => `${t.factId} 没有写出来：${t.claim}（${t.reason}）`),
            evidence: retrieval ? retrieval.evidence : [],
            researchMap,
            figures: figs,
            missingFacts: list,
          }),
          9000,
        );
        const fixed = String(r?.content || '').trim();
        if (!fixed || !/^#{1,3}\s/.test(fixed)) continue;
        const patched = replaceSection(markdown, title, fixed);
        if (!patched) continue;
        markdown = patched.endsWith('\n') ? patched : `${patched}\n`;
        applied += 1;
        factRepairs.push({ section: title, facts: list.map((t) => t.factId), statuses: list.map((t) => t.status), round: round + 1 });
      } catch (err) {
        warnings.push(`事实补写失败（保留原稿）：${(err && err.message) || err}`);
      }
    }
    const next = checkSectionFactCoverage({ ledger, markdownBySection: sectionsFromMarkdown(markdown), structure });
    const improved = (next.stats.coverage ?? 0) >= (writerCoverage.stats.coverage ?? 0);
    writerCoverage = next;
    if (!applied || !improved) break;
  }
  // 台账状态回填（供 evidence-ledger.json 与 benchmark 指标使用）
  for (const fact of ledger.facts) {
    const assessed = writerCoverage.byFact[fact.id];
    if (!assessed) continue;
    fact.status = assessed.status;
    fact.reason = assessed.reason || fact.reason;
    fact.writtenIn = assessed.section || '';
    fact.coverage = {
      termHits: assessed.termHits,
      termTotal: assessed.termTotal,
      numberHits: assessed.numberHits,
      numberTotal: assessed.numberTotal,
      unsupportedNumbers: assessed.unsupportedNumbers || [],
      derivedNumbers: assessed.derivedNumbers || [],
    };
  }
  const highUnwritten = (writerCoverage.results || []).filter((r) => {
    if (r.status !== 'unwritten' && r.status !== 'unsupported') return false;
    const fact = ledger.facts.find((f) => f.id === r.factId);
    return fact?.priority === 'high';
  }).length;
  stages.fact_coverage = makeStage({
    stage: 'fact_coverage',
    status: highUnwritten ? STAGE_STATUS.WARN : STAGE_STATUS.SUCCESS,
    source: STAGE_SOURCE.MODEL,
    parsed: true,
    durationMs: Date.now() - coverageStartedAt,
    reason: highUnwritten ? `${highUnwritten} 条 high 优先级事实仍未写入（已尝试 ${factRepairs.length} 次定点补写）` : '',
    extra: {
      facts: ledger.facts.length,
      covered: writerCoverage.stats.covered,
      derived: writerCoverage.stats.derived,
      unsupported: writerCoverage.stats.unsupported,
      unwritten: writerCoverage.stats.unwritten,
      missingEvidence: writerCoverage.stats.missingEvidence,
      coverage: writerCoverage.stats.coverage,
      factRepairs: factRepairs.length,
    },
  });
  emit({
    stage: 'fact_coverage',
    detail: `事实覆盖：covered ${writerCoverage.stats.covered} / derived ${writerCoverage.stats.derived} / unsupported ${writerCoverage.stats.unsupported} / unwritten ${writerCoverage.stats.unwritten} / missing_evidence ${writerCoverage.stats.missingEvidence}（补写 ${factRepairs.length} 次）`,
  });

  emit({ stage: 'finalize', detail: `成稿 ${(markdown || '').replace(/\s/g, '').length} 字` });

  // 数字核验表（迁移自青稞「技术解读稿件」规范）：终稿里每个数字都要能追到原文句子。
  // 确定性回查 chunk，不调用模型；产物单独落盘（deepread.fact-check.md），不进正文。
  const factCheck = buildFactCheck({ markdown, structure, ledger });
  emit({
    stage: 'finalize',
    detail: `数字核验：${factCheck.stats.numbers} 个数字 / 可定位 ${factCheck.stats.located} / 推导 ${factCheck.stats.derived} / 查不到 ${factCheck.stats.unsupported}`,
  });

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
      stages,
      stageSummary: summarizeStages(stages),
      researchMapStatus: mapResult.status,
      researchMapStageStatus: stages.research_map.status,
      researchMapSource: stages.research_map.source,
      researchMapStats: mapResult.stats,
      researchMapEvidenceIds: mapResult.evidenceChunkIds || [],
      planStatus: stages.plan.status,
      planSource: stages.plan.source,
      plan: plan.map((s) => ({
        title: s.title,
        note: s.note,
        role: s.role,
        sourceSections: s.sourceSections || [],
        sourceSectionsRequested: s.sourceSectionsRequested || [],
        sourceSectionsAddedByFacts: s.sourceSectionsAddedByFacts || [],
        sourceSectionsDeferred: s.sourceSectionsDeferred || [],
        sourceSectionsAddedByCoverage: s.sourceSectionsAddedByCoverage || [],
        sourceSectionsAddedByRequirements: s.sourceSectionsAddedByRequirements || [],
        mustUseTerms: s.mustUseTerms || [],
        mustUseTermsDeferred: s.mustUseTermsDeferred || [],
        mustUseTermRanking: s.mustUseTermRanking || [],
        criticalFactIds: s.criticalFactIds || [],
      })),
      criticalFacts,
      planCoverage,
      evidenceRequirements: requirements,
      // Research Map 可靠性：确定性小节清单 + 事实定位结果（与地图是否被截断无关）
      sourceSectionInventory: sourceSectionInventoryRef,
      factLocalization: localizationStats,
      mapStatus: stages.research_map?.status || null,
      allocation: packedAllocation
        ? {
            stats: packedAllocation.stats,
            overflow: packedAllocation.overflow,
            byPlanSection: packedAllocation.byPlanSection,
            coverage: reqCoverage,
          }
        : null,
      evidenceLedger: ledger,
      writerCoverage,
      factCoverageStats: writerCoverage.stats,
      // 数字核验表：终稿数字 ↔ 原文句子（表外数字 = unsupported，供前端/审计/benchmark 使用）
      factCheckStats: factCheck.stats,
      factCheck,
      factRepairs,
      evidence: evidenceLog,
      auditVerdict: audit?.verdict || null,
      auditWarnings: (audit?.warnings || []).map((w) => w.code),
      evidenceText: evidenceLines.join('\n\n'),
      repairs,
      warnings,
    },
  };
}
