/**
 * 检查点与 rewind：写操作前自动快照；rewind 同时回退文件与对话，日志可重放、resume 后状态一致。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../src/agent/runtime.js';
import { SystemPromptAssembler } from '../../src/agent/system-prompt.js';
import { CheckpointManager } from '../../src/ext/audit/checkpoints.js';
import { ShadowGit } from '../../src/ext/audit/shadow-git.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { foldHistory } from '../../src/session/history.js';
import { loadRunLog } from '../../src/session/projection.js';
import { openRunLog } from '../../src/session/resume.js';
import { createDefaultToolRegistry, MapToolServices } from '../../src/tools/index.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { textScript, toolCallScript } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { replayMismatches } from '../fixtures/replay.js';

async function drain(rt: AgentRuntime, text: string) {
  for await (const _ of rt.run(text)) {
    // drain
  }
}

describe('检查点与 rewind', () => {
  it('yolo snapshots every bash and replays the first turn baseline for rewind', async () => {
    const ws = tempWorkspace(); ws.file('a.txt', 'baseline');
    const events: Parameters<CheckpointManager['restoreFromEvents']>[0][number][] = [];
    const checkpoints = new CheckpointManager(new ShadowGit(ws.dir), () => 'yolo');
    checkpoints.attach((body) => events.push({ ...body, seq: events.length + 1, agentId: 'main' }));
    const bash = createDefaultToolRegistry().get('bash');
    const ctx = { cwd: ws.dir, services: new MapToolServices(), signal: new AbortController().signal, turn: 1 };
    await checkpoints.hook()(bash, { command: 'git status' }, ctx);
    ws.file('a.txt', 'changed');
    await checkpoints.hook()(bash, { command: 'git status' }, ctx);
    ws.file('created.txt', 'new');
    expect(events.filter((e) => e.type === 'checkpoint')).toHaveLength(2);
    const restored = new CheckpointManager(new ShadowGit(ws.dir)); restored.restoreFromEvents(events);
    await restored.rewind(1);
    expect(readFileSync(path.join(ws.dir, 'a.txt'), 'utf8')).toBe('baseline');
    expect(existsSync(path.join(ws.dir, 'created.txt'))).toBe(false);
  }, 60_000);
  it('turn 2 写文件前自动快照；rewind 到 turn 2 后文件与对话回到 turn 1 结束时', async () => {
    const ws = tempWorkspace('roast-rewind-');
    const provider = new ScriptedProvider([
      toolCallScript('c1', 'write', { path: 'a.txt', content: 'one\n' }),
      textScript('写好了 one'),
      toolCallScript('c2', 'write', { path: 'b.txt', content: 'two\n' }),
      textScript('写好了 two'),
      textScript('rewind 之后的回答'),
    ]);
    const providers = new ProviderRegistry();
    providers.register('p', provider);
    const opened = await openRunLog({ logsRoot: path.join(ws.dir, 'logs'), info: { cwd: ws.dir, provider: 'p', model: 'm' } });
    const checkpoints = new CheckpointManager(new ShadowGit(ws.dir));
    const rt = new AgentRuntime({
      providers,
      modelRef: { provider: 'p', model: 'm' },
      tools: createDefaultToolRegistry(),
      systemPrompt: new SystemPromptAssembler(),
      log: opened.log,
      cwd: ws.dir,
      services: new MapToolServices(),
      hooks: { preExecute: [checkpoints.hook()], postExecute: [] },
    });
    checkpoints.attach((b) => rt.committer.commit(b));

    await drain(rt, '写 a');
    await drain(rt, '写 b');
    expect(existsSync(path.join(ws.dir, 'b.txt'))).toBe(true);
    expect(checkpoints.turns()).toEqual([1, 2]);

    const result = await checkpoints.rewind(2);
    rt.committer.commit({ type: 'rewind', at: 't', toTurn: 2, ...(result.checkpoint ? { checkpoint: result.checkpoint } : {}) });
    expect(existsSync(path.join(ws.dir, 'b.txt'))).toBe(false);
    expect(readFileSync(path.join(ws.dir, 'a.txt'), 'utf8')).toBe('one\n');

    const msgs = rt.committer.messages();
    expect(JSON.stringify(msgs)).toContain('写好了 one');
    expect(JSON.stringify(msgs)).not.toContain('写 b');

    await drain(rt, '换个思路');
    const lastReq = provider.requests.at(-1)!;
    expect(JSON.stringify(lastReq.messages)).not.toContain('two');
    await opened.log.close();

    expect(replayMismatches(opened.log.path)).toEqual([]);
    const folded = foldHistory(loadRunLog(opened.log.path).events);
    expect(JSON.stringify(folded.messages)).not.toContain('写 b');
    const restored = new CheckpointManager(new ShadowGit(ws.dir));
    restored.restoreFromEvents(loadRunLog(opened.log.path).events);
    expect(restored.turns()).toEqual([1]);
  }, 60_000);
});
