/**
 * 流空闲看门狗：两个协议适配器共用。
 * 超过 idleMs 没有任何 SSE 数据到达时 abort 内部 controller，
 * 适配器据此把停滞的流按 SERVER（可重试）错误终结，而不是无限挂起。
 */

export interface IdleController {
  /** 传给 fetch / SSE 解析器的中止信号 */
  readonly signal: AbortSignal;
  /** 每收到一个数据块调用一次，重置计时 */
  touch(): void;
  /** 是否因空闲超时而中止（区别于外部 signal abort） */
  timedOut(): boolean;
  /** 清理计时器与监听 */
  dispose(): void;
}

export function createIdleController(
  idleMs: number,
  outerSignal?: AbortSignal,
  onTimeout?: () => void,
): IdleController {
  const controller = new AbortController();
  let timeout = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timeout = true;
      onTimeout?.();
      controller.abort(new Error(`stream idle for ${idleMs}ms`));
    }, idleMs);
    // 不要让看门狗计时器阻止进程退出
    (timer as { unref?: () => void }).unref?.();
  };
  arm();

  const onOuterAbort = () => controller.abort(outerSignal?.reason);
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort(outerSignal.reason);
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }

  return {
    signal: controller.signal,
    touch: arm,
    timedOut: () => timeout,
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      outerSignal?.removeEventListener('abort', onOuterAbort);
    },
  };
}

/** 包装一个 AsyncIterable，每产出一条数据调用一次 onEach（喂看门狗） */
export async function* tapEach<T>(source: AsyncIterable<T>, onEach: () => void): AsyncGenerator<T> {
  for await (const item of source) {
    onEach();
    yield item;
  }
}
