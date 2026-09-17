#!/usr/bin/env node
/**
 * DeepRead Benchmark v1 runner
 *
 *   npm run benchmark                # 跑 benchmark/papers/ 下的全部论文
 *   npm run benchmark -- --limit 2   # 只跑前 2 篇
 *   npm run benchmark -- --papers 1706.03762,2406.09246
 *   npm run benchmark -- --dry-run   # 只校验 metadata，不调用模型
 *   npm run benchmark -- --resume    # 复用最近一次运行里已完成的论文，只补跑缺的
 *   npm run benchmark -- --update-baseline
 *
 * 设计要点：
 *   - 只读 benchmark/papers/*.json，运行结果写入 benchmark/runs/<timestamp>/
 *   - 每篇论文独立失败：单篇异常只影响自己（status=failed），不影响其它论文
 *   - 没有可用模型时明确 skipped + 提示需要哪个环境变量，进程仍以 0 退出（不会污染 npm test）
 *   - benchmark 结果不写死：所有指标都来自本次真实运行
 *   - 不下载/不提交论文文件：只按 arXiv URL 取源（缓存在 output/_arxivsrc，已被 .gitignore 忽略）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../src/config.js';
import { createProvider } from '../src/ai/index.js';
import { fetchArxivMeta } from '../src/arxiv.js';
import { fetchArxivSource } from '../src/arxivSource.js';
import { extractInstitution, extractTerms, parseIsoDate } from '../src/meta.js';
import {
  BENCHMARK_VERSION,
  aggregateMetrics,
  collectQualityNotes,
  compareWithBaseline,
  computeMetrics,
  entryFromResumedRecord,
  expectedSnapshot,
  loadPapers,
  pickResumableRecords,
  renderCliSummary,
  renderSummaryMarkdown,
  resolveProviderStatus,
} from '../src/deepread/benchmark.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BENCH_DIR = path.join(ROOT, 'benchmark');
const PAPERS_DIR = path.join(BENCH_DIR, 'papers');
const EXPECTED_DIR = path.join(BENCH_DIR, 'expected');
const RUNS_DIR = path.join(BENCH_DIR, 'runs');
const METRICS_DIR = path.join(BENCH_DIR, 'metrics');
const BASELINE_FILE = path.join(BENCH_DIR, 'baseline.json');

/** 简单参数解析：--key value / --flag。 */
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
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

/** 超时护栏：取源/模型都可能卡住（例如图片栅格化），不能让整轮 benchmark 挂死。 */
function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${Math.round(ms / 1000)}s）`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function ensureDirs() {
  await fs.mkdir(PAPERS_DIR, { recursive: true });
  await fs.mkdir(EXPECTED_DIR, { recursive: true });
  await fs.mkdir(RUNS_DIR, { recursive: true });
  await fs.mkdir(METRICS_DIR, { recursive: true });
}

/** 最近一次含论文结果的运行目录（--resume 用）。 */
async function latestRunDir() {
  let entries = [];
  try {
    entries = await fs.readdir(RUNS_DIR, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (let i = dirs.length - 1; i >= 0; i--) {
    const dir = path.join(RUNS_DIR, dirs[i]);
    try {
      const files = await fs.readdir(path.join(dir, 'papers'));
      if (files.some((f) => f.endsWith('.json'))) return dir;
    } catch {
      /* 该目录没有 papers/，继续往前找 */
    }
  }
  return null;
}

/** 读取一个运行目录里的全部论文记录（损坏记录忽略）。 */
async function readRunRecords(dir) {
  const paperDir = path.join(dir, 'papers');
  let files = [];
  try {
    files = (await fs.readdir(paperDir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(paperDir, f), 'utf8')));
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Ollama 可达性检查（5s）。 */
async function checkOllama(baseUrl) {
  try {
    const base = String(baseUrl).replace(/\/v1\/?$/, '');
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 组一篇论文的 source（与 server.js 的 deepread 一致，但不注入 memory 以保证可复现）。 */
function buildSource({ url, fetched, arxiv, withMemory }) {
  return {
    type: 'pdf',
    kind: fetched.kind,
    title: arxiv?.title || fetched.title || fetched.id,
    byline: arxiv?.authors || '',
    institution: extractInstitution(fetched.text || ''),
    date: arxiv?.published ? parseIsoDate(arxiv.published) : '',
    url,
    text: fetched.text || '',
    textLines: fetched.textLines || '',
    structure: fetched.structure || null,
    terms: extractTerms(fetched.text || ''),
    memory: withMemory ? undefined : '',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const runDir = path.join(RUNS_DIR, timestamp());

  await ensureDirs();

  const { papers, invalid } = loadPapers(PAPERS_DIR);
  const filter = typeof args.papers === 'string' ? new Set(args.papers.split(',').map((s) => s.trim())) : null;
  let selected = filter ? papers.filter((p) => filter.has(p.id)) : papers;
  if (args.limit) selected = selected.slice(0, Number(args.limit));

  const providerName = String(args.provider || process.env.BENCHMARK_PROVIDER || config.llmProvider || 'deepseek');
  const model = String(args.model || process.env.BENCHMARK_MODEL || '');
  const timeoutMs = Number(args['timeout-ms'] || process.env.BENCHMARK_TIMEOUT_MS || 20 * 60 * 1000);
  const withMemory = args.memory === true || process.env.BENCHMARK_MEMORY === '1';
  const updateBaseline = args['update-baseline'] === true || process.env.BENCHMARK_UPDATE_BASELINE === '1';
  const resumeWanted = args.resume === true || typeof args.resume === 'string' || process.env.BENCHMARK_RESUME === '1';

  console.log(`DeepRead Benchmark ${BENCHMARK_VERSION}`);
  console.log(`- 论文目录：${path.relative(ROOT, PAPERS_DIR)}（${papers.length} 篇可用${invalid.length ? `，${invalid.length} 篇 metadata 非法` : ''}）`);
  console.log(`- 本次运行：${selected.length} 篇${filter ? `（--papers ${[...filter].join(',')}）` : ''}`);
  console.log(`- Provider：${providerName}${model ? `（${model}）` : ''}`);

  if (args['dry-run']) {
    for (const p of selected) console.log(`  · ${p.id} [${p.category}] ${p.title}`);
    for (const bad of invalid) console.log(`  ! metadata 非法：${path.basename(bad.file)} → ${bad.errors.join('；')}`);
    console.log('\n--dry-run：仅校验 metadata，不调用模型、不写运行结果。');
    return 0;
  }

  // 断点续跑：复用上一次运行里已完成的论文（benchmark 一轮几十分钟，中断不该丢结果）
  const entries = [];
  let pendingPapers = selected;
  if (resumeWanted) {
    const fromDir = typeof args.resume === 'string' ? path.resolve(args.resume) : await latestRunDir();
    if (!fromDir) {
      console.log('\n--resume：没找到可复用的历史运行目录，本次照常全量运行。');
    } else {
      const records = await readRunRecords(fromDir);
      const { reusable, pending } = pickResumableRecords(records, selected.map((p) => p.id));
      if (reusable.length) {
        await fs.mkdir(path.join(runDir, 'papers'), { recursive: true });
        for (const record of reusable) {
          entries.push(entryFromResumedRecord(record));
          // 复用记录一并写进本次运行目录，保证 summary 与明细自洽
          await fs.writeFile(path.join(runDir, 'papers', `${record.id}.json`), JSON.stringify(record, null, 2));
        }
        console.log(
          `\n--resume：复用 ${path.relative(ROOT, fromDir)} 里已完成的 ${reusable.length} 篇（${reusable
            .map((r) => r.id)
            .join(', ')}），本次补跑 ${pending.length} 篇。`,
        );
      }
      pendingPapers = selected.filter((p) => pending.includes(p.id));
    }
  }

  // provider 可用性（没有模型 → 明确 skipped，不伪造结果）
  const apiKeyPresent =
    providerName === 'ollama' ? true : providerName === 'openai' ? !!config.openaiApiKey : !!config.deepseekApiKey;
  const ollamaReachable = providerName === 'ollama' ? await checkOllama(config.ollamaBaseUrl) : null;
  const providerStatus = resolveProviderStatus({ providerName, apiKeyPresent, ollamaReachable });

  let provider = null;
  let providerModel = model;
  if (!providerStatus.ok) {
    console.log(`\n⚠️  跳过全部论文：${providerStatus.reason}`);
    console.log(`    ${providerStatus.hint}`);
    for (const p of pendingPapers) {
      entries.push({ id: p.id, title: p.title, category: p.category, status: 'skipped', reason: providerStatus.reason });
    }
    pendingPapers = [];
  } else {
    try {
      provider = createProvider(providerName, model || undefined);
      providerModel = provider.model || model;
    } catch (err) {
      const reason = `provider 初始化失败：${err.message}`;
      console.log(`\n⚠️  ${reason}`);
      for (const p of pendingPapers) entries.push({ id: p.id, title: p.title, category: p.category, status: 'skipped', reason });
      pendingPapers = [];
    }
  }

  for (const bad of invalid) {
    entries.push({
      id: path.basename(bad.file, '.json'),
      title: '',
      category: '-',
      status: 'failed',
      stage: 'metadata',
      reason: bad.errors.join('；'),
    });
  }

  if (provider) {
    await fs.mkdir(path.join(runDir, 'papers'), { recursive: true });
    for (const paper of pendingPapers) {
      const t0 = Date.now();
      const stageTimes = {};
      let currentStage = 'start';
      const onProgress = (p) => {
        const stage = p?.stage || 'unknown';
        stageTimes[stage] = stageTimes[stage] || { firstAtMs: Date.now() - t0 };
        stageTimes[stage].lastAtMs = Date.now() - t0;
        if (stage !== currentStage) {
          currentStage = stage;
          process.stdout.write(`    · ${stage}${p?.detail ? ` — ${p.detail}` : ''}\n`);
        }
      };
      process.stdout.write(`\n▶ ${paper.id} [${paper.category}] ${paper.title}\n`);
      try {
        const arxiv = await fit(
          fetchArxivMeta(paper.url).catch(() => null),
          timeoutMs,
          `${paper.id} arXiv 元数据`,
        );
        const fetched = await withTimeout(
          fetchArxivSource(paper.url, (m) => process.stdout.write(`    [src] ${m}\n`)),
          timeoutMs,
          `${paper.id} 取源`,
        );
        const source = buildSource({ url: paper.url, fetched, arxiv, withMemory });
        const result = await withTimeout(
          provider.deepRead({ source, figures: fetched.figures || [], onProgress }),
          timeoutMs,
          `${paper.id} 深度解读`,
        );
        const { metrics, detail } = computeMetrics({ paper, result, structure: fetched.structure });
        const runtimeMs = Date.now() - t0;
        const record = {
          id: paper.id,
          title: paper.title,
          category: paper.category,
          url: paper.url,
          status: 'completed',
          provider: provider.name,
          model: provider.model || '',
          runtimeMs,
          source: {
            kind: fetched.kind,
            chars: (fetched.text || '').length,
            textLines: (fetched.textLines || '').length,
            figures: (fetched.figures || []).length,
            sections: fetched.structure?.sections?.length || 0,
            chunks: fetched.structure?.chunks?.length || 0,
          },
          pipeline: result.meta?.pipeline || (result.degraded ? 'legacy' : 'structured'),
          degraded: result.degraded === true,
          structure: result.meta?.structure || null,
          researchMapStatus: result.meta?.researchMapStatus || null,
          researchMapStats: result.meta?.researchMapStats || null,
          evidence: result.meta?.evidence || null,
          audit: result.audit || null,
          metrics,
          detail,
          warnings: result.meta?.warnings || [],
          stageTimes,
          markdownChars: (result.markdown || '').length,
          finishedAt: new Date().toISOString(),
        };
        await fs.writeFile(path.join(runDir, 'papers', `${paper.id}.json`), JSON.stringify(record, null, 2));
        await fs.writeFile(path.join(runDir, 'papers', `${paper.id}.md`), result.markdown || '');
        entries.push(record);
        process.stdout.write(
          `  ✓ 完成：${runtimeMs / 1000}s | coverage ${
            metrics.sourceCoverage == null ? 'n/a' : `${(metrics.sourceCoverage * 100).toFixed(0)}%`
          } | late ${metrics.latePaperCoverage == null ? 'n/a' : `${(metrics.latePaperCoverage * 100).toFixed(0)}%`}\n`,
        );
      } catch (err) {
        const record = {
          id: paper.id,
          title: paper.title,
          category: paper.category,
          url: paper.url,
          status: 'failed',
          stage: currentStage,
          reason: (err && err.message) || String(err),
          runtimeMs: Date.now() - t0,
        };
        entries.push(record);
        process.stdout.write(`  ✗ 失败（${record.stage}）：${record.reason}\n`);
      }
    }
  }

  const aggregate = aggregateMetrics(entries);
  const qualityNotes = collectQualityNotes(entries);
  const summary = {
    version: BENCHMARK_VERSION,
    startedAt,
    finishedAt: new Date().toISOString(),
    runDir: path.relative(ROOT, runDir),
    provider: provider?.name || providerName,
    model: providerModel || '',
    ...aggregate,
    qualityNotes,
    metrics: aggregate.metrics,
    papers: entries.map((e) => ({
      id: e.id,
      title: e.title,
      category: e.category,
      status: e.status,
      reason: e.reason || '',
      runtimeMs: e.runtimeMs || 0,
      degraded: e.degraded || false,
      resumed: e.resumed === true,
      pipeline: e.pipeline || '',
      researchMapStatus: e.researchMapStatus || null,
      researchMapStats: e.researchMapStats || null,
      metrics: e.metrics || null,
      lengthStability: e.metrics?.lengthStability ?? null,
      source: e.source || null,
    })),
  };

  // baseline：只在真的跑完至少一篇时才写；否则不产生任何 baseline
  if (summary.completed > 0) {
    let baseline = null;
    try {
      baseline = JSON.parse(await fs.readFile(BASELINE_FILE, 'utf8'));
    } catch {
      baseline = null;
    }
    if (baseline && !updateBaseline) {
      summary.comparison = compareWithBaseline({ metrics: summary.metrics }, baseline);
    }
    if (!baseline || updateBaseline) {
      await fs.writeFile(
        BASELINE_FILE,
        JSON.stringify(
          {
            version: BENCHMARK_VERSION,
            updatedAt: new Date().toISOString(),
            provider: summary.provider,
            model: summary.model,
            total: summary.total,
            completed: summary.completed,
            metrics: summary.metrics,
            papers: summary.papers
              .filter((p) => p.status === 'completed')
              .map((p) => ({ id: p.id, category: p.category, metrics: p.metrics })),
          },
          null,
          2,
        ),
      );
      console.log(`\n已${baseline ? '更新' : '写入'} baseline：${path.relative(ROOT, BASELINE_FILE)}`);
    }
  }

  // 运行产物
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  await fs.writeFile(path.join(runDir, 'README.md'), renderSummaryMarkdown(summary));

  // metrics/：每篇最新指标 + 追加历史
  for (const e of entries) {
    if (e.status !== 'completed') continue;
    await fs.writeFile(
      path.join(METRICS_DIR, `${e.id}.json`),
      JSON.stringify({ id: e.id, at: summary.finishedAt, provider: e.provider, model: e.model, metrics: e.metrics, detail: e.detail }, null, 2),
    );
  }
  await fs.appendFile(
    path.join(METRICS_DIR, 'history.jsonl'),
    `${JSON.stringify({
      at: summary.finishedAt,
      run: summary.runDir,
      provider: summary.provider,
      model: summary.model,
      total: summary.total,
      completed: summary.completed,
      skipped: summary.skipped,
      failed: summary.failed,
      metrics: summary.metrics,
    })}\n`,
  );

  // 锚点快照（人读 + diff 用）
  for (const p of papers) {
    await fs.writeFile(path.join(EXPECTED_DIR, `${p.id}.json`), JSON.stringify(expectedSnapshot(p), null, 2));
  }

  console.log('\n' + renderCliSummary(summary));
  console.log(`\n运行结果：${path.relative(ROOT, runDir)}/summary.json`);
  if (qualityNotes.length) {
    console.log('\nBenchmark 暴露的问题：');
    for (const n of qualityNotes) console.log(`  - ${n}`);
  }
  return 0;
}

/** 辅助：对返回 Promise 的函数做超时包装（允许失败）。 */
function fit(promise, ms, label) {
  return withTimeout(promise, ms, label);
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error('[benchmark] 致命错误：', (err && err.message) || err);
    process.exit(1);
  });
