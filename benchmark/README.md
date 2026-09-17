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

### 阶段可靠性指标（v2 新增）

光看覆盖率会被骗：**上游阶段没生效时，覆盖率照样可能很高**（模型地图没产出 → 检索退化成关键词匹配 →
报告依然写得挺完整，但漏掉的是消融、失败案例、伦理附录这类要靠地图定位的内容）。
所以 v2 把「阶段有没有真的跑起来」也变成指标，全部来自真实调用状态：

| 指标 | 定义 | 方向 |
| --- | --- | --- |
| `researchMapModelSuccess` | 研究地图由**模型产出且可用**的论文比例 | 越高越好 |
| `researchMapFallbackRate` | 研究地图走了兜底（本地关键词 / 截断 / 解析失败 / 调用失败）的比例 | **越低越好** |
| `planModelSuccess` | 大纲由模型产出且可用的论文比例 | 越高越好 |
| `planFallbackRate` | 大纲退回内置默认骨架的比例 | **越低越好** |
| `stagesWithWarnings` | 平均每篇有几个阶段处在告警状态（截断 / 解析失败 / 兜底 / 部分失败） | 越低越好 |
| `evidenceFromModelMapRate` | 逐节写作用到的证据里，有多少比例来自**模型地图点名的 chunk** | 越高越好 |
| `auditConfidence` | 审计可信度（见下） | 越高越好 |

`auditConfidence = 地图系数 × 结论系数`：

| 地图系数 | 值 | | 结论系数 | 值 |
| --- | --- | --- | --- | --- |
| 研究地图 `model_success` | 1.0 | | 审计 `passed` | 1.0 |
| 截断 / 解析失败 / 调用失败 | 0.5 | | `passed_with_warning` | 0.8 |
| 本地关键词兜底 | 0.4 | | `failed` | 0.5 |

也就是说：地图没生效时，即使 audit 说「通过」，可信度上限也只有 0.4——**「没发现问题」不等于「高可信通过」**。

### 阶段状态怎么读（model_success / model_truncated / parse_failed / fallback）

每个阶段的元数据（`benchmark/runs/<ts>/papers/<id>.json` 的 `stages`）形状统一：

```json
{
  "stage": "research_map",
  "status": "model_truncated",
  "source": "local",
  "finishReason": "length",
  "rawContentLength": 0,
  "parsed": false,
  "fallback": true,
  "fallbackReason": "模型输出被截断（finish_reason=length）",
  "durationMs": 41230,
  "warning": true
}
```

| status | 含义 | 典型成因 |
| --- | --- | --- |
| `model_success` | 模型产出可用结构 | 正常 |
| `model_truncated` | `finish_reason=length`，输出被 max_tokens 截断 | reasoning 模型把思考 token 算进 max_tokens |
| `parse_failed` | 有（或没有）可见正文，但解析不出可用结构 | 返回空正文、返回 prose、JSON 不完整 |
| `provider_error` | 调用抛错/超时/HTTP 失败 | 网络、超时、配额 |
| `fallback` | 没尝试模型，直接走兜底 | 未提供 chat、切片不足 |
| `success` / `warn` / `failed` / `skipped` | 确定性阶段的状态（检索、审计、修复等） | — |

只保留状态、长度、`finish_reason` 与错误摘要，**不落原始 reasoning / 原始输出**。

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

> 下面是 **v1 基线（commit `18449be`，run `20260917-130545`）** 的发现，是**修复前**的真实结果，
> 不要把它当成修复后的数字。修复与修复后的对比见下一节。

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

## v2：上游阶段可靠性修复

### 为什么模型地图会因为 reasoning token 不足而截断

Research Map 要求模型输出一份结构化 JSON（问题 / 主张 / 方法 / 结果 / 消融 / 局限 / 证据定位）。
对**推理模型**来说，`max_tokens` 限制的是「思考 token + 可见输出」的**总和**：思考写掉几千 token 后，
留给 JSON 的额度就没了。v1 的预算写死 4096，实测结果是：

| max_tokens | finish_reason | 可见正文 | 能否解析 |
| --- | --- | --- | --- |
| 4096 | `length` | 0 字符（reasoning 约 1.3 万字符） | 否 |
| 16000 | `stop` | 7313 字符 | 是（`main_results` 6 条） |

v2 的处理：

1. 研究地图 / 大纲的输出预算改为 `DEEPREAD_MAP_TOKENS` / `DEEPREAD_PLAN_TOKENS`（默认 16000），
   不再写死 4096；
2. `chat` 调用把 `finish_reason` / `usage` / `model` 一起带回来，**解析前先看客观信号**；
3. `finish_reason=length` 一律判为 `model_truncated`（**不允许伪装成普通 parse failure**），
   并把 `fallbackReason` 写进阶段元数据与 warnings；
4. 如果 provider 支持把 reasoning 预算和可见输出分开，可以用 `LLM_REASONING_EFFORT` 显式传入
   （留空则不发送该字段，兼容不支持的服务端）。

### 覆盖率 ≠ 模型地图生效

`sourceCoverage` 只说明「终稿里出现了锚点关键词」，它无法区分下面两种情形：

- 模型地图生效 → 检索按地图点名的 chunk 加权，实验 / 消融 / 局限都能被定位；
- 模型地图兜底 → 检索退化成纯关键词匹配，覆盖率可能依然很高，但漏掉的多半是
  「只有读懂全文才找得到」的内容（失败案例、伦理 / broader impacts、附录）。

所以 v2 把 `researchMapModelSuccess` / `researchMapFallbackRate` / `evidenceFromModelMapRate`
和覆盖率并列展示，并在 CLI 里单独列「阶段降级明细」。CLI 与 `summary.json` 里
**只要 research map 不是 `model_success` 就会显式显示**，不再只报结果指标。

### 为什么 audit 要结合上游可信度读

audit 的「实体 / 主要结果 / 消融 / 局限」检查全部建立在这份研究地图上。地图是本地关键词兜底时，
这些检查仍然会跑（确定性检查不该被关掉），但它们的「通过」只说明**关键词层面没发现问题**，
不能当成结论。v2 让 audit 接收地图的阶段元数据，并产出三级结论：

| verdict | 条件 |
| --- | --- |
| `failed` | 有事实性失败（数字对不上、公式丢失、图号越界等） |
| `passed_with_warning` | 没有事实性失败，但有 warning 级问题，或上游地图不可信 |
| `passed` | 没有事实性失败、没有 warning、地图由模型产出 |

地图不可信时 audit 会带 `research_map_unavailable` / `research_map_local_fallback`
/ `research_map_source_unknown` 这类 warning code；audit 本身不会被关闭。

### 数字匹配：exact / normalized / approximate

arXiv HTML 的表格被展平后会出现列粘连（源表里是 `01.30%`），终稿写的是 `1.30%`。
v1 用字面比较，于是把**格式差异**误判成「原文查不到」，还触发了无意义的定点修复。v2 在匹配层加了
**只做格式、不做数值近似**的归一化：

| 规则 | 例子 |
| --- | --- |
| 千位逗号 | `4,200` ≡ `4200` |
| 百分号 / 乘号前后空格与全角形态 | `41.8 %` ≡ `41.8%`、`10 ×` ≡ `10x` |
| 整数部分前导零 | `01.30%` ≡ `1.30%`、`007` ≡ `7`（`0.8` 不变） |
| 小数尾零 | `41.80` ≡ `41.8` |
| Unicode 减号 / 连字符 | `−1.2` ≡ `-1.2` |

匹配方式会如实记录在 audit 结果里（`numbers` 检查的 `matched[].method` 与 `stats.numberMatchMethods`）：
`exact`（字面一致）/ `normalized`（格式归一化后一致）/ `approximate`（数值一致、单位写法不同）。
三种都不中的数字才算「原文查不到」——**不会因为归一化而放过编造数字**（数值不同一律算 missing）。

### 召回：结果 / 消融 / 局限不再只看前半篇

检索仍是确定性词法检索（**不引入 embedding / 向量库**），v2 在原有「本节原文优先 + 章节角色先验」
之上加了：

1. 证据类别识别：`main_results` / `ablations` / `limitations` / `failure_cases` / `ethics` /
   `broader_impacts` / `appendix` / `future_work` / `discussion`；
2. 角色 × 类别加权：结果节偏主结果与表格，局限节偏局限 / 失败案例 / 伦理 / broader impacts / 附录；
3. 结果 / 局限类小节加入**后半篇最低召回保障**（默认 1–2 条，`lateQuota` 可覆盖或置 0 关闭），
   避免所有证据都来自前半篇；方法节不启用该保障，免得把机制解释挤掉；
4. 参考文献 / 致谢仍按噪声降权，且不进入后半篇保障名额。

### 终稿审校同样要给足 reasoning 余量

审校是「把整篇稿子交给模型改写再拿回来」，它的 `max_tokens` 也要同时覆盖「改写后的正文 + 思考 token」。
v2 运行里 4/5 篇的审校被护栏丢弃（3 篇返回空正文、1 篇反而变短），实测原因：

| max_tokens | finish_reason | 可见正文 | reasoning | 护栏判定 |
| --- | --- | --- | --- | --- |
| 32000（旧默认上限） | `length` | 11373 字（原稿 12597 字） | 约 6.8 万字符 | 丢弃（明显变短） |
| 48000 | `stop` | 14062 字 | 约 4.3 万字符 | 接受（变长、小节不减少） |

现在的预算 = 「原稿字数 × 1.3 + 30000 reasoning 余量」，上限 48000；如果 provider 对 `max_tokens`
有硬上限（例如 gpt-4o-mini 16384）而返回 4xx，会自动退一档重试（旧行为），不会让审校变成死阶段。
无论成功、被拒还是被护栏丢弃，都会记进 `stages.review`。

### 修复前后对比（同一批 5 篇 seed，deepseek-v4-flash）

| 指标 | v1 基线 `20260917-130545` | v2 `20260917-235800` |
| --- | --- | --- |
| Research map model success | 0% | **80%** |
| Research map fallback rate | 100% | **20%** |
| Plan model success | 20% | **100%** |
| Plan fallback rate | 80% | **0%** |
| Evidence from model map | n/a（无此指标） | 54% |
| Audit confidence | n/a（无此指标） | 58% |
| Source coverage | 88% | 90% |
| Late-paper coverage | 67% | 44% |
| Number evidence | 75% | 73% |
| Figure coverage | 90% | 100% |
| Formula coverage | 100% | 100% |
| Ablation coverage | 70% | 80% |
| Limitation coverage | 30% | 30% |
| Section completeness | 100% | 96% |
| Length stability | 100% | 100% |
| Audit missing rate | 1% | 5% |

怎么读这张表：

- **阶段可靠性是明确的修复**：研究地图 0% → 80%、大纲 20% → 100%。剩下 1 篇（DeepSeek-R1，337 个切片）
  仍然撞到 `max_tokens` 上限，但状态是 `model_truncated`，**显式暴露而不是静默兜底**——这正是本轮的修复目标。
- **内容覆盖是混合结果，不要只看方向**：5 篇样本 + 每轮重新生成，内容指标本身波动很大；两处下探需要分开看：
  - `latePaperCoverage` 67% → 44%：v1 有 4/5 篇用的是**同一份内置默认骨架**（固定 6 节，其中「关键公式与实验证据有多硬」
    天然与后半篇实验 chunk 词法重合），换成逐篇定制大纲后各节与原文小节的对齐关系变了，属于口径 + 样本波动的叠加，
    不能直接读成「检索变差了」。
  - `auditMissingRate` 1% → 5%：v2 的 audit 面对的是**模型地图**（实体 / 主结果条目更多更具体），
    而且数字匹配新增了归一化与近似通道（本轮实际命中「归一化 3 / 近似 27」），所以这 5% 里包含更多**真实缺口**；
    旧的 1% 是「兜底地图 + 字面匹配」共同造成的乐观假象。
  - `sectionCompleteness` 100% → 96%：有 1 篇的某一节生成失败，`section_generation=warn` 如实记录，
    不再被平均值掩盖。
- **audit 结论要连着上游读**：v2 有 3 篇 `auditConfidence` 在 0.5 附近，说明「审计通过 / 未通过」是在
  上游不完备的前提下得到的，不能单独当结论。
