/**
 * roast mcp add / list / remove：管理 MCP 服务器配置（默认写用户级 ~/.roast/config.json，--project 写 .roast/config.json）。
 * 函数返回要打印的文本，便于测试。
 */
import path from 'node:path';
import { isProjectTrusted, roastHome } from '../core/config.js';
import { addMcpServer, loadMcpServers, removeMcpServer, type McpServerSpec } from '../ext/mcp/config.js';

export interface McpAddOptions {
  project?: boolean;
  url?: string;
  transport?: string;
  env?: string[];
  header?: string[];
  command?: string[];
}

const SECRET_KEY = /token|key|secret|password|auth/i;

function configFile(cwd: string, project: boolean | undefined): string {
  return project ? path.join(cwd, '.roast', 'config.json') : path.join(roastHome(), 'config.json');
}

function parsePairs(pairs: string[] | undefined, what: string): Record<string, string> | undefined {
  if (!pairs?.length) return undefined;
  return Object.fromEntries(
    pairs.map((p) => {
      const i = p.indexOf('=');
      if (i <= 0) throw new Error(`${what} 格式应为 KEY=VALUE：${p}`);
      return [p.slice(0, i), p.slice(i + 1)];
    }),
  );
}

/** 疑似直接写入了密钥的条目（应改为 ${VAR} 引用） */
function literalSecrets(rec: Record<string, string> | undefined): string[] {
  return Object.entries(rec ?? {})
    .filter(([k, v]) => SECRET_KEY.test(k) && v !== '' && !v.includes('${'))
    .map(([k]) => k);
}

export function mcpAdd(cwd: string, name: string, opts: McpAddOptions): string {
  const [command, ...args] = opts.command ?? [];
  if (!opts.url && !command) throw new Error('需要 --url <地址>，或在 -- 之后给出启动命令，例如：roast mcp add fs -- npx -y @modelcontextprotocol/server-filesystem .');
  const transport = opts.transport as McpServerSpec['transport'];
  if (transport !== undefined && !['stdio', 'http', 'sse'].includes(transport)) throw new Error(`未知传输方式：${opts.transport}（stdio / http / sse）`);
  const env = parsePairs(opts.env, '--env');
  const headers = parsePairs(opts.header, '--header');
  const spec: McpServerSpec = {
    ...(transport ? { transport } : {}),
    ...(command ? { command, ...(args.length ? { args } : {}) } : {}),
    ...(env ? { env } : {}),
    ...(opts.url ? { url: opts.url } : {}),
    ...(headers ? { headers } : {}),
  };
  const file = configFile(cwd, opts.project);
  addMcpServer(file, name, spec);
  const secrets = [...literalSecrets(env), ...literalSecrets(headers)];
  const hint = secrets.length ? `\n提示：${secrets.join(', ')} 看起来是密钥，建议改成 \${环境变量名} 引用，避免把密钥写进配置文件。` : '';
  const trust = opts.project && !isProjectTrusted(cwd) ? '\n提示：项目级服务器需要先运行 roast trust 才会启用。' : '';
  return `已添加 MCP 服务器 ${name} → ${file}${hint}${trust}`;
}

export function mcpList(cwd: string): string {
  const loaded = loadMcpServers(cwd, isProjectTrusted(cwd));
  const lines = loaded.servers.map((s) => {
    const target = s.transport === 'stdio' ? [s.command, ...(s.args ?? [])].join(' ') : s.url;
    return `${s.name}  [${s.transport} · ${s.layer}]  ${target}`;
  });
  for (const n of loaded.ignored) lines.push(`${n}  [未启用：项目未信任，运行 roast trust]`);
  for (const f of loaded.invalid) lines.push(`（格式错误，已忽略：${f}）`);
  return lines.length ? lines.join('\n') : '没有配置 MCP 服务器。添加：roast mcp add <名称> -- <命令> [参数...] 或 roast mcp add <名称> --url <地址>';
}

export function mcpRemove(cwd: string, name: string, project?: boolean): string {
  const file = configFile(cwd, project);
  return removeMcpServer(file, name) ? `已移除 MCP 服务器 ${name}（${file}）` : `${file} 中没有名为 ${name} 的 MCP 服务器`;
}
