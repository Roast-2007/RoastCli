/**
 * 用户钩子装配：加载各配置层的 hooks（仓库层需信任）→ 生成工具管线钩子、输入守卫、Stop 边界钩子，
 * 并在会话启动时运行 SessionStart（stdout 作为稳定 system 段）。
 * 非阻塞错误（命令失败 / 超时）在下一个 step 边界以 UI 提示显示，不进入模型上下文。
 */
import { isProjectTrusted } from '../core/config.js';
import { loadHooks } from '../ext/hooks/config.js';
import { HookRunner } from '../ext/hooks/runner.js';
import { postToolUseHook, preToolUseHook, promptSubmitGuard, stopHookBoundary } from '../ext/hooks/integration.js';
import type { InputGuard } from '../ext/guard.js';
import type { PostExecuteHook, PreExecuteHook } from '../tools/tool.js';
import { composeBoundary, type BoundaryHooks } from './boundary.js';
import type { SystemPromptAssembler } from './system-prompt.js';

export interface HooksSetup {
  /** 放在权限检查之前 */
  preExecute: PreExecuteHook[];
  postExecute: PostExecuteHook[];
  inputGuard?: InputGuard;
  /** 主会话的边界钩子（Stop + 错误提示） */
  boundary: BoundaryHooks;
  /** 启动提示（未生效的仓库钩子、格式错误、SessionStart 失败） */
  warnings: string[];
}

export interface HooksSetupInput {
  cwd: string;
  sessionId: string;
  resumed: boolean;
  systemPrompt: SystemPromptAssembler;
}

export async function setupHooks(input: HooksSetupInput): Promise<HooksSetup> {
  const loaded = loadHooks(input.cwd, isProjectTrusted(input.cwd));
  const runner = new HookRunner(loaded.hooks, { cwd: input.cwd, sessionId: input.sessionId });
  const warnings: string[] = [];
  if (loaded.ignored > 0) warnings.push(`项目配置中的 ${loaded.ignored} 个钩子未生效（未信任项目，可运行 roast trust）`);
  for (const file of loaded.invalid) warnings.push(`钩子配置格式错误，已忽略：${file}`);

  if (runner.has('SessionStart')) {
    const r = await runner.run('SessionStart', { source: input.resumed ? 'resume' : 'startup' });
    warnings.push(...r.errors);
    if (r.output) input.systemPrompt.register({ name: 'session-start', order: 340, text: `## 会话启动信息（SessionStart 钩子）\n${r.output}` });
  }

  const pendingErrors: string[] = [];
  const onError = (errors: string[]) => pendingErrors.push(...errors);
  const errorNotices: BoundaryHooks = {
    beforeRequest: () => pendingErrors.splice(0).map((text) => ({ kind: 'notice' as const, text: `⚠ ${text}` })),
  };

  return {
    preExecute: runner.has('PreToolUse') ? [preToolUseHook(runner, onError)] : [],
    postExecute: runner.has('PostToolUse') ? [postToolUseHook(runner, onError)] : [],
    ...(runner.has('UserPromptSubmit') ? { inputGuard: promptSubmitGuard(runner, onError) } : {}),
    boundary: composeBoundary(errorNotices, stopHookBoundary(runner, onError)),
    warnings,
  };
}

/** 依次执行两个输入守卫：任一拦截即拦截；sanitize 结果传给下一个 */
export function chainInputGuards(first: InputGuard | undefined, second: InputGuard | undefined): InputGuard | undefined {
  if (!first || !second) return first ?? second;
  return {
    async check(text, source, opts) {
      const a = await first.check(text, source, opts);
      if (a.action === 'block') return a;
      const mid = a.action === 'sanitize' && a.sanitized !== undefined ? a.sanitized : text;
      const b = await second.check(mid, source, opts);
      if (b.action !== 'pass' || mid === text) return b;
      return { action: 'sanitize', sanitized: mid };
    },
  };
}
