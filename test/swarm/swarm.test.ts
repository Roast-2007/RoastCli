/**
 * Hive 蜂群集成（真实会话 + RoutedProvider）：
 * 1. 派生两个 worker 并行，await_agents 取回两份报告（不再经 inbox 重复投递），各 agent 日志可重放
 * 2. 层级通信：子 agent 向上提问 → 父 agent 的 await 提前返回 → 父回答 → 子在等待中被唤醒、带着答案完成
 * 3. 只读角色（scout）不能写文件
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSession, type Session } from '../../src/agent/session.js';
import type { RoastConfig } from '../../src/core/config.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import type { RecordedRequest, Script } from '../fixtures/scripted-provider.js';
import { RoutedProvider } from '../fixtures/routed-provider.js';
import { textScript, toolCallScript, toolCallsScript } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { replayMismatches } from '../fixtures/replay.js';

const saved = process.env['ROAST_HOME'];
beforeEach(() => {
  process.env['ROAST_HOME'] = tempWorkspace('roast-swarm-home-').dir;
});
afterEach(() => {
  if (saved === undefined) delete process.env['ROAST_HOME'];
  else process.env['ROAST_HOME'] = saved;
});

const config: RoastConfig = {
  providers: { p: { driver: 'openai-compat', apiKeyEnv: 'UNUSED' } },
  default: 'p:m',
  maxSteps: 12,
  logsDir: 'logs',
  debugLog: false,
  context: {},
  swarm: { maxAgents: 12, maxDepth: 3, maxMinutes: 60 },
};

async function session(scripts: Record<string, Script[]>): Promise<{ s: Session; provider: RoutedProvider; dir: string }> {
  const ws = tempWorkspace('roast-swarm-');
  const provider = new RoutedProvider(scripts);
  const providers = new ProviderRegistry();
  providers.register('p', provider);
  const s = await createSession({ cwd: ws.dir, config, providers, permissionMode: 'acceptEdits' });
  return { s, provider, dir: ws.dir };
}

async function drain(s: Session, text: string) {
  const events = [];
  for await (const e of s.loop.run(text)) events.push(e);
  return events;
}

const lastUserText = (req: RecordedRequest) => JSON.stringify(req.messages.at(-1));

describe('Hive 蜂群', () => {
  it('并行派生两个 worker，await 取回两份报告；agent 日志可重放', async () => {
    const { s, provider } = await session({
      main: [
        toolCallsScript([
          { id: 's1', name: 'spawn_agent', args: { role: 'worker', task: '做 A' } },
          { id: 's2', name: 'spawn_agent', args: { role: 'worker', task: '做 B' } },
        ]),
        toolCallScript('a1', 'await_agents', { mode: 'all' }),
        textScript('全部完成'),
      ],
      w1: [toolCallScript('r1', 'report', { status: 'done', summary: 'A 完成' }), textScript('结束')],
      w2: [toolCallScript('r2', 'report', { status: 'done', summary: 'B 完成' }), textScript('结束')],
    });
    const events = await drain(s, '把 A 和 B 都做了');
    expect(events.at(-1)).toMatchObject({ type: 'turn-end', reason: 'completed' });

    const mainReqs = provider.requests.filter((r) => r.agent === 'main').map((r) => r.req);
    const afterAwait = lastUserText(mainReqs[2]!);
    expect(afterAwait).toContain('A 完成');
    expect(afterAwait).toContain('B 完成');
    expect(afterAwait).not.toContain('<inbox>');

    await s.swarm.whenIdle();
    expect(s.swarm.tree().filter((a) => a.parentId === 'main').map((a) => [a.id, a.state])).toEqual([
      ['w1', 'done'],
      ['w2', 'done'],
    ]);
    const workerLog = path.join(path.dirname(s.log.path), 'agents', 'w1.jsonl');
    expect(existsSync(workerLog)).toBe(true);
    expect(replayMismatches(workerLog)).toEqual([]);
    await s.shutdown();
    expect(replayMismatches(s.log.path)).toEqual([]);
  }, 30_000);

  it('子 agent 向上提问：父 await 提前返回并回答，子 agent 被唤醒后带着答案完成', async () => {
    const answer = (req: Parameters<Extract<Script, Function>>[0]) => {
      const id = /消息 id (m-[\w-]+)/.exec(JSON.stringify(req.messages))?.[1] ?? '';
      return toolCallScript('ans', 'send_message', { to: 'w1', kind: 'answer', subject: '决定', body: '用 zod', reply_to: id });
    };
    const { s, provider } = await session({
      main: [
        toolCallScript('s1', 'spawn_agent', { role: 'worker', task: '实现校验，需要先问上级选库' }),
        toolCallScript('a1', 'await_agents', { mode: 'all' }),
        answer,
        toolCallScript('a2', 'await_agents', { mode: 'all' }),
        textScript('完成'),
      ],
      w1: [
        toolCallScript('q1', 'send_message', { to: 'parent', kind: 'question', subject: '选哪个库', body: 'zod 还是 yup？' }),
        textScript('等待上级回答'),
        (req) => {
          const got = JSON.stringify(req.messages).includes('用 zod');
          return toolCallScript('r1', 'report', { status: 'done', summary: got ? '已按上级要求使用 zod' : '没收到回答' });
        },
        textScript('结束'),
      ],
    });
    const events = await drain(s, '做校验');
    expect(events.at(-1)).toMatchObject({ type: 'turn-end', reason: 'completed' });
    const mainReqs = provider.requests.filter((r) => r.agent === 'main').map((r) => r.req);
    expect(JSON.stringify(mainReqs[2]!.messages)).toContain('选哪个库');
    expect(lastUserText(mainReqs[4]!)).toContain('已按上级要求使用 zod');
    await s.shutdown();
  }, 30_000);

  it('只读角色 scout 写文件被拒绝，并在报告中说明', async () => {
    const { s, dir } = await session({
      main: [toolCallScript('t1', 'task', { prompt: '调研并顺手改个文件', role: 'scout' }), textScript('ok')],
      s1: [
        toolCallScript('w', 'write', { path: 'x.txt', content: 'nope' }),
        (req) => toolCallScript('r', 'report', { status: 'partial', summary: JSON.stringify(req.messages).includes('只读') ? '我是只读角色，未修改' : '?' }),
        textScript('结束'),
      ],
    });
    await drain(s, '派个侦察兵');
    expect(existsSync(path.join(dir, 'x.txt'))).toBe(false);
    expect(s.swarm.info('s1')?.report?.summary).toBe('我是只读角色，未修改');
    await s.shutdown();
  }, 30_000);
});

describe('Hive 防失控', () => {
  it('无进展看门狗：子 agent 连续多步没有实质产出时，父 agent 收到 alert', async () => {
    const { Supervisor } = await import('../../src/swarm/supervisor.js');
    const { s } = await session({
      main: [toolCallScript('s1', 'spawn_agent', { role: 'worker', task: '找东西' }), toolCallScript('a', 'await_agents', { mode: 'all' }), textScript('ok')],
      w1: [
        toolCallScript('g1', 'ls', {}),
        toolCallScript('g2', 'ls', {}),
        toolCallScript('g3', 'ls', {}),
        toolCallScript('r', 'report', { status: 'partial', summary: '没找到' }),
        textScript('结束'),
      ],
    });
    expect(s.swarm).toBeInstanceOf(Supervisor);
    s.swarm.setWatchdog({ steps: 2 });
    const alerts: string[] = [];
    s.swarm.bus.onSend(() => {});
    const original = s.swarm.mailbox('main')!;
    const enqueue = original.enqueue.bind(original);
    original.enqueue = (e) => {
      if (e.kind === 'alert') alerts.push(e.body);
      enqueue(e);
    };
    await drain(s, '派个人找东西');
    expect(alerts.some((a) => a.includes('w1') && a.includes('没有新增工具结果'))).toBe(true);
    await s.shutdown();
  }, 30_000);
});
