# DeepRead Benchmark v1 运行报告

- 时间：2026-09-17T15:58:00.307Z
- Provider：deepseek（deepseek-v4-flash）
- 论文：5 篇（完成 5 / 跳过 0 / 失败 0）
- 说明：指标衡量「证据覆盖与结构完整性」，不是对文章文学质量的绝对评分。

## 汇总指标

| 分组 | 指标 | 数值 |
| --- | --- | --- |
| 内容覆盖指标 | Source coverage | 90.0% |
| 内容覆盖指标 | Late-paper coverage | 44.4% |
| 内容覆盖指标 | Number evidence | 73.3% |
| 内容覆盖指标 | Figure coverage | 100.0% |
| 内容覆盖指标 | Formula coverage | 100.0% |
| 内容覆盖指标 | Ablation coverage | 80.0% |
| 内容覆盖指标 | Limitation coverage | 30.0% |
| 内容覆盖指标 | Section completeness | 95.6% |
| 内容覆盖指标 | Length stability | 100.0% |
| 阶段可靠性指标 | Research map model success | 80.0% |
| 阶段可靠性指标 | Research map fallback rate | 20.0% |
| 阶段可靠性指标 | Plan model success | 100.0% |
| 阶段可靠性指标 | Plan fallback rate | 0.0% |
| 阶段可靠性指标 | Stages with warnings (avg/papers) | 1.20 |
| 阶段可靠性指标 | Evidence from model map | 54.1% |
| 审计可信度指标 | Audit missing rate | 5.2% |
| 审计可信度指标 | Audit confidence | 58.4% |

## 逐篇结果

| 论文 | 分类 | 状态 | research_map | plan | sourceCoverage | latePaper | numbers | figures | formulas | ablation | limitation | auditMissing | auditConfidence | 耗时 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1706.03762 | LLM | completed | model_success | model_success | 100% | 33% | 100% | 100% | 100% | 0% | 100% | 3% | 50% | 492s |
| 2405.15793 | Agent | completed | model_success | model_success | 100% | n/a | 67% | 100% | n/a | 100% | 0% | 3% | 80% | 320s |
| 2406.09246 | Embodied AI / Robotics | completed | model_success | model_success | 100% | 0% | 100% | 100% | n/a | 100% | 0% | 9% | 80% | 355s |
| 2409.12191 | Multimodal / VLM | completed | model_success | model_success | 100% | n/a | 100% | 100% | n/a | 100% | 0% | 9% | 50% | 322s |
| 2501.12948 | RL / RLVR | completed | model_truncated | model_success | 50% | 100% | 0% | 100% | n/a | 100% | 50% | 2% | 32% | 384s |

## 与 baseline 对比

- 提升：Source coverage 88%→90%；Figure coverage 90%→100%；Ablation coverage 70%→80%
- 回退：Late-paper coverage 67%→44%；Number evidence 75%→73%；Audit missing rate 1%→5%；Section completeness 100%→96%
- 持平：Formula coverage；Limitation coverage；Length stability
- 无基线可比（新增指标或旧 baseline 未记录）：Research map model success；Research map fallback rate；Plan model success；Plan fallback rate；Stages with warnings (avg/papers)；Evidence from model map；Audit confidence
