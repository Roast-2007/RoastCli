/**
 * MessageBus：信封路由 + 防风暴（每分钟限流、去重、hop 上限、正文长度上限）。
 * 收件人解析由 Supervisor 提供（知道 agent 树）；投递到各自 Mailbox。
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Address, Envelope, EnvelopeKind } from './types.js';

export interface SendRequest {
  to: Address;
  kind: EnvelopeKind;
  subject: string;
  body: string;
  refs?: string[];
  replyTo?: string;
  hop?: number;
}

export type SendResult = { ok: true; id: string; recipients: string[] } | { ok: false; reason: 'rate' | 'route' | 'dup' | 'hop' | 'too-long' | 'forbidden' };

export interface BusOptions {
  perMinute?: number;
  maxHop?: number;
  maxBodyChars?: number;
  now?: () => number;
}

export interface BusDeps {
  /** 解析收件人；返回 null 表示路由被禁止（如非 Queen 广播） */
  resolve(from: string, to: Address): string[] | null;
  deliver(agentId: string, env: Envelope): void;
}

export class MessageBus {
  private readonly sent = new Map<string, number[]>();
  private readonly recent: string[] = [];
  private readonly listeners = new Set<(e: Envelope, recipients: string[]) => void>();
  private readonly perMinute: number;
  private readonly maxHop: number;
  private readonly maxBody: number;
  private readonly now: () => number;

  constructor(
    private readonly deps: BusDeps,
    opts: BusOptions = {},
  ) {
    this.perMinute = opts.perMinute ?? 30;
    this.maxHop = opts.maxHop ?? 4;
    this.maxBody = opts.maxBodyChars ?? 4000;
    this.now = opts.now ?? Date.now;
  }

  onSend(l: (e: Envelope, recipients: string[]) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  send(from: string, req: SendRequest): SendResult {
    const hop = req.hop ?? 0;
    if (hop > this.maxHop) return { ok: false, reason: 'hop' };
    if (req.body.length > this.maxBody) return { ok: false, reason: 'too-long' };
    const t = this.now();
    const window = (this.sent.get(from) ?? []).filter((x) => t - x < 60_000);
    if (window.length >= this.perMinute) return { ok: false, reason: 'rate' };
    const fp = createHash('sha1').update(`${from}|${req.kind}|${req.subject}|${req.body}`).digest('hex');
    if (this.recent.includes(fp)) return { ok: false, reason: 'dup' };
    const recipients = this.deps.resolve(from, req.to);
    if (recipients === null) return { ok: false, reason: 'forbidden' };
    const targets = recipients.filter((r) => r !== from);
    if (targets.length === 0) return { ok: false, reason: 'route' };

    this.sent.set(from, [...window, t]);
    this.recent.push(fp);
    if (this.recent.length > 200) this.recent.shift();
    const env: Envelope = {
      id: `m-${randomBytes(3).toString('hex')}`,
      from,
      to: req.to,
      kind: req.kind,
      subject: req.subject,
      body: req.body,
      refs: req.refs ?? [],
      ...(req.replyTo ? { replyTo: req.replyTo } : {}),
      hop,
      at: t,
    };
    for (const r of targets) this.deps.deliver(r, env);
    for (const l of this.listeners) l(env, targets);
    return { ok: true, id: env.id, recipients: targets };
  }
}
