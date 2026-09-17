# DeepRead Benchmark v1

「论文深度解读」的质量基准测试。目标是把 DeepRead 从「功能测试通过」升级到
**可以持续衡量真实论文解读质量**：给一篇长论文，它到底有没有读到后半篇的实验、消融、局限和公式。

> **它衡量的是「证据覆盖 + 结构完整性」，不是对文章文学质量的绝对评分。**
> 第一版刻意不用 LLM judge：所有指标都由确定性匹配算出，可复现、可比对、可进 CI。

## 目录结构

```text
benchmark/
  README.md            ← 本文档
  papers/              ← 论文清单 + 关键事实锚点（人工定义，进 git）
  expected/            ← 锚点归一化快照（每次运行自动生成，便于 diff 与人工核对）
  runs/<timestamp>/    ← 每次运行：summary.json / README.md / papers/<id>.json + .md
  metrics/             ← 每篇论文最新指标 metrics/<id>.json + 追加式 metrics/history.jsonl
  baseline.json        ← 当前 baseline（只在真实跑完至少一篇时生成，绝不伪造）
```

论文 PDF / HTML **不进 git**：`papers/` 只存 id / URL / metadata，运行时按 URL 取源，
缓存落在 `output/_arxivsrc/`（已被 `.gitignore` 忽略）。

## 快速开始

```bash
npm run benchmark -- --dry-run         # 只校验 metadata，不调用模型
npm run benchmark                      # 跑全部 seed 论文（用 .env 里的 provider）
npm run benchmark -- --limit 1         # 只跑第 1 篇（冒烟用）
npm run benchmark -- --papers 1706.03762,2406.09246
npm run benchmark -- --provider ollama # 用本地模型（需要 Ollama 在跑）
npm run benchmark -- --update-baseline # 跑完把结果写成新 baseline
```

可用参数 / 环境变量：

| 参数 | 环境变量 | 说明 |
| --- | --- | --- |
| `--provider` | `BENCHMARK_PROVIDER` | `deepseek` / `openai` / `ollama`，默认取 `.env` 的 `LLM_PROVIDER` |
| `--model` | `BENCHMARK_MODEL` | 覆盖模型名 |
| `--papers` | – | 逗号分隔的论文 id |
| `--limit` | – | 只跑前 N 篇 |
| `--timeout-ms` | `BENCHMARK_TIMEOUT_MS` | 单篇超时（默认 20 分钟） |
| `--memory` | `BENCHMARK_MEMORY=1` | 注入历史记忆（默认关闭，保证可复现） |
| `--update-baseline` | `BENCHMARK_UPDATE_BASELINE=1` | 覆盖 baseline |
| `--dry-run` | – | 只校验 metadata |

**没有模型配置时**：每篇论文标记 `skipped`，打印需要哪个环境变量（如 `DEEPSEEK_API_KEY`），
进程仍以 `0` 退出——不会伪造结果，也不会让 CI 挂掉。

## 如何添加论文

在 `benchmark/papers/` 新建 `<arxiv-id>.json`：

```json
{
  "id": "1706.03762",
  "title": "Attention Is All You Need",
  "category": "LLM",
  "url": "https://arxiv.org/abs/1706.03762",
  "expectedSections": ["Introduction", "Model Architecture", "Results"],
  "expectedEvidence": [
    {
      "type": "main_result",
      "text": "WMT 2014 英德任务 28.4 BLEU",
      "keywords": ["BLEU", "WMT 2014"],
      "numbers": ["28.4"]
    }
  ],
  "expectedFigures": [{ "num": 1, "captionKeywords": ["model architecture"] }],
  "expectedFormulas": [{ "text": "缩放点积注意力", "keywords": ["softmax", "sqrt"] }],
  "expectedAblations": [
    { "type": "ablation", "text": "标签平滑", "keywords": ["label smoothing"], "numbers": ["0.1"] }
  ],
  "expectedLimitations": [
    { "type": "limitation", "text": "复杂度代价", "keywords": ["complexity"] }
  ]
}
```

规则：

- 必填：`id` / `title` / `url`（`url` 必须是 http(s)）。
- **只定义少量「关键事实锚点」**，不要穷举全文：每篇 3–5 条 evidence、1–3 条 ablation / limitation 就够。
- 锚点必须能**在原文里找到**（写之前先看原文），否则覆盖率的定义就失去意义。
- 建议至少留一条**后半篇锚点**（出现在原文 50% 之后），这样 `latePaperCoverage` 才有区分度。
- **关键词写「中英双语」**：终稿是中文，术语可能保留英文原词（如 M-RoPE / LoRA），也可能写成中文
  （如「消融」「局限」「成分句法」）。同一个事实把两种写法都写进 `keywords`，避免因为语言对不上
  把「其实讲到了」误判成没覆盖。第一版实测就踩过这个坑：英文关键词在中文终稿上出现假阴性。
- metadata 写坏不会让整轮失败：该篇标记 `failed (metadata)`，其余论文继续。

### 锚点字段

| 字段 | 说明 |
| --- | --- |
| `type` | `main_result` / `method` / `ablation` / `limitation` / 自定义，仅用于报告 |
| `text` | 给人看的一句话描述 |
| `keywords` | 字符串数组，判定「终稿是否讲到」：命中比例 ≥ 50% 算覆盖（`strict: true` 要求全中） |
| `numbers` | 期望数字，做数值等价匹配（`28.4` ≡ `28.40`，`41.8%` ≡ `41.8`，年份不计） |
| `strict` | 可选，要求关键词与数字全部命中 |

## 指标怎么读

| 指标 | 定义 | 方向 |
| --- | --- | --- |
| `sourceCoverage` | 终稿命中的 expected evidence / 总数 | 越高越好 |
| `latePaperCoverage` | 只统计「证据位于原文后半篇」的锚点覆盖率 | 越高越好 |
| `numberEvidenceCoverage` | 期望数字在终稿出现、且 audit 能在原文定位的比例 | 越高越好 |
| `figureCoverage` | 期望图被正确引用（图号或图注关键词）的比例 | 越高越好 |
| `formulaCoverage` | 期望公式在终稿保留（有 LaTeX 且符号命中）的比例 | 越高越好 |
| `ablationCoverage` | 期望消融点的覆盖率 | 越高越好 |
| `limitationCoverage` | 期望局限点的覆盖率 | 越高越好 |
| `auditMissingRate` | audit 判为「原文查不到」的数字/实体/图/公式占审计项比例 | **越低越好** |
| `sectionCompleteness` | 计划小节与终稿 H2 的一致性 | 越高越好 |
| `lengthStability` | 终稿是否完整（小节齐全 + 收尾不悬空） | `1` 稳定 / `0` 疑似截断 |

某篇论文没有某类锚点（例如 Agent 论文没有公式）时，该指标为 `n/a`，**不参与平均**，
避免用无意义的 0 拉低整体分数。

`latePaperCoverage` 的「后半篇」判定是确定性的：把锚点关键词放进全文章节切片，
取命中数最多的那个 chunk 的位置（chunk 顺序 = 原文顺序），位置 ≥ 50% 记为 late。

## 输出与产物

每次运行生成：

```text
benchmark/runs/<timestamp>/
  summary.json     # total/completed/skipped/failed + metrics + papers[] + 质量问题清单
  README.md        # summary 的人读版（指标表 + 逐篇表）
  papers/<id>.json # 单篇：metrics + detail + audit + research map 摘要 + 结构 + 耗时 + 阶段时间
  papers/<id>.md   # 单篇终稿（默认不进 git，见 runs/.gitignore）
```

CLI 也会打印同样一份（数字全部来自本次真实运行）：

```text
DeepRead Benchmark v1

Papers: 5
Completed: 5

Source coverage: 92%
Late-paper coverage: 88%
Number evidence: 100%
Figure coverage: 100%
Formula coverage: 96%
Ablation coverage: 83%
Limitation coverage: 80%
Audit missing rate: 0%
```

## baseline 与回归

- 第一次真实跑完（≥1 篇 completed）时自动写入 `baseline.json`。
- 之后每次运行会与 baseline 比对，输出 `improved` / `regressed` / `unchanged`
  （`auditMissingRate` 方向相反：下降算提升；默认容差 0.005）。
- 确认某项改动是长期收益后，用 `npm run benchmark -- --update-baseline` 更新 baseline。
- **没有真实运行就不会生成 baseline**：全 skipped / 全 failed 时该文件保持原样。

## 与 `npm test` 的区别

| | `npm test` | `npm run benchmark` |
| --- | --- | --- |
| 目标 | 代码正确性（切片 / 检索 / 审计 / 降级 / provider 兼容） | 真实论文的解读质量与证据覆盖 |
| 依赖 | 无网络、无模型，纯确定性 | 需要网络（arXiv）+ 真实模型 |
| 耗时 | ~2 秒 | 每篇数分钟（5 篇约 30–60 分钟） |
| 失败含义 | 代码坏了 | 质量指标回退 / 论文取源失败 |
| 建议频率 | 每次改动 | 改动 DeepRead 前后各跑一次 |

两者互不影响：benchmark 的 skipped / failed **不会**让 `npm test` 失败，反之亦然。

## seed 论文（v1）

| id | 分类 | 论文 | 后半篇锚点举例 |
| --- | --- | --- | --- |
| 1706.03762 | LLM | Attention Is All You Need | label smoothing（约 59% 处） |
| 2501.12948 | RL / RLVR | DeepSeek-R1 | Unsuccessful Attempts / reward hacking（约 73% 处） |
| 2405.15793 | Agent | SWE-agent | Ethics & Broader Impacts（约 97% 处） |
| 2409.12191 | Multimodal / VLM | Qwen2-VL | agent benchmark 表与局限（24%–86% 处） |
| 2406.09246 | Embodied AI / Robotics | OpenVLA | 失败案例 / 部分成功（约 58% 处） |

选片标准：arXiv 有 HTML 版（真实 section 层次 + 图注 + 表格）、覆盖不同方向、
每篇都有「后半篇才有」的关键证据。

## 首轮真实运行发现（benchmark 的价值所在）

第一次跑满 5 篇 seed（`benchmark/runs/<timestamp>/`，结果见 `baseline.json`）就已经暴露了
「功能测试通过」看不到的问题。**指标只能证明覆盖不足，具体原因要回单篇记录里看**
（`papers/<id>.json` 里有 audit、research map 状态、逐节证据 id、阶段耗时）：

1. **Research Map 阶段从没真正生效**：5 篇全部落到本地关键词兜底（`researchMapStatus: fallback`）。
   根因是模型输出被 `max_tokens=4096` 截断——同一提示词下 `max_tokens: 4096` 返回
   `finish_reason: length`、JSON 正文 0 字符（预算全被 reasoning 吃掉），
   `max_tokens: 16000` 才返回可解析的完整 JSON。所以「模型产出的研究地图 → 检索加权 → 消融/局限识别」
   整条链路实际是退化的，而 summary 里的覆盖率看起来仍然正常（这类**静默降级**现在会被
   `qualityNotes` 点名）。
2. **计划阶段同样静默降级**：4/5 篇的小节标题等于 `defaultDeepReadPlan()` 的固定 6 节
   （在 `papers/<id>.json` 的 `evidence[].section` 里可以直接看出来）。唯一拿到模型大纲的那篇，
   10 项指标全部满分——说明「模型大纲 + 模型地图」是否生效，和最终质量是强相关的。
3. **审计里的「原文查不到的数字」有假阳性**：arXiv HTML 的表格被展平后会出现 `01.30%` 这类
   列粘连文本，audit 做字面/裸数字比较时匹配不上终稿里的 `1.30%`，于是报 missing 并触发定点修复。
4. **终稿审校护栏是有用的**：本轮有 2 篇的审校结果被丢弃（一次 `11235 → 355` 字符、
   一次 `10804 → 9400`），护栏挡住了「把长报告截断成半篇」的事故。
5. **覆盖率对措辞敏感**：终稿统一把小节写成「失效边界与可以继续追的问题」，而 `局限/limitations`
   这类关键词一个都没出现，`limitationCoverage` 因此偏低——这里面既有真实缺口（论文的 ethics /
   failure-mode 附录确实没读到），也有措辞造成的假阴性。v2 应该让 limitation/ablation 这类
   **概念型锚点**按小节语义判断，而不是只做字面匹配。

结论：v1 的能量集中在「证据覆盖 + 结构完整性」上，够用来发现上面这些问题，但
**不要把它当成文章质量的绝对分数**；概念型锚点的措辞敏感性是 v1 已知的局限。
