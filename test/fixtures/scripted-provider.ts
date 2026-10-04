/**
 * ScriptedProvider：确定性 provider 测试替身。
 * - 每次 stream() 取下一段脚本（数组或按请求生成的函数）
 * - 记录每次请求（去掉 signal）
 * - 感知 abort：发 chunk 前检查 signal，已中断则以 finish aborted 收尾
 * - 可选 chunk 间延迟，用于制造"流进行中"的时间窗
 */
import type { GenerateOptions, StreamChunk } from '../../src/core/types.js';
import { RoastError } from '../../src/core/errors.js';
import type { ModelInfo, ProviderAdapter } from '../../src/providers/adapter.js';

export type RecordedRequest = Omit<GenerateOptions, 'signal'>;
export type Script = StreamChunk[] | ((req: RecordedRequest, index: number) => StreamChunk[]);

export interface ScriptedProviderOptions {
  chunkDelayMs?: number;
  models?: Record<string, ModelInfo>;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export class ScriptedProvider implements ProviderAdapter {
  readonly driver = 'scripted';
  readonly requests: RecordedRequest[] = [];
  private readonly scripts: Script[];
  private cursor = 0;

  constructor(
    scripts: Script[],
    private readonly options: ScriptedProviderOptions = {},
  ) {
    this.scripts = [...scripts];
  }

  /** 剩余未消费的脚本数 */
  remaining(): number {
    return this.scripts.length - this.cursor;
  }

  resolveModel(model: string): ModelInfo | undefined {
    return this.options.models?.[model];
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const { signal, ...rest } = options;
    this.requests.push(rest);
    const index = this.cursor++;
    const script = this.scripts[index];
    if (!script) {
      yield { type: 'finish', reason: 'error', error: new RoastError('UNKNOWN', `scripted provider 脚本耗尽（第 ${index + 1} 次请求）`) };
      return;
    }
    const chunks = typeof script === 'function' ? script(rest, index) : script;
    for (const chunk of chunks) {
      if (this.options.chunkDelayMs) await sleep(this.options.chunkDelayMs, signal);
      if (signal?.aborted) {
        yield { type: 'finish', reason: 'aborted', error: new RoastError('ABORTED', '请求被中断') };
        return;
      }
      yield chunk;
    }
  }
}
