/**
 * 控制器：/技能名 回退到技能、/skills 与 /memory 命令；system prompt 含技能摘要，模型可用 skill 工具读取正文。
 */
import { describe, expect, it } from 'vitest';
import { createSession } from '../../src/agent/session.js';
import type { RoastConfig } from '../../src/core/config.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { createUiController } from '../../src/ui/controller.js';
import { skillCommands, skillPrompt } from '../../src/ui/commands.js';
import { createUiStore } from '../../src/ui/store/store.js';
import { ScriptedProvider, type Script } from '../fixtures/scripted-provider.js';
import { textScript, toolCallScript } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';

const config: RoastConfig = {
  providers: { p: { driver: 'openai-compat', apiKeyEnv: 'UNUSED' } },
  default: 'p:m',
  maxSteps: 10,
  logsDir: 'logs',
  debugLog: false,
  context: {},
  swarm: { maxAgents: 12, maxDepth: 3, maxMinutes: 60 },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(scripts: Script[] = []) {
  const ws = tempWorkspace('roast-ctl-');
  ws.file('.roast/skills/deploy/SKILL.md', '---\ndescription: 部署到预发\n---\n先运行 pnpm build');
  const provider = new ScriptedProvider(scripts);
  const providers = new ProviderRegistry();
  providers.register('p', provider);
  const session = await createSession({ cwd: ws.dir, config, providers });
  const store = createUiStore({ frameMs: 1 });
  const controller = createUiController(session, store, { exit: () => {} });
  const items = () => (store.flush(), store.getState().agents['main']!.items);
  return { session, store, controller, provider, items };
}

describe('controller skills', () => {
  it('/技能名 参数 becomes a user turn and the model loads the skill body', async () => {
    const { session, controller, provider, items } = await setup([toolCallScript('k', 'skill', { name: 'deploy' }), textScript('部署完成')]);

    controller.submit('/deploy staging', '/deploy staging');
    for (let i = 0; i < 100 && !items().some((x) => x.kind === 'turn-summary'); i++) await sleep(20);

    expect(items().find((x) => x.kind === 'user')).toMatchObject({ text: skillPrompt('deploy', 'staging') });
    const system = provider.requests[0]!.system ?? '';
    expect(system).toContain('- deploy：部署到预发');
    const toolResult = JSON.stringify(provider.requests[1]!.messages.at(-1));
    expect(toolResult).toContain('先运行 pnpm build');
    controller.dispose();
    await session.shutdown();
  });

  it('unknown names warn; /skills and /memory list content', async () => {
    const { session, controller, items } = await setup();
    await session.memory.store({ content: '偏好 pnpm' });

    controller.submit('/nope', '/nope');
    controller.submit('/skills', '/skills');
    controller.submit('/memory pnpm', '/memory pnpm');
    await sleep(50);

    const notices = items().filter((x) => x.kind === 'notice').map((x) => (x.kind === 'notice' ? x.text : ''));
    expect(notices.some((t) => t.includes('未知命令：/nope'))).toBe(true);
    expect(notices.some((t) => t.includes('/deploy  部署到预发（project）'))).toBe(true);
    expect(notices.some((t) => t.includes('偏好 pnpm'))).toBe(true);
    controller.dispose();
    await session.shutdown();
  });

  it('skillCommands hides skills shadowed by built-in commands', () => {
    const cmds = skillCommands([
      { name: 'help', description: 'x', path: '/a', source: 'user' },
      { name: 'deploy', description: '部署', path: '/b', source: 'project' },
    ]);
    expect(cmds).toEqual([{ name: 'deploy', description: '技能 · 部署', args: '[参数]' }]);
  });
});
