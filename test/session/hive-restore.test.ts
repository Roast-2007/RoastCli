import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createSession, type Session } from '../../src/agent/session.js';
import type { RuntimeInput } from '../../src/agent/runtime.js';
import { ConfigSchema } from '../../src/core/config.js';
import { RoastError } from '../../src/core/errors.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { loadRunLog } from '../../src/session/projection.js';
import { restoreHiveMembers } from '../../src/session/hive-restore.js';
import { readHiveRecords } from '../../src/swarm/hive-journal.js';
import { loadStrategies, missionInput } from '../../src/swarm/strategies.js';
import { createUiController } from '../../src/ui/controller.js';
import { createUiStore } from '../../src/ui/store/store.js';
import { createOutputRows } from '../../src/ui/output-rows.js';
import { RoutedProvider } from '../fixtures/routed-provider.js';
import { ScriptedProvider, type Script } from '../fixtures/scripted-provider.js';
import { textScript, toolCallScript, toolCallsScript } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { replayMismatches } from '../fixtures/replay.js';

const config = ConfigSchema.parse({
  providers: { p: { driver: 'openai-compat', auth: 'none' } },
  default: 'p:m',
  logsDir: 'logs',
  swarm: { worktrees: false },
  maxSteps: 15,
});
const registry = (scripts: Record<string, Script[]>) => {
  const providers = new ProviderRegistry();
  providers.register('p', new RoutedProvider(scripts));
  return providers;
};
const run = async (session: Session, text: RuntimeInput) => {
  for await (const _event of session.loop.run(text)) {
    /* drain */
  }
  await session.swarm.whenIdle();
};
const mission = (goal: string) => missionInput(loadStrategies('', ''), goal, 'fanout', 3);
const scripts = (): Record<string, Script[]> => ({
  main: [
    toolCallScript('plan', 'board_write', {
      key: '/mission/plan',
      value: JSON.stringify({ tasks: [{ id: 't1', title: '实现', role: 'lead', acceptance: '通过', dependsOn: [] }] }),
    }),
    toolCallScript('spawn', 'spawn_agent', { role: 'lead', task: '实现', task_id: 't1' }),
    toolCallScript('wait', 'await_agents', { mode: 'all' }),
    toolCallScript('scout', 'spawn_agent', { role: 'scout', task: '未完成调研' }),
    toolCallScript('wait2', 'await_agents', { mode: 'all' }),
    textScript('Queen **完成**'),
  ],
  l1: [
    toolCallScript('child', 'spawn_agent', { role: 'worker', task: '写代码', task_id: 't1' }),
    toolCallScript('wait', 'await_agents', { mode: 'all' }),
    toolCallScript('report', 'report', { status: 'done', summary: 'Lead 完成' }),
    textScript('Lead 输出'),
  ],
  w2: [
    toolCallScript('board', 'board_write', { key: '/worker', value: 'worker data' }),
    toolCallScript('message', 'send_message', { to: 'parent', kind: 'info', subject: '进度', body: 'Worker 消息' }),
    toolCallScript('report', 'report', { status: 'done', summary: 'Worker 完成' }),
    textScript('Worker 输出'),
  ],
  s3: [[{ type: 'finish', reason: 'aborted', error: new RoastError('ABORTED', '测试中断') }]],
});
const textOf = (store: ReturnType<typeof createUiStore>, id = 'main') =>
  createOutputRows()(store.getState().agents[id]!, 100, false)
    .map((row) => row.spans.map((span) => span.text).join(''))
    .join('\n');

describe('Hive 恢复与回退', () => {
  it('restores two-level members, report states, board, messages and outputs while skipping a damaged child', async () => {
    const ws = tempWorkspace();
    const first = await createSession({ cwd: ws.dir, config, providers: registry(scripts()) });
    const store = createUiStore(),
      controller = createUiController(first, store, { exit() {} });
    controller.submit(mission('恢复测试'), '恢复测试');
    await controller.whenIdle();
    await first.swarm.whenIdle();
    store.flush();
    const liveMessages = store.getState().meta.messages.map((message) => message.id),
      board = first.swarm.board.read('/mission/plan');
    await first.shutdown();
    controller.dispose();
    writeFileSync(path.join(path.dirname(first.log.path), 'agents', 'w99.jsonl'), '{broken\n');
    const second = await first.resume(first.log.path),
      restored = createUiStore(),
      ui = createUiController(second, restored, { exit() {} });
    try {
      expect(restored.getState().meta.swarm.map((agent) => [agent.id, agent.parentId, agent.state])).toEqual(
        expect.arrayContaining([
          ['l1', 'main', 'done'],
          ['w2', 'l1', 'done'],
          ['s3', 'main', 'cancelled'],
        ]),
      );
      expect(second.restoredHive.members.find((member) => member.info.id === 'w2')).toMatchObject({
        spawnTurn: 1,
        info: { depth: 2, taskId: 't1', restored: true },
      });
      expect(textOf(restored)).toContain('Queen 完成');
      expect(textOf(restored, 'w2')).toContain('Worker 输出');
      expect(second.swarm.board.read('/mission/plan')).toEqual(board);
      expect(second.swarm.board.read('/worker')?.value).toBe('worker data');
      expect(restored.getState().meta.messages.map((message) => message.id)).toEqual(liveMessages);
      expect(second.swarm.tree()).toHaveLength(1);
      expect(second.swarm.info('w2')).toBeUndefined();
      expect(ui.togglePause('w2')).toBe('历史成员，不可操作');
      expect(ui.steerAgent('w2', '继续')).toBe('历史成员，不可操作');
      expect(replayMismatches(second.log.path)).toEqual([]);
      const inferred = restoreHiveMembers(
        path.dirname(first.log.path),
        first.displayEvents().filter((event) => !('callId' in event) || event.callId !== 'spawn'),
      );
      expect(inferred.find((member) => member.info.id === 'l1')).toMatchObject({
        info: { parentId: 'main', role: 'lead' },
        spawnTurn: undefined,
      });
      expect(inferred.find((member) => member.info.id === 'w2')).toMatchObject({
        info: { parentId: 'l1', depth: 2 },
        spawnTurn: undefined,
      });
    } finally {
      ui.dispose();
      await second.shutdown();
    }
  }, 30_000);
  it('forks from the source run, snapshots the board and reserves historical ids through a second resume', async () => {
    const ws = tempWorkspace(),
      first = await createSession({ cwd: ws.dir, config, providers: registry(scripts()) });
    for await (const _event of first.loop.run(mission('fork'))) {
      /* drain */
    }
    await first.swarm.whenIdle();
    first.log.flush();
    writeFileSync(path.join(path.dirname(first.log.path), 'agents', 'w99.jsonl'), '{broken\n');
    const fork = await first.resume(first.log.path);
    try {
      expect(fork.log.path).not.toBe(first.log.path);
      expect(fork.restoredHive.members.map((member) => member.info.id)).toEqual(['l1', 'w2', 's3']);
      expect(fork.swarm.board.read('/worker')?.value).toBe('worker data');
      expect(readHiveRecords(path.dirname(fork.log.path))[0]?.type).toBe('snapshot');
      const spawn = fork.swarm.spawn('main', { role: 'scout', task: '新成员' });
      expect(spawn).toMatchObject({ ok: true, id: 's100' });
      // 源目录坏日志的数字水位也被保留，不会覆盖残留日志。
    } finally {
      await fork.shutdown();
      await first.shutdown();
    }
    const again = await fork.resume(fork.log.path);
    try {
      expect(again.restoredHive.members.some((member) => member.info.id === 'w2')).toBe(true);
      expect(again.swarm.board.read('/worker')?.value).toBe('worker data');
    } finally {
      await again.shutdown();
    }
  }, 30_000);
  it('restores 0.5.0 members without hive.jsonl', async () => {
    const ws = tempWorkspace(),
      first = await createSession({ cwd: ws.dir, config, providers: registry(scripts()) });
    for await (const _event of first.loop.run(mission('old'))) {
      /* drain */
    }
    await first.shutdown();
    rmSync(path.join(path.dirname(first.log.path), 'hive.jsonl'));
    const second = await first.resume(first.log.path);
    try {
      expect(second.restoredHive.members).toHaveLength(3);
      expect(second.restoredHive.board).toEqual([]);
      expect(second.restoredHive.messages).toEqual([]);
    } finally {
      await second.shutdown();
    }
  }, 30_000);
  it('keeps source usage once and rewinds original turns in a fork after the source has continued', async () => {
    const ws = tempWorkspace(),
      first = await createSession({
        cwd: ws.dir,
        config,
        providers: registry({
          main: [textScript('源保留'), ...scripts().main!, textScript('分叉后源新增'), textScript('分叉输出')],
          ...Object.fromEntries(Object.entries(scripts()).filter(([id]) => id !== 'main')),
        }),
      });
    await run(first, mission('保留'));
    await run(first, mission('删去'));
    first.log.flush();
    const entries = (session: Session) =>
      session.costBreakdown!().entries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const sourceUsage = entries(first),
      fork = await first.resume(first.log.path);
    let expectedUsage = sourceUsage;
    try {
      expect(entries(fork)).toEqual(sourceUsage);
      await run(first, '源继续');
      first.log.flush();
      await run(fork, mission('分叉任务'));
      expectedUsage = entries(fork);
      await fork.rewind(2);
      expect(
        fork.loop.committer
          .messages()
          .map((message) => JSON.stringify(message))
          .join(''),
      ).toContain('源保留');
      expect(
        fork.loop.committer
          .messages()
          .map((message) => JSON.stringify(message))
          .join(''),
      ).not.toContain('Queen **完成**');
      expect(entries(fork)).toEqual(expectedUsage);
      expect(replayMismatches(fork.log.path)).toEqual([]);
    } finally {
      await fork.shutdown();
      await first.shutdown();
    }
    const again = await fork.resume(fork.log.path),
      store = createUiStore(),
      ui = createUiController(again, store, { exit() {} });
    try {
      expect(textOf(store)).toContain('源保留');
      expect(textOf(store)).not.toContain('分叉后源新增');
      expect(textOf(store)).not.toContain('删去');
      expect(again.restoredHive.members).toEqual([]);
      expect(entries(again)).toEqual(expectedUsage);
      expect(replayMismatches(again.log.path)).toEqual([]);
    } finally {
      ui.dispose();
      await again.shutdown();
    }
  }, 30_000);
  it('replays cancelled child partials with the same marker and leaves the child model history committed only', async () => {
    const ws = tempWorkspace(),
      first = await createSession({
        cwd: ws.dir,
        config,
        providers: registry({
          main: [
            toolCallScript('spawn', 'spawn_agent', { role: 'scout', task: '中断子输出' }),
            toolCallScript('wait', 'await_agents', { mode: 'all' }),
            textScript('Queen 完成'),
          ],
          s1: [
            [
              { type: 'block-start', index: 0, block: 'text' },
              { type: 'text-delta', index: 0, text: '成员未提交段落\n\n尾巴' },
              { type: 'finish', reason: 'aborted', error: new RoastError('ABORTED', '中断') },
            ],
          ],
        }),
      });
    const store = createUiStore(),
      ui = createUiController(first, store, { exit() {} });
    ui.submit(mission('子中断'), '子中断');
    await ui.whenIdle();
    await first.swarm.whenIdle();
    store.flush();
    const live = textOf(store, 's1');
    expect(live).toContain('成员未提交段落');
    expect(live).toContain('已中断，未发送给模型');
    const child = loadRunLog(path.join(path.dirname(first.log.path), 'agents', 's1.jsonl'));
    expect(child.events.some((event) => event.type === 'assistant/message')).toBe(false);
    ui.dispose();
    await first.shutdown();
    const second = await first.resume(first.log.path),
      replay = createUiStore(),
      resumed = createUiController(second, replay, { exit() {} });
    try {
      expect(textOf(replay, 's1')).toBe(live);
      expect(replayMismatches(first.log.path)).toEqual([]);
    } finally {
      resumed.dispose();
      await second.shutdown();
    }
  });
  it('keeps interrupted streamed text only in the display, live and after resume', async () => {
    const ws = tempWorkspace(),
      provider = new ScriptedProvider([textScript('第一段\n\n尚未提交的尾巴')], { chunkDelayMs: 40 });
    const providers = new ProviderRegistry();
    providers.register('p', provider);
    const first = await createSession({ cwd: ws.dir, config, providers }),
      store = createUiStore(),
      ui = createUiController(first, store, { exit() {} });
    ui.submit(mission('中断'), '中断');
    await new Promise((resolve) => setTimeout(resolve, 95));
    ui.interrupt();
    await ui.whenIdle();
    store.flush();
    const live = textOf(store);
    expect(live).toContain('第一段');
    expect(live).toContain('已中断，未发送给模型');
    expect(JSON.stringify(first.loop.committer.messages())).not.toContain('第一段');
    expect(loadRunLog(first.log.path).events.some((event) => event.type === 'assistant/message')).toBe(false);
    ui.dispose();
    await first.shutdown();
    const second = await first.resume(first.log.path),
      replay = createUiStore(),
      resumed = createUiController(second, replay, { exit() {} });
    try {
      expect(textOf(replay)).toContain('第一段');
      expect(textOf(replay)).toContain('已中断，未发送给模型');
      expect(replayMismatches(second.log.path)).toEqual([]);
    } finally {
      resumed.dispose();
      await second.shutdown();
    }
  });
  it('rewinds UI past clear watermarks, members, board and messages and resumes the same display', async () => {
    const ws = tempWorkspace(),
      first = await createSession({
        cwd: ws.dir,
        config,
        providers: registry({
          main: [textScript('保留输出'), ...scripts().main!],
          ...Object.fromEntries(Object.entries(scripts()).filter(([id]) => id !== 'main')),
        }),
      });
    const store = createUiStore(),
      ui = createUiController(first, store, { exit() {} });
    ui.submit(mission('保留任务'), '保留任务');
    await ui.whenIdle();
    ui.submit(mission('回退任务'), '回退任务');
    await ui.whenIdle();
    await first.swarm.whenIdle();
    store.flush();
    const watermark = store.getState().agents.main!.nextId - 1;
    ui.notify('更新提醒');
    await first.rewind(2);
    expect(textOf(store)).toContain('保留输出');
    expect(textOf(store)).not.toContain('回退任务');
    expect(Object.keys(store.getState().agents)).toEqual(['main']);
    expect(store.getState().agents.main!.items.every((item) => item.id > watermark)).toBe(true);
    expect(store.getState().meta.messages).toEqual([]);
    expect(first.swarm.board.list('/')).toEqual([]);
    expect(store.getState().meta.signals).toContainEqual({ text: '更新提醒', tone: 'info' });
    ui.dispose();
    await first.shutdown();
    const second = await first.resume(first.log.path),
      restored = createUiStore(),
      resumed = createUiController(second, restored, { exit() {} });
    try {
      expect(second.restoredHive.members).toEqual([]);
      expect(textOf(restored)).not.toContain('回退任务');
      expect(textOf(restored)).toContain('保留输出');
      expect(second.swarm.board.list('/')).toEqual([]);
      expect(restored.getState().meta.messages).toEqual([]);
    } finally {
      resumed.dispose();
      await second.shutdown();
    }
  }, 30_000);
  it.each([false, true])(
    'snapshots concurrent shared workers in the Queen turn once (git=%s)',
    async (git) => {
      const ws = tempWorkspace();
      ws.file('a.txt', '原始\r\n');
      ws.file('b.txt', '原始\r\n');
      if (git) {
        execFileSync('git', ['init', '-q', ws.dir]);
        execFileSync('git', ['-C', ws.dir, 'add', 'a.txt', 'b.txt']);
        execFileSync('git', ['-C', ws.dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'baseline']);
      }
      const first = await createSession({
        cwd: ws.dir,
        config,
        permissionMode: 'acceptEdits',
        providers: registry({
          main: [
            toolCallsScript([
              { id: 'a', name: 'spawn_agent', args: { role: 'worker', task: 'A' } },
              { id: 'b', name: 'spawn_agent', args: { role: 'worker', task: 'B' } },
            ]),
            toolCallScript('wait', 'await_agents', { mode: 'all' }),
            textScript('完成'),
          ],
          w1: [
            toolCallScript('read', 'read', { path: 'a.txt' }),
            toolCallScript('write', 'write', { path: 'a.txt', content: 'changed A' }),
            textScript('完成'),
          ],
          w2: [
            toolCallScript('read', 'read', { path: 'b.txt' }),
            toolCallScript('write', 'write', { path: 'b.txt', content: 'changed B' }),
            textScript('完成'),
          ],
        }),
      });
      try {
        await run(first, '并行修改');
        expect(readFileSync(path.join(ws.dir, 'a.txt'), 'utf8')).toBe('changed A');
        expect(loadRunLog(first.log.path).events.filter((event) => event.type === 'checkpoint')).toHaveLength(1);
        await first.rewind(1);
        expect(readFileSync(path.join(ws.dir, 'a.txt'), 'utf8')).toBe('原始\r\n');
        expect(readFileSync(path.join(ws.dir, 'b.txt'), 'utf8')).toBe('原始\r\n');
      } finally {
        await first.shutdown();
      }
    },
    30_000,
  );
  it('restores a critic report that requests changes', async () => {
    const ws = tempWorkspace();
    const session = await createSession({
      cwd: ws.dir,
      config,
      providers: registry({
        main: [
          toolCallScript('spawn', 'spawn_agent', { role: 'critic', task: '评审' }),
          toolCallScript('wait', 'await_agents', { mode: 'all' }),
          textScript('done'),
        ],
        c1: [toolCallScript('report', 'report', { status: 'changes_requested', summary: '需要修改' }), textScript('评审完成')],
      }),
    });
    await run(session, mission('评审'));
    await session.shutdown();
    const [critic] = restoreHiveMembers(path.dirname(session.log.path), loadRunLog(session.log.path).events);
    expect(critic?.info).toMatchObject({
      id: 'c1',
      role: 'critic',
      state: 'done',
      report: { status: 'changes_requested', summary: '需要修改' },
    });
  });
  it('refuses a rewind while a queued or paused child is still active', async () => {
    const ws = tempWorkspace(),
      providers = new ProviderRegistry();
    providers.register('p', new ScriptedProvider([textScript('done')], { chunkDelayMs: 100 }));
    const session = await createSession({ cwd: ws.dir, config, providers });
    try {
      const spawned = session.swarm.spawn('main', { role: 'scout', task: 'wait' });
      if (spawned.ok) session.swarm.setPaused(spawned.id, true);
      await expect(session.rewind(1)).rejects.toThrow('请等蜂群成员结束后再回退');
    } finally {
      await session.shutdown();
    }
  });
});
