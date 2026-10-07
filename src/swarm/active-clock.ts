/** 等待任意用户交互时暂停；各个计时预算使用自己的起点。 */
export class ActiveClock {
  private pausedAt: number | undefined;
  private readonly pauses: { start: number; end: number }[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly now: () => number) {}

  setPaused(paused: boolean): void {
    if (paused === (this.pausedAt !== undefined)) return;
    if (paused) this.pausedAt = this.now();
    else {
      this.pauses.push({ start: this.pausedAt!, end: this.now() });
      this.pausedAt = undefined;
    }
    for (const listener of this.listeners) listener();
  }

  elapsed(since: number): number {
    const now = this.now();
    let paused = this.pausedAt === undefined ? 0 : Math.max(0, now - Math.max(since, this.pausedAt));
    for (const p of this.pauses) paused += Math.max(0, Math.min(now, p.end) - Math.max(since, p.start));
    return Math.max(0, now - since - paused);
  }

  timeout(since: number, limit: number, done: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ended = false;
    const arm = () => {
      clearTimeout(timer);
      if (ended || this.pausedAt !== undefined || !Number.isFinite(limit)) return;
      timer = setTimeout(
        () => {
          if (this.elapsed(since) < limit) {
            arm();
            return;
          }
          cancel();
          done();
        },
        Math.max(0, limit - this.elapsed(since)),
      );
    };
    const cancel = () => {
      ended = true;
      clearTimeout(timer);
      this.listeners.delete(arm);
    };
    this.listeners.add(arm);
    arm();
    return cancel;
  }
}
