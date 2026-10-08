import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../../src/core/config.js';
import { createSession, type Session } from '../../src/agent/session.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { RoutedProvider } from '../fixtures/routed-provider.js';
import { textScript, toolCallScript, errorScript } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { createUiController } from '../../src/ui/controller.js';
import { createUiStore } from '../../src/ui/store/store.js';
import { deriveDisplayMessages, loadRunLog } from '../../src/session/projection.js';
import { initTarget, initPrompt } from '../../src/ui/init-prompt.js';
import { replayMismatches } from '../fixtures/replay.js';
import { spawnAgentTool } from '../../src/swarm/tools.js';

const image = { type: 'image' as const, mediaType: 'image/png', data: 'iVBORw0KGgo=' };
const config = ConfigSchema.parse({
  providers: { p: { driver: 'openai-compat', auth: 'none', models: { m: {}, other: {} } } },
  default: 'p:m',
  swarm: { worktrees: false },
});
const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.shutdown();
  vi.unstubAllEnvs();
});
const drain = async (stream: AsyncIterable<unknown>) => {
  for await (const _ of stream) {
  }
};
async function open(provider: ScriptedProvider | RoutedProvider, opts: Parameters<typeof createSession>[0] = {}) {
  const ws = tempWorkspace(),
    providers = new ProviderRegistry();
  providers.register('p', provider);
  const session = await createSession({ cwd: ws.dir, config, providers, ...opts });
  sessions.push(session);
  return { ws, session, provider };
}

describe('image runtime and controller', () => {
  it('preserves mission and boundary images in logged history and after resume', async () => {
    const provider = new ScriptedProvider([toolCallScript('read', 'read', { path: 'a.txt' }), textScript('done'), textScript('again')]);
    const { session, ws } = await open(provider);
    ws.file('a.txt', 'text');
    const controller = createUiController(session, createUiStore(), { exit() {} });
    controller.setScreen('hive');
    controller.submit('[图片 #1] goal', '[图片 #1] goal', [image]);
    await controller.whenIdle();
    const history = [...session.loop.committer.messages()];
    expect(history[0]!.content).toContainEqual(image);
    const mission = session.displayEvents().find((e) => e.type === 'hive/mission');
    expect(mission).toMatchObject({ images: [image] });
    expect(deriveDisplayMessages([...session.displayEvents()])[0]!.content).toContainEqual(image);
    controller.dispose();
    const log = session.log.path;
    await session.shutdown();
    const providers = new ProviderRegistry();
    providers.register('p', provider);
    const resumed = await createSession({ cwd: ws.dir, config, providers, resumeLogPath: log });
    sessions.push(resumed);
    expect(resumed.loop.committer.messages()).toEqual(history);
    await drain(resumed.loop.run('next'));
    expect(resumed.loop.committer.messages().some((msg) => msg.content.some((b) => b.type === 'image'))).toBe(true);
    await resumed.shutdown();
    expect(replayMismatches(log)).toEqual([]);
  });
  it('routes Chat and Queen images, rejects member images and ignores command attachments', async () => {
    const provider = new ScriptedProvider([textScript('chat'), textScript('queen')]);
    const { session } = await open(provider),
      store = createUiStore({ frameMs: 1 }),
      controller = createUiController(session, store, { exit() {} });
    try {
      controller.setScreen('inline');
      controller.submit('chat', 'chat', [image]);
      await controller.whenIdle();
      expect(provider.requests[0]!.messages[0]!.content).toContainEqual(image);
      controller.setScreen('hive');
      controller.submit('@queen see this', '@queen see this', [image]);
      await controller.whenIdle();
      expect(provider.requests[1]!.messages.at(-1)!.content).toContainEqual(image);
      const member = session.swarm.spawn('main', { role: 'scout', task: 'read' });
      expect(member.ok).toBe(true);
      controller.submit(`@${member.ok ? member.id : 's1'} hi`, 'raw', [image]);
      expect(store.getState().meta.signals?.some((s) => s.text === '图片只能发给 Queen')).toBe(true);
      controller.submit('/status', '/status', [image]);
      expect(store.getState().meta.signals?.some((s) => s.text === '图片只能随普通消息发送')).toBe(true);
    } finally {
      controller.dispose();
    }
  });
  it('keeps queued images through an active mission and its next boundary', async () => {
    const provider = new ScriptedProvider([toolCallScript('r', 'read', { path: 'a.txt' }), textScript('done')]);
    const { session, ws } = await open(provider);
    ws.file('a.txt', 'text');
    for await (const event of session.loop.run('read'))
      if (event.type === 'tool-call-start') session.loop.enqueue({ role: 'user', content: [{ type: 'text', text: 'look' }, image] });
    expect(provider.requests[1]!.messages.at(-1)!.content).toContainEqual(image);
  });
  it.each([1, 5])(
    'warns about unsupported images delivered by a queued mission while the initial turn has only text (steps=%i)',
    async (maxSteps) => {
      const provider = new ScriptedProvider([toolCallScript('r', 'read', { path: 'a.txt' }), errorScript('INVALID_REQUEST')], {
        chunkDelayMs: 5,
      });
      const { session, ws } = await open(provider, { maxSteps });
      ws.file('a.txt', 'text');
      const store = createUiStore({ frameMs: 1 }),
        controller = createUiController(session, store, { exit() {} });
      try {
        controller.submit('read', 'read');
        await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
        controller.submit(
          {
            kind: 'mission',
            goal: 'queued picture',
            strategy: { name: 'auto', description: '', playbook: '', source: 'builtin' },
            n: 3,
            images: [image],
          },
          'queued picture',
        );
        await controller.whenIdle();
        expect(provider.requests[1]!.messages.at(-1)!.content).toContainEqual(image);
        expect(store.getState().meta.signals?.some((signal) => signal.text === '当前模型可能不支持图片输入')).toBe(true);
      } finally {
        controller.dispose();
      }
    },
  );
  it('restores only text and warns about lost images during a shell command', async () => {
    const { session } = await open(new ScriptedProvider([])),
      store = createUiStore({ frameMs: 1 }),
      controller = createUiController(session, store, { exit() {} });
    try {
      controller.submit('!echo shell', '!echo shell');
      controller.submit('picture text', 'picture text', [image]);
      expect(store.getState().meta.inputSeed.text).toBe('picture text');
      expect(store.getState().meta.signals?.some((signal) => signal.text.includes('图片未保留'))).toBe(true);
      controller.interrupt();
      await controller.whenIdle();
    } finally {
      controller.dispose();
    }
  });
});
describe('init repository analysis', () => {
  it('selects instruction precedence and sends a normal Queen turn, rejecting busy and plan mode', async () => {
    const provider = new ScriptedProvider([textScript('updated')]),
      { session, ws } = await open(provider);
    expect(initTarget(ws.dir)).toBe('ROAST.md');
    ws.file('CLAUDE.md', 'claude');
    ws.file('AGENTS.md', 'agents');
    expect(initTarget(ws.dir)).toBe('AGENTS.md');
    const store = createUiStore({ frameMs: 1 }),
      controller = createUiController(session, store, { exit() {} });
    try {
      controller.setScreen('hive');
      controller.runCommand('/init');
      await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
      await controller.whenIdle();
      expect(JSON.stringify(provider.requests[0]!.messages)).toContain(initPrompt('AGENTS.md').split('\n')[0]);
      expect(session.displayEvents().some((e) => e.type === 'hive/mission')).toBe(false);
      expect(store.getState().meta.signals?.some((s) => s.text === '说明文件在下次会话生效')).toBe(true);
      session.permissions.setMode('plan');
      controller.runCommand('/init');
      await Promise.resolve();
      expect(provider.requests).toHaveLength(1);
      session.permissions.setMode('default');
      store.setMeta({ running: true });
      controller.runCommand('/init');
      await Promise.resolve();
      expect(provider.requests).toHaveLength(1);
      store.setMeta({ running: false });
      controller.runCommand('/init template');
      await vi.waitFor(() => expect(initTarget(ws.dir)).toBe('ROAST.md'));
      controller.runCommand('/init template');
      await Promise.resolve();
      expect(provider.requests).toHaveLength(1);
    } finally {
      controller.dispose();
    }
  });
});
describe('profile spawning and shared process constraints', () => {
  it('enforces the profile whitelist in execution and allows report, while rejecting writer profiles in read-only missions', async () => {
    const home = tempWorkspace();
    vi.stubEnv('ROAST_HOME', home.dir);
    home.file('agents/limited.md', '---\nrole: worker\ntools: Read\nmodel: inherit\n---\nRead and report');
    const provider = new RoutedProvider({
      main: [toolCallScript('spawn', 'spawn_agent', { agent: 'limited', task: 'read' }), textScript('done')],
      w1: [
        toolCallScript('glob', 'glob', { pattern: '**/*' }),
        toolCallScript('report', 'report', { status: 'done', summary: 'done', refs: [] }),
      ],
    });
    const { session } = await open(provider, { roleModels: { worker: 'p:other' } });
    session.swarm.observeMission({
      type: 'hive/mission',
      turn: 1,
      at: '',
      missionId: 'm1',
      goal: 'research',
      brief: '',
      strategy: 'research',
      n: 3,
      readOnly: true,
    });
    expect(session.swarm.spawn('main', { agent: 'limited', task: 'read' })).toMatchObject({ ok: false, reason: '本任务为只读调研' });
    await drain(session.loop.run('read'));
    await session.swarm.whenIdle();
    expect(session.swarm.info('w1')?.model).toBe('p:m');
    const child = loadRunLog(session.log.path.replace(/log\.jsonl$/, 'agents/w1.jsonl'));
    expect(child.events.find((event) => event.type === 'tool/result' && event.name === 'glob')).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('成员 w1（limited）不允许使用 glob') }],
    });
    expect(child.events.find((event) => event.type === 'tool/result' && event.name === 'report')).toMatchObject({ isError: false });
  });
  it('enforces profile routing, role conflicts, read-only restrictions and restores profile metadata', async () => {
    const home = tempWorkspace();
    vi.stubEnv('ROAST_HOME', home.dir);
    home.file('agents/reviewer.md', '---\nrole: critic\nmodel: p:other\nreasoning_effort: high\ntools: Read, Edit\n---\nEvidence only');
    const provider = new RoutedProvider({
      main: [toolCallScript('spawn', 'spawn_agent', { agent: 'reviewer', task: 'review' }), textScript('done')],
      c1: [toolCallScript('edit', 'edit', { path: 'a.ts', old_string: 'x', new_string: 'y' }), textScript('report')],
    });
    const { session } = await open(provider, {
      roleModels: { critic: 'inherit' },
      disallowedTools: ['web_*'],
      allowedTools: ['edit(*)'],
      maxSteps: 2,
    });
    const conflict = session.swarm.spawn('main', { agent: 'reviewer', role: 'worker', task: 'review' });
    expect(conflict).toMatchObject({ ok: false });
    expect(session.swarm.spawn('main', { agent: 'missing', task: 'review' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('reviewer'),
    });
    expect(session.swarm.spawn('main', { agent: 'reviewer', task: 'review', model: 'p:m' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('已由用户指定'),
    });
    expect(session.swarm.spawn('main', { agent: 'reviewer', task: 'review', reasoningEffort: 'low' })).toMatchObject({ ok: false });
    await drain(session.loop.run('review'));
    await session.swarm.whenIdle();
    expect(session.swarm.info('c1')).toMatchObject({ role: 'critic', profile: 'reviewer', model: 'p:other', reasoningEffort: 'high' });
    const main = provider.requests.find((r) => r.agent === 'main')!.req,
      child = provider.requests.find((r) => r.agent === 'c1')!.req;
    expect(child.system).toBe(main.system);
    expect(child.tools).toEqual(main.tools);
    expect(main.system).toContain('Agent profiles');
    expect(child.tools?.some((t) => t.name === 'web_fetch')).toBe(false);
    expect(JSON.stringify(child.messages)).toContain('Profile reviewer:');
    const log = session.log.path;
    await session.shutdown();
    const spawn = loadRunLog(log).events.find((e) => e.type === 'tool/result' && e.name === 'spawn_agent');
    expect(spawn).toMatchObject({ metadata: { agentId: 'c1', role: 'critic', profile: 'reviewer' } });
    const providers = new ProviderRegistry();
    providers.register('p', provider);
    const resumed = await createSession({ cwd: session.log.header.cwd, config, providers, resumeLogPath: log });
    sessions.push(resumed);
    expect(resumed.restoredHive.members[0]?.info).toMatchObject({ role: 'critic', profile: 'reviewer' });
    expect(spawnAgentTool.parameters.safeParse({ agent: 'reviewer', task: 'review' }).success).toBe(true);
  });
});
