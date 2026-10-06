#!/usr/bin/env node
/**
 * 封面审计 CLI：审任意已生成的封面 SVG（含 output/handdrawn 下的手工封面）。
 *
 *   node scripts/audit-cover.js --dir output/handdrawn                 # 审一整个目录
 *   node scripts/audit-cover.js --file output/handdrawn/bpo-cover.svg  # 审单张
 *   node scripts/audit-cover.js --dir output/handdrawn --md article.md # 追加「数字出处」核查
 *   node scripts/audit-cover.js --dir output/handdrawn --strict        # 有问题时退出码非 0（CI 可用）
 *   node scripts/audit-cover.js --dir output/handdrawn --json          # 机器可读结果
 *
 * 检查项见 src/cover/audit.js：越界 / 压字 / 字号 / 撑破面板 / 裸 LaTeX / emoji /
 * 渐变投影 / 调色板外颜色 / 数字出处。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditCover, formatFindings } from '../src/cover/audit.js';

export function parseArgs(argv) {
  const args = { _: [], file: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      args._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      if (key === 'file') args.file.push(next);
      else args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function collectSvgFiles(args) {
  const files = [...(args.file || [])];
  if (args.dir) {
    const entries = await fs.readdir(args.dir).catch(() => []);
    for (const name of entries) {
      if (!name.endsWith('.svg')) continue;
      files.push(path.join(args.dir, name));
    }
  }
  files.push(...(args._ || []));
  return [...new Set(files.map((f) => path.resolve(f)))];
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const files = await collectSvgFiles(args);
  if (!files.length) {
    console.error('用法：node scripts/audit-cover.js --dir output/handdrawn [--md article.md] [--strict] [--json]');
    return 2;
  }
  const markdown = args.md ? await fs.readFile(args.md, 'utf-8') : '';
  const minFontSize = Number(args['min-font'] || 11);
  const results = [];
  let errors = 0;
  let warns = 0;
  for (const file of files) {
    const svg = await fs.readFile(file, 'utf-8').catch(() => '');
    if (!svg) {
      results.push({ file, ok: false, findings: [{ level: 'error', code: 'file-unreadable', where: file, message: '读不到这个 SVG' }], summary: { errors: 1, warns: 0 } });
      errors += 1;
      continue;
    }
    const audit = auditCover({ svg, markdown, minFontSize });
    errors += audit.summary.errors;
    warns += audit.summary.warns;
    results.push({ file, ...audit });
  }

  if (args.json) {
    console.log(JSON.stringify({ ok: errors === 0, errors, warns, results }, null, 2));
  } else {
    for (const r of results) {
      const rel = path.relative(process.cwd(), r.file);
      const tag = r.findings.length ? (r.summary.errors ? '✗' : '!') : '✓';
      console.log(`${tag} ${rel}　文字 ${r.summary.texts}　面板 ${r.summary.panels}　错误 ${r.summary.errors} / 警告 ${r.summary.warns}`);
      for (const line of formatFindings(r.findings)) console.log(`    ${line.replace(/\n/g, '\n    ')}`);
    }
    console.log(`\n合计：${results.length} 张，错误 ${errors}，警告 ${warns}`);
  }

  if (args.strict && errors > 0) return 1;
  if (args['strict-all'] && errors + warns > 0) return 1;
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      console.error('[audit-cover] 失败：', (err && err.message) || err);
      process.exit(1);
    });
}
