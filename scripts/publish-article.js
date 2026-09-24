#!/usr/bin/env node
/**
 * 把一次深度解读的产物发布到 public repo（GitHub Pages 形态）。
 *
 *   node scripts/publish-article.js --dir output/<id> [--repo <path>] [--dry-run|--yes]
 *        [--theme orange] [--number 004] [--force] [--push] [--pr]
 *
 * 不传 --repo 时按 PUBLIC_REPO_DIR → ~/Documents/qingke-public-pages 的顺序找仓库。
 *
 * 默认 **dry-run**：只打印将要写入的文件与首页入口，不落盘、不碰 git。
 * 真正写盘要 `--yes`；`--push` / `--pr` 才会碰远端（需要仓库凭证与用户明确同意）。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { applyPublish, planPublish, publishGitCommands } from '../src/publish/publicArticle.js';

const execFileP = promisify(execFile);

/** 默认发布仓库：命令行 --repo 与 PUBLIC_REPO_DIR 都没给时用它。 */
export const DEFAULT_REPO_DIR = path.join(os.homedir(), 'Documents', 'qingke-public-pages');

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      args._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const dir = args.dir || args._[0];
  if (!dir) {
    console.error('用法：node scripts/publish-article.js --dir output/<id> [--repo <public-repo>] [--yes] [--force] [--push] [--pr]');
    process.exit(2);
  }
  const repoDir = path.resolve(args.repo || process.env.PUBLIC_REPO_DIR || DEFAULT_REPO_DIR);
  if (!(await fs.stat(repoDir).then(() => true).catch(() => false))) {
    console.error(`发布仓库不存在：${repoDir}\n用 --repo <path> 或环境变量 PUBLIC_REPO_DIR 指定另一个仓库`);
    process.exit(2);
  }
  const abs = path.resolve(dir);
  const readIfExists = async (p) => fs.readFile(p, 'utf-8').catch(() => '');
  const markdown = await readIfExists(path.join(abs, 'deepread.md'));
  if (!markdown) {
    console.error(`没找到 ${path.join(abs, 'deepread.md')}（深度解读产物）`);
    process.exit(2);
  }
  const factCheck = await readIfExists(path.join(abs, 'deepread.fact-check.md'));
  const files = await fs.readdir(abs).catch(() => []);
  // cover.png 作为头图单独处理，不再混进正文配图列表
  const coverFile = files.find((f) => /^cover\.png$/i.test(f)) ? path.join(abs, 'cover.png') : null;
  // 手绘配图：由 `npm run figures` 生成的 figures/index.json 决定插入哪几节
  const figuresIndex = await fs
    .readFile(path.join(abs, 'figures', 'index.json'), 'utf-8')
    .then((s) => JSON.parse(s))
    .catch(() => null);
  const figures = (figuresIndex?.figures || [])
    .filter((f) => f.sectionTitle && f.file)
    .map((f) => ({ sectionTitle: f.sectionTitle, title: f.title, file: f.file, from: path.join(abs, 'figures', f.file) }));
  const images = files
    .filter((f) => /\.png$/i.test(f) && !/^cover\.png$/i.test(f))
    .sort()
    .map((f) => path.join(abs, f));

  const plan = await planPublish({
    repoDir,
    markdown: rewriteImageLinks(markdown),
    factCheckMarkdown: factCheck,
    sourceUrl: (markdown.match(/arxiv\.org\/abs\/(\d{4}\.\d{4,5})/) || [])[0] || '',
    theme: args.theme || 'orange',
    imageFiles: images,
    coverFile,
    figures,
    articleNumber: args.number || null,
    allowOverwrite: Boolean(args.force),
    generatedAt: new Date().toISOString().slice(0, 10),
  });

  const dryRun = !args.yes;
  console.log(`public repo: ${repoDir}`);
  console.log(`产物目录   : ${abs}`);
  console.log(`计划       : ${plan.summary}`);
  for (const w of plan.writes) console.log(`  - ${w.type} ${path.relative(repoDir, w.target)}`);
  if (plan.indexUpdate?.mode === 'marker') {
    console.log(`  - update ${path.relative(repoDir, plan.indexUpdate.path)}：在 ${plan.indexUpdate.marker} 后插入入口`);
  } else if (plan.indexUpdate?.mode === 'list') {
    console.log(`  - update ${path.relative(repoDir, plan.indexUpdate.path)}：插到文章列表末尾（最后一个 </ul> 之前）`);
  } else if (plan.indexUpdate?.mode === 'skip') {
    console.log(`  - 首页 ${path.relative(repoDir, plan.indexUpdate.path)} 无法自动定位插入点，跳过（不会瞎追加）`);
  }
  if (dryRun) {
    console.log('\n[dry-run] 未写入任何文件（加 --yes 才会落盘；--push / --pr 才会碰远端）');
    return 0;
  }

  const result = await applyPublish(plan, { dryRun: false });
  console.log(`\n已写入 ${plan.slug}/（${plan.writes.length} 个文件操作）`);
  if (result.index?.mode === 'marker' || result.index?.mode === 'list') {
    console.log(`首页入口已追加（mode=${result.index.mode}）`);
  } else if (result.index?.mode === 'skip') {
    console.log('首页未改动。请手动把下面这行粘到文章列表里：');
    console.log(result.index.snippet);
  }

  if (args.push || args.pr) {
    const cmds = publishGitCommands({ articleNumber: plan.articleNumber, title: plan.title, push: Boolean(args.push), pr: Boolean(args.pr) });
    for (const [bin, argv] of cmds) {
      console.log(`$ ${bin} ${argv.join(' ')}`);
      await execFileP(bin, argv, { cwd: repoDir });
    }
  } else {
    console.log('未触碰 git。需要建分支/提交时加 --push（推送并开 PR：--push --pr）。');
  }
  return 0;
}

/** 把正文里的本地图片引用改写成 public 形态 `images/xxx.png`。 */
export function rewriteImageLinks(markdown) {
  return String(markdown || '').replace(/!\[([^\]]*)\]\((?!https?:)([^)]+)\)/g, (m, alt, src) => {
    const base = path.basename(String(src).trim());
    return `![${alt}](images/${base})`;
  });
}

// 直接执行脚本时才跑 CLI；被 import（例如测试）时只暴露函数。
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      console.error('[publish] 失败：', (err && err.message) || err);
      process.exit(1);
    });
}
