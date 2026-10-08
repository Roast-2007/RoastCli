import { fstatSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { RoastError } from '../core/errors.js';

/** -p 已带任务时，最多等这么久收到管道输入的第一个字节；避免 CI 中从不关闭的 stdin 卡住运行 */
export const STDIN_FIRST_BYTE_MS = 3000;
const MAX_STDIN_BYTES = 10 * 1024 * 1024;

/**
 * 读取管道 / 重定向输入。TTY 与字符设备（NUL、/dev/null）不读。
 * Windows 的匿名管道在 fstat 中既不是 FIFO 也不是文件，所以按"不是字符设备"判断，而不是按 FIFO 判断。
 * 给了 waitMs 时，超时仍没有第一个字节就放弃读取并调用 onSkip；数据开始到达后一直读到 EOF。
 */
export async function readPipedStdin(opts: {
  stdin: AsyncIterable<string | Buffer> & { isTTY?: boolean; destroy?(): unknown };
  fstat?: (fd: number) => Pick<Stats, 'isCharacterDevice'>;
  maxBytes?: number;
  waitMs?: number;
  onSkip?(): void;
}): Promise<string | undefined> {
  if (opts.stdin.isTTY) return undefined;
  try {
    if ((opts.fstat ?? fstatSync)(0).isCharacterDevice()) return undefined;
  } catch {
    return undefined;
  }
  const iterator = opts.stdin[Symbol.asyncIterator]();
  let next = iterator.next();
  if (opts.waitMs !== undefined) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), opts.waitMs);
    });
    const first = await Promise.race([next, timeout]);
    clearTimeout(timer);
    if (first === 'timeout') {
      // 挂起中的 next() 会让 iterator.return() 一直排队，直接销毁 stdin，不再占住事件循环
      opts.stdin.destroy?.();
      opts.onSkip?.();
      return undefined;
    }
    next = Promise.resolve(first);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for (let result = await next; !result.done; result = await iterator.next()) {
    const buffer = Buffer.isBuffer(result.value) ? result.value : Buffer.from(result.value);
    bytes += buffer.length;
    if (bytes > (opts.maxBytes ?? MAX_STDIN_BYTES)) {
      opts.stdin.destroy?.();
      throw new RoastError('INVALID_REQUEST', '管道输入超过 10 MiB');
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks)
    .toString('utf8')
    .replace(/^\uFEFF/, '');
  return text.trim() ? text : undefined;
}

/** 管道模式的最终输入：有任务时 stdin 作为附带材料，没有任务时 stdin 就是任务 */
export async function promptWithStdin(prompt: string, stdin: NodeJS.ReadStream, warn: (text: string) => void): Promise<string> {
  const input = await readPipedStdin({
    stdin,
    ...(prompt.trim()
      ? {
          waitMs: STDIN_FIRST_BYTE_MS,
          onSkip: () =>
            warn(`[${STDIN_FIRST_BYTE_MS / 1000} 秒内没有收到管道输入，已忽略 stdin；慢命令请先输出到文件，再用 < 文件 传入]\n`),
        }
      : {}),
  });
  return combinePrompt(prompt, input);
}

export function combinePrompt(prompt: string, input?: string): string {
  return input === undefined ? prompt : prompt === '' ? input : `${prompt}\n\n<stdin>\n${input}\n</stdin>`;
}
