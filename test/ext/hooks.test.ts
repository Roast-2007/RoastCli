/**
 * 用户钩子：配置加载与信任、命令执行（stdin 负载 / 退出码语义 / 超时）、各接入点、以及会话级端到端。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { emptyHooksConfig, loadHooks, matchesTool, type HookSpec } from '../../src/ext/hooks/config.js';
import { HookRunner, runHookCommand } from '../../src/ext/hooks/runner.js';
import { MAX_STOP_BLOCKS, postToolUseHook, preToolUseHook, promptSubmitGuard, stopHookBoundary } from '../../src/ext/hooks/integration.js';
import { chainInputGuards } from '../../src/agent/hooks-setup.js';
import { createSession } from '../../src/agent/session.js';
import { trustProject, type RoastConfig } from '../../src/core/config.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { readTool, textResult, writeTool } from '../../src/tools/index.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { textScript, toolCallScript } from '../fixtures/chunks.js';
import { replayMismatches } from '../fixtures/replay.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { makeCtx } from '../tools/helpers.js';

const HOOK_JS = `
const fs = require('fs');
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const p = JSON.parse(input);
  const [mode, arg] = process.argv.slice(2);
  if (mode === 'echo') { process.stdout.write(p.hook_event_name + ':' + (p.tool_name || p.prompt || p.source || '')); process.exit(0); }
  if (mode === 'block') { process.stderr.write('blocked ' + (p.tool_name || '')); process.exit(2); }
  if (mode === 'fail') { process.stderr.write('oops'); process.exit(1); }
  if (mode === 'hang') { setTimeout(() => {}, 20000); return; }
  if (mode === 'once') {
    if (fs.existsSync(arg)) process.exit(0);
    fs.writeFileSync(arg, '1');
    process.stderr.write('请先运行测试');
    process.exit(2);
  }
});
`;

const fwd = (p: string) => p.split(path.sep).join('/');

function hookCommand(dir: string, mode: string, arg = ''): string {
  const script = path.join(dir, 'hook.cjs');
  if (!existsSync(script)) writeFileSync(script, HOOK_JS, 'utf8');
  return `"${fwd(process.execPath)}" "${fwd(script)}" ${mode}${arg ? ` "${fwd(arg)}"` : ''}`;
}

const saved = process.env['ROAST_HOME'];
let home: ReturnType<typeof tempWorkspace>;
beforeEach(() => {
  home = tempWorkspace('roast-hooks-home-');
  process.env['ROAST_HOME'] = home.dir;
});
afterEach(() => {
  if (saved === undefined) delete process.env['ROAST_HOME'];
  else process.env['ROAST_HOME'] = saved;
});

describe('hooks config', () => {
  it('collects user hooks always and repo hooks only when trusted', () => {
    const ws = tempWorkspace();
    home.file('config.json', JSON.stringify({ hooks: { Stop: [{ command: 'user-stop' }] } }));
    ws.file('.roast/config.json', JSON.stringify({ hooks: { Stop: [{ command: 'repo-stop' }], PreToolUse: [{ matcher: 'bash', command: 'x' }] } }));

    const untrusted = loadHooks(ws.dir, false);
    expect(untrusted.hooks.Stop.map((h) => h.command)).toEqual(['user-stop']);
    expect(untrusted.ignored).toBe(2);

    const trusted = loadHooks(ws.dir, true);
    expect(trusted.hooks.Stop.map((h) => h.command)).toEqual(['repo-stop', 'user-stop']);
    expect(trusted.hooks.PreToolUse).toHaveLength(1);
    expect(trusted.ignored).toBe(0);
  });

  it('reports malformed hook sections without failing', () => {
    const ws = tempWorkspace();
    ws.file('roastcli.config.json', JSON.stringify({ hooks: { Stop: [{ nope: 1 }] } }));
    const loaded = loadHooks(ws.dir, true);
    expect(loaded.invalid).toEqual([path.join(ws.dir, 'roastcli.config.json')]);
    expect(loaded.hooks).toEqual(emptyHooksConfig());
  });

  it('matches tool names by anchored regex, wildcard, or literal fallback', () => {
    expect(matchesTool(undefined, 'bash')).toBe(true);
    expect(matchesTool('*', 'bash')).toBe(true);
    expect(matchesTool('edit|write', 'write')).toBe(true);
    expect(matchesTool('edit|write', 'multi_edit')).toBe(false);
    expect(matchesTool('(', '(')).toBe(true);
  });
});

describe('hook runner', () => {
  it('passes the JSON payload on stdin and returns stdout on exit 0', async () => {
    const ws = tempWorkspace();
    const r = await runHookCommand({ command: hookCommand(ws.dir, 'echo') }, { hook_event_name: 'PreToolUse', tool_name: 'bash' }, { cwd: ws.dir });
    expect(r).toMatchObject({ code: 0, stdout: 'PreToolUse:bash', timedOut: false });
  });

  it('settles promptly when a background grandchild keeps the output pipe open', async () => {
    const ws = tempWorkspace();
    const started = Date.now();
    const r = await runHookCommand({ command: 'sleep 20 & echo started', timeoutMs: 10_000 }, {}, { cwd: ws.dir });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r).toMatchObject({ code: 0, stdout: 'started', timedOut: false });
  }, 15_000);

  it('does not start when the signal is already aborted', async () => {
    const ws = tempWorkspace();
    const ac = new AbortController();
    ac.abort();
    const r = await runHookCommand({ command: hookCommand(ws.dir, 'echo') }, {}, { cwd: ws.dir, signal: ac.signal });
    expect(r).toMatchObject({ aborted: true, code: null, stdout: '' });
    const runner = new HookRunner({ ...emptyHooksConfig(), Stop: [{ command: hookCommand(ws.dir, 'block') }] }, { cwd: ws.dir, sessionId: 's' });
    expect(await runner.run('Stop', {}, { signal: ac.signal })).toEqual({ output: '', errors: [] });
  });

  it('kills commands that exceed their timeout', async () => {
    const ws = tempWorkspace();
    const r = await runHookCommand({ command: hookCommand(ws.dir, 'hang'), timeoutMs: 300 }, {}, { cwd: ws.dir });
    expect(r.timedOut).toBe(true);
  }, 10_000);

  it('filters by matcher, stops at the first block and collects non-blocking errors', async () => {
    const ws = tempWorkspace();
    const specs: HookSpec[] = [
      { matcher: 'write', command: hookCommand(ws.dir, 'fail') },
      { matcher: 'read', command: hookCommand(ws.dir, 'block') },
      { matcher: 'write', command: hookCommand(ws.dir, 'block') },
      { command: hookCommand(ws.dir, 'echo') },
    ];
    const runner = new HookRunner({ ...emptyHooksConfig(), PreToolUse: specs }, { cwd: ws.dir, sessionId: 's' });

    const r = await runner.run('PreToolUse', { tool_name: 'write' }, { toolName: 'write' });

    expect(r.blocked).toBe('blocked write');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('退出码 1');
    expect(runner.has('PreToolUse', 'ls')).toBe(true);
    expect(runner.has('Stop')).toBe(false);
  });
});

describe('hook integration points', () => {
  function runnerWith(event: 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop', mode: string, dir: string, arg = '') {
    return new HookRunner({ ...emptyHooksConfig(), [event]: [{ command: hookCommand(dir, mode, arg) }] }, { cwd: dir, sessionId: 's' });
  }

  it('PreToolUse exit 2 denies the call with the stderr reason', async () => {
    const ws = tempWorkspace();
    const hook = preToolUseHook(runnerWith('PreToolUse', 'block', ws.dir), () => {});
    expect(await hook(writeTool, { path: 'a' }, makeCtx(ws.dir))).toEqual({ action: 'deny', reason: 'PreToolUse 钩子阻止：blocked write' });
  });

  it('PostToolUse exit 2 appends feedback; failures go to onError', async () => {
    const ws = tempWorkspace();
    const errors: string[] = [];
    const result = textResult('ok');
    const fed = await postToolUseHook(runnerWith('PostToolUse', 'block', ws.dir), () => {})(readTool, {}, result, makeCtx(ws.dir));
    expect(fed.content.at(-1)).toEqual({ type: 'text', text: 'PostToolUse 钩子反馈：blocked read' });
    const same = await postToolUseHook(runnerWith('PostToolUse', 'fail', ws.dir), (e) => errors.push(...e))(readTool, {}, result, makeCtx(ws.dir));
    expect(same).toBe(result);
    expect(errors).toHaveLength(1);
  });

  it('UserPromptSubmit appends stdout as context or blocks', async () => {
    const ws = tempWorkspace();
    const echo = await promptSubmitGuard(runnerWith('UserPromptSubmit', 'echo', ws.dir), () => {}).check('你好', 'user');
    expect(echo).toEqual({ action: 'sanitize', sanitized: '你好\n\n[UserPromptSubmit 钩子附加的上下文]\nUserPromptSubmit:你好' });
    const blocked = await promptSubmitGuard(runnerWith('UserPromptSubmit', 'block', ws.dir), () => {}).check('x', 'user');
    expect(blocked.action).toBe('block');
  });

  it('Stop exit 2 continues the turn with injected feedback, at most MAX_STOP_BLOCKS times', async () => {
    const ws = tempWorkspace();
    const boundary = stopHookBoundary(runnerWith('Stop', 'block', ws.dir), () => {});
    const ctx = { agentId: 'main', turn: 1, step: 1, signal: new AbortController().signal, messages: () => [] };
    for (let i = 0; i < MAX_STOP_BLOCKS; i++) {
      expect(await boundary.onWouldEndTurn!(ctx)).toEqual({ kind: 'continue' });
      expect(await boundary.beforeRequest!(ctx)).toEqual([{ kind: 'inject', source: 'hook:Stop', blocks: [{ type: 'text', text: '[Stop 钩子要求继续] blocked' }] }]);
    }
    expect(await boundary.onWouldEndTurn!(ctx)).toEqual({ kind: 'end' });
    expect(await boundary.onWouldEndTurn!({ ...ctx, turn: 2 })).toEqual({ kind: 'continue' });
    // turn 2 在注入前结束（步数用尽 / 中断）：反馈不会漏进 turn 3
    expect(await boundary.beforeRequest!({ ...ctx, turn: 3 })).toEqual([]);
  }, 20_000);

  it('chainInputGuards runs both guards and keeps the sanitized text', async () => {
    const upper = { check: async (t: string) => ({ action: 'sanitize' as const, sanitized: t.toUpperCase() }) };
    const pass = { check: async () => ({ action: 'pass' as const }) };
    expect(chainInputGuards(undefined, pass)).toBe(pass);
    expect(await chainInputGuards(upper, pass)!.check('a', 'user')).toEqual({ action: 'sanitize', sanitized: 'A' });
  });
});

const config: RoastConfig = {
  providers: { p: { driver: 'openai-compat', apiKeyEnv: 'UNUSED' } },
  default: 'p:m',
  maxSteps: 10,
  logsDir: 'logs',
  debugLog: false,
  context: {},
  swarm: { maxAgents: 12, maxDepth: 3, maxMinutes: 60 },
};

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen);
}

describe('session hooks end-to-end', () => {
  it('PreToolUse blocks writes even in yolo mode; UserPromptSubmit and SessionStart add context; Stop continues once', async () => {
    const ws = tempWorkspace();
    const marker = path.join(ws.dir, 'stop-marker');
    home.file(
      'config.json',
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'write', command: hookCommand(home.dir, 'block') }],
          UserPromptSubmit: [{ command: hookCommand(home.dir, 'echo') }],
          SessionStart: [{ command: hookCommand(home.dir, 'echo') }],
          Stop: [{ command: hookCommand(home.dir, 'once', marker) }],
        },
      }),
    );
    const provider = new ScriptedProvider([toolCallScript('w', 'write', { path: 'x.txt', content: 'hi' }), textScript('写不了'), textScript('测试已运行')]);
    const providers = new ProviderRegistry();
    providers.register('p', provider);
    const session = await createSession({ cwd: ws.dir, config, providers, permissionMode: 'yolo' });

    await drain(session.loop.run('写个文件'));

    expect(existsSync(path.join(ws.dir, 'x.txt'))).toBe(false);
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[0]!.system).toContain('SessionStart:startup');
    expect(JSON.stringify(provider.requests[0]!.messages[0])).toContain('UserPromptSubmit:写个文件');
    expect(JSON.stringify(provider.requests[1]!.messages.at(-1))).toContain('PreToolUse 钩子阻止：blocked write');
    expect(JSON.stringify(provider.requests[2]!.messages.at(-1))).toContain('请先运行测试');
    await session.shutdown();
    expect(replayMismatches(session.log.path)).toEqual([]);
  }, 30_000);

  it('ignores repo hooks of untrusted projects and warns; applies them once trusted', async () => {
    const ws = tempWorkspace();
    ws.file('.roast/config.json', JSON.stringify({ hooks: { SessionStart: [{ command: hookCommand(home.dir, 'echo') }] } }));
    const providers = new ProviderRegistry();
    providers.register('p', new ScriptedProvider([]));

    const untrusted = await createSession({ cwd: ws.dir, config, providers });
    expect(untrusted.startupWarnings).toEqual(['项目配置中的 1 个钩子未生效（未信任项目，可运行 roast trust）']);
    await untrusted.shutdown();

    trustProject(ws.dir);
    const trusted = await createSession({ cwd: ws.dir, config, providers });
    expect(trusted.startupWarnings).toEqual([]);
    await trusted.shutdown();
  }, 30_000);
});
