/**
 * Evidence Requirements（证据保障层）—— Plan Coverage v2
 *
 * 上一轮（Evidence/Writer v3）确认：事实层没问题，缺口在 **allocation** ——
 * 高优先级事实对应的 source section 去和普通证据抢同一组 slot，抢不到就成了
 * `missing_evidence`（2501 的 MATH-500 / 79.8 / 97.3 / 2029、2406 的 failure / partial success）。
 *
 * 本模块只做分配策略，**不动 Retrieval v2 的排序**：
 *   Critical Fact → Evidence Requirement → sourceSection 优先级 → guaranteed / preferred / opportunistic
 *
 * 关键约束：
 *   - guaranteed requirement 必须拿到 slot（先分配、再排序竞争），拿不到要显式记 overflow；
 *   - 同一 source section 承载多条事实时做 packing（一个 section 一份保障，多条 fact 共用）；
 *   - 事实所在 source section 没被计划请求时，**只补 evidence requirement**，绝不新增文章小节；
 *   - 保障额度有上限（默认 4），其余额度仍然交给 Retrieval v2 正常竞争。
 */

import { buildCorpusIndex, rareTermsFromChunks } from './criticalFacts.js';
import { normalizeSectionName } from './sourceSections.js';
import { extractNumberTokens } from './audit.js';

export const ALLOCATION_MODES = ['guaranteed', 'preferred', 'opportunistic'];

/** 每个写作小节最多给多少「保障槽」（其余槽位仍由 Retrieval v2 正常排序决定）。 */
export const MAX_GUARANTEED_SLOTS = 4;

const KEY_CATEGORIES = new Set(['main_result', 'ablation', 'limitation', 'failure', 'comparison']);

const CATEGORY_WEIGHT = {
  main_result: 3,
  ablation: 2.5,
  failure: 2.5,
  limitation: 2.2,
  comparison: 1.4,
  method: 1,
  formula: 0.6,
  figure: 0.5,
};

/**
 * 分配模式（deterministic）：
 *   guaranteed    high 优先级的核心事实 / 带数字的 main_result / benchmark 关键数字
 *   preferred     medium 的一般事实
 *   opportunistic 只是背景/主题词支撑
 */
export function allocationModeOf(fact = {}) {
  const keyCategory = KEY_CATEGORIES.has(fact.category);
  const numbers = (fact.mustUseNumbers || []).length;
  if (fact.priority === 'high') return 'guaranteed';
  if (keyCategory && numbers > 0) return 'guaranteed';
  if (keyCategory) return 'preferred';
  if (numbers > 0) return 'preferred';
  return 'opportunistic';
}

function priorityWeight(fact) {
  const base = fact.priority === 'high' ? 2 : 1;
  return base + (CATEGORY_WEIGHT[fact.category] || 1);
}

/**
 * 找出「真正承载这条 requirement 的 chunk」：包含 requiredTerms / requiredNumbers 的 chunk。
 * 保障分配优先取这些 chunk（而不是「该小节的前 N 块」），否则像 97.3 / 2029 这种
 * 落在小节中后段的数字仍然会被 slot competition 挤掉。
 */
export function requiredChunksOf({ chunkIds = [], terms = [], numbers = [], structure = null, cap = 3 } = {}) {
  const byId = new Map((structure?.chunks || []).map((c) => [c.id, c]));
  const lowerTerms = (terms || []).map((t) => String(t).toLowerCase()).filter(Boolean);
  const numberList = (numbers || []).map((n) => String(n));
  const scored = [];
  for (const id of chunkIds) {
    const chunk = byId.get(id);
    if (!chunk) continue;
    const lower = String(chunk.text || '').toLowerCase();
    let score = 0;
    for (const t of lowerTerms) if (t && lower.includes(t)) score += 2;
    for (const n of numberList) if (n && lower.includes(n)) score += 1;
    if (score > 0) scored.push({ id, score, index: chunk.index ?? 0 });
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, cap).map((s) => s.id);
}

/** 某个 source section 的 criticality：由挂在它上面的事实决定（取最大值 + 组合加成）。 */
export function criticalityOf(group, { rareTermCount = 0, numberCount = 0 } = {}) {
  const facts = group.facts || [];
  if (!facts.length) return 0;
  const maxWeight = Math.max(...facts.map(priorityWeight));
  const factCountBonus = Math.min(2, (facts.length - 1) * 0.5);
  const rareTermBonus = Math.min(1.5, rareTermCount * 0.25);
  const numberBonus = Math.min(1.5, numberCount * 0.3);
  const categoryBonus = Math.max(...facts.map((f) => (CATEGORY_WEIGHT[f.category] || 1) * 0.2));
  return Number((maxWeight + factCountBonus + rareTermBonus + numberBonus + categoryBonus).toFixed(3));
}

/**
 * 构建证据需求：fact → requirement。
 * @returns {{requirements:Array, additions:Array, stats:object}}
 */
export function buildEvidenceRequirements({ ledger, plan = [], sourceIndex = null, structure = null, facts = null } = {}) {
  const factList = facts || ledger?.facts || [];
  const corpus = structure ? buildCorpusIndex(structure) : null;
  const planTitles = plan.map((s) => s.title);
  const requestedByPlan = new Map(); // sourceSection 标题 → 哪些计划小节请求了它
  for (const s of plan) {
    for (const t of s.sourceSections || []) {
      if (!requestedByPlan.has(t)) requestedByPlan.set(t, []);
      requestedByPlan.get(t).push(s.title);
    }
  }

  const requirements = [];
  const additions = [];

  // A) 论文侧关键小节（coverage / requirement 补入的）也要拿保障额度：
  //    它们承载的是「benchmark 数字 / 失败案例」这类事实，不能靠普通排序碰运气。
  const sectionEntry = (title) => sourceIndex?.sections?.find((s) => s.title === title);
  for (const s of plan) {
    const addedSections = [...new Set([...(s.sourceSectionsAddedByCoverage || []), ...(s.sourceSectionsAddedByRequirements || [])])];
    for (const title of addedSections) {
      const entry = sectionEntry(title);
      if (!entry) continue;
      const chunkIds = (entry.chunkIds || []).slice(0, 6);
      const rare = corpus ? rareTermsFromChunks(chunkIds, { structure, corpus, limit: 6 }) : [];
      const allChunkIds = entry.chunkIds || [];
      // 只留「针尖数字」：在小节里出现、但全篇很少出现的数字（97.3 / 2029 / 79.8），
      // 而不是 1 / 2 / 3 这类到处都是的数字——后者会把 guaranteed 槽位浪费掉。
      const sectionNumbers = [...new Set(allChunkIds.flatMap((cid) => extractNumberTokens(structure?.chunks?.find((c) => c.id === cid)?.text || '')))];
      const numberDf = (n) => (structure?.chunks || []).filter((c) => String(c.text || '').includes(String(n))).length;
      const rareNumbers = sectionNumbers.filter((n) => numberDf(n) <= 3);
      const numbers = (rareNumbers.length ? rareNumbers : sectionNumbers)
        .sort((a, b) => numberDf(a) - numberDf(b) || String(a).localeCompare(String(b)))
        .slice(0, 12);
      requirements.push({
        factId: `cfg:${title}`,
        priority: 'high',
        category: 'main_result',
        allocationMode: 'guaranteed',
        sourceSectionIds: [entry.id],
        sourceSectionTitles: [title],
        requiredTerms: rare,
        requiredNumbers: numbers,
        targetPlanSections: [s.title],
        chunkIds: allChunkIds,
        sourceChunkIds: entry.chunkIds || [],
        requiredChunkIds: requiredChunksOf({ chunkIds: allChunkIds, terms: rare, numbers, structure, cap: 4 }),
        allocationReason: '论文侧关键小节（coverage/requirement 补入），承载 benchmark 数字或失败案例',
        uncoveredSourceSections: [],
        rareTerms: rare,
        synthetic: true,
      });
    }
  }
  for (const fact of factList) {
    const targets = (fact.writerSections || []).length ? fact.writerSections : fact.planSections || [];
    const mode = allocationModeOf(fact);
    const sourceTitles = fact.sourceSections || [];
    const uncovered = sourceTitles.filter((t) => !requestedByPlan.has(t));
    // 事实所在的原文小节没人请求 → 生成「证据需求补入」（只补 requirement，不新增文章小节）
    if (uncovered.length && targets.length) {
      for (const title of uncovered) {
        additions.push({
          factId: fact.id,
          planSection: targets[0],
          sourceSection: title,
          allocationMode: mode,
          reason: 'fact_source_section_not_requested',
        });
      }
    }
    requirements.push({
      factId: fact.id,
      priority: fact.priority,
      category: fact.category,
      allocationMode: mode,
      sourceSectionIds: fact.sourceSectionIds || [],
      sourceSectionTitles: sourceTitles,
      requiredTerms: [...new Set([...(fact.mustUseTerms || []), ...((fact.mustUseNumbers || []).map((n) => n.term || ''))])].filter(Boolean),
      requiredNumbers: (fact.mustUseNumbers || []).map((n) => n.value),
      targetPlanSections: targets,
      chunkIds: fact.retrievedChunkIds?.length ? fact.retrievedChunkIds : fact.chunkIds || [],
      sourceChunkIds: fact.chunkIds || [],
      // 该事实「真正该读」的 chunk（含 requiredTerms / requiredNumbers 的那些）
      requiredChunkIds: requiredChunksOf({
        chunkIds: fact.chunkIds || [],
        terms: [...(fact.mustUseTerms || []), ...(fact.mustUseNumbers || []).map((n) => n.term || '')],
        numbers: (fact.mustUseNumbers || []).map((n) => n.value),
        structure,
        cap: 3,
      }),
      allocationReason:
        mode === 'guaranteed'
          ? `high/关键类别（${fact.category}）${(fact.mustUseNumbers || []).length ? '且带关键数字' : ''}`
          : mode === 'preferred'
            ? `medium 事实（${fact.category}）`
            : '仅背景/主题支撑',
      uncoveredSourceSections: uncovered,
      rareTerms: corpus && fact.chunkIds?.length ? rareTermsFromChunks(fact.chunkIds.slice(0, 3), { structure, corpus, limit: 4 }) : [],
    });
  }

  const byMode = requirements.reduce((acc, r) => {
    acc[r.allocationMode] = (acc[r.allocationMode] || 0) + 1;
    return acc;
  }, {});
  return {
    requirements,
    additions,
    stats: {
      total: requirements.length,
      byMode,
      guaranteed: byMode.guaranteed || 0,
      additions: additions.length,
      factsWithUncoveredSections: new Set(additions.map((a) => a.factId)).size,
    },
  };
}

/**
 * 打包 + 分配计划：
 *   同一 source section 的多条事实合成一组（一份保障服务多条 fact），
 *   guaranteed 组按 criticality 排序后取前 maxGuaranteedSlots 个，超出的显式记 overflow。
 *
 * @returns {{groups:Array, byPlanSection:Object, overflow:Array, stats:object}}
 */
export function packEvidenceRequirements({
  requirements = [],
  maxGuaranteedSlots = MAX_GUARANTEED_SLOTS,
  rareTermCountOf = () => 0,
} = {}) {
  const bySection = new Map();
  for (const r of requirements) {
    if (r.allocationMode === 'opportunistic') continue; // 只做保障与偏好，不做背景词
    const titles = r.sourceSectionTitles?.length ? r.sourceSectionTitles : [`fact:${r.factId}`];
    for (const title of titles) {
      const key = title;
      if (!bySection.has(key)) {
        bySection.set(key, {
          sourceSection: title,
          facts: [],
          requirements: [],
          targetPlanSections: new Set(),
          terms: new Set(),
          numbers: new Set(),
        });
      }
      const group = bySection.get(key);
      group.facts.push({ id: r.factId, category: r.category, priority: r.priority });
      group.requirements.push(r);
      for (const t of r.targetPlanSections || []) group.targetPlanSections.add(t);
      for (const t of r.requiredTerms || []) group.terms.add(String(t).toLowerCase());
      for (const n of r.requiredNumbers || []) group.numbers.add(String(n));
    }
  }

  const groups = [...bySection.values()].map((g) => {
    const rareTermCount = rareTermCountOf(g);
    return {
      sourceSection: g.sourceSection,
      factIds: g.facts.map((f) => f.id),
      facts: g.facts,
      priority: g.facts.some((f) => f.priority === 'high') ? 'high' : 'medium',
      allocationMode: g.requirements.some((r) => r.allocationMode === 'guaranteed') ? 'guaranteed' : 'preferred',
      targetPlanSections: [...g.targetPlanSections],
      requiredTerms: [...g.terms],
      requiredNumbers: [...g.numbers],
      chunkIds: [...new Set(g.requirements.flatMap((r) => r.chunkIds || []))],
      requiredChunkIds: [...new Set(g.requirements.flatMap((r) => r.requiredChunkIds || []))],
      sourceChunkIds: [...new Set(g.requirements.flatMap((r) => r.sourceChunkIds || []))],
      rareTermCount,
      criticality: criticalityOf(g, { rareTermCount, numberCount: g.numbers.size }),
    };
  });

  // 保障额度是**每个写作小节**的：一个小节最多 4 个 guaranteed source section
  // （spec §四：guaranteedSlots = min(maxGuaranteedSlots, 该节 high-priority requirement 数)）。
  const guaranteed = groups
    .filter((g) => g.allocationMode === 'guaranteed')
    .sort((a, b) => b.criticality - a.criticality || a.sourceSection.localeCompare(b.sourceSection));
  const keptGuaranteed = [];
  const overflow = [];
  const guaranteedCountBySection = new Map();
  for (const g of guaranteed) {
    const targets = (g.targetPlanSections || []).length ? g.targetPlanSections : ['<unassigned>'];
    for (const t of targets) {
      const used = guaranteedCountBySection.get(t) || 0;
      if (used < maxGuaranteedSlots) {
        guaranteedCountBySection.set(t, used + 1);
        if (!keptGuaranteed.includes(g)) keptGuaranteed.push(g);
      } else {
        overflow.push({
          sourceSection: g.sourceSection,
          factIds: g.factIds,
          planSection: t,
          criticality: g.criticality,
          reason: `「${t}」的 guaranteed 额度已满（maxGuaranteedSlots=${maxGuaranteedSlots}），转入普通排序竞争`,
        });
      }
    }
  }
  const droppedOverflow = overflow.map((g) => ({
    sourceSection: g.sourceSection,
    factIds: g.factIds,
    criticality: g.criticality,
    reason: g.reason,
  }));

  // 按计划小节汇总：每节拿到哪些 guaranteed source section
  const byPlanSection = {};
  for (const g of [...keptGuaranteed, ...groups.filter((x) => x.allocationMode !== 'guaranteed')]) {
    for (const title of g.targetPlanSections) {
      if (!byPlanSection[title]) byPlanSection[title] = { guaranteed: [], preferred: [] };
      const bucket = g.allocationMode === 'guaranteed' ? byPlanSection[title].guaranteed : byPlanSection[title].preferred;
      if (!bucket.includes(g.sourceSection)) bucket.push(g.sourceSection);
    }
  }

 return {
    groups,
    guaranteedGroups: keptGuaranteed,
    byPlanSection,
    overflow: droppedOverflow,
    stats: {
      groups: groups.length,
      guaranteedGroups: keptGuaranteed.length,
      preferredGroups: groups.length - guaranteed.length,
      overflow: droppedOverflow.length,
      maxGuaranteedSlots,
    },
    dropped: droppedOverflow,
  };
}

/**
 * Plan Coverage v2：source section 级别的覆盖度（比"请求了几个小节"更有意义）。
 */
export function requirementCoverage({ requirements = [], plan = [], packed = null } = {}) {
  const requested = new Set(plan.flatMap((s) => s.sourceSections || []));
  const sectionTitlesOf = (list) => [...new Set(list.flatMap((r) => r.sourceSectionTitles || []))];
  const ratioOf = (hit, total) => (total ? Number((hit / total).toFixed(4)) : null);

  const guaranteedSections = sectionTitlesOf(requirements.filter((r) => r.allocationMode === 'guaranteed'));
  const highSections = sectionTitlesOf(requirements.filter((r) => r.priority === 'high'));
  const factBacked = sectionTitlesOf(requirements);
  return {
    criticalSourceSectionCoverage: ratioOf(guaranteedSections.filter((t) => requested.has(t)).length, guaranteedSections.length),
    highPrioritySourceSectionCoverage: ratioOf(highSections.filter((t) => requested.has(t)).length, highSections.length),
    factBackedSourceSectionCoverage: ratioOf(factBacked.filter((t) => requested.has(t)).length, factBacked.length),
    guaranteedSourceSections: guaranteedSections.length,
    guaranteedSourceSectionsCovered: guaranteedSections.filter((t) => requested.has(t)).length,
    overflow: packed?.overflow?.length || 0,
  };
}

/** 事实 ID → requirement（供 lifecycle 诊断查「这条事实有没有保障」）。 */
export function requirementOfFact(requirements = [], factId = '') {
  return (requirements || []).find((r) => r.factId === factId) || null;
}

/** 归一化小节名（对齐用，导出给测试）。 */
export function normalizeRequirementSection(title) {
  return normalizeSectionName(title);
}
