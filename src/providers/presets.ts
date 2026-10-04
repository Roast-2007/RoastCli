import type { ModelMeta, ProviderProfile } from '../core/config.js';

export interface ProviderPreset {
  name: string;
  label: string;
  driver: ProviderProfile['driver'];
  baseURL: string;
  model: string;
  contextWindow?: number;
  modelMeta?: ModelMeta;
  note?: string;
}

/** Suggestions only: endpoint/model names remain editable and require no network lookup. */
export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  deepseek: { name: 'deepseek', label: 'DeepSeek', driver: 'openai-compat', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', contextWindow: 131_072 },
  qwen: { name: 'qwen', label: '通义千问 / 百炼', driver: 'openai-compat', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', note: '按账号区域调整地址，国际站可使用 dashscope-intl.aliyuncs.com。' },
  zhipu: { name: 'zhipu', label: '智谱 GLM', driver: 'openai-compat', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', note: 'Coding Plan 等套餐可能使用不同地址，请按服务商说明调整。' },
  kimi: { name: 'kimi', label: 'Kimi / Moonshot', driver: 'openai-compat', baseURL: 'https://api.moonshot.cn/v1', model: 'kimi-k2', note: '国际站可使用 api.moonshot.ai。' },
  'kimi-code': { name: 'kimi-code', label: 'Kimi Code', driver: 'openai-compat', baseURL: 'https://api.kimi.com/coding/v1', model: 'kimi-for-coding', contextWindow: 1_048_576, modelMeta: { reasoningReplay: 'field' }, note: '使用 Kimi Code API Key；支持 low / high / max 推理强度，模型与上下文按套餐调整。' },
  doubao: { name: 'doubao', label: '豆包 / 火山方舟', driver: 'openai-compat', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', model: '', note: '填写方舟控制台中实际可用的模型 ID 或 Endpoint ID（ep-…）。' },
  hunyuan: { name: 'hunyuan', label: '腾讯混元', driver: 'openai-compat', baseURL: 'https://api.hunyuan.cloud.tencent.com/v1', model: 'hunyuan-turbos-latest', note: '使用混元 API Key，而非腾讯云 SecretId / SecretKey。' },
  siliconflow: { name: 'siliconflow', label: '硅基流动', driver: 'openai-compat', baseURL: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-32B', note: '模型 ID 以控制台为准，国际站可使用 api.siliconflow.com。' },
  openai: { name: 'openai', label: 'OpenAI', driver: 'openai-compat', baseURL: 'https://api.openai.com/v1', model: 'gpt-5', contextWindow: 200_000 },
  anthropic: { name: 'claude', label: 'Claude / Anthropic', driver: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', contextWindow: 200_000 },
  gemini: { name: 'gemini', label: 'Google Gemini', driver: 'openai-compat', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-pro', note: '使用 Gemini 的 OpenAI 兼容接口。' },
  openrouter: { name: 'openrouter', label: 'OpenRouter', driver: 'openai-compat', baseURL: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5' },
  custom: { name: 'custom', label: '自定义 OpenAI 兼容端点', driver: 'openai-compat', baseURL: '', model: '' },
  'custom-anthropic': { name: 'custom-claude', label: '自定义 Anthropic 端点', driver: 'anthropic', baseURL: '', model: '' },
};
