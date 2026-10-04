/**
 * OpenAI 兼容协议的 SSE 解析（裸实现，不依赖 eventsource-parser）。
 *
 * 帧规则：
 * - 以空行分隔事件；`data:` 行为数据，多行 data 以 "\n" 拼接
 * - 以 ":" 开头的是注释行（心跳），跳过
 * - `event:` / `id:` / `retry:` 字段对本协议无意义，忽略
 * - 字面量 `data: [DONE]` 为终止哨兵，解析器在其后停止
 *
 * 产出的是 JSON.parse 后的 data 对象；EOF 前未见到 [DONE] 视为截断，抛 SERVER 错误。
 */
import { RoastError } from '../../core/errors.js';

export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let dataLines: string[] = [];
  let sawDone = false;
  const pending: unknown[] = [];

  const handleLine = (rawLine: string): void => {
    let line = rawLine;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line === '') {
      // 事件分隔符：派发累积的 data
      if (dataLines.length === 0) return;
      const data = dataLines.join('\n');
      dataLines = [];
      if (data === '[DONE]') {
        sawDone = true;
        return;
      }
      try {
        pending.push(JSON.parse(data));
      } catch {
        throw new RoastError('SERVER', `无法解析的 SSE 数据: ${data.slice(0, 120)}`);
      }
      return;
    }
    if (line.startsWith(':')) return; // 注释 / 心跳
    if (line.startsWith('data:')) {
      let value = line.slice(5);
      if (value.startsWith(' ')) value = value.slice(1);
      dataLines.push(value);
    }
    // 其他字段（event:/id:/retry:）忽略
  };

  try {
    while (!sawDone) {
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
        while (pending.length > 0) yield pending.shift();
        if (sawDone) break;
      }
    }
    // EOF：冲刷尾部未以 \n 结尾的行与未派发的事件
    if (!sawDone && buffer.trim() !== '') handleLine(buffer);
    if (!sawDone && dataLines.length > 0) handleLine('');
    while (pending.length > 0) yield pending.shift();
  } finally {
    reader.releaseLock();
    if (!sawDone) await reader.cancel().catch(() => {});
  }

  if (!sawDone) {
    throw new RoastError('SERVER', 'SSE 流在 [DONE] 之前结束（响应被截断）', { retryable: true });
  }
}
