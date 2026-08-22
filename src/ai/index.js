import { config } from '../config.js';
import { openAiCompatibleProvider } from './openaiProvider.js';

/**
 * Provider 统一接口：`generate({ source, limits }) => Promise<{title, titles, copy}>`
 *
 * 选择规则：
 * 1. LLM_PROVIDER=openai → 需配置 OPENAI_API_KEY
 * 2. 其余（默认 deepseek）→ 需配置 DEEPSEEK_API_KEY
 * 3. 未配置对应 key 时直接抛错，不做任何占位/示例文案。
 */
export function createProvider() {
  if (config.llmProvider === 'openai') {
    if (!config.openaiApiKey) {
      throw new Error(
        '未配置 OPENAI_API_KEY：请在 .env 中填写，或改用 LLM_PROVIDER=deepseek',
      );
    }
    return openAiCompatibleProvider({
      name: 'openai',
      apiKey: config.openaiApiKey,
      baseUrl: config.openaiBaseUrl,
      model: config.openaiModel,
    });
  }

  // 默认 deepseek
  if (!config.deepseekApiKey) {
    throw new Error(
      '未配置 AI 文案模型：请 cp .env.example .env 后填写 DEEPSEEK_API_KEY（或设 LLM_PROVIDER=openai + OPENAI_API_KEY）',
    );
  }
  return openAiCompatibleProvider({
    name: 'deepseek',
    apiKey: config.deepseekApiKey,
    baseUrl: config.deepseekBaseUrl,
    model: config.deepseekModel,
  });
}
