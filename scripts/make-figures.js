#!/usr/bin/env node
/**
 * 生成文章配图（手绘重述，一节一张）。
 *
 *   node scripts/make-figures.js --dir output/<id>            # 海报同款手绘风，横版 1200×660
 *   node scripts/make-figures.js --dir output/<id> --max 4    # 最多 4 张
 *   node scripts/make-figures.js --dir output/<id> --svg-only # 只出 SVG（不需要 Chrome）
 *
 * 产物：<dir>/figures/figure-01.svg|png … + figures/index.json（小节标题 → 文件名/结构）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSectionFigures, buildSectionFigurePngs } from '../src/cover/index.js';

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
  const mdPath = args.md || (dir ? path.join(dir, 'deepread.md') : '');
  if (!mdPath) {
    console.error('用法：node scripts/make-figures.js --dir output/<id> [--max 6] [--svg-only]');
    return 2;
  }
  const markdown = await fs.readFile(mdPath, 'utf-8').catch(() => '');
  if (!markdown) {
    console.error(`没找到 Markdown：${mdPath}`);
    return 2;
  }
  const max = Number(args.max || 6);
  const figures = args['svg-only']
    ? await buildSectionFigures({ markdown, max })
    : await buildSectionFigurePngs({ markdown, max });
  if (!figures.length) {
    console.error('没有可用的小节（每节正文需 ≥160 字）');
    return 1;
  }

  const outDir = args.out ? path.resolve(args.out) : path.join(path.dirname(mdPath), 'figures');
  await fs.mkdir(outDir, { recursive: true });
  const index = [];
  for (const fig of figures) {
    const base = `figure-${String(fig.index).padStart(2, '0')}`;
    await fs.writeFile(path.join(outDir, `${base}.svg`), fig.svg, 'utf-8');
    if (fig.png) await fs.writeFile(path.join(outDir, `${base}.png`), fig.png);
    index.push({
      index: fig.index,
      sectionTitle: fig.sectionTitle,
      title: fig.distilled.title,
      structure: fig.distilled.primary,
      numbers: fig.distilled.numbers.length,
      svg: `${base}.svg`,
      png: fig.png ? `${base}.png` : null,
      file: fig.png ? `${base}.png` : `${base}.svg`,
    });
    console.log(
      `  · ${base} ${fig.distilled.primary.padEnd(9)} ← ${fig.distilled.title.slice(0, 24)}（数字 ${fig.distilled.numbers.length}）`,
    );
  }
  await fs.writeFile(
    path.join(outDir, 'index.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), dir: path.basename(outDir), figures: index }, null, 2),
    'utf-8',
  );
  console.log(`共 ${figures.length} 张手绘配图 → ${outDir}${figures[0].png ? '' : '（未栅格化 PNG）'}`);
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      console.error('[figures] 失败：', (err && err.message) || err);
      process.exit(1);
    });
}
