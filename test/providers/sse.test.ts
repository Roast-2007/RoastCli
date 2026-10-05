import { describe, expect, it, vi } from 'vitest';
import { parseSse } from '../../src/providers/openai-compat/sse.js';

function stream(text: string, size = 1) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  });
}
async function collect(input: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const out: unknown[] = [];
  for await (const item of parseSse(input, signal)) out.push(item);
  return out;
}
describe('SSE framing and lifetime', () => {
  it.each([1, 2, 7, 1000])('decodes UTF-8, CRLF and multiline data in %i-byte chunks', async (size) => {
    expect(
      await collect(stream(':heartbeat\r\nevent: chunk\r\ndata: {"text":\r\ndata: "中文👩‍💻"}\r\n\r\ndata: [DONE]\r\n\r\n', size)),
    ).toEqual([{ text: '中文👩‍💻' }]);
  });
  it('accepts a final DONE without a trailing newline and ignores data after DONE', async () => {
    expect(await collect(stream('data: {"a":1}\n\ndata: [DONE]'))).toEqual([{ a: 1 }]);
    expect(await collect(stream('data: [DONE]\n\ndata: invalid\n\n', 1000))).toEqual([]);
  });
  it('rejects incomplete JSON and a stream without DONE', async () => {
    await expect(collect(stream('data: {"a":'))).rejects.toMatchObject({ code: 'SERVER' });
    await expect(collect(stream('data: {"a":1}\n\n'))).rejects.toMatchObject({ code: 'SERVER', retryable: true });
  });
  it('cancels a blocked read when aborted and cancels the source when the consumer stops', async () => {
    const abort = new AbortController(),
      cancelled = vi.fn();
    const blocked = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const work = collect(blocked, abort.signal);
    abort.abort();
    await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toHaveBeenCalled();
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"a":1}\n\n'));
      },
      cancel,
    });
    for await (const _ of parseSse(source)) break;
    expect(cancel).toHaveBeenCalled();
  });
});
