/**
 * 扩展缝：MCP（Model Context Protocol）加载与扩展。
 *
 * 接入方式：
 * - 配置文件中增加 mcp.servers（stdio/sse/http 三种 transport）
 * - 实现 McpClientManager（建议基于 @modelcontextprotocol/sdk）
 * - 每个 MCP 工具包装成 ToolDefinition 注册进 ToolRegistry（与内置工具同权，
 *   命名约定 `mcp__<server>__<tool>`），loop 与执行管线零改动
 * - MCP server 中途接入/断开时通过 ToolRegistry 动态增删
 */

export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  /** stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** sse/http */
  url?: string;
  headers?: Record<string, string>;
}

export interface McpServerStatus {
  name: string;
  state: 'connecting' | 'connected' | 'failed' | 'closed';
  toolCount: number;
  resourceCount?: number;
  promptCount?: number;
  error?: string;
}

export interface McpClientManager {
  /** 按配置启动所有 server 连接，并把其工具注册进 ToolRegistry */
  connectAll(configs: McpServerConfig[]): Promise<void>;
  status(): McpServerStatus[];
  /** 断开并注销其工具 */
  disconnect(name: string): Promise<void>;
  disconnectAll(): Promise<void>;
}
