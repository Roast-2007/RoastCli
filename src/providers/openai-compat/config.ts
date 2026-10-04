/**
 * openai-compat driver 的 profile 解析：一次性完成校验与默认值落地，
 * 运行时（stream 路径）不再散落 `?? default`。
 */
import { defaultBaseURL, type ModelMeta, type ProviderProfile } from '../../core/config.js';
import { RoastError } from '../../core/errors.js';

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

export interface ResolvedAdapterOptions {
  baseURL: string;
  headers: Record<string, string>;
  streamIdleTimeoutMs: number;
  models: Record<string, ModelMeta> | undefined;
}

export function resolveAdapterOptions(profile: ProviderProfile, providerName: string): ResolvedAdapterOptions {
  if (profile.driver !== 'openai-compat') {
    throw new RoastError(
      'CONFIG',
      `provider "${providerName}" 的 driver 是 "${profile.driver}"，不能用 openai-compat 适配器`,
    );
  }
  return {
    baseURL: profile.baseURL ?? defaultBaseURL('openai-compat'),
    headers: { ...profile.headers },
    streamIdleTimeoutMs: profile.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    models: profile.models,
  };
}
