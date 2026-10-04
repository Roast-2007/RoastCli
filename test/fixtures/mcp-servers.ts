/**
 * MCP 测试服务器：同一组工具既可进程内（InMemoryTransport）运行，也可作为 stdio 子进程运行（mcp-stdio-server.ts）。
 * - echo：只读，回显文本（可加 ECHO_PREFIX 环境变量前缀）
 * - add：两数相加
 * - fail：返回 isError 结果
 * - snapshot：返回一张图片（测试占位文本）
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import type { TransportFactory } from '../../src/ext/mcp/manager.js';

export function buildTestServer(): McpServer {
  const server = new McpServer({ name: 'test-server', version: '1.0.0' });
  server.registerTool(
    'echo',
    { description: 'Echo the text back', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
    async ({ text }) => ({ content: [{ type: 'text', text: `${process.env['ECHO_PREFIX'] ?? ''}${text}` }] }),
  );
  server.registerTool('add', { description: 'Add two numbers', inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({
    content: [{ type: 'text', text: String(a + b) }],
  }));
  server.registerTool('fail', { description: 'Always fails' }, async () => ({ content: [{ type: 'text', text: 'it broke' }], isError: true }));
  server.registerTool('snapshot', { description: 'Return an image' }, async () => ({
    content: [{ type: 'image', data: Buffer.alloc(3072).toString('base64'), mimeType: 'image/png' }],
  }));
  return server;
}

/** 进程内传输工厂：每个服务器名对应一个新的测试服务器；names 之外的服务器连接失败 */
export function inMemoryTransport(names: readonly string[] = ['test']): TransportFactory {
  return async (server) => {
    if (!names.includes(server.name)) throw new Error(`无法连接 ${server.name}`);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildTestServer().connect(serverSide);
    return clientSide;
  };
}
