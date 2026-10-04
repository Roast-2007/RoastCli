/**
 * Anthropic /v1/messages 的 SSE 解析（裸实现）。
 *
 * 与 OpenAI 协议的差别：
 * - 每个事件带 `event:` 字段（message_start / content_block_delta / ...），需要透传
 * - 没有 [DONE] 哨兵；message_stop 后流自然结束，EOF 即终止
 * - 注释行（":" 开头，Anthropic 用作心跳）跳过；多行 data 以 "\n" 拼接
 *
 * 产出 { event, data }（data 为 JSON.parse 后的对象）；是否截断由 translate 判断。
 */
import { RoastError } from '../../core/errors.js';

export interface AnthropicSseEvent {
  event: string;
  data: unknown;
}

export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<AnthropicSseEvent> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let dataLines: string[] = [];
  let eventField: string | null = null;
  const pending: AnthropicSseEvent[] = [];

  const handleLine = (rawLine: string): void => {
    let line = rawLine;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line === '') {
      if (dataLines.length === 0) {
        eventField = null;
        return;
      }
      const data = dataLines.join('\n');
      const event = eventField ?? 'message';
      dataLines = [];
      eventField = null;
      try {
        pending.push({ event, data: JSON.parse(data) });
      } catch {
        throw new RoastError('SERVER', `无法解析的 SSE 数据 (event=${event}): ${data.slice(0, 120)}`);
      }
      return;
    }
    if (line.startsWith(':')) return; // 注释 / 心跳
    if (line.startsWith('event:')) {
      let value = line.slice(6);
      if (value.startsWith(' ')) value = value.slice(1);
      eventField = value;
      return;
    }
    if (line.startsWith('data:')) {
      let value = line.slice(5);
      if (value.startsWith(' ')) value = value.slice(1);
      dataLines.push(value);
    }
    // 其他字段（id:/retry:）忽略
  };

  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
        while (pending.length > 0) yield pending.shift()!;
      }
    }
    // EOF：冲刷尾部
    if (buffer.trim() !== '') handleLine(buffer);
    if (dataLines.length > 0) handleLine('');
    while (pending.length > 0) yield pending.shift()!;
  } finally {
    reader.releaseLock();
    await reader.cancel().catch(() => {});
  }
}
