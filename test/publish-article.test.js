// 发布到 public repo（GitHub Pages 形态）：编号 / HTML / 写操作清单 / dry-run / git 命令。
// 全部在临时目录里跑，不碰真实仓库、不碰远端。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyPublish,
  buildPublicHtml,
  nextArticleNumber,
  planPublish,
  planIndexUpdate,
  protectMarkdownMath,
  publishGitCommands,
  summaryOf,
  titleOf,
} from '../src/publish/publicArticle.js';
import { parseArgs, rewriteImageLinks } from '../scripts/publish-article.js';
import { markdownToHtml } from '../src/markdown.js';

const MARKDOWN = [
  '# LoopFormer：把循环状态写进 KV 缓存',
  '',
  '导语段落。',
  '',
  '## 结果',
  '',
  'BLEU 41.8（WMT14 英德，Transformer-base 基线）。',
  '',
  '![架构图](output/abc/1.png)',
  '',
].join('\n');

async function tmpRepo(files = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return dir;
}

test('publish：从 Markdown 一级标题取文章标题，缺失时回落', () => {
  assert.equal(titleOf(MARKDOWN), 'LoopFormer：把循环状态写进 KV 缓存');
  assert.equal(titleOf('没有标题的正文'), '未命名解读');
});

test('publish：编号 = 已有 article/NNN 最大值 +1；空仓库从 001 开始', async () => {
  const empty = await tmpRepo();
  assert.equal(await nextArticleNumber(empty), '001');

  const used = await tmpRepo({
    'article/001/index.html': 'a',
    'article/007/index.html': 'b',
    'article/003/index.html': 'c',
  });
  assert.equal(await nextArticleNumber(used), '008', '取最大值而不是数量');
});

test('publish：`--number` 指定编号时不覆盖已有文章（编号由调用方负责）', async () => {
  const repo = await tmpRepo({ 'article/001/index.html': 'a' });
  const plan = await planPublish({ repoDir: repo, markdown: MARKDOWN, articleNumber: '005' });
  assert.equal(plan.articleNumber, '005');
  assert.equal(plan.slug, 'article/005');

  // 撞到已发布的编号：默认拒绝，而不是覆盖
  await assert.rejects(
    planPublish({ repoDir: repo, markdown: MARKDOWN, articleNumber: '001' }),
    /已存在/,
  );
  const forced = await planPublish({ repoDir: repo, markdown: MARKDOWN, articleNumber: '001', allowOverwrite: true });
  assert.equal(forced.articleNumber, '001');
});

test('publish：HTML 自包含（内联样式、无外链脚本），正文与核验表都在', () => {
  const html = buildPublicHtml({
    title: '测试标题',
    markdown: MARKDOWN,
    articleNumber: '004',
    sourceUrl: 'https://arxiv.org/abs/1706.03762',
    factCheckMarkdown: '# 数字核验表\n\n| 数字 | 状态 |\n| --- | --- |\n| 41.8 | ✅ |\n',
    generatedAt: '2026-09-21',
  });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<style>/);
  assert.equal(/<script/i.test(html), false, '不应引入脚本（自包含且更安全）');
  assert.equal(/https?:\/\/(?!arxiv\.org)/.test(html), false, '除原文链接外不应有外链资源');
  assert.match(html, /id="article-004"/);
  assert.match(html, /数字核验表/);
  assert.match(html, /41\.8/);
});

test('publish：HTML 转义标题，避免注入', () => {
  const html = buildPublicHtml({ title: '<img src=x onerror=alert(1)>', markdown: '# x', articleNumber: '001' });
  assert.equal(html.includes('<img src=x'), false);
  assert.match(html, /&lt;img src=x/);
});

test('publish：planPublish 只规划不落盘，写操作清单可审阅', async () => {
  const repo = await tmpRepo({ 'index.html': '<ul>\n<!-- articles -->\n</ul>\n' });
  const plan = await planPublish({
    repoDir: repo,
    markdown: MARKDOWN,
    factCheckMarkdown: '# 数字核验表',
    imageFiles: ['/tmp/1.png', '/tmp/2.png'],
  });
  assert.equal(plan.articleNumber, '001');
  const kinds = plan.writes.map((w) => w.type);
  assert.deepEqual(kinds.slice(0, 2), ['mkdir', 'write']);
  assert.equal(plan.writes.filter((w) => w.type === 'copy').length, 2);
  assert.ok(plan.indexUpdate, '首页存在时应生成入口更新');
  assert.equal(plan.indexUpdate.mode, 'marker');
  assert.match(plan.indexUpdate.entry, /article\/001\//);
  // 关键：规划阶段不能写任何东西
  await assert.rejects(fs.stat(path.join(repo, 'article', '001', 'index.html')));
});

test('publish：dry-run 默认不落盘，--yes 才写文件并追加首页入口', async () => {
  const repo = await tmpRepo({ 'index.html': '<ul>\n<!-- articles -->\n</ul>\n' });
  const plan = await planPublish({ repoDir: repo, markdown: MARKDOWN, imageFiles: [] });

  const dry = await applyPublish(plan, { dryRun: true });
  assert.equal(dry.applied, false);
  await assert.rejects(fs.stat(path.join(repo, 'article')));

  const done = await applyPublish(plan, { dryRun: false });
  assert.equal(done.applied, true);
  assert.equal(done.index.updated, true);
  assert.equal(done.index.mode, 'marker');
  const html = await fs.readFile(path.join(repo, 'article', '001', 'index.html'), 'utf-8');
  assert.match(html, /LoopFormer/);
  const index = await fs.readFile(path.join(repo, 'index.html'), 'utf-8');
  assert.match(index, /<!-- articles -->\n\s*<li><a href="\.\/article\/001\/">/);
});

test('publish：没有 marker 但有 </ul> 时插到列表末尾（兼容卡片式首页）', async () => {
  const repo = await tmpRepo({
    'article/001/index.html': '旧文章',
    'index.html': [
      '<main>',
      '<h2>文章</h2>',
      '<ul>',
      '  <li><a class="card" href="article/001/"><span class="card-title">旧文章</span></a></li>',
      '</ul>',
      '<footer>版权</footer>',
      '</main>',
    ].join('\n'),
  });
  const plan = await planPublish({ repoDir: repo, markdown: MARKDOWN });
  assert.equal(plan.indexUpdate.mode, 'list');
  assert.match(plan.indexUpdate.entry, /class="card"/, '仓库用卡片样式就跟着用卡片');
  await applyPublish(plan, { dryRun: false });
  const index = await fs.readFile(path.join(repo, 'index.html'), 'utf-8');
  const posOld = index.indexOf('旧文章');
  const posNew = index.indexOf('article/002/');
  const posUl = index.lastIndexOf('</ul>');
  const posFooter = index.indexOf('<footer>');
  assert.ok(posOld < posNew, '新入口排在旧文章之后');
  assert.ok(posNew < posUl, '新入口必须落在 </ul> 之前（不能被追加到页面末尾）');
  assert.ok(posUl < posFooter, 'footer 结构未被破坏');
});

test('publish：既没有 marker 也没有 </ul> 时不改首页，只交还片段（绝不瞎追加）', async () => {
  const repo = await tmpRepo({ 'index.html': '<main><p>暂无文章</p></main>\n' });
  const plan = await planPublish({ repoDir: repo, markdown: MARKDOWN });
  assert.equal(plan.indexUpdate.mode, 'skip');
  const before = await fs.readFile(path.join(repo, 'index.html'), 'utf-8');
  const res = await applyPublish(plan, { dryRun: false });
  assert.equal(res.index.updated, false);
  assert.match(res.index.snippet, /article\/001\//);
  assert.equal(await fs.readFile(path.join(repo, 'index.html'), 'utf-8'), before, '首页必须原样不动');
});

test('publish：summaryOf 取正文第一段作为首页描述，跳过标题与图片行', () => {
  assert.equal(summaryOf(MARKDOWN), '导语段落。');
  assert.equal(summaryOf('![img](a.png)\n\n# 标题\n\n正文一段'), '正文一段');
});

test('publish：summaryOf 跳过文首出处块（代码块），不把「作者：xxx」当描述', () => {
  const md = ['```text', '作者：Ashish Vaswani', 'arXiv：https://arxiv.org/abs/1706.03762', '```', '', '# Attention Is All You Need', '', '这篇论文把注意力机制变成唯一构件。'].join('\n');
  assert.equal(summaryOf(md), '这篇论文把注意力机制变成唯一构件。');
});

test('publish：planIndexUpdate 在首页不存在时返回 null', async () => {
  const repo = await tmpRepo();
  assert.equal(await planIndexUpdate({ indexPath: path.join(repo, 'index.html'), slug: 'article/001', title: 't' }), null);
});

test('publish：图片按 basename 复制到 images/，不保留本地路径', async () => {
  const repo = await tmpRepo({ 'index.html': '<ul></ul>' });
  const imgDir = await tmpRepo({ '1.png': 'PNG-A', '2.png': 'PNG-B' });
  const plan = await planPublish({
    repoDir: repo,
    markdown: MARKDOWN,
    imageFiles: [path.join(imgDir, '1.png'), path.join(imgDir, '2.png')],
  });
  await applyPublish(plan, { dryRun: false });
  assert.equal(await fs.readFile(path.join(repo, 'article', '001', 'images', '1.png'), 'utf-8'), 'PNG-A');
});

test('publish：没有 index.html 时不硬造首页（indexUpdate = null）', async () => {
  const repo = await tmpRepo();
  const plan = await planPublish({ repoDir: repo, markdown: MARKDOWN });
  assert.equal(plan.indexUpdate, null);
  await applyPublish(plan, { dryRun: false });
  assert.equal(await fs.readFile(path.join(repo, 'article', '001', 'index.html'), 'utf-8').then(() => true), true);
});

test('publish：默认只给 git 命令、不 push 不建 PR', () => {
  const cmds = publishGitCommands({ articleNumber: '001', title: '测试' });
  const flat = cmds.map(([bin, argv]) => [bin, ...argv].join(' '));
  assert.deepEqual(flat, [
    'git checkout -b article/001',
    'git add article/001 index.html',
    'git commit -m article(001): 测试',
  ]);
  assert.equal(flat.some((c) => c.includes('push')), false);
  assert.equal(flat.some((c) => c.startsWith('gh ')), false);
});

test('publish：显式 --push / --pr 才追加远端动作', () => {
  const cmds = publishGitCommands({ articleNumber: '002', title: 't', push: true, pr: true });
  const flat = cmds.map(([bin, argv]) => [bin, ...argv].join(' '));
  assert.ok(flat.includes('git push -u origin article/002'));
  assert.ok(flat.includes('gh pr create --fill --base main'));
});

test('publish：rewriteImageLinks 把本地图片改写成 public 相对路径，外链保持原样', () => {
  const md = ['![a](output/abc/1.png)', '![b](./deep read 2.png)', '![c](https://x.test/y.png)'].join('\n');
  const out = rewriteImageLinks(md);
  assert.match(out, /!\[a\]\(images\/1\.png\)/);
  assert.match(out, /!\[b\]\(images\/deep read 2\.png\)/);
  assert.match(out, /!\[c\]\(https:\/\/x\.test\/y\.png\)/);
});

test('publish：CLI 参数解析支持 --dir/--repo/--yes/--push/--pr', () => {
  const args = parseArgs(['--dir', 'output/x', '--repo', '/tmp/repo', '--yes', '--push']);
  assert.equal(args.dir, 'output/x');
  assert.equal(args.repo, '/tmp/repo');
  assert.equal(args.yes, true);
  assert.equal(args.push, true);
  assert.equal(args.pr, undefined);
});

// ============ 公式：发布页必须渲染成数学，而不是灰色等宽字 ============

const MATH_MD = [
  '# 公式测试',
  '',
  '行内 $h_t = \\alpha \\odot h_{t-1}$ 出现在这里。',
  '',
  '$$\\mathrm{LayerNorm}(x + \\mathrm{Sublayer}(x))$$',
  '',
  '```js',
  'const price = "$100";',
  '```',
].join('\n');

test('publish：Markdown 里的公式被保护并渲染成 MathML，代码里的 $ 不动', () => {
  const guard = protectMarkdownMath(MATH_MD);
  assert.equal(guard.count, 2, '应识别 1 个行内 + 1 个块级公式');
  assert.equal(/\$\$/.test(guard.markdown), false, '原 Markdown 里不该再有 $$');
  const html = guard.restore(markdownToHtml(guard.markdown, 'orange'));
  assert.match(html, /<math/);
  assert.match(html, /<msub>/, '行内公式保留下标结构');
  assert.match(html, /math-block/, '块级公式单独成块');
  assert.match(html, /const price = "\$100";/, '代码块原样保留');
  const outside = html.replace(/<annotation[\s\S]*?<\/annotation>/g, '');
  assert.equal(/\\alpha|\\odot|\\mathrm/.test(outside), false, '渲染部分不该残留 LaTeX');
});

test('publish：文章页自包含（MathML 无外链），且带公式样式', () => {
  const html = buildPublicHtml({ title: 'T', markdown: MATH_MD, articleNumber: '001' });
  assert.match(html, /<math/);
  assert.equal(html.includes('$$'), false);
  assert.match(html, /\.math-block \{/);
  assert.equal(/katex\.min\.(css|js)|cdn\.jsdelivr/.test(html), false, '不需要引 CDN（MathML 原生渲染）');
});
