/**
 * RoutedProvider：多 agent 测试用。按请求首条 user 消息中的 [agent:<id>] 标记路由到各自的脚本序列；
 * 没有标记的请求视为主会话（id = main）。脚本可以是函数（读取请求后决定输出）。
 */
import type { GenerateOptions, StreamChunk } from '../../src/core/types.js';
import { RoastError } from '../../src/core/errors.js';
import type { ProviderAdapter } from '../../src/providers/adapter.js';
import type { RecordedRequest, Script } from './scripted-provider.js';

export function agentOf(req: RecordedRequest): string {
  const first = req.messages[0];
  const text = first?.content.find((b) => b.type === 'text');
  const m = text && text.type === 'text' ? /\[agent:([\w-]+)\]/.exec(text.text) : null;
  return m ? m[1]! : 'main';
}

export class RoutedProvider implements ProviderAdapter {
  readonly driver = 'routed';
  readonly requests: { agent: string; req: RecordedRequest }[] = [];
  private readonly cursors = new Map<string, number>();

  constructor(private readonly scripts: Record<string, Script[]>) {}

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const { signal: _s, ...rest } = options;
    const agent = agentOf(rest);
    this.requests.push({ agent, req: rest });
    const i = this.cursors.get(agent) ?? 0;
    this.cursors.set(agent, i + 1);
    const script = this.scripts[agent]?.[i];
    if (!script) {
      yield { type: 'finish', reason: 'error', error: new RoastError('UNKNOWN', `agent ${agent} 的脚本耗尽（第 ${i + 1} 次请求）`) };
      return;
    }
    for (const c of typeof script === 'function' ? script(rest, i) : script) yield c;
  }
}
