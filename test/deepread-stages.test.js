import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STAGE_SOURCE,
  STAGE_STATUS,
  classifyModelOutput,
  fallbackStage,
  isTruncatedFinish,
  makeStage,
  stageView,
  summarizeStages,
  visibleContent,
} from '../src/deepread/stages.js';

// ============ finish_reason / 截断判定 ============

test('finish_reason=length 判为 model_truncated，而不是普通 parse failure', () => {
  const stage = classifyModelOutput({
    stage: 'research_map',
    // 真实事故：max_tokens=4096 被 reasoning 吃满，可见正文 0 字
    response: { content: '', finishReason: 'length', model: 'deepseek-v4-flash' },
    parsed: false,
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    durationMs: 1234,
  });
  assert.equal(stage.status, 'model_truncated');
  assert.notEqual(stage.status, 'parse_failed', '截断必须与解析失败区分开');
  assert.equal(stage.source, 'local', '降级后结果来源是本地');
  assert.equal(stage.fallback, true);
  assert.equal(stage.warning, true);
  assert.equal(stage.finishReason, 'length');
  assert.equal(stage.rawContentLength, 0);
  assert.equal(stage.durationMs, 1234);
  assert.equal(stage.model, 'deepseek-v4-flash');
  assert.equal(stage.provider, 'deepseek');
  assert.match(stage.reason, /截断/);
  assert.equal(isTruncatedFinish('length'), true);
  assert.equal(isTruncatedFinish('stop'), false);
});

test('模型返回空正文判为 parse_failed（并注明可能被 reasoning 占满）', () => {
  const stage = classifyModelOutput({
    stage: 'plan',
    response: { content: '   ', finishReason: 'stop' },
    parsed: false,
  });
  assert.equal(stage.status, 'parse_failed');
  assert.match(stage.reason, /可见正文|空/);
  assert.equal(stage.rawContentLength, 0);
  assert.equal(visibleContent({ content: '  x ' }), 'x');
});

test('合法 JSON / 可用结构判为 model_success', () => {
  const stage = classifyModelOutput({
    stage: 'research_map',
    response: { content: '{"problem":"x"}', finishReason: 'stop', model: 'm' },
    parsed: true,
    provider: 'deepseek',
    durationMs: 10,
  });
  assert.equal(stage.status, 'model_success');
  assert.equal(stage.source, 'model');
  assert.equal(stage.fallback, false);
  assert.equal(stage.warning, false);
  assert.equal(stage.parsed, true);
});

test('调用抛错判为 provider_error，并保留错误摘要（不含原始输出）', () => {
  const stage = classifyModelOutput({
    stage: 'research_map',
    response: null,
    parsed: null,
    providerError: '模型调用超时（300 秒）：请稍后重试',
  });
  assert.equal(stage.status, 'provider_error');
  assert.match(stage.fallbackReason, /超时/);
  assert.equal(stage.rawContentLength, 0);
});

test('未调用模型时用 fallbackStage 明确标注 fallback', () => {
  const stage = fallbackStage({ stage: 'research_map', reason: '未提供可用 chat，使用本地关键词地图' });
  assert.equal(stage.status, STAGE_STATUS.FALLBACK);
  assert.equal(stage.source, STAGE_SOURCE.LOCAL);
  assert.equal(stage.fallback, true);
  assert.match(stage.fallbackReason, /未提供可用 chat/);
});

// ============ 统一结构 ============

test('makeStage 统一字段；skipped 不算告警，warn/failed 算', () => {
  const base = makeStage({ stage: 'retrieval', status: STAGE_STATUS.SUCCESS, source: STAGE_SOURCE.LOCAL });
  for (const key of ['stage', 'status', 'source', 'model', 'provider', 'finishReason', 'rawContentLength', 'parsed', 'fallback', 'fallbackReason', 'durationMs', 'warning']) {
    assert.ok(key in base, `阶段记录必须包含 ${key}`);
  }
  assert.equal(base.model, null);
  assert.equal(base.durationMs, null);
  assert.equal(makeStage({ stage: 'audit', status: STAGE_STATUS.SKIPPED }).warning, false, 'skipped 是「没跑」而非「跑坏了」');
  assert.equal(makeStage({ stage: 'retrieval', status: STAGE_STATUS.WARN }).warning, true);
  assert.equal(makeStage({ stage: 'audit', status: STAGE_STATUS.FAILED }).fallback, true);
  // extra 字段可以扩展，但不会挤掉统一字段
  const withExtra = makeStage({ stage: 'plan', status: STAGE_STATUS.MODEL_SUCCESS, extra: { sectionCount: 6 } });
  assert.equal(withExtra.sectionCount, 6);
  assert.equal(withExtra.status, 'model_success');
});

test('阶段元数据只保留摘要，不落原始输出', () => {
  const long = 'x'.repeat(2000);
  const stage = makeStage({ stage: 'research_map', status: STAGE_STATUS.PARSE_FAILED, reason: long, fallbackReason: long });
  assert.ok(stage.reason.length <= 320, 'reason 必须被截断');
  assert.ok(stage.fallbackReason.length <= 320, 'fallbackReason 必须被截断');
  assert.equal(JSON.stringify(stage).includes('x'.repeat(400)), false, '不得包含原始长文本');
  const view = stageView(stage);
  assert.deepEqual(Object.keys(view).sort(), [
    'durationMs',
    'fallback',
    'fallbackReason',
    'finishReason',
    'parsed',
    'rawContentLength',
    'reason',
    'source',
    'stage',
    'status',
  ]);
});

test('summarizeStages 汇总告警/兜底/截断/跳过阶段', () => {
  const summary = summarizeStages({
    research_map: makeStage({ stage: 'research_map', status: STAGE_STATUS.MODEL_TRUNCATED, source: STAGE_SOURCE.LOCAL }),
    plan: makeStage({ stage: 'plan', status: STAGE_STATUS.MODEL_SUCCESS, source: STAGE_SOURCE.MODEL }),
    retrieval: makeStage({ stage: 'retrieval', status: STAGE_STATUS.SUCCESS }),
    review: makeStage({ stage: 'review', status: STAGE_STATUS.SKIPPED }),
    audit: makeStage({ stage: 'audit', status: STAGE_STATUS.WARN }),
  });
  assert.equal(summary.total, 5);
  assert.equal(summary.withWarnings, 2, '截断 + warn 两个告警阶段');
  assert.deepEqual(summary.stagesWithWarnings.sort(), ['audit', 'research_map']);
  assert.deepEqual(summary.fallbacks, ['research_map', 'audit']);
  assert.deepEqual(summary.truncated, ['research_map']);
  assert.deepEqual(summary.skipped, ['review']);
  assert.deepEqual(summarizeStages(null).stagesWithWarnings, []);
});
