#!/usr/bin/env node
/**
 * 生成「手绘技术研究笔记」风格头图。
 *
 *   node scripts/make-cover.js --dir output/<id>                 # 海报（1200×1600）
 *   node scripts/make-cover.js --dir output/<id> --ratio wide     # 宽版头图（1600×900）
 *   node scripts/make-cover.js --md article.md --out cover        # 直接指定 Markdown
 *   node scripts/make-cover.js --dir output/<id> --svg-only       # 只出 SVG（不需要 Chrome）
 *   node scripts/make-cover.js --dir output/<id> --no-font         # 不内联手写字体（SVG 更小，走系统字体）
 *   node scripts/make-cover.js --dir output/<id> --json           # 打印提炼结果与视觉结构
 *
 * 默认写出 <dir>/cover.svg（矢量）与 <dir>/cover.png（需要本机 Chrome 栅格化）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COVER_RATIOS, buildCoverPng } from '../src/cover/index.js';

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

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const dir = args.dir || args._[0];
  const mdPath = args.md || (dir ? path.join(dir, 'deepread.md') : '');
  if (!mdPath) {
    console.error('用法：node scripts/make-cover.js --dir output/<id> [--ratio poster|wide|square] [--out cover] [--scale 2] [--svg-only] [--no-font] [--json]');
    return 2;
  }
  const markdown = await fs.readFile(mdPath, 'utf-8').catch(() => '');
  if (!markdown) {
    console.error(`没找到 Markdown：${mdPath}`);
    return 2;
  }
  let meta = null;
  if (dir) {
    meta = await fs
      .readFile(path.join(dir, 'deepread.audit.json'), 'utf-8')
      .then((s) => JSON.parse(s)?.meta || null)
      .catch(() => null);
  }

  const ratio = args.ratio || 'poster';
  const scale = Number(args.scale || 2);
  const built = await buildCoverPng({
    markdown,
    meta,
    ratio,
    scale,
    sourceUrl: args.source || '',
    embedFont: args['no-font'] !== true,
  });

  const base = args.out || (dir ? path.join(dir, 'cover') : 'cover');
  const svgPath = path.join(path.dirname(base), `${path.basename(base).replace(/\.(svg|png)$/, '')}.svg`);
  const pngPath = svgPath.replace(/\.svg$/, '.png');
  await fs.mkdir(path.dirname(svgPath), { recursive: true });
  await fs.writeFile(svgPath, built.svg, 'utf-8');
  if (built.png && !args['svg-only']) await fs.writeFile(pngPath, built.png);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          size: `${built.width}x${built.height}`,
          structure: built.structure,
          title: built.content.title,
          subtitle: built.content.subtitle,
          numbers: built.content.numbers,
          tags: built.content.tags,
          steps: built.content.steps.length,
          claims: built.content.claims.length,
        },
        null,
        2,
      ),
    );
  }
  console.log(`视觉结构：${built.structure.primary}（${built.structure.reason}）`);
  console.log(`尺寸：${built.width}×${built.height}（${COVER_RATIOS[ratio] ? ratio : 'custom'}）`);
  console.log(`手写字体：${built.fontEmbedded ? '已按用字内联（霞鹜文楷 Lite / OFL）' : '未内联（退回系统字体栈）'}`);
  console.log(`已写出：${svgPath}${built.png && !args['svg-only'] ? `\n         ${pngPath}` : '（未栅格化 PNG）'}`);
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      console.error('[cover] 失败：', (err && err.message) || err);
      process.exit(1);
    });
}
