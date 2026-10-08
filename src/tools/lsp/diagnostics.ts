import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { canonicalPath, isPathInside } from '../../core/paths.js';
import type { ToolResult, ToolServices } from '../tool.js';
import { newDiagnostics, type FileDiagnostic } from './diagnostics-diff.js';

export const DIAGNOSTICS_KEY = 'diagnostics';
export interface DiagnosticsConfig {
  enabled?: boolean;
  maxItems?: number;
  timeoutMs?: number;
}
export interface DiagnosticCheck {
  diagnostics?: FileDiagnostic[];
  error?: string;
  notice?: string;
}
export function diagnosticsConfig(file: string, root: string): string | undefined {
  if (!/\.[cm]?[jt]sx?$/.test(file) || !isPathInside(canonicalPath(root), file)) return undefined;
  for (let dir = path.dirname(file); isPathInside(canonicalPath(root), dir); dir = path.dirname(dir)) {
    for (const name of ['tsconfig.json', 'jsconfig.json']) if (existsSync(path.join(dir, name))) return path.join(dir, name);
    if (canonicalPath(dir) === canonicalPath(root) || path.dirname(dir) === dir) break;
  }
  return undefined;
}

export interface DiagnosticWorker {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (reply: { id: number } & DiagnosticCheck) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
  unref(): void;
}
const STOPPED_NOTICE = '诊断超时，本会话已停用自动诊断';
const MAX_TIMEOUTS = 3;

function defaultWorker(): DiagnosticWorker {
  const js = new URL('./diagnostics-worker.js', import.meta.url);
  return existsSync(js)
    ? new Worker(js)
    : new Worker(new URL('./diagnostics-worker.ts', import.meta.url), { execArgv: ['--import', 'tsx'] });
}

/**
 * 会话内唯一的诊断 worker：主会话与所有子 agent 共用，请求串行排队。
 * 每个 worker 都会加载整个 TS 项目，按成员各开一个会让内存随成员数膨胀。
 */
export class DiagnosticsWorkerClient {
  private worker?: DiagnosticWorker;
  private seq = 0;
  private timeouts = 0;
  private stoppedNotice?: string;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Map<number, (reply: DiagnosticCheck) => void>();
  stopped = false;
  constructor(
    private readonly timeoutMs = 8000,
    private readonly factory: () => DiagnosticWorker = defaultWorker,
  ) {}
  check(file: string, text: string | undefined, kind: 'check' | 'warm'): Promise<DiagnosticCheck> {
    const work = this.queue.then(() => this.request(file, text, kind));
    this.queue = work.catch(() => {});
    return work;
  }
  /** 预热请求触发停用时，提示留给下一次编辑结果 */
  takeNotice(): string | undefined {
    const notice = this.stoppedNotice;
    this.stoppedNotice = undefined;
    return notice;
  }
  private start(): DiagnosticWorker {
    const worker = this.factory();
    this.worker = worker;
    worker.unref();
    worker.on('message', (reply) => {
      if (this.worker === worker) this.pending.get(reply.id)?.(reply);
    });
    const failed = () => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      for (const finish of this.pending.values()) finish({ error: '诊断 worker 已退出' });
    };
    worker.on('error', failed);
    worker.on('exit', failed);
    return worker;
  }
  private request(file: string, text: string | undefined, kind: 'check' | 'warm'): Promise<DiagnosticCheck> {
    if (this.stopped) return Promise.resolve({});
    let worker: DiagnosticWorker;
    try {
      worker = this.worker ?? this.start();
    } catch (err) {
      return Promise.resolve({ error: String(err) });
    }
    const id = ++this.seq;
    return new Promise((resolve) => {
      const finish = (reply: DiagnosticCheck) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (reply.error !== '诊断超时') this.timeouts = 0;
        resolve(reply);
      };
      const timer = setTimeout(() => {
        this.timeouts++;
        this.worker = undefined;
        void worker.terminate();
        if (this.timeouts >= MAX_TIMEOUTS) {
          this.stopped = true;
          if (kind === 'warm') this.stoppedNotice = STOPPED_NOTICE;
        }
        finish({ error: '诊断超时', ...(this.stopped && kind === 'check' ? { notice: STOPPED_NOTICE } : {}) });
      }, this.timeoutMs);
      this.pending.set(id, finish);
      try {
        worker.postMessage({ id, kind, file, ...(text !== undefined ? { text } : {}) });
      } catch (err) {
        finish({ error: String(err) });
      }
    });
  }
  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const finish of this.pending.values()) finish({ error: '诊断已关闭' });
    const worker = this.worker;
    this.worker = undefined;
    await worker?.terminate();
  }
}

/** 某个工作区（主会话 cwd 或成员 worktree）看到的诊断服务；worker 由 client 共享 */
export class DiagnosticsHost {
  readonly client: DiagnosticsWorkerClient;
  private readonly ownsClient: boolean;
  constructor(
    readonly cwd: string,
    readonly config: DiagnosticsConfig = {},
    worker?: DiagnosticsWorkerClient | (() => DiagnosticWorker),
  ) {
    this.ownsClient = !(worker instanceof DiagnosticsWorkerClient);
    this.client = worker instanceof DiagnosticsWorkerClient ? worker : new DiagnosticsWorkerClient(config.timeoutMs ?? 8000, worker);
  }
  /** 子 agent 用：换成它自己的工作区，沿用同一个 worker */
  forWorkspace(cwd: string): DiagnosticsHost {
    return new DiagnosticsHost(cwd, this.config, this.client);
  }
  eligible(file: string): boolean {
    return (
      !this.client.stopped &&
      this.config.enabled !== false &&
      process.env['ROAST_DIAGNOSTICS'] !== '0' &&
      !!diagnosticsConfig(file, this.cwd)
    );
  }
  check(file: string, text?: string, kind: 'check' | 'warm' = 'check'): Promise<DiagnosticCheck> {
    return this.eligible(file) ? this.client.check(file, text, kind) : Promise.resolve({});
  }
  warm(file: string): void {
    if (this.eligible(file)) void this.check(file, undefined, 'warm');
  }
  takeNotice(): string | undefined {
    return this.client.takeNotice();
  }
  /** 只有创建 worker 的那个 host（主会话）负责关闭它 */
  async shutdown(): Promise<void> {
    if (this.ownsClient) await this.client.shutdown();
  }
}

export async function beginDiagnostics(services: ToolServices, file: string, oldText: string): Promise<DiagnosticCheck | undefined> {
  const host = services.get<DiagnosticsHost>(DIAGNOSTICS_KEY);
  const notice = host?.takeNotice();
  return notice ? { notice } : host?.eligible(file) ? host.check(file, oldText) : undefined;
}
export async function finishDiagnostics(
  services: ToolServices,
  file: string,
  text: string,
  baseline?: DiagnosticCheck,
): Promise<DiagnosticCheck | undefined> {
  const host = services.get<DiagnosticsHost>(DIAGNOSTICS_KEY);
  if (!host || baseline === undefined) return undefined;
  const after = await host.check(file, text);
  return {
    ...after,
    diagnostics: after.diagnostics ? newDiagnostics(baseline.diagnostics ?? [], after.diagnostics) : undefined,
    ...(baseline.diagnostics === undefined ? { error: '含已有错误' } : {}),
    notice: after.notice ?? baseline.notice,
  };
}
export function appendDiagnostics(
  result: ToolResult,
  check: DiagnosticCheck | undefined,
  file: string,
  services: ToolServices,
): ToolResult {
  if (!check || (!check.diagnostics?.length && !check.notice)) return result;
  const host = services.get<DiagnosticsHost>(DIAGNOSTICS_KEY),
    max = host?.config.maxItems ?? 10;
  const diagnostics = check.diagnostics ?? [];
  const label = path
    .relative(host?.cwd ?? path.dirname(file), file)
    .split(path.sep)
    .join('/');
  const lines = diagnostics.length
    ? [
        `诊断：新增 ${diagnostics.length} 个 TypeScript 错误${check.error ? '（含已有错误）' : ''}`,
        ...diagnostics.slice(0, max).map((d) => `${label}:${d.line}:${d.column} TS${d.code} ${d.message}`),
        ...(diagnostics.length > max ? [`…另有 ${diagnostics.length - max} 个`] : []),
      ]
    : [];
  if (check.notice) lines.push(check.notice);
  return {
    ...result,
    content: [...result.content, { type: 'text', text: lines.join('\n') }],
    metadata: {
      ...result.metadata,
      diagnostics: { file: label, items: diagnostics, includesExisting: !!check.error, notice: check.notice },
    },
  };
}
