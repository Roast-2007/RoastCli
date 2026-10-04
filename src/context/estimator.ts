/**
 * Token 估算：
 * - 启发式：CJK 字符约 1 token/字，其他约 4 字符/token，结构开销按块计
 * - 校准：用 provider 返回的真实 usage 做 EMA，系数按 provider:model 区分
 * - 锚点 + 增量：最近一次请求的真实 tokens + 其后新增消息的估算（见 controller）
 */
import type { ContentBlock, Message } from '../core/types.js';

const CJK = /[⺀-鿿가-힯豈-﫿＀-￯　-〿]/g;
const BLOCK_OVERHEAD = 4;
const MESSAGE_OVERHEAD = 4;

export function estimateText(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = text.length - cjk;
  return cjk + Math.ceil(rest / 4);
}

export function estimateBlock(b: ContentBlock): number {
  switch (b.type) {
    case 'text':
    case 'reasoning':
      return BLOCK_OVERHEAD + estimateText(b.text);
    case 'tool-call':
      return BLOCK_OVERHEAD + estimateText(b.name) + estimateText(JSON.stringify(b.args ?? {}));
    case 'tool-result':
      return BLOCK_OVERHEAD + b.content.reduce((n, c) => n + estimateBlock(c), 0);
    case 'image':
      return 1500;
  }
}

export function estimateMessage(m: Message): number {
  return MESSAGE_OVERHEAD + m.content.reduce((n, b) => n + estimateBlock(b), 0);
}

export function estimateMessages(ms: readonly Message[]): number {
  return ms.reduce((n, m) => n + estimateMessage(m), 0);
}

/** 估算值 → 真实值 的校准系数（EMA） */
export class Calibrator {
  private k = 1;

  constructor(private readonly alpha = 0.3) {}

  get factor(): number {
    return this.k;
  }

  /** k ← k + α·(实际/估算 − k)，初值 1 */
  observe(estimated: number, actual: number): void {
    if (estimated <= 0 || actual <= 0) return;
    this.k += this.alpha * (actual / estimated - this.k);
  }

  adjust(estimated: number): number {
    return Math.round(estimated * this.k);
  }
}
