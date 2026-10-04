/**
 * 上下文引擎集成：长会话（每轮读取一个大文件）始终保持在窗口阈值以内；
 * 每次请求配对合法、日志可重放；recall 能取回被折叠/压缩的原文；溢出时紧急压缩重试。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../src/agent/runtime.js';
import { SystemPromptAssembler } from '../../src/agent/system-prompt.js';
import { ContextController } from '../../src/context/controller.js';
import { estimateMessages } from '../../src/context/estimator.js';
import { CONTEXT_ACCESS_KEY, recallTool } from '../../src/context/recall-tool.js';
import { RoastError } from '../../src/core/errors.js';
import type { StreamChunk } from '../../src/core/types.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { RunLogWriter } from '../../src/session/log-writer.js';
import { executeTool } from '../../src/tools/executor.js';
import { createDefaultToolRegistry, MapToolServices } from '../../src/tools/index.js';
import { ScriptedProvider, type RecordedRequest } from '../fixtures/scripted-provider.js';
import { textScript, toolCallScript, usageOf } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { pairingErrors } from '../fixtures/history.js';
import { replayMismatches } from '../fixtures/replay.js';

const WINDOW = 20_000;
const OVERHEAD = 500;

/** 模拟模型：轮次开始时读一个文件，读完后回答；usage 按请求规模给出 */
function modelScript(turns: number) {
  return Array.from({ length: turns * 2 }, (_, i) => (req: RecordedRequest): StreamChunk[] => {
    const usage = usageOf(OVERHEAD + estimateMessages(req.messages), 20);
    const turn = Math.floor(i / 2) + 1;
    return i % 2 === 0
      ? toolCallScript(`r${turn}`, 'read', { path: `f${turn}.txt` }, usage)
      : textScript(`第 ${turn} 个文件读完了`, usage);
  });
}

async function setup(scripts: ReturnType<typeof modelScript>, turns: number) {
  const ws = tempWorkspace('roast-ctx-');
  for (let n = 1; n <= turns; n++) ws.file(`f${n}.txt`, `文件 ${n} 的标记 MARK${n}\n` + 'x'.repeat(12_000));
  const provider = new ScriptedProvider(scripts, { models: { m: { id: 'm', contextWindow: WINDOW } } });
  const providers = new ProviderRegistry();
  providers.register('p', provider);
  const log = await RunLogWriter.create(path.join(ws.dir, 'logs'), { cwd: ws.dir, provider: 'p', model: 'm' });
  const controller = new ContextController({ window: WINDOW, overhead: () => OVERHEAD });
  const services = new MapToolServices();
  const rt = new AgentRuntime({
    providers,
    modelRef: { provider: 'p', model: 'm' },
    tools: createDefaultToolRegistry(),
    systemPrompt: new SystemPromptAssembler(),
    log,
    cwd: ws.dir,
    services,
    boundary: controller.hooks(),
  });
  controller.attach((b) => rt.committer.commit(b), () => rt.committer.state);
  rt.committer.onCommit((ev) => controller.observe(ev));
  services.set(CONTEXT_ACCESS_KEY, { state: () => rt.committer.state });
  return { ws, provider, log, rt, controller, services };
}

async function drain(rt: AgentRuntime, text: string) {
  const events = [];
  for await (const e of rt.run(text)) events.push(e);
  return events;
}

describe('上下文引擎：长会话', () => {
  it('30 轮各读一个大文件：每次请求都在 85% 窗口以内，配对合法，日志可重放', async () => {
    const TURNS = 30;
    const { provider, log, rt, controller, services } = await setup(modelScript(TURNS), TURNS);
    for (let n = 1; n <= TURNS; n++) await drain(rt, `读第 ${n} 个文件`);
    await log.close();

    for (const req of provider.requests) {
      expect(OVERHEAD + estimateMessages(req.messages)).toBeLessThan(WINDOW * 0.85);
      expect(pairingErrors(req.messages)).toEqual([]);
    }
    expect(replayMismatches(log.path)).toEqual([]);
    const stats = controller.stats(rt.committer.state);
    expect(stats.compactedUpTo).not.toBeNull();
    expect(stats.percent).toBeLessThan(85);

    // 早期文件已被压缩出视图，但 recall 能取回原文
    const recalled = await executeTool(recallTool, { handle: 'r1' }, { cwd: '.', signal: new AbortController().signal, services });
    expect(JSON.stringify(recalled)).toContain('MARK1');
    const searched = await executeTool(recallTool, { query: 'MARK2' }, { cwd: '.', signal: new AbortController().signal, services });
    expect(JSON.stringify(searched)).toContain('⟦ctx:r2⟧');
  }, 60_000);
});

describe('上下文引擎：溢出恢复', () => {
  it('provider 报 CONTEXT_WINDOW_EXCEEDED：紧急压缩并以同一 step 重试一次', async () => {
    const TURNS = 4;
    const scripts = modelScript(TURNS);
    const overflow = (): StreamChunk[] => [{ type: 'finish', reason: 'error', error: new RoastError('CONTEXT_WINDOW_EXCEEDED', 'too long') }];
    const { provider, rt, log } = await setup([...scripts.slice(0, 6), overflow, ...scripts.slice(6)], TURNS);
    for (let n = 1; n <= 3; n++) await drain(rt, `读第 ${n} 个文件`);
    const events = await drain(rt, '读第 4 个文件');
    expect(events.some((e) => e.type === 'notice' && e.text.includes('紧急压缩'))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'turn-end', reason: 'completed' });
    const retried = provider.requests[7]!;
    expect(estimateMessages(retried.messages)).toBeLessThan(estimateMessages(provider.requests[6]!.messages));
    await log.close();
    expect(replayMismatches(log.path)).toEqual([]);
  }, 30_000);
});
