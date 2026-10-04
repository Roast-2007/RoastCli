/**
 * Anthropic /v1/messages 协议适配器。
 *
 * stream() 流程与 openai-compat 适配器同构：每次调用时 resolveApiKey() →
 * POST {baseURL}/v1/messages（x-api-key + anthropic-version 头）→ HTTP 非 2xx 归一化为
 * finish error → parseSse → translate。空闲看门狗 / abort / 恰好一个 finish 的纪律相同。
 *
 * 请求体构建见 request.ts（纯函数，含 thinking 签名回放）。
 */
import type { GenerateOptions, StreamChunk } from '../../core/types.js';
import { VERSION } from '../../core/version.js';
import { resolveApiKey, type ProviderProfile } from '../../core/config.js';
import { RoastError, asRoastError, httpErrorCode, isRetryableCode, parseRetryAfter } from '../../core/errors.js';

const retryAfterOf = (response: Response): number | undefined => parseRetryAfter(response.headers);
import type { ModelInfo, ProviderAdapter } from '../adapter.js';
import { createIdleController, tapEach } from '../idle.js';
import { ANTHROPIC_VERSION, resolveAdapterOptions, type ResolvedAdapterOptions } from './config.js';
import { buildRequest } from './request.js';
import { parseSse } from './sse.js';
import { translate } from './translate.js';

/** 模型配置了 thinkingBudget 时开启 extended thinking */
function thinkingOf(profile: ProviderProfile, model: string) {
  const meta = profile.models?.[model];
  return { thinkingBudget: meta?.thinkingBudget, reasoningEffort: meta?.reasoningEffort };
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly driver = 'anthropic';
  private readonly options: ResolvedAdapterOptions;

  constructor(
    private readonly profile: ProviderProfile,
    private readonly providerName: string,
  ) {
    this.options = resolveAdapterOptions(profile, providerName);
  }

  resolveModel(model: string): ModelInfo | undefined {
    const meta = this.options.models?.[model];
    if (!meta) return undefined;
    const info: ModelInfo = { id: model };
    if (meta.contextWindow !== undefined) info.contextWindow = meta.contextWindow;
    if (meta.maxTokens !== undefined) info.maxTokens = meta.maxTokens;
    return info;
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const state = { idleTimedOut: false };
    try {
      yield* this.run(options, state);
    } catch (err) {
      if (state.idleTimedOut) {
        yield {
          type: 'finish',
          reason: 'error',
          error: new RoastError('SERVER', `流空闲超过 ${this.options.streamIdleTimeoutMs}ms，已终止`, {
            retryable: true,
          }),
        };
        return;
      }
      const error = asRoastError(err);
      if (error.code === 'ABORTED') {
        yield { type: 'finish', reason: 'aborted', error };
      } else {
        yield { type: 'finish', reason: 'error', error };
      }
    }
  }

  private async *run(
    options: GenerateOptions,
    state: { idleTimedOut: boolean },
  ): AsyncGenerator<StreamChunk> {
    const apiKey = resolveApiKey(this.profile, this.providerName);
    const idle = createIdleController(this.options.streamIdleTimeoutMs, options.signal, () => {
      state.idleTimedOut = true;
    });
    try {
      const response = await fetch(`${this.options.baseURL}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'user-agent': `RoastCli/${VERSION}`,
          'anthropic-version': ANTHROPIC_VERSION,
          ...this.options.headers,
        },
        body: JSON.stringify(buildRequest(options, { promptCaching: this.profile.promptCaching !== false, ...thinkingOf(this.profile, options.model) })),
        signal: idle.signal,
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        const code = httpErrorCode(response.status, bodyText);
        yield {
          type: 'finish',
          reason: 'error',
          error: new RoastError(
            code,
            `provider "${this.providerName}" 返回 HTTP ${response.status}: ${bodyText.slice(0, 500)}`,
            {
              retryable: isRetryableCode(code),
              status: response.status,
              ...(retryAfterOf(response) !== undefined ? { retryAfterMs: retryAfterOf(response) } : {}),
            },
          ),
        };
        return;
      }

      if (!response.body) {
        throw new RoastError('SERVER', '响应缺少 body，无法流式读取');
      }

      const events = tapEach(parseSse(response.body, idle.signal), () => idle.touch());
      yield* translate(events);
    } finally {
      idle.dispose();
    }
  }
}
