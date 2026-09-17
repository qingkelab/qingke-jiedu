// 前端进度文案：保证新增的深度解读阶段（chunking/research_map/retrieval/audit/repair/finalize）
// 都能映射成用户可读的提示，而不是落到「处理中…」。
import fs from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');

async function loadApp() {
  const html = await fs.readFile(path.join(root, 'public/index.html'), 'utf-8');
  const appJs = await fs.readFile(path.join(root, 'public/app.js'), 'utf-8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  // 打桩网络与 SSE：只验证前端逻辑，不产生真实请求
  dom.window.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  dom.window.EventSource = class {
    addEventListener() {}
    close() {}
  };
  dom.window.eval(appJs);
  return dom.window;
}

test('深度解读各阶段都有可读提示', async () => {
  const win = await loadApp();
  const f = win.deepStageText;
  assert.equal(typeof f, 'function', 'deepStageText 应对页面可用');

  const cases = [
    [{ stage: 'fetch' }, /抓取/],
    [{ stage: 'chunking', detail: '全文切片完成：25 节 / 185 chunks / 40960 字' }, /185 chunks/],
    [{ stage: 'research_map', detail: '研究地图：模型产出（主张 6 / 结果 8）' }, /研究地图/],
    [{ stage: 'retrieval', detail: '已从 185 个切片中为 7 节召回 78 条证据' }, /召回 78 条证据/],
    [{ stage: 'plan', detail: '大纲 7 节' }, /大纲/],
    [
      { stage: 'section', section: { index: 3, total: 7, title: '注意力才是主角' }, detail: '检索到 12 条证据' },
      /第 3\/7 节：注意力才是主角（检索到 12 条证据）/,
    ],
    [{ stage: 'audit', detail: '证据审计通过' }, /证据审计通过/],
    [{ stage: 'repair', detail: '按审计结果定点修复 1 节…' }, /定点修复/],
    [{ stage: 'finalize', detail: '成稿 10448 字' }, /10448 字/],
  ];
  for (const [payload, expect] of cases) {
    const text = f(payload);
    assert.match(text, expect, `${payload.stage} 的提示应可读：${text}`);
    assert.notEqual(text, '处理中…', `${payload.stage} 不应落到兜底文案`);
  }
});

test('证据审计面板能展示切片规模与各项审计结论', async () => {
  const win = await loadApp();
  assert.equal(typeof win.renderDeepAudit, 'function');
  win.renderDeepAudit({
    pipeline: 'structured',
    structure: { sectionCount: 25, chunkCount: 185, chars: 40960 },
    audit: {
      checks: [
        { name: 'numbers', status: 'pass', detail: '67 个数字全部可追溯' },
        { name: 'limitation', status: 'warn', detail: '原文有局限' },
      ],
      stats: { numbers: 67, formulas: 12 },
    },
  });
  const el = win.document.querySelector('#deep-audit');
  assert.equal(el.hidden, false);
  assert.match(el.textContent, /185 chunks/);
  assert.match(el.textContent, /numbers·通过/);
  assert.match(el.textContent, /limitation·提示/);
});
