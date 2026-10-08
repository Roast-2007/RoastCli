import type { Session } from '../agent/session.js';
import type { RuntimeInput } from '../agent/runtime.js';
import type { UiEvent } from '../agent/ui-events.js';
import { asRoastError, RoastError } from '../core/errors.js';
import { addUsage, emptyUsage } from '../core/types.js';
import { resolvePricing } from '../providers/pricing/index.js';
import { runPrintMode, runStreamJson, type WritableLike } from './print-mode.js';
import { savedWorktreesText } from './worktrees.js';

export async function runHeadless(
  session: Session,
  prompt: RuntimeInput,
  opts: {
    format?: string;
    budget?: number;
    out: WritableLike;
    err: WritableLike;
    controller: AbortController;
  },
): Promise<number> {
  const start = Date.now(),
    first = session.displayEvents().length;
  let subtype = 'success',
    error: { code: string; message: string } | undefined;
  let budgetError: typeof error;
  const checkBudget = () => {
    if (opts.budget === undefined || budgetError) return;
    const cost = session.cost();
    if (cost !== null && cost < opts.budget) return;
    budgetError = {
      code: 'BUDGET',
      message: `预算 $${opts.budget}，已用${cost === null ? '金额未知（模型缺少定价）' : ` $${cost.toFixed(6)}`}`,
    };
    opts.err.write(`error [BUDGET] ${budgetError.message}\n`);
    opts.controller.abort();
    for (const agent of session.swarm.tree()) if (agent.parentId === 'main') session.swarm.cancelSubtree(agent.id, '预算限制');
  };
  const off = session.onCostChange?.(checkBudget);
  const observe = (ev: UiEvent) => {
    if (ev.type === 'turn-end') subtype = ev.reason === 'completed' ? 'success' : ev.reason;
    if (ev.type === 'error') error = { code: ev.error.code, message: ev.error.message };
  };
  const loop = {
    async *run(input: RuntimeInput, signal?: AbortSignal) {
      for await (const ev of session.loop.run(input, signal)) {
        observe(ev);
        yield ev;
      }
    },
  };
  let code = 1,
    worktrees: string[] = [];
  try {
    if (opts.budget !== undefined && !resolvePricing(session.config, { provider: session.providerName, model: session.model }))
      throw new RoastError('INVALID_REQUEST', '当前模型缺少定价，无法执行预算限制');
    checkBudget();
    code =
      opts.format === 'stream-json'
        ? await runStreamJson({ loop, onAgentEvent: session.onAgentEvent }, prompt, opts.out, opts.controller.signal)
        : await runPrintMode(loop, prompt, opts.format === 'json' ? { write() {} } : opts.out, opts.err, opts.controller.signal);
  } catch (err) {
    const e = asRoastError(err);
    error = { code: e.code, message: e.message };
    subtype = 'error';
    opts.err.write(`error [${e.code}] ${e.message}\n`);
  } finally {
    worktrees = (await session.shutdown()).worktrees;
    off?.();
    opts.err.write(savedWorktreesText(worktrees));
  }
  if (budgetError) {
    subtype = 'budget';
    error = budgetError;
    code = 1;
  } else if (opts.controller.signal.aborted || subtype === 'aborted') {
    subtype = 'aborted';
    code = 130;
  }
  if (opts.format === 'json') {
    const events = session.displayEvents().slice(first);
    const last = events
      .filter(
        (event) => event.type === 'assistant/message' && event.message.content.some((block) => block.type === 'text' && block.text.trim()),
      )
      .at(-1);
    const result =
      last?.type === 'assistant/message'
        ? last.message.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('')
        : '';
    const usage = (session.costBreakdown?.().entries ?? []).reduce((sum, entry) => addUsage(sum, entry.usage), emptyUsage());
    opts.out.write(
      JSON.stringify({
        type: 'result',
        subtype,
        isError: subtype !== 'success',
        result,
        runId: session.log.header.runId,
        logPath: session.log.path,
        model: `${session.providerName}:${session.model}`,
        durationMs: Date.now() - start,
        steps: events.filter((event) => event.type === 'step/start').length,
        usage,
        costUsd: session.cost(),
        worktrees,
        ...(subtype === 'error' || subtype === 'budget' ? { error } : {}),
      }) + '\n',
    );
  }
  return code;
}
