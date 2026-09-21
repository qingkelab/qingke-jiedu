// 源码级噪声修复：arXiv HTML 的 MathML 同时含可见数字与 TeX 注释，
// textContent 会把两者首尾相接（41.0 + 41.0 → 41.041.0、N=6 → N=6N=6）。
// 这类粘连会污染检索/审计，并让「终稿数字能否在原文定位」误判成 unsupported。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaperStructure } from '../src/deepread/chunker.js';
import { assessFactInText, buildEvidenceLedger, checkSectionFactCoverage } from '../src/deepread/evidenceLedger.js';

/** 真实 arXiv HTML 的片段形态：<div class="ltx_para"> 包着 <p>，行内是带 annotation 的 MathML。 */
const ARXIV_LIKE_HTML = `
<html><body>
<section class="ltx_section">
  <h2 class="ltx_title ltx_title_section">3 Model Architecture</h2>
  <div class="ltx_para ltx_noindent">
    <p class="ltx_p">The encoder is composed of a stack of
      <math id="m1" class="ltx_Math" alttext="N=6" display="inline"><semantics><mrow><mi>N</mi><mo>=</mo><mn>6</mn></mrow><annotation encoding="application/x-tex">N=6</annotation></semantics></math>
      identical layers.</p>
  </div>
  <div class="ltx_para ltx_noindent">
    <p class="ltx_p">On the WMT 2014 English-to-French task our big model achieves a BLEU score of
      <math id="m2" class="ltx_Math" alttext="41.0" display="inline"><semantics><mn>41.0</mn><annotation encoding="application/x-tex">41.0</annotation></semantics></math>,
      outperforming all of the previously published single models.</p>
  </div>
</section>
</body></html>
`;

test('HTML 切片：行内公式不会把可见数字与 TeX 注释粘成 41.041.0 / N=6N=6', () => {
  const structure = buildPaperStructure({ kind: 'html', html: ARXIV_LIKE_HTML });
  const text = structure.chunks.map((c) => c.text).join('\n');
  assert.equal(/41\.041\.0/.test(text), false, `不应出现 41.041.0：${text}`);
  assert.equal(/N=6N=6/.test(text), false, `不应出现 N=6N=6：${text}`);
  // 公式本身要保留（LaTeX 形态），供检索与审计使用
  assert.match(text, /\$N=6\$/);
  assert.match(text, /\$41\.0\$/);
});

test('HTML 切片：公式仍单独成块（供公式审计命中）', () => {
  const structure = buildPaperStructure({ kind: 'html', html: ARXIV_LIKE_HTML });
  const formulas = structure.chunks.filter((c) => c.type === 'formula');
  assert.ok(formulas.length >= 2, `应有独立公式块，实际 ${formulas.length}`);
  assert.ok(formulas.some((c) => c.text.includes('N=6')));
});

test('数字定位：写「41.0 BLEU」不会被判成 unsupported（尾零 + 单位后缀要能对上）', () => {
  const structure = buildPaperStructure({ kind: 'html', html: ARXIV_LIKE_HTML });
  const section = '论文称 big model 取得 41.0 BLEU，超过此前所有已发表的单模型。';
  const fact = {
    id: 'cf-1',
    category: 'main_result',
    priority: 'high',
    claim: 'Our big model achieves a BLEU score of 41.0 on WMT 2014 English-to-French.',
    chunkIds: structure.chunks.map((c) => c.id),
    mustUseTerms: ['bleu'],
    sourceNumbers: [],
  };
  const ledger = buildEvidenceLedger({
    paperId: 'probe',
    researchMap: { main_results: [{ text: 'BLEU 41.0', chunkIds: ['c1'] }] },
    criticalFacts: [fact],
    plan: [{ title: '实验', role: 'results', sourceSections: [], mustUseTerms: [] }],
    retrievalResults: [],
    structure,
  });
  const built = ledger.facts[0];
  const assessed = assessFactInText(built, section, {
    structure,
    paperNumbers: ledger.paperNumbers,
    paperValues: ledger.paperValues,
  });
  assert.deepEqual(assessed.unsupportedNumbers, [], `不该有 unsupported：${JSON.stringify(assessed)}`);
  assert.equal(assessed.status, 'covered');
});

test('覆盖率统计：BLEU 类数字不会把 writerFactCoverage 压成 0', () => {
  const structure = buildPaperStructure({ kind: 'html', html: ARXIV_LIKE_HTML });
  const section = '论文称 big model 取得 41.0 BLEU，解码器堆叠 6 层。';
  const ledger = buildEvidenceLedger({
    paperId: 'probe',
    researchMap: { main_results: [{ text: 'BLEU 41.0', chunkIds: ['c1'] }] },
    criticalFacts: [
      {
        id: 'cf-1',
        category: 'main_result',
        priority: 'high',
        claim: 'The big model achieves a BLEU score of 41.0 on WMT 2014 English-to-French.',
        chunkIds: structure.chunks.map((c) => c.id),
        mustUseTerms: ['bleu'],
        sourceNumbers: [],
      },
    ],
    plan: [{ title: '实验', role: 'results', sourceSections: [], mustUseTerms: [] }],
    retrievalResults: [],
    structure,
  });
  assert.ok(ledger.facts.length >= 1, '应至少有 1 条事实');
  const coverage = checkSectionFactCoverage({
    ledger: { ...ledger, facts: ledger.facts.map((f) => ({ ...f, writerSections: ['实验'] })) },
    markdownBySection: { 实验: section },
    structure,
  });
  assert.ok(coverage.stats.assigned >= 1);
  assert.equal(coverage.stats.unsupported, 0, `不该判 unsupported：${JSON.stringify(coverage.stats)}`);
  assert.ok(coverage.stats.coverage > 0, `覆盖率不应为 0：${JSON.stringify(coverage.stats)}`);
});
