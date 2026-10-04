/**
 * 钩子执行：以与 bash 工具相同的 shell 运行命令，JSON 负载写入 stdin。
 * 退出码约定（与 Claude Code 一致）：
 *   0 → 通过（stdout 可作为附加上下文：UserPromptSubmit / SessionStart）
 *   2 → 阻止（stderr 作为理由反馈给模型或用户）
 *   其他 → 非阻塞错误（记录，继续执行）
 */
import { runForeground } from '../../tools/bash/run.js';
import { matchesTool, type HookEvent, type HooksConfig, type HookSpec } from './config.js';

const DEFAULT_TIMEOUT_MS = 60_000;
/** 单个钩子 stdout / stderr 最多保留的字符数 */
const OUTPUT_LIMIT = 16_000;
const BLOCK_EXIT_CODE = 2;

export interface HookOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface HookRunResult {
  /** 某个钩子以退出码 2 阻止时的理由（stderr，空则给默认文案） */
  blocked?: string;
  /** 通过的钩子的 stdout（按顺序拼接） */
  output: string;
  /** 非阻塞错误（命令失败 / 超时） */
  errors: string[];
}

export type HookPayload = Record<string, unknown>;

/**
 * 运行一个钩子命令。复用 bash 工具的 runForeground，保证任何情况下都会按时 settle：
 * 进程退出后孙进程占住管道、超时、中断（含调用前已中断）都不会挂起调用方。
 */
export async function runHookCommand(spec: HookSpec, payload: HookPayload, opts: { cwd: string; signal?: AbortSignal }): Promise<HookOutcome> {
  const text = { out: '', err: '' };
  const r = await runForeground({
    command: spec.command,
    cwd: opts.cwd,
    timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: opts.signal ?? new AbortController().signal,
    env: { ROAST_HOOK_EVENT: String(payload['hook_event_name'] ?? ''), ROAST_PROJECT_DIR: opts.cwd },
    input: JSON.stringify(payload),
    onOutput: (chunk, stream) => {
      if (text[stream].length < OUTPUT_LIMIT) text[stream] += chunk;
    },
  });
  const stdout = text.out.slice(0, OUTPUT_LIMIT).trim();
  const stderr = text.err.slice(0, OUTPUT_LIMIT).trim();
  switch (r.kind) {
    case 'exited':
      return { code: r.code, stdout, stderr, timedOut: false, aborted: false };
    case 'timeout':
      return { code: null, stdout, stderr, timedOut: true, aborted: false };
    case 'aborted':
      return { code: null, stdout, stderr, timedOut: false, aborted: true };
    case 'spawn-error':
      return { code: null, stdout: '', stderr: r.message, timedOut: false, aborted: false };
  }
}

export class HookRunner {
  constructor(
    private readonly hooks: HooksConfig,
    private readonly base: { cwd: string; sessionId: string },
  ) {}

  has(event: HookEvent, toolName?: string): boolean {
    return this.hooks[event].some((h) => toolName === undefined || matchesTool(h.matcher, toolName));
  }

  /** 依次运行命中的钩子；遇到阻止即停止 */
  async run(event: HookEvent, payload: HookPayload, opts: { toolName?: string; signal?: AbortSignal } = {}): Promise<HookRunResult> {
    const specs = this.hooks[event].filter((h) => opts.toolName === undefined || matchesTool(h.matcher, opts.toolName));
    const outputs: string[] = [];
    const errors: string[] = [];
    const full = { hook_event_name: event, session_id: this.base.sessionId, cwd: this.base.cwd, ...payload };
    for (const spec of specs) {
      if (opts.signal?.aborted) break;
      const r = await runHookCommand(spec, full, { cwd: this.base.cwd, ...(opts.signal ? { signal: opts.signal } : {}) });
      if (r.aborted) break;
      if (r.code === BLOCK_EXIT_CODE) {
        return { blocked: r.stderr || `${event} 钩子阻止了此操作（${spec.command}）`, output: outputs.join('\n'), errors };
      }
      if (r.code === 0) {
        if (r.stdout) outputs.push(r.stdout);
        continue;
      }
      const why = r.timedOut ? '超时' : `退出码 ${r.code ?? '?'}`;
      errors.push(`${event} 钩子 \`${spec.command}\` ${why}${r.stderr ? `：${r.stderr.slice(0, 300)}` : ''}`);
    }
    return { output: outputs.join('\n'), errors };
  }
}
