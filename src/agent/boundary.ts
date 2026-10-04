/**
 * Step 边界钩子：运行时在每个 step 发请求前、以及模型"想结束 turn"时询问外部。
 * - beforeRequest：返回要注入的附件（提醒、inbox 等，追加到末尾 user 消息并落日志）
 * - onWouldEndTurn：模型没有工具调用时决定 end / continue / wait（等待期间不耗 token）
 * 上下文策略（M3）、mailbox 投递（M5）都挂在这里，运行时本体不感知具体来源。
 */
import type { ContentBlock, Message } from '../core/types.js';

export interface BoundaryCtx {
  agentId: string;
  turn: number;
  step: number;
  signal: AbortSignal;
  messages(): readonly Message[];
}

export interface InjectAction {
  kind: 'inject';
  source: string;
  blocks: ContentBlock[];
}

/** 仅给 UI 的提示（不进入模型上下文），如"上下文已压缩" */
export interface NoticeAction {
  kind: 'notice';
  text: string;
}

export type BoundaryAction = InjectAction | NoticeAction;

export type EndTurnDecision =
  | { kind: 'end' }
  /** 有新内容可供模型处理（如 inbox 已就绪）：继续下一个 step */
  | { kind: 'continue' }
  /** 不发请求、不耗 token 地等待，结束后再次询问 */
  | { kind: 'wait'; reason: string; until: Promise<unknown> };

export interface BoundaryHooks {
  beforeRequest?(ctx: BoundaryCtx): BoundaryAction[] | Promise<BoundaryAction[]>;
  onWouldEndTurn?(ctx: BoundaryCtx): EndTurnDecision | Promise<EndTurnDecision>;
  /** 请求因上下文超长被拒：尝试缩减（如强制压缩），返回 true 表示已缩减、可重试一次 */
  onOverflow?(ctx: BoundaryCtx): Promise<boolean>;
}

/** 组合多个钩子：beforeRequest 依次执行并拼接动作；onWouldEndTurn 取第一个非 end 决定；onOverflow 任一成功即成功 */
export function composeBoundary(...hooks: (BoundaryHooks | undefined)[]): BoundaryHooks {
  const list = hooks.filter((h): h is BoundaryHooks => h !== undefined);
  return {
    async beforeRequest(ctx) {
      const out: BoundaryAction[] = [];
      for (const h of list) out.push(...((await h.beforeRequest?.(ctx)) ?? []));
      return out;
    },
    async onWouldEndTurn(ctx) {
      for (const h of list) {
        const d = await h.onWouldEndTurn?.(ctx);
        if (d && d.kind !== 'end') return d;
      }
      return { kind: 'end' };
    },
    async onOverflow(ctx) {
      for (const h of list) if (await h.onOverflow?.(ctx)) return true;
      return false;
    },
  };
}

/** 可被 signal 打断的等待；打断时 resolve（调用方检查 signal.aborted） */
export function abortable(promise: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      signal.removeEventListener('abort', done);
      resolve();
    };
    signal.addEventListener('abort', done, { once: true });
    promise.then(done, done);
  });
}
