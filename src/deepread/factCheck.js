/**
 * Fact Check（数字核验表）—— 迁移自青稞社区「技术解读稿件」规范里的 `fact-check.md`
 *
 * 目的：把「终稿里的每个数字都要能追溯条件和来源」变成**可核验产物**，而不是只靠模型自觉。
 * 规范要点（对齐 qingke-embodied-ai 的 references/article.md）：
 *   - 每个数字必须绑定「条件 + 来源位置 + 状态」，表外不得出现数字化 claim；
 *   - 事实 / 作者结论 / 本文判断分开句式；
 *   - 数字来源只有三态：source（原文可定位）/ derived（按论文数据计算，必须标注）/ unsupported（查不到）。
 *
 * 本模块只用确定性匹配（复刻 audit 的归一化口径），不调用模型、不引入新依赖。
 */

import { extractNumberTokens, normalizeNumberToken, numberValue, splitMarkdownSections } from './audit.js';

/** 明确标注「这是计算/换算」的措辞 —— 与 audit/provenance 同口径。 */
const DERIVED_MARKER =
  /按论文数据|按原文|换算|推算|折算|计算得|计算出来|两者相除|差值|由此可得|derived|per second|per frame|=\s*\d/i;

/** 句子切分（中英混排）。 */
function sentencesOf(text) {
  return String(text || '')
    .split(/(?<=[。！？!?;；])\s*|(?<=\.)\s+(?=[A-Z(\u4e00-\u9fff])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildChunkIndex(structure) {
  const map = new Map();
  for (const c of structure?.chunks || []) map.set(c.id, String(c.text || ''));
  return map;
}

/** 在原文 chunk 里找承载该数字的句子（作为「条件」），返回 {chunkIds, condition, source}。 */
function locateInSource(value, chunkIndex) {
  const key = normalizeNumberToken(value);
  const bare = key.replace(/[^\d.]/g, '');
  if (!bare) return { chunkId: '', condition: '', source: '' };
  for (const [id, text] of chunkIndex) {
    const tokens = extractNumberTokens(text);
    const hit = tokens.some((t) => {
      const tk = normalizeNumberToken(t);
      return tk === key || tk.replace(/[^\d.]/g, '') === bare;
    });
    if (!hit) continue;
    const sentence = sentencesOf(text).find((s) => extractNumberTokens(s).some((t) => normalizeNumberToken(t) === key || normalizeNumberToken(t).replace(/[^\d.]/g, '') === bare));
    return { chunkId: id, condition: (sentence || text).slice(0, 160), source: 'source' };
  }
  return { chunkId: '', condition: '', source: '' };
}

/**
 * 生成核验表。
 * @param {object} args
 * @param {string} args.markdown 终稿
 * @param {object} args.structure chunk 结构（用于回查原文）
 * @param {object} [args.ledger] Evidence Ledger（可选，用于标注该数字是否属于关键事实）
 * @returns {{rows:Array, stats:object, markdown:string}}
 */
export function buildFactCheck({ markdown, structure = null, ledger = null, maxRows = 80 } = {}) {
  const chunkIndex = buildChunkIndex(structure);
  const factNumbers = new Set();
  const factValues = new Set();
  for (const f of ledger?.facts || []) {
    for (const n of f.mustUseNumbers || []) {
      factNumbers.add(normalizeNumberToken(n.value));
      const v = numberValue(n.value);
      if (v != null) factValues.add(v);
    }
    for (const n of f.sourceNumbers || []) {
      factNumbers.add(normalizeNumberToken(n));
      const v = numberValue(n);
      if (v != null) factValues.add(v);
    }
  }
  // 终稿里的 token 常带单位后缀（41.8 → 41.8b，来自 audit 的数字口径），
  // 所以「是不是关键事实」既比对归一化 token，也比对数值本身。
  const isCritical = (value) => {
    if (factNumbers.has(normalizeNumberToken(value))) return true;
    const v = numberValue(value);
    return v != null && factValues.has(v);
  };

  const rows = [];
  // 只看正文小节（H1 标题节 + H2 小节）：H1 节里的是导语段落，H3 以下不单独成行。
  const sections = splitMarkdownSections(String(markdown || ''))
    .filter((s) => s.heading && s.level <= 2)
    .filter((s) => s.body && !/^```text[\s\S]*?```$/.test(s.body.trim()));
  for (const sec of sections) {
    for (const sentence of sentencesOf(sec.body)) {
      for (const value of extractNumberTokens(sentence)) {
        if (rows.length >= maxRows) break;
        const located = locateInSource(value, chunkIndex);
        const derivedMarked = DERIVED_MARKER.test(sentence);
        const status = located.source === 'source' ? 'source' : derivedMarked ? 'derived' : 'unsupported';
        const critical = isCritical(value);
        const dup = rows.find((r) => r.section === sec.heading && r.number === value);
        if (dup) {
          // 同一小节同一数字只留一行；只要任一次出现属于关键事实，就标成关键事实。
          if (critical) dup.critical = true;
          continue;
        }
        rows.push({
          section: sec.heading,
          number: value,
          condition: located.condition || (status === 'derived' ? sentence.slice(0, 160) : '（原文未找到对应句子）'),
          chunkIds: located.chunkId ? [located.chunkId] : [],
          critical,
          status,
        });
      }
    }
  }

  const locatedCount = rows.filter((r) => r.status === 'source').length;
  const derivedCount = rows.filter((r) => r.status === 'derived').length;
  const unsupportedCount = rows.filter((r) => r.status === 'unsupported').length;
  const stats = {
    numbers: rows.length,
    located: locatedCount,
    derived: derivedCount,
    unsupported: unsupportedCount,
    coverage: rows.length ? Number((locatedCount / rows.length).toFixed(4)) : null,
    unsupportedRate: rows.length ? Number((unsupportedCount / rows.length).toFixed(4)) : null,
  };
  return { rows, stats, markdown: renderFactCheckMarkdown({ rows, stats, title: '' }) };
}

/** 渲染成人读的 fact-check.md（对齐 qingke 的表格形态）。 */
export function renderFactCheckMarkdown({ rows = [], stats = {}, title = '' } = {}) {
  const lines = [];
  lines.push(`# ${title ? `${title} · ` : ''}数字核验表`);
  lines.push('');
  lines.push('用途：记录终稿中每个数字的来源位置与适用条件。**本表之外不应出现数字化 claim。**');
  lines.push('');
  lines.push(`核验方式：确定性回查原文切片（chunk）；三态 = source（原文可定位）/ derived（按论文数据计算，需正文标注）/ unsupported（原文查不到）。`);
  lines.push('');
  lines.push(`- 终稿数字总数：${stats.numbers ?? rows.length}`);
  lines.push(`- 可定位（source）：${stats.located ?? 0}`);
  lines.push(`- 推导（derived）：${stats.derived ?? 0}`);
  lines.push(`- **查不到（unsupported）：${stats.unsupported ?? 0}**${stats.unsupportedRate ? `（占 ${(stats.unsupportedRate * 100).toFixed(0)}%）` : ''}`);
  lines.push('');
  lines.push('| 小节 | 数字 | 条件 / 原文句子 | 来源 chunk | 关键事实 | 状态 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    const status = r.status === 'source' ? '✅' : r.status === 'derived' ? '🟡 derived' : '❌ unsupported';
    lines.push(
      `| ${String(r.section).replace(/\|/g, '\\|')} | ${r.number} | ${String(r.condition).replace(/\|/g, '\\|')} | ${(r.chunkIds || []).join(', ') || '-'} | ${r.critical ? '★' : '-'} | ${status} |`,
    );
  }
  if (!rows.length) lines.push('| - | - | - | - | - | - |');
  lines.push('');
  return lines.join('\n');
}
