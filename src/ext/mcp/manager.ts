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
  stderr: string[];
  error?: string;
}

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
    const conn: Connection = { server, state: 'connecting', tools: [], stderr: [] };
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
      const listed = await withTimeout(client.listTools(), timeout, '获取工具列表');
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
    }
    return defs.sort((a, b) => a.name.localeCompare(b.name));
  }

  status(): McpServerStatus[] {
    return [...this.conns.values()].map((c) => ({ name: c.server.name, state: c.state, toolCount: c.tools.length, ...(c.error ? { error: c.error } : {}) }));
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
