/**
 * MCP 装配：加载服务器配置（仓库层需信任）→ 并行连接 → 把工具注册进会话的工具表（主会话与子 agent 共用）。
 * 连接失败只产生启动提示，不阻止会话启动。
 */
import { isProjectTrusted } from '../core/config.js';
import { loadMcpServers } from '../ext/mcp/config.js';
import { McpManager, type TransportFactory } from '../ext/mcp/manager.js';
import type { ToolRegistry } from '../tools/index.js';

export interface McpSetup {
  manager: McpManager;
  warnings: string[];
}

export async function setupMcp(cwd: string, tools: ToolRegistry, transport?: TransportFactory): Promise<McpSetup> {
  const loaded = loadMcpServers(cwd, isProjectTrusted(cwd));
  const manager = new McpManager(cwd, transport ? { transport } : {});
  const warnings: string[] = [];
  if (loaded.ignored.length) warnings.push(`项目配置中的 MCP 服务器未启用（未信任项目，可运行 roast trust）：${loaded.ignored.join(', ')}`);
  for (const file of loaded.invalid) warnings.push(`MCP 配置格式错误，已忽略：${file}`);
  if (loaded.servers.length === 0) return { manager, warnings };

  await manager.connectAll(loaded.servers);
  for (const s of manager.status()) if (s.state === 'failed') warnings.push(`MCP 服务器 ${s.name} 连接失败：${s.error ?? '未知错误'}`);
  const seen = new Set(tools.list().map((t) => t.name));
  for (const def of manager.tools()) {
    if (seen.has(def.name)) {
      warnings.push(`MCP 工具名冲突，已跳过：${def.name}`);
      continue;
    }
    seen.add(def.name);
    tools.register(def);
  }
  return { manager, warnings };
}
