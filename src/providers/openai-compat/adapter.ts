/**
 * OpenAI 兼容协议适配器（DeepSeek / OpenAI / 任意兼容端点共用）。
 *
 * stream() 流程：每次调用时 resolveApiKey() 取密钥 → POST {baseURL}/chat/completions
 * （stream:true, stream_options:{include_usage:true}）→ HTTP 非 2xx 归一化为 finish error →
 * 正常路径 pipe parseSse → translate。流空闲看门狗超过 streamIdleTimeoutMs 无数据按
 * SERVER 错误终结；外部 abort → finish 'aborted'。任何路径恰好产出一个 finish chunk。
 */
import type { GenerateOptions, StreamChunk } from '../../core/types.js';
import { VERSION } from '../../core/version.js';
import { resolveApiKey, type ProviderProfile } from '../../core/config.js';
import { RoastError, asRoastError, httpErrorCode, isRetryableCode, parseRetryAfter } from '../../core/errors.js';

const retryAfterOf = (response: Response): number | undefined => parseRetryAfter(response.headers);
import type { ModelInfo, ProviderAdapter } from '../adapter.js';
import { createIdleController, tapEach } from '../idle.js';
import { resolveAdapterOptions, type ResolvedAdapterOptions } from './config.js';
import { buildRequest, defaultMaxTokensField } from './request.js';
import { parseSse } from './sse.js';
import { translate, type WireChunk } from './translate.js';

export class OpenAICompatAdapter implements ProviderAdapter {
  readonly driver = 'openai-compat';
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

  private requestBody(options: GenerateOptions): Record<string, unknown> {
    const meta = this.options.models?.[options.model];
    return buildRequest(options, meta?.reasoningReplay ?? 'drop', meta?.maxTokensField ?? defaultMaxTokensField(options.model), meta?.reasoningEffort);
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
      const response = await fetch(`${this.options.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': `RoastCli/${VERSION}`,
          authorization: `Bearer ${apiKey}`,
          ...this.options.headers,
        },
        body: JSON.stringify(this.requestBody(options)),
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

      const chunks = tapEach(parseSse(response.body, idle.signal), () => idle.touch());
      yield* translate(chunks as AsyncIterable<WireChunk>);
    } finally {
      idle.dispose();
    }
  }
}
