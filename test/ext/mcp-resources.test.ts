import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { McpManager, type TransportFactory } from '../../src/ext/mcp/manager.js';
import { createSession } from '../../src/agent/session.js';
import { ConfigSchema } from '../../src/core/config.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { createUiController } from '../../src/ui/controller.js';
import { createUiStore } from '../../src/ui/store/store.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { textScript, toolCallScript } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { makeCtx, textOf } from '../tools/helpers.js';

const savedHome = process.env['ROAST_HOME'];
let home: ReturnType<typeof tempWorkspace>;
beforeEach(() => {
  home = tempWorkspace();
  process.env['ROAST_HOME'] = home.dir;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env['ROAST_HOME'];
  else process.env['ROAST_HOME'] = savedHome;
});

const transport: TransportFactory = async () => {
  const server = new McpServer({ name: 'docs', version: '1' });
  server.registerResource('guide', 'docs://guide', { mimeType: 'text/plain' }, async (uri) => ({
    contents: [{ uri: uri.href, text: 'Guide contents' }],
  }));
  server.registerPrompt('review', { argsSchema: { topic: z.string(), tone: z.string().optional() } }, async ({ topic, tone }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Review ${topic} in ${tone ?? 'normal'} tone` } }],
  }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  return clientSide;
};

describe('MCP resources and prompt commands', () => {
  it('connects without tools, lists resources and validates quoted prompt arguments', async () => {
    const manager = new McpManager('.', { transport });
    await manager.connectAll([{ name: 'docs', transport: 'stdio', command: 'unused', layer: 'user' }]);
    try {
      expect(manager.status()[0]).toMatchObject({ state: 'connected', toolCount: 0, resourceCount: 1, promptCount: 1 });
      const tools = manager.tools();
      expect(textOf(await tools.find((t) => t.name.endsWith('list_resources'))!.execute({}, makeCtx('.')))).toContain('docs://guide');
      expect(textOf(await tools.find((t) => t.name.endsWith('read_resource'))!.execute({ uri: 'docs://guide' }, makeCtx('.')))).toContain(
        'Guide contents',
      );
      expect(JSON.stringify(await manager.promptContent('mcp__docs__prompt_review', '"cache engine" tone="precise and brief"'))).toContain(
        'Review cache engine in precise and brief tone',
      );
      await expect(manager.promptContent('mcp__docs__prompt_review', '')).rejects.toThrow('缺少参数 topic');
      await expect(manager.promptContent('mcp__docs__prompt_review', 'wrong=x')).rejects.toThrow('参数名称');
    } finally {
      await manager.disconnectAll();
    }
  });
  it('reads resource URIs without filesystem approval and submits a prompt through the UI controller', async () => {
    home.file('config.json', JSON.stringify({ mcp: { servers: { docs: { command: 'unused' } } } }));
    const provider = new ScriptedProvider([
      toolCallScript('r', 'mcp__docs__read_resource', { uri: 'docs://guide' }),
      textScript('read'),
      textScript('reviewed'),
    ]);
    const providers = new ProviderRegistry();
    providers.register('p', provider);
    const session = await createSession({
      cwd: tempWorkspace().dir,
      config: ConfigSchema.parse({
        providers: { p: { driver: 'openai-compat', auth: 'none' } },
        default: 'p:m',
        swarm: { worktrees: false },
      }),
      providers,
      mcpTransport: transport,
    });
    const store = createUiStore(),
      controller = createUiController(session, store, { exit() {} });
    try {
      for await (const _ of session.loop.run('read guide')) {
      }
      expect(JSON.stringify(provider.requests[1]!.messages)).toContain('Guide contents');
      expect(session.broker.pending()).toEqual([]);
      controller.runCommand('/mcp__docs__prompt_review topic="cache engine"');
      await vi.waitFor(() => expect(provider.requests).toHaveLength(3));
      await controller.whenIdle();
      expect(JSON.stringify(provider.requests[2]!.messages)).toContain('Review cache engine');
    } finally {
      controller.dispose();
      await session.shutdown();
    }
  });
});
