import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../src/agent/runtime.js';
import { setupPermissions } from '../../src/agent/permissions-setup.js';
import { SystemPromptAssembler } from '../../src/agent/system-prompt.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { loadRunLog } from '../../src/session/projection.js';
import { openRunLog } from '../../src/session/resume.js';
import { createDefaultToolRegistry, MapToolServices } from '../../src/tools/index.js';
import { ScriptedProvider, type Script } from '../fixtures/scripted-provider.js';
import { textScript, toolCallScript } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';

const saved = process.env['ROAST_HOME'];
beforeEach(() => {
  process.env['ROAST_HOME'] = tempWorkspace('roast-ps-home-').dir;
});
afterEach(() => {
  if (saved === undefined) delete process.env['ROAST_HOME'];
  else process.env['ROAST_HOME'] = saved;
});

async function start(dir: string, scripts: Script[], resumeLogPath?: string) {
  const provider = new ScriptedProvider(scripts);
  const providers = new ProviderRegistry();
  providers.register('p', provider);
  const opened = await openRunLog({
    logsRoot: path.join(dir, 'logs'),
    info: { cwd: dir, provider: 'p', model: 'm' },
    ...(resumeLogPath ? { resumeLogPath } : {}),
  });
  const services = new MapToolServices();
  const perms = setupPermissions({ cwd: dir, services, ...(opened.permissions ? { restored: opened.permissions } : {}) });
  const rt = new AgentRuntime({
    providers,
    modelRef: { provider: 'p', model: 'm' },
    tools: createDefaultToolRegistry(),
    systemPrompt: new SystemPromptAssembler(),
    log: opened.log,
    cwd: dir,
    services,
    hooks: { preExecute: [perms.hook], postExecute: [] },
    initialHistory: opened.initialHistory,
  });
  opened.finalize((b) => rt.committer.commit(b));
  perms.attach((b) => rt.committer.commit(b));
  return { rt, perms, opened, provider };
}

async function drain(rt: AgentRuntime, text: string) {
  for await (const _ of rt.run(text)) {
    // drain
  }
}

describe('会话权限装配', () => {
  it('用户"本会话始终允许"后落 permission/grant；切换模式落 mode/change；resume 后均恢复', async () => {
    const ws = tempWorkspace('roast-ps-');
    const s1 = await start(ws.dir, [toolCallScript('c1', 'bash', { command: 'echo hi > out.txt' }), textScript('done')]);
    s1.perms.broker.onRequest((req) => s1.perms.broker.respond(req.id, { kind: 'permission', decision: 'allow', remember: 'session' }));
    await drain(s1.rt, '写文件');
    s1.perms.engine.setMode('acceptEdits');
    await s1.opened.log.close();

    const types = loadRunLog(s1.opened.log.path).events.map((e) => e.type);
    expect(types).toContain('permission/grant');
    expect(types).toContain('mode/change');

    const s2 = await start(ws.dir, [], s1.opened.log.path);
    expect(s2.perms.engine.mode).toBe('acceptEdits');
    expect(s2.perms.engine.evaluate({ tool: 'bash', kind: 'execute', target: 'echo hi > y.txt', cwd: ws.dir }).behavior).toBe('allow');
    await s2.opened.log.close();
  });

  it('无界面时需要询问的操作被拒绝，模型收到可读的拒绝原因', async () => {
    const ws = tempWorkspace('roast-ps2-');
    const s = await start(ws.dir, [toolCallScript('c1', 'bash', { command: 'npm install' }), textScript('ok')]);
    await drain(s.rt, '装依赖');
    const result = loadRunLog(s.opened.log.path).events.find((e) => e.type === 'tool/result');
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('非交互');
    await s.opened.log.close();
  });
});
