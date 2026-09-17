/**
 * 统一的「阶段元数据」（stage metadata）
 *
 * 深度解读是一条多阶段管线（research_map → plan → retrieval → section → audit → repair → review）。
 * 每个阶段都可能**静默降级**：模型输出被 max_tokens 截断、JSON 解析失败、调用报错，然后悄悄用
 * 本地兜底继续跑。结果是「报告看起来正常，但上游其实没生效」——这正是 Benchmark 首轮暴露的问题
 * （5/5 篇 research map 都落到了本地关键词兜底，summary 里却看不出来）。
 *
 * 所以这里不发明新的 pipeline，只做一件事：给每个阶段一份形状统一的、可观测的状态记录：
 *   { stage, status, source, model, provider, finishReason, rawContentLength,
 *     parsed, fallback, fallbackReason, durationMs, warning, reason }
 *
 * 设计约束：
 *   - 只保留状态、长度、finish_reason 与错误摘要，**不落原始 reasoning / 原始输出**（避免泄露与膨胀）；
 *   - 状态判定只看客观信号（finish_reason / 是否有可见 content / 能否解析），不猜语义；
 *   - `source` 记「最终采用的结果来自哪里」（model / local / default / provider），
 *     尝试调用过模型但降级时，用 status + fallbackReason 描述这次尝试。
 */

/** 模型类阶段的终态（research_map / plan / section_generation / repair）。 */
export const STAGE_STATUS = {
  MODEL_SUCCESS: 'model_success', // 模型产出可用结果
  MODEL_TRUNCATED: 'model_truncated', // finish_reason=length，输出被截断
  PARSE_FAILED: 'parse_failed', // 有输出但解析不出可用结构（含空输出）
  PROVIDER_ERROR: 'provider_error', // 调用抛错/超时/HTTP 失败
  FALLBACK: 'fallback', // 未尝试模型（无 chat / 前置条件不足），直接走兜底
  SUCCESS: 'success', // 确定性阶段正常完成
  WARN: 'warn', // 完成但有降级/部分失败
  FAILED: 'failed',
  SKIPPED: 'skipped', // 按配置关闭或前置依赖失败，未执行
};

/** 结果来源：模型 / 本地确定性兜底 / 内置默认 / provider 层。 */
export const STAGE_SOURCE = {
  MODEL: 'model',
  LOCAL: 'local',
  DEFAULT: 'default',
  PROVIDER: 'provider',
};

/** 需要被 qualityNotes / 可靠性指标点名的状态（skipped / success 不算问题）。 */
const WARNING_STATUSES = new Set([
  STAGE_STATUS.MODEL_TRUNCATED,
  STAGE_STATUS.PARSE_FAILED,
  STAGE_STATUS.PROVIDER_ERROR,
  STAGE_STATUS.FALLBACK,
  STAGE_STATUS.WARN,
  STAGE_STATUS.FAILED,
]);

const OK_STATUSES = new Set([STAGE_STATUS.MODEL_SUCCESS, STAGE_STATUS.SUCCESS, STAGE_STATUS.SKIPPED]);

const REASON_MAX = 300;

function shortText(value) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length > REASON_MAX ? `${s.slice(0, REASON_MAX)}…` : s;
}

/** finish_reason 是否表示「被 max_tokens 截断」。 */
export function isTruncatedFinish(finishReason) {
  const r = String(finishReason || '').toLowerCase();
  return r === 'length' || r === 'max_tokens' || r === 'max_output_tokens';
}

/** 模型返回里的可见正文（不含 reasoning）。 */
export function visibleContent(response) {
  return String((response && response.content) || '').trim();
}

/**
 * 组装一条阶段记录。缺省值统一为 null，避免各模块各自发明字段。
 */
export function makeStage(input = {}) {
  const status = String(input.status || STAGE_STATUS.SUCCESS);
  const fallback = input.fallback == null ? !OK_STATUSES.has(status) : !!input.fallback;
  const rawLength = input.rawContentLength;
  const duration = input.durationMs;
  const stage = {
    stage: String(input.stage || 'unknown'),
    status,
    source: String(input.source || STAGE_SOURCE.LOCAL),
    model: input.model ? String(input.model) : null,
    provider: input.provider ? String(input.provider) : null,
    finishReason: input.finishReason == null ? null : String(input.finishReason),
    rawContentLength: Number.isFinite(rawLength) ? Number(rawLength) : null,
    parsed: input.parsed == null ? null : !!input.parsed,
    fallback,
    fallbackReason: shortText(input.fallbackReason),
    reason: shortText(input.reason),
    durationMs: Number.isFinite(duration) ? Number(duration) : null,
    warning: WARNING_STATUSES.has(status),
    skipped: status === STAGE_STATUS.SKIPPED,
  };
  const extra = input.extra && typeof input.extra === 'object' ? input.extra : null;
  return extra ? { ...stage, ...extra } : stage;
}

/**
 * 依据模型响应判定阶段状态。**不依赖内容语义**，只看客观信号：
 *   providerError → provider_error
 *   finish_reason=length → model_truncated（绝不能伪装成普通 parse failure）
 *   没有可见 content → parse_failed（典型成因：reasoning 吃满 token 预算）
 *   解析失败 → parse_failed
 *   否则 → model_success
 *
 * @param {object} args
 * @param {string} args.stage
 * @param {{content?:string, finishReason?:string}|null} args.response
 * @param {boolean|null} args.parsed 业务上是否解析出了可用结构（false/null 表示没解析出来）
 * @param {string} [args.providerError] 调用抛出的错误摘要
 * @param {string} [args.source] 成功时结果来源；降级时会被替换成 fallbackSource
 * @param {string} [args.fallbackSource] 降级时实际采用的来源（local/default）
 */
export function classifyModelOutput({
  stage,
  response = null,
  parsed = null,
  providerError = '',
  source = STAGE_SOURCE.MODEL,
  fallbackSource = STAGE_SOURCE.LOCAL,
  model = null,
  provider = null,
  durationMs = null,
  extra = null,
  parseRequired = true,
} = {}) {
  const content = visibleContent(response);
  const finishReason = response && response.finishReason != null ? String(response.finishReason) : null;
  const base = {
    stage,
    model: model || (response && response.model) || null,
    provider: provider || null,
    finishReason,
    rawContentLength: content.length,
    durationMs,
    extra,
  };

  if (providerError) {
    return makeStage({
      ...base,
      status: STAGE_STATUS.PROVIDER_ERROR,
      source: fallbackSource,
      parsed: false,
      reason: '模型调用失败，已走兜底',
      fallbackReason: `调用失败：${shortText(providerError)}`,
    });
  }
  if (isTruncatedFinish(finishReason)) {
    return makeStage({
      ...base,
      status: STAGE_STATUS.MODEL_TRUNCATED,
      source: fallbackSource,
      parsed: false,
      reason: `输出被 max_tokens 截断（finish_reason=${finishReason}，可见正文 ${content.length} 字）`,
      fallbackReason: `模型输出被截断（finish_reason=${finishReason}）`,
    });
  }
  if (!content) {
    return makeStage({
      ...base,
      status: STAGE_STATUS.PARSE_FAILED,
      source: fallbackSource,
      parsed: false,
      reason: '模型未返回可见正文（可能被 reasoning 占满 token 预算）',
      fallbackReason: '模型返回空正文',
    });
  }
  if (parseRequired && !parsed) {
    return makeStage({
      ...base,
      status: STAGE_STATUS.PARSE_FAILED,
      source: fallbackSource,
      parsed: false,
      reason: '模型输出无法解析出可用结构',
      fallbackReason: '模型输出无法解析',
    });
  }
  return makeStage({
    ...base,
    status: STAGE_STATUS.MODEL_SUCCESS,
    source,
    parsed: true,
    reason: '',
    fallbackReason: '',
  });
}

/** 未调用模型、直接使用兜底时使用。 */
export function fallbackStage({ stage, reason, source = STAGE_SOURCE.LOCAL, extra = null, durationMs = null } = {}) {
  return makeStage({
    stage,
    status: STAGE_STATUS.FALLBACK,
    source,
    parsed: false,
    reason,
    fallbackReason: reason,
    extra,
    durationMs,
  });
}

/**
 * 阶段汇总（供 pipeline metadata / benchmark 可靠性指标消费）。
 * @param {object} stages { [stageName]: stageRecord }
 */
export function summarizeStages(stages = {}) {
  const list = Object.values(stages || {}).filter(Boolean);
  const warnings = list.filter((s) => s.warning);
  return {
    total: list.length,
    withWarnings: warnings.length,
    stagesWithWarnings: warnings.map((s) => s.stage),
    fallbacks: list.filter((s) => s.fallback).map((s) => s.stage),
    truncated: list.filter((s) => s.status === STAGE_STATUS.MODEL_TRUNCATED).map((s) => s.stage),
    skipped: list.filter((s) => s.skipped).map((s) => s.stage),
    failed: list.filter((s) => s.status === STAGE_STATUS.FAILED).map((s) => s.stage),
  };
}

/** 面向产物/日志的精简视图：字段都在白名单里，天然不含原始输出。 */
export function stageView(stage) {
  if (!stage) return null;
  return {
    stage: stage.stage,
    status: stage.status,
    source: stage.source,
    finishReason: stage.finishReason ?? null,
    rawContentLength: stage.rawContentLength ?? null,
    parsed: stage.parsed ?? null,
    fallback: !!stage.fallback,
    fallbackReason: stage.fallbackReason || '',
    durationMs: stage.durationMs ?? null,
    reason: stage.reason || '',
  };
}
