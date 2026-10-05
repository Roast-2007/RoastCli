/**
 * MCP 客户端管理：会话启动时并行连接所有服务器（每个有连接超时），拉取工具列表并包装成 ToolDefinition。
 * 工具在第一次请求前一次性注册、按名称排序，整场会话不变（前缀缓存友好）；
 * 中途断开的服务器，其工具调用返回错误结果，不从工具列表移除。
 * SDK 按需动态加载：没有配置 MCP 服务器时不付出任何启动成本。
 */
import path from 'node:path';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { RoastError } from '../../core/errors.js';
import { killTree } from '../../tools/bash/shell.js';
import type { ToolDefinition } from '../../tools/tool.js';
import type { McpServerStatus } from '../mcp.js';
import { expandEnvRefs, expandRecord, type McpServerEntry } from './config.js';
import { wrapMcpTool, type McpCallResult, type McpToolInfo } from './tool.js';
import { defineTool, textResult } from '../../tools/tool.js';
import { mcpResultToToolResult, mcpToolName } from './tool.js';
import { z } from 'zod';
import type { ContentBlock } from '../../core/types.js';

const CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const STDERR_LINES = 20;

export type TransportFactory = (server: McpServerEntry, cwd: string, onStderr: (line: string) => void) => Promise<Transport>;

interface Connection {
  server: McpServerEntry;
  state: McpServerStatus['state'];
  client?: Client;
  transport?: Transport;
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  templates: Array<{ uriTemplate: string; name: string; description?: string }>;
  prompts: McpPromptInfo[];
  stderr: string[];
  error?: string;
}
export interface McpResourceInfo { uri: string; name: string; description?: string; mimeType?: string }
export interface McpPromptInfo { name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }
export interface McpPromptCommand extends McpPromptInfo { server: string; command: string }

/** 默认传输：stdio（stderr 走管道，避免污染 TUI）/ streamable http / sse */
export const defaultTransport: TransportFactory = async (server, cwd, onStderr) => {
  if (server.transport === 'stdio') {
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const env = expandRecord(server.env);
    const t = new StdioClientTransport({
      command: server.command!,
      args: (server.args ?? []).map((a) => expandEnvRefs(a)),
      ...(env ? { env } : {}),
      cwd: server.cwd ? path.resolve(cwd, server.cwd) : cwd,
      stderr: 'pipe',
    });
    t.stderr?.on('data', (chunk: Buffer) => chunk.toString('utf8').split(/\r?\n/).filter(Boolean).forEach(onStderr));
    return t;
  }
  const headers = expandRecord(server.headers);
  const requestInit = headers ? { headers } : undefined;
  if (server.transport === 'sse') {
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
    return new SSEClientTransport(new URL(server.url!), requestInit ? { requestInit } : undefined);
  }
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  return new StreamableHTTPClientTransport(new URL(server.url!), requestInit ? { requestInit } : undefined);
};

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}超时（${ms}ms）`)), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e: unknown) => (clearTimeout(timer), reject(e instanceof Error ? e : new Error(String(e)))),
    );
  });
}

export class McpManager {
  private readonly conns = new Map<string, Connection>();

  constructor(
    private readonly cwd: string,
    private readonly opts: { transport?: TransportFactory; connectTimeoutMs?: number; clientVersion?: string } = {},
  ) {}

  async connectAll(servers: readonly McpServerEntry[]): Promise<void> {
    await Promise.all(servers.map((s) => this.connect(s)));
  }

  private async connect(server: McpServerEntry): Promise<void> {
    const conn: Connection = { server, state: 'connecting', tools: [], resources: [], templates: [], prompts: [], stderr: [] };
    this.conns.set(server.name, conn);
    try {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const transport = await (this.opts.transport ?? defaultTransport)(server, this.cwd, (line) => {
        conn.stderr = [...conn.stderr, line].slice(-STDERR_LINES);
      });
      const client = new Client({ name: 'roastcli', version: this.opts.clientVersion ?? '0.0.0' });
      conn.client = client;
      conn.transport = transport;
      transport.onclose = () => {
        if (conn.state === 'connected') conn.state = 'closed';
      };
      const timeout = this.opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
      await withTimeout(client.connect(transport), timeout, '连接');
      const capabilities = client.getServerCapabilities();
      const pages = async <T>(load: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>): Promise<T[]> => {
        const out: T[] = [], cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await withTimeout(load(cursor), timeout, '获取 MCP 列表');
          out.push(...page.items);
          cursor = page.nextCursor;
          if (cursor && cursors.has(cursor)) throw new Error('MCP 列表返回重复 cursor');
          if (cursor) cursors.add(cursor);
          if (cursors.size > 100 || out.length > 10_000) throw new Error('MCP 列表过大');
        } while (cursor);
        return out;
      };
      const [toolInfos, resources, templates, prompts] = await Promise.all([
        capabilities?.tools ? pages(async (cursor) => { const page = await client.listTools({ cursor }); return { items: page.tools, nextCursor: page.nextCursor }; }) : [],
        capabilities?.resources ? pages(async (cursor) => { const page = await client.listResources({ cursor }); return { items: page.resources, nextCursor: page.nextCursor }; }) : [],
        capabilities?.resources ? pages(async (cursor) => {
          try { const page = await client.listResourceTemplates({ cursor }); return { items: page.resourceTemplates, nextCursor: page.nextCursor }; }
          catch (error) { if ((error as { code?: number }).code === -32601) return { items: [] }; throw error; }
        }) : [],
        capabilities?.prompts ? pages(async (cursor) => { const page = await client.listPrompts({ cursor }); return { items: page.prompts, nextCursor: page.nextCursor }; }) : [],
      ]);
      conn.resources = resources;
      conn.templates = templates;
      conn.prompts = prompts;
      const listed = { tools: toolInfos };
      conn.tools = listed.tools.map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        inputSchema: t.inputSchema as Record<string, unknown>,
        ...(t.annotations ? { annotations: t.annotations } : {}),
      }));
      conn.state = 'connected';
    } catch (err) {
      conn.state = 'failed';
      const tail = conn.stderr.slice(-3).join(' | ');
      conn.error = `${err instanceof Error ? err.message : String(err)}${tail ? `（stderr：${tail}）` : ''}`;
      await this.closeConn(conn);
    }
  }

  private async callTool(server: string, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
    const conn = this.conns.get(server);
    if (!conn?.client || conn.state !== 'connected') {
      throw new RoastError('UNKNOWN', `MCP 服务器 ${server} 未连接（${conn?.state ?? '不存在'}）${conn?.error ? `：${conn.error}` : ''}`);
    }
    const timeout = conn.server.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    return (await conn.client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout })) as McpCallResult;
  }

  /** 所有已连接服务器的工具（按名称排序） */
  tools(): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const conn of this.conns.values()) {
      if (conn.state !== 'connected') continue;
      const timeout = (conn.server.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS) + 5_000;
      for (const info of conn.tools) {
        defs.push(wrapMcpTool(conn.server.name, info, (tool, args, signal) => this.callTool(conn.server.name, tool, args, signal), { timeoutMs: timeout, ...(conn.server.trustAnnotations ? { trustAnnotations: true } : {}) }));
      }
      if (conn.client?.getServerCapabilities()?.resources) {
        const server = conn.server.name;
        defs.push(defineTool({
          name: mcpToolName(server, 'list_resources'), description: `[MCP · ${server}] 列出可读取的资源及 URI 模板。`,
          parameters: z.object({}), isReadOnly: true, isConcurrencySafe: true, permission: { kind: 'read' },
          async execute() { return textResult(JSON.stringify({ resources: conn.resources, templates: conn.templates })); },
        }));
        defs.push(defineTool({
          name: mcpToolName(server, 'read_resource'), description: `[MCP · ${server}] 按 URI 读取资源，URI 可来自列表或 URI 模板。`,
          parameters: z.object({ uri: z.string().min(1) }), isReadOnly: true, isConcurrencySafe: true, timeoutMs: timeout,
          permission: { kind: 'read', targetKind: 'label', target: (args) => args.uri },
          execute: async (args, ctx) => mcpResultToToolResult({ content: (await this.readResource(server, args.uri, ctx.signal)).map((resource) => ({ type: 'resource', resource })) }),
        }));
      }
    }
    return defs.sort((a, b) => a.name.localeCompare(b.name));
  }

  prompts(): McpPromptCommand[] {
    return [...this.conns.values()].flatMap((conn) => conn.prompts.map((prompt) => ({ ...prompt, server: conn.server.name, command: mcpToolName(conn.server.name, `prompt_${prompt.name}`) }))).sort((a, b) => a.command.localeCompare(b.command));
  }

  private connection(server: string): Connection & { client: Client } {
    const conn = this.conns.get(server);
    if (!conn?.client || conn.state !== 'connected') throw new RoastError('UNKNOWN', `MCP 服务器 ${server} 未连接`);
    return conn as Connection & { client: Client };
  }

  async readResource(server: string, uri: string, signal?: AbortSignal) {
    const conn = this.connection(server);
    const result = await conn.client.readResource({ uri }, { signal, timeout: conn.server.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS });
    return result.contents;
  }

  async promptContent(command: string, values: string, signal?: AbortSignal): Promise<ContentBlock[]> {
    const prompt = this.prompts().find((p) => p.command === command);
    if (!prompt) throw new RoastError('INVALID_REQUEST', `未知 MCP prompt: ${command}`);
    const conn = this.connection(prompt.server), args: Record<string, string> = {};
    const tokens = values.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    let positional = 0;
    for (const token of tokens) {
      const index = token.indexOf('=');
      const name = index > 0 ? token.slice(0, index) : prompt.arguments?.[positional++]?.name;
      if (!name || !prompt.arguments?.some((a) => a.name === name)) throw new RoastError('INVALID_REQUEST', 'MCP prompt 参数名称或数量错误');
      args[name] = (index > 0 ? token.slice(index + 1) : token).replace(/^(["'])(.*)\1$/, '$2');
    }
    for (const arg of prompt.arguments ?? []) if (arg.required && !(arg.name in args)) throw new RoastError('INVALID_REQUEST', `缺少参数 ${arg.name}；用法：/${command} ${(prompt.arguments ?? []).map((a) => `${a.name}=值`).join(' ')}`);
    const result = await conn.client.getPrompt({ name: prompt.name, arguments: args }, { signal, timeout: conn.server.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS });
    return result.messages.flatMap((message) => [{ type: 'text' as const, text: `[MCP prompt ${prompt.server}/${prompt.name} · ${message.role}]` }, ...mcpResultToToolResult({ content: [message.content] }).content]);
  }

  status(): McpServerStatus[] {
    return [...this.conns.values()].map((c) => ({ name: c.server.name, state: c.state, toolCount: c.tools.length, ...(c.resources.length || c.templates.length ? { resourceCount: c.resources.length + c.templates.length } : {}), ...(c.prompts.length ? { promptCount: c.prompts.length } : {}), ...(c.error ? { error: c.error } : {}) }));
  }

  private async closeConn(conn: Connection): Promise<void> {
    // Windows 上 npx / pnpm dlx 等 .cmd 垫片经 cmd.exe 启动，close() 只能结束 cmd.exe，真正的服务器进程会成为孤儿：
    // 先按进程树强杀（taskkill /T），再关闭传输
    const pid = (conn.transport as { pid?: number | null } | undefined)?.pid;
    if (process.platform === 'win32' && typeof pid === 'number') killTree(pid, { sync: true });
    try {
      await (conn.client ? conn.client.close() : conn.transport?.close());
    } catch {
      // 关闭失败不影响退出
    }
    if (conn.state === 'connected' || conn.state === 'connecting') conn.state = 'closed';
  }

  async disconnect(name: string): Promise<void> {
    const conn = this.conns.get(name);
    if (conn) await this.closeConn(conn);
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.conns.values()].map((c) => this.closeConn(c)));
  }
}
