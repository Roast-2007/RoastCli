/**
 * InteractionBroker：运行时需要用户介入时（权限审批、ask_user 提问）的中转站。
 * 工具/钩子 request() 拿到 Promise；UI 通过 onRequest 订阅并在用户作答后 respond()。
 * 没有任何订阅者（管道模式 / 无界面）时，请求立即以 noInteractive 兜底结果返回。
 * 多 agent 时请求带 agentId，Mission Control 可集中排队处理。
 * 带 countdownMs 的权限请求（帮我审批）在界面显示后开始倒计时，到时以 timedOut 拒绝；
 * 用户在审批卡上操作时暂停，等待明确作答。
 */
import { randomBytes } from 'node:crypto';
import { RoastError } from './errors.js';

export type InteractionRequestBody =
  | {
      kind: 'permission';
      agentId: string;
      tool: string;
      /** 一行标题，如 "bash: npm install" */
      title: string;
      /** 详细内容（完整命令 / 文件路径 / diff 预览） */
      detail?: string;
      preview?: string[];
      fullDetail?: string;
      reason: string;
      suggestedRule?: string;
      suggestedRules?: string[];
      /** 每次必须明确授权：不提供"始终允许" */
      forced?: boolean;
      /** 帮我审批：显示后倒计时，到时自动拒绝 */
      countdownMs?: number;
    }
  | { kind: 'question'; agentId: string; question: string; options?: string[] };

export type InteractionRequest = InteractionRequestBody & {
  id: string;
  /** 倒计时开始后：自动拒绝的时刻（epoch 毫秒） */
  deadline?: number;
  /** 用户已开始操作，倒计时暂停（优先于 deadline） */
  paused?: boolean;
};

export type InteractionResponse =
  | { kind: 'permission'; decision: 'allow' | 'deny'; remember?: 'session' | 'project'; feedback?: string; timedOut?: boolean }
  | { kind: 'question'; answer: string }
  /** 无交互界面时的兜底 */
  | { kind: 'unavailable' };

type Listener = (req: InteractionRequest) => void;

interface Pending {
  req: InteractionRequest;
  resolve: (r: InteractionResponse) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const countdownOf = (req: InteractionRequest) => (req.kind === 'permission' ? req.countdownMs : undefined);

export class InteractionBroker {
  private readonly listeners = new Set<Listener>();
  private readonly changeListeners = new Set<() => void>();
  private readonly waiting = new Map<string, Pending>();

  onRequest(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Lifecycle observers do not themselves provide an interactive approval interface. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.changeListeners) listener();
  }

  get interactive(): boolean {
    return this.listeners.size > 0;
  }

  pending(): InteractionRequest[] {
    return [...this.waiting.values()].map((p) => p.req);
  }

  request(body: InteractionRequestBody, signal: AbortSignal): Promise<InteractionResponse> {
    if (!this.interactive) return Promise.resolve({ kind: 'unavailable' });
    if (signal.aborted) return Promise.reject(new RoastError('ABORTED', '等待用户响应时被中断'));
    const req = { ...body, id: randomBytes(4).toString('hex') } as InteractionRequest;
    return new Promise<InteractionResponse>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(this.waiting.get(req.id)?.timer);
        this.waiting.delete(req.id);
        this.changed();
        reject(new RoastError('ABORTED', '等待用户响应时被中断'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.set(req.id, {
        req,
        resolve: (r) => {
          signal.removeEventListener('abort', onAbort);
          resolve(r);
        },
      });
      this.changed();
      for (const l of this.listeners) l(req);
    });
  }

  respond(id: string, response: InteractionResponse): boolean {
    const p = this.waiting.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.waiting.delete(id);
    this.changed();
    p.resolve(response);
    return true;
  }

  /** 界面已显示这条请求：带倒计时的请求开始计时（只开始一次，暂停后不再恢复） */
  shown(id: string): void {
    const p = this.waiting.get(id);
    const ms = p && countdownOf(p.req);
    if (!p || ms === undefined || p.req.deadline !== undefined || p.req.paused) return;
    p.req = { ...p.req, deadline: Date.now() + ms };
    p.timer = setTimeout(() => this.respond(id, { kind: 'permission', decision: 'deny', timedOut: true }), ms);
    p.timer.unref?.();
    this.changed();
  }

  /** 用户开始操作审批卡：暂停倒计时，等待明确作答 */
  hold(id: string): void {
    const p = this.waiting.get(id);
    if (!p || countdownOf(p.req) === undefined || p.req.paused) return;
    clearTimeout(p.timer);
    p.req = { ...p.req, paused: true };
    this.changed();
  }
}
