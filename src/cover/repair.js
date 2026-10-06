/**
 * 契约修复：审计发现问题的**只改 spec，不改已渲染的图**（审计前移的同一条原则）。
 *
 * 修复动作全部确定性、可回放，并留下 repair ledger：
 *   编出来的数字/术语 → 从契约里删掉；
 *   两段文字压字 / 撑破面板 → 收起批注、丢掉优先级最低的模块、或缩短该行文字；
 *   文字不合规（emoji、裸 LaTeX）→ 就地清洗；
 *   白名单/负约束缺失 → 补齐。
 */

import { NEGATIVE_CONSTRAINTS, buildCoverSpec, specVisibleText } from './audit.js';
import { stripDecorative } from './distill.js';

/** 去掉 emoji 与裸 LaTeX（`$…$` 与常见命令），保留中文与普通符号。 */
export function sanitizeSpecText(value) {
  return stripDecorative(String(value ?? ''))
    .replace(/\$[^$]*\$/g, '')
    .replace(/\\(?:frac|dfrac|tfrac|sum|prod|hat|bar|tilde|mathbb|mathrm|nabla|eta|mu|pi|theta|alpha|odot|langle|rangle|text|sqrt)\b[^\s，。；、）)]*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 把 spec 还原成渲染器要的 { content, structure }（修复后的版本）。 */
export function specToRenderInput(spec = {}) {
  return {
    content: {
      title: spec.title || '',
      subtitle: spec.subtitle || '',
      tags: [...(spec.tags || [])],
      steps: [...(spec.steps || [])],
      numbers: (spec.numbers || []).map((n) => ({ value: n.value, label: n.label, condition: n.condition })),
      claims: [...(spec.claims || [])],
      formula: spec.formula?.latex ? { latex: spec.formula.latex } : null,
      sourceUrl: spec.sourceUrl || '',
      sections: (spec.steps || []).length,
    },
    structure: {
      primary: spec.structure?.primary || 'concept',
      reason: spec.structure?.reason || '',
      modules: [...(spec.structure?.modules || [])],
    },
  };
}

/**
 * 依据审计结果修 spec。
 * @returns {{spec:object, applied:Array<{code:string, action:string, detail?:string}>}}
 */
export function repairCoverSpec({ spec: input = {}, findings = [] } = {}) {
  const spec = JSON.parse(JSON.stringify(input));
  const applied = [];
  const hit = (where, needle) => String(needle || '').length >= 2 && String(where || '').includes(String(needle).slice(0, Math.min(12, String(needle).length)));

  for (const f of findings) {
    if (f.code === 'ungrounded-number') {
      const before = spec.numbers.length;
      spec.numbers = spec.numbers.filter((n) => String(n.value) !== String(f.where));
      if (spec.numbers.length !== before) applied.push({ code: f.code, action: 'drop-number', detail: String(f.where) });
      continue;
    }
    if (f.code === 'ungrounded-term') {
      const before = spec.tags.length;
      spec.tags = spec.tags.filter((t) => !hit(f.where, sanitizeSpecText(t)));
      if (spec.tags.length !== before) applied.push({ code: f.code, action: 'drop-tag', detail: String(f.where) });
      continue;
    }
    if (f.code === 'emoji-in-text' || f.code === 'raw-latex-in-text') {
      const clean = { title: sanitizeSpecText(spec.title), subtitle: sanitizeSpecText(spec.subtitle) };
      spec.title = clean.title || spec.title;
      spec.subtitle = clean.subtitle || spec.subtitle;
      spec.tags = spec.tags.map(sanitizeSpecText).filter(Boolean);
      spec.claims = spec.claims.map(sanitizeSpecText).filter(Boolean);
      spec.steps = spec.steps.map(sanitizeSpecText).filter(Boolean);
      applied.push({ code: f.code, action: 'sanitize-text', detail: String(f.where).slice(0, 20) });
      continue;
    }
    if (f.code === 'spec-missing-negative-constraints') {
      spec.negativeConstraints = [...NEGATIVE_CONSTRAINTS];
      applied.push({ code: f.code, action: 'fill-negative-constraints' });
      continue;
    }
    if (f.code === 'spec-no-visible-text-whitelist') {
      spec.visibleText = (spec.visibleText || []).length ? spec.visibleText : specVisibleText(spec).split('｜').filter(Boolean).slice(0, 3);
      applied.push({ code: f.code, action: 'fill-visible-text' });
      continue;
    }
    if (f.code === 'text-overlap' || f.code === 'panel-overflow' || f.code === 'text-out-of-frame') {
      const where = String(f.where || '');
      // 批注/数字/步骤能定位就先收拾它们，否则退化成「丢掉最低优先级的模块」
      const claim = spec.claims.find((c) => hit(where, c));
      if (claim) {
        spec.claims = spec.claims.filter((c) => c !== claim);
        applied.push({ code: f.code, action: 'drop-claim', detail: claim.slice(0, 20) });
        continue;
      }
      const num = spec.numbers.find((n) => hit(where, n.value));
      if (num) {
        spec.numbers = spec.numbers.filter((n) => n !== num);
        applied.push({ code: f.code, action: 'drop-number', detail: num.value });
        continue;
      }
      const dropOrder = ['code', 'timeline', 'tree', 'notes', 'annotation', 'formula'];
      const next = dropOrder.find((kind) => (spec.structure?.modules || []).includes(kind));
      if (next) {
        spec.structure.modules = spec.structure.modules.filter((m) => m !== next);
        applied.push({ code: f.code, action: 'drop-module', detail: next });
        continue;
      }
      // 已经没模块可丢：把批注压到一条
      if (spec.claims.length > 1) {
        spec.claims = spec.claims.slice(0, 1);
        applied.push({ code: f.code, action: 'trim-claims', detail: String(spec.claims.length) });
      }
    }
  }

  // 修完再统一重算白名单（保证白名单与实际要画的字一致）
  if (applied.length) spec.visibleText = specVisibleText(spec).split('｜').filter(Boolean).slice(0, 3);
  return { spec, applied };
}

/** 结构候选：主图三选一 + 去掉某个模块的变体（用于「先发散后收敛」）。 */
export function coverCandidates({ content = {}, structure = {}, max = 4 } = {}) {
  const primaries = ['curve', 'pipeline', 'concept'];
  const hasNumbers = (content.numbers || []).length >= 2;
  const hasSteps = (content.steps || []).length >= 1;
  const usable = primaries.filter((p) => (p === 'curve' ? hasNumbers : p === 'pipeline' ? hasSteps : true));
  const base = usable.length ? usable : ['concept'];
  const out = [];
  for (const primary of base) {
    out.push({ ...structure, primary, reason: `${structure.reason || ''}`.trim() });
    if (out.length >= max) break;
  }
  // 还不到上限：再补一个「最简」候选（去掉全部可选模块）
  if (out.length < max) out.push({ ...structure, primary: base[0], modules: [] });
  return out.slice(0, Math.max(1, max));
}

/** 便捷入口：先建 spec，再用审计结果修一轮。 */
export function buildAndRepairSpec({ content, structure, width, height, footer, sourceUrl, findings = [] } = {}) {
  const spec = buildCoverSpec({ content, structure, width, height, footer, sourceUrl });
  return repairCoverSpec({ spec, findings });
}
