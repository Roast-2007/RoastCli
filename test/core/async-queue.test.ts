import { describe, expect, it } from 'vitest';
import { AsyncQueue } from '../../src/core/async-queue.js';

async function drain<T>(q: AsyncQueue<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of q) out.push(item);
  return out;
}

describe('AsyncQueue', () => {
  it('按顺序产出 push 的元素，close 后结束', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    setTimeout(() => {
      q.push(3);
      q.close();
    }, 5);
    expect(await drain(q)).toEqual([1, 2, 3]);
  });

  it('close(err) 在缓冲耗尽后让迭代抛出该错误', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.close(new Error('boom'));
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const x of q) seen.push(x);
      })(),
    ).rejects.toThrow('boom');
    expect(seen).toEqual([1]);
  });

  it('close 之后 push 被忽略', async () => {
    const q = new AsyncQueue<number>();
    q.close();
    q.push(1);
    expect(await drain(q)).toEqual([]);
  });

  it('消费者等待时 close 能唤醒它', async () => {
    const q = new AsyncQueue<string>();
    const p = drain(q);
    await new Promise((r) => setTimeout(r, 5));
    q.close();
    expect(await p).toEqual([]);
  });
});

describe('AsyncQueue 单消费者约束', () => {
  it('第二个并发消费者直接报错，而不是让第一个永久挂起', async () => {
    const q = new AsyncQueue<number>();
    const it1 = q[Symbol.asyncIterator]();
    const p1 = it1.next();
    const it2 = q[Symbol.asyncIterator]();
    await expect(it2.next()).rejects.toThrow(/单消费者/);
    q.push(1);
    expect(await p1).toEqual({ value: 1, done: false });
  });
});
