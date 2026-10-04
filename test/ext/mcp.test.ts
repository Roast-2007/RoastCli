/**
 * MCP：配置加载与信任、工具包装与结果转换、管理器（进程内 + 真实 stdio 子进程）、会话接线、roast mcp 命令。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { addMcpServer, expandEnvRefs, loadMcpServers, removeMcpServer } from '../../src/ext/mcp/config.js';
import { McpManager } from '../../src/ext/mcp/manager.js';
import { mcpResultToToolResult, mcpToolName, wrapMcpTool } from '../../src/ext/mcp/tool.js';
import { mcpAdd, mcpList, mcpRemove } from '../../src/cli/mcp.js';
import { createSession } from '../../src/agent/session.js';
import { trustProject, type RoastConfig } from '../../src/core/config.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { toolSchemaOf } from '../../src/tools/tool.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { textScript, toolCallScript } from '../fixtures/chunks.js';
import { inMemoryTransport } from '../fixtures/mcp-servers.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { makeCtx, textOf } from '../tools/helpers.js';

const saved = process.env['ROAST_HOME'];
let home: ReturnType<typeof tempWorkspace>;
beforeEach(() => {
  home = tempWorkspace('roast-mcp-home-');
  process.env['ROAST_HOME'] = home.dir;
});
afterEach(() => {
  if (saved === undefined) delete process.env['ROAST_HOME'];
  else process.env['ROAST_HOME'] = saved;
});

const entry = (name: string) => ({ name, transport: 'stdio' as const, command: 'x', layer: 'user' as const });

describe('mcp config', () => {
  it('merges layers by name, requires trust for repo servers and drops disabled ones', () => {
    const ws = tempWorkspace();
    home.file('config.json', JSON.stringify({ mcp: { servers: { a: { command: 'user-a' }, off: { command: 'x', disabled: true } } } }));
    ws.file('.roast/config.json', JSON.stringify({ mcp: { servers: { a: { command: 'repo-a' }, web: { url: 'https://e.com/mcp' } } } }));

    const untrusted = loadMcpServers(ws.dir, false);
    expect(untrusted.servers.map((s) => [s.name, s.command])).toEqual([['a', 'user-a']]);
    expect(untrusted.ignored).toEqual(['web']);

    const trusted = loadMcpServers(ws.dir, true);
    expect(trusted.servers.map((s) => [s.name, s.command ?? s.url, s.transport, s.layer])).toEqual([
      ['a', 'repo-a', 'stdio', 'project'],
      ['web', 'https://e.com/mcp', 'http', 'project'],
    ]);
  });

  it('rejects servers without command or url and invalid names', () => {
    const ws = tempWorkspace();
    ws.file('roastcli.config.json', JSON.stringify({ mcp: { servers: { 'bad name': { command: 'x' } } } }));
    expect(loadMcpServers(ws.dir, true).invalid).toHaveLength(1);
    expect(() => addMcpServer(path.join(ws.dir, 'c.json'), 'ok', {})).toThrow();
    expect(() => addMcpServer(path.join(ws.dir, 'c.json'), 'bad name', { command: 'x' })).toThrow();
  });

  it('expands ${VAR} references from the environment', () => {
    expect(expandEnvRefs('Bearer ${TOK}-${MISSING}', { TOK: 'abc' })).toBe('Bearer abc-');
  });

  it('adds and removes servers while preserving other config', () => {
    const file = path.join(tempWorkspace().dir, 'config.json');
    addMcpServer(file, 'fs', { command: 'npx', args: ['-y', 'server'] });
    addMcpServer(file, 'web', { url: 'https://e.com/mcp' });
    expect(removeMcpServer(file, 'fs')).toBe(true);
    expect(removeMcpServer(file, 'fs')).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ mcp: { servers: { web: { url: 'https://e.com/mcp' } } } });
  });
});

describe('mcp tool wrapping', () => {
  it('builds API-safe names, truncating long ones with a hash', () => {
    expect(mcpToolName('git hub', 'create.issue')).toBe('mcp__git_hub__create_issue');
    const long = mcpToolName('server', 'x'.repeat(100));
    expect(long).toHaveLength(64);
    expect(long).not.toBe(mcpToolName('server', `${'x'.repeat(99)}y`));
  });

  it('passes the raw schema through; readOnlyHint is honoured only when the server is trusted for annotations', () => {
    const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
    const info = { name: 'find', inputSchema: schema, annotations: { readOnlyHint: true } };
    const ro = wrapMcpTool('s', info, async () => ({}), { timeoutMs: 1000, trustAnnotations: true });
    expect(toolSchemaOf(ro).parameters).toBe(schema);
    expect(ro).toMatchObject({ isReadOnly: true, permission: { kind: 'read' } });
    expect(wrapMcpTool('s', info, async () => ({}), { timeoutMs: 1000 })).toMatchObject({ isReadOnly: false, permission: { kind: 'execute' } });
    const rw = wrapMcpTool('s', { name: 'write', inputSchema: {} }, async () => ({}), { timeoutMs: 1000, trustAnnotations: true });
    expect(toolSchemaOf(rw).parameters).toEqual({ type: 'object', properties: {} });
    expect(rw).toMatchObject({ isReadOnly: false, permission: { kind: 'execute' } });
  });

  it('converts text, media, resources and structured content', () => {
    const r = mcpResultToToolResult({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///a', text: 'body' } },
        { type: 'resource', resource: { uri: 'file:///b', blob: 'AA', mimeType: 'application/zip' } },
        { type: 'resource_link', uri: 'file:///c', name: 'c' },
      ],
    });
    expect(textOf(r)).toBe('hello\n\n[图片 image/png，约 0 KB，未展示]\n\n[资源 file:///a]\nbody\n\n[二进制资源 file:///b application/zip，未展示]\n\n[资源链接 c file:///c]');
    expect(textOf(mcpResultToToolResult({ structuredContent: { n: 1 } }))).toBe('{\n  "n": 1\n}');
    expect(mcpResultToToolResult({ content: [], isError: true })).toEqual({ content: [{ type: 'text', text: '（无输出）' }], isError: true });
  });
});

describe('McpManager', () => {
  it('connects in-memory servers, lists sorted tools, calls them and reports failures', async () => {
    const mgr = new McpManager('/', { transport: inMemoryTransport(['test']) });
    await mgr.connectAll([entry('test'), entry('broken')]);

    expect(mgr.status()).toEqual([
      { name: 'test', state: 'connected', toolCount: 4 },
      { name: 'broken', state: 'failed', toolCount: 0, error: '无法连接 broken' },
    ]);
    const tools = mgr.tools();
    expect(tools.map((t) => t.name)).toEqual(['mcp__test__add', 'mcp__test__echo', 'mcp__test__fail', 'mcp__test__snapshot']);
    const ctx = makeCtx('/');
    expect(textOf(await tools[0]!.execute({ a: 2, b: 3 }, ctx))).toBe('5');
    expect((await tools[2]!.execute({}, ctx)).isError).toBe(true);
    expect(textOf(await tools[3]!.execute({}, ctx))).toBe('[图片 image/png，约 3 KB，未展示]');

    await mgr.disconnectAll();
    expect(mgr.status()[0]!.state).toBe('closed');
    await expect(tools[1]!.execute({ text: 'x' }, ctx)).rejects.toThrow('未连接');
  });

  it('talks to a real stdio server with piped stderr and ${VAR} env', async () => {
    process.env['ROAST_TEST_PREFIX'] = '>> ';
    const tsx = path.resolve('node_modules/tsx/dist/cli.mjs');
    const script = path.resolve('test/fixtures/mcp-stdio-server.ts');
    const mgr = new McpManager(process.cwd(), { connectTimeoutMs: 20_000 });
    await mgr.connectAll([{ name: 'stdio', transport: 'stdio', layer: 'user', command: process.execPath, args: [tsx, script], env: { ECHO_PREFIX: '${ROAST_TEST_PREFIX}' } }]);

    expect(mgr.status()[0]).toMatchObject({ state: 'connected', toolCount: 4 });
    const echo = mgr.tools().find((t) => t.name === 'mcp__stdio__echo')!;
    expect(textOf(await echo.execute({ text: 'hi' }, makeCtx('/')))).toBe('>> hi');
    await mgr.disconnectAll();
  }, 30_000);
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

describe('session MCP wiring', () => {
  it('registers MCP tools before the first request and runs read-only calls without asking', async () => {
    const ws = tempWorkspace();
    home.file('config.json', JSON.stringify({ mcp: { servers: { test: { command: 'unused', trustAnnotations: true }, broken: { command: 'unused' } } } }));
    const provider = new ScriptedProvider([toolCallScript('e', 'mcp__test__echo', { text: '你好' }), textScript('完成')]);
    const providers = new ProviderRegistry();
    providers.register('p', provider);
    const session = await createSession({ cwd: ws.dir, config, providers, mcpTransport: inMemoryTransport(['test']) });

    for await (const _ of session.loop.run('回显一下'));

    const names = provider.requests[0]!.tools!.map((t) => t.name);
    expect(names.filter((n) => n.startsWith('mcp__'))).toEqual(['mcp__test__add', 'mcp__test__echo', 'mcp__test__fail', 'mcp__test__snapshot']);
    expect(JSON.stringify(provider.requests[1]!.messages.at(-1))).toContain('你好');
    expect(session.startupWarnings).toEqual(['MCP 服务器 broken 连接失败：无法连接 broken']);
    expect(session.mcpStatus().map((s) => s.state)).toEqual(['failed', 'connected']);
    await session.shutdown();
    expect(session.mcpStatus().map((s) => s.state)).toEqual(['failed', 'closed']);
  });

  it('skips untrusted repo servers with a warning', async () => {
    const ws = tempWorkspace();
    ws.file('.roast/config.json', JSON.stringify({ mcp: { servers: { test: { command: 'unused' } } } }));
    const providers = new ProviderRegistry();
    providers.register('p', new ScriptedProvider([]));

    const session = await createSession({ cwd: ws.dir, config, providers, mcpTransport: inMemoryTransport(['test']) });
    expect(session.mcpStatus()).toEqual([]);
    expect(session.startupWarnings[0]).toContain('MCP 服务器未启用');
    await session.shutdown();

    trustProject(ws.dir);
    const trusted = await createSession({ cwd: ws.dir, config, providers, mcpTransport: inMemoryTransport(['test']) });
    expect(trusted.mcpStatus()).toEqual([{ name: 'test', state: 'connected', toolCount: 4 }]);
    await trusted.shutdown();
  });
});

describe('roast mcp commands', () => {
  it('adds, lists and removes servers, warning about literal secrets', () => {
    const ws = tempWorkspace();
    const added = mcpAdd(ws.dir, 'gh', { command: ['npx', '-y', 'server-github'], env: ['GITHUB_TOKEN=ghp_literal'] });
    expect(added).toContain('已添加 MCP 服务器 gh');
    expect(added).toContain('GITHUB_TOKEN 看起来是密钥');
    expect(mcpAdd(ws.dir, 'docs', { url: 'https://e.com/mcp', header: ['Authorization=Bearer ${DOCS}'] })).not.toContain('看起来是密钥');
    expect(mcpAdd(ws.dir, 'local', { project: true, command: ['node', 's.js'] })).toContain('roast trust');

    expect(mcpList(ws.dir)).toBe(
      ['docs  [http · user]  https://e.com/mcp', 'gh  [stdio · user]  npx -y server-github', 'local  [未启用：项目未信任，运行 roast trust]'].join('\n'),
    );
    expect(mcpRemove(ws.dir, 'gh')).toContain('已移除');
    expect(mcpRemove(ws.dir, 'gh')).toContain('没有名为 gh');
  });

  it('validates arguments', () => {
    const ws = tempWorkspace();
    expect(() => mcpAdd(ws.dir, 'x', {})).toThrow('需要 --url');
    expect(() => mcpAdd(ws.dir, 'x', { url: 'https://e.com', transport: 'ws' })).toThrow('未知传输方式');
    expect(() => mcpAdd(ws.dir, 'x', { command: ['a'], env: ['NOEQUALS'] })).toThrow('KEY=VALUE');
    expect(mcpList(ws.dir)).toContain('没有配置 MCP 服务器');
  });
});
