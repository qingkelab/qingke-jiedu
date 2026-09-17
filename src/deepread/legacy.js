/**
 * 旧版深度解读路径（作为结构化流程不可用时的回退）：
 *   - deepReadMultipass：大纲 → 逐节生成 → 合并（Ollama 等本地小模型主力路径）
 *   - deepReadSinglePass：整篇一次生成 + 审校（API 模型路径）
 *
 * 结构化流程（chunker → research map → retrieval → audit）失败时，provider 会回退到这里，
 * 保证「Research Map 失败 → 回退当前 multipass」这一降级要求。
 */

import { checkStyle, styleWarningsForPrompt } from '../styleCheck.js';
import { acceptReview, reviewBudgetTokens } from './review.js';
import {
  buildDeepReadMessages,
  buildDeepReadSectionMessages,
  buildDeepReviewMessages,
  buildPlanMessages,
  defaultDeepReadPlan,
  parseDeepReadPlan,
} from './prompts.js';

/** 分段生成主流程：大纲 → 逐节生成 → 合并。 */
export async function deepReadMultipass({ chat, source, figures, onProgress, context = '' }) {
  onProgress?.({ stage: 'plan' });
  const planRaw = await chat(buildPlanMessages({ source, structure: null, researchMap: null, figures }), 4096);
  let plan = parseDeepReadPlan(planRaw.content);
  if (plan.length < 3) plan = defaultDeepReadPlan();

  const sections = [];
  const reasoningParts = [];
  let prev = '';
  for (let i = 0; i < plan.length; i++) {
    const secInfo = { index: i + 1, total: plan.length, title: plan[i].title };
    onProgress?.({ stage: 'section', section: secInfo });
    let content = '';
    for (let attempt = 0; attempt < 2 && !content; attempt++) {
      try {
        const r = await chat(
          buildDeepReadSectionMessages({
            source,
            figures,
            plan,
            index: i,
            prevMd: prev,
            evidence: [],
            globalContext: context,
            researchMap: null,
            role: 'general',
          }),
          12000,
        );
        content = String(r.content || '').trim();
        if (r.reasoning) reasoningParts.push(r.reasoning);
      } catch {
        /* 单节失败，重试一次 */
      }
    }
    if (!content) content = `## ${plan[i].title}\n\n（本节生成失败已跳过——可重试或换更强的模型。）`;
    sections.push(content);
    onProgress?.({ stage: 'section_done', section: secInfo });
    prev = `${prev}\n\n${content}`.slice(-9000);
  }

  onProgress?.({ stage: 'merge' });
  const merged = sections.join('\n\n').replace(/^(## [^\n]+)\n\n(?=## \1\n)/gm, '');
  return {
    markdown: `# ${source.title || '深度解读'}\n\n${merged}`.trim() + '\n',
    reasoning: reasoningParts.join('\n\n---\n\n'),
  };
}

/** 整篇单次生成（+ 可选审校）。 */
export async function deepReadSinglePass({ chat, source, figures, onProgress, context = '', review = true }) {
  onProgress?.({ stage: 'section', section: { index: 1, total: 1, title: '整篇生成' } });
  const first = await chat(buildDeepReadMessages(source, figures, { extraContext: context }), 16000);
  let content = first.content || '';

  if (review && content) {
    onProgress?.({ stage: 'audit' });
    try {
      const styleHint = styleWarningsForPrompt(content, 'deepread');
      const res = await chat(
        buildDeepReviewMessages(source, content, styleHint, { evidenceText: context }),
        reviewBudgetTokens(content),
      );
      const verdict = acceptReview(content, res?.content);
      if (verdict.ok && isChineseText(res.content)) content = res.content;
      else if (res?.content) console.warn('[deepread/review] 丢弃审校结果：', verdict.reason || '非中文输出');
    } catch {
      /* 审校失败，用原稿 */
    }
  }

  return {
    markdown: content || '',
    reasoning: first.reasoning || '',
    style: checkStyle(content || '', 'deepread'),
  };
}

/** 粗略判断文本是否以中文为主（避免审校输出英文覆盖中文稿）。 */
export function isChineseText(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
  return cjk >= 20;
}
