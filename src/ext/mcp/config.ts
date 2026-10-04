/**
 * MCP 服务器配置：各配置层的 "mcp.servers"，同名后者覆盖前者。
 *
 *   "mcp": { "servers": {
 *     "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } },
 *     "docs":   { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } }
 *   } }
 *
 * - 密钥不写进配置：env / headers / args 中的 ${VAR} 在连接时从环境变量展开
 * - stdio 服务器只继承安全的默认环境变量（PATH、HOME 等）加上这里显式配置的 env
 * - 仓库内配置层的服务器会执行任意命令 / 连接任意地址，需 `roast trust` 后才启用
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { configSources, type ConfigLayer } from '../../core/config.js';

export const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

function validName(name: string): boolean {
  return SERVER_NAME.test(name) && !RESERVED_NAMES.has(name);
}

const ServerSchema = z
  .object({
    transport: z.enum(['stdio', 'http', 'sse']).optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    /** 单次工具调用超时（毫秒），默认 120s */
    timeoutMs: z.number().int().positive().optional(),
    disabled: z.boolean().optional(),
    /** 信任服务器声明的 readOnlyHint（只读工具免审批）。默认不信任：服务器可以把破坏性工具谎报为只读 */
    trustAnnotations: z.boolean().optional(),
  })
  .refine((s) => s.command !== undefined || s.url !== undefined, { message: '需要 command（stdio）或 url（http/sse）' });

export type McpServerSpec = z.infer<typeof ServerSchema>;

export interface McpServerEntry extends McpServerSpec {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  layer: ConfigLayer;
}

const REPO_LAYERS: readonly ConfigLayer[] = ['project', 'legacy'];

export interface LoadedMcpServers {
  servers: McpServerEntry[];
  /** 因项目未被信任而未启用的仓库服务器名 */
  ignored: string[];
  invalid: string[];
}

function serversField(file: string): unknown {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { mcp?: { servers?: unknown } } | null;
    return raw?.mcp?.servers;
  } catch {
    return undefined;
  }
}

export function loadMcpServers(cwd: string, trusted: boolean): LoadedMcpServers {
  const byName = new Map<string, McpServerEntry>();
  const ignored = new Set<string>();
  const invalid: string[] = [];
  for (const source of configSources(cwd)) {
    if (!source.exists) continue;
    const field = serversField(source.path);
    if (field === undefined) continue;
    const parsed = z.record(z.string().refine(validName), ServerSchema).safeParse(field);
    if (!parsed.success) {
      invalid.push(source.path);
      continue;
    }
    for (const [name, spec] of Object.entries(parsed.data)) {
      if (REPO_LAYERS.includes(source.layer) && !trusted) {
        ignored.add(name);
        continue;
      }
      byName.set(name, { ...spec, name, transport: spec.transport ?? (spec.url ? 'http' : 'stdio'), layer: source.layer });
    }
  }
  const servers = [...byName.values()].filter((s) => !s.disabled).sort((a, b) => a.name.localeCompare(b.name));
  return { servers, ignored: [...ignored].filter((n) => !byName.has(n)), invalid };
}

/** ${VAR} → 环境变量值（未设置则为空串） */
export function expandEnvRefs(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k: string) => env[k] ?? '');
}

export function expandRecord(rec: Record<string, string> | undefined): Record<string, string> | undefined {
  return rec ? Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, expandEnvRefs(v)])) : undefined;
}

// ---------------------------------------------------------------------------
// roast mcp add / remove：读写某个配置文件的 mcp.servers
// ---------------------------------------------------------------------------

function readObject(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function serversOf(cfg: Record<string, unknown>): Record<string, unknown> {
  const mcp = (cfg['mcp'] ?? {}) as Record<string, unknown>;
  return { ...((mcp['servers'] ?? {}) as Record<string, unknown>) };
}

function writeServers(file: string, cfg: Record<string, unknown>, servers: Record<string, unknown>): void {
  const next = { ...cfg, mcp: { ...((cfg['mcp'] ?? {}) as Record<string, unknown>), servers } };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

export function addMcpServer(file: string, name: string, spec: McpServerSpec): void {
  if (!validName(name)) throw new Error(`服务器名只能包含字母、数字、_ 和 -（最长 32），且不能是保留名：${name}`);
  const checked = ServerSchema.parse(spec);
  const cfg = readObject(file);
  writeServers(file, cfg, { ...serversOf(cfg), [name]: checked });
}

export function removeMcpServer(file: string, name: string): boolean {
  const cfg = readObject(file);
  const servers = serversOf(cfg);
  if (!Object.hasOwn(servers, name)) return false;
  const { [name]: _removed, ...rest } = servers;
  writeServers(file, cfg, rest);
  return true;
}
