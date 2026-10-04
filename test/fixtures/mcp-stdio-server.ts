/**
 * stdio MCP 测试服务器（由 tsx 启动）：工具定义见 mcp-servers.ts。
 * 启动时向 stderr 打一行日志，用于验证 stderr 走管道、不污染终端。
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildTestServer } from './mcp-servers.js';

process.stderr.write('test mcp server starting\n');
await buildTestServer().connect(new StdioServerTransport());
