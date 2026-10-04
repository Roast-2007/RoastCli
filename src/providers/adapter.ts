/**
 * Provider 适配器接口。
 * 唯一必须实现的方法是 stream()；其余为可选元数据能力。
 * 适配器纪律（借鉴 deepseek-harness）：
 * - 连接事实（baseURL / apiKey / headers）在每次 stream() 调用时重新解析
 * - 任何失败（HTTP 错误、网络错误、abort）都必须归一化，且流必须以
 *   恰好一个 finish chunk（reason: 'error' | 'aborted'）终结
 */
import type { GenerateOptions, StreamChunk } from '../core/types.js';
import type { ModelRef, ProviderProfile } from '../core/config.js';
import { RoastError } from '../core/errors.js';

export interface ModelInfo {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface ProviderAdapter {
  /** driver 标识，如 'openai-compat' / 'anthropic' */
  readonly driver: string;
  /** 发起一次流式生成 */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
  /** 可选：列出该 profile 下可用模型 */
  listModels?(): Promise<ModelInfo[]>;
  /** 可选：解析模型元数据（上下文窗口等， advisory 用） */
  resolveModel?(model: string): ModelInfo | undefined;
}

/** 适配器工厂：一个 profile 实例化一个 adapter */
export type AdapterFactory = (profile: ProviderProfile, providerName: string) => ProviderAdapter;

/**
 * Provider 注册表：provider 路由键 → adapter。
 * 启动时按 config.providers 一次性组装。
 */
export class ProviderRegistry {
  private adapters = new Map<string, ProviderAdapter>();

  register(name: string, adapter: ProviderAdapter): void {
    this.adapters.set(name, adapter);
  }

  get(ref: ModelRef): ProviderAdapter {
    const adapter = this.adapters.get(ref.provider);
    if (!adapter) {
      const known = [...this.adapters.keys()].join(', ') || '(无)';
      throw new RoastError('NO_ADAPTER', `未注册的 provider "${ref.provider}"，已注册: ${known}`);
    }
    return adapter;
  }

  has(name: string): boolean {
    return this.adapters.has(name);
  }

  names(): string[] {
    return [...this.adapters.keys()];
  }
}
