/**
 * roast trust：信任前列出仓库内配置将会启用的内容（provider 连接信息、钩子命令、MCP 服务器、allow 规则），
 * 让用户知道自己信任了什么。
 */
import { readFileSync } from 'node:fs';
import { configSources, trustProject, untrustedProviderOverrides } from '../core/config.js';
import { HOOK_EVENTS } from '../ext/hooks/config.js';

const REPO_LAYERS = new Set(['project', 'legacy']);

type Json = Record<string, unknown>;

function asObject(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
}

function readRepoLayers(cwd: string): { path: string; data: Json }[] {
  return configSources(cwd)
    .filter((s) => s.exists && REPO_LAYERS.has(s.layer))
    .flatMap((s) => {
      try {
        return [{ path: s.path, data: asObject(JSON.parse(readFileSync(s.path, 'utf8'))) }];
      } catch {
        return [];
      }
    });
}

/** 仓库配置中需要信任才生效的条目（每条一行，供打印） */
export function trustSummary(cwd: string): string[] {
  const lines: string[] = [];
  const providers = untrustedProviderOverrides(cwd);
  if (providers.length) lines.push(`provider 连接信息：${providers.join(', ')}`);
  for (const { path, data } of readRepoLayers(cwd)) {
    const hooks = asObject(data['hooks']);
    for (const event of HOOK_EVENTS) {
      const specs = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
      for (const spec of specs) lines.push(`钩子 ${event}：${String(asObject(spec)['command'] ?? '?')}（${path}）`);
    }
    for (const [name, spec] of Object.entries(asObject(asObject(data['mcp'])['servers']))) {
      const s = asObject(spec);
      const target = s['url'] ?? [s['command'], ...(Array.isArray(s['args']) ? s['args'] : [])].join(' ');
      lines.push(`MCP 服务器 ${name}：${String(target)}（${path}）`);
    }
    const allow = asObject(data['permissions'])['allow'];
    const memory = asObject(data['memory']);
    if (memory['driver'] === 'mem0') lines.push(`远程记忆 Mem0：${String(memory['baseURL'] ?? 'https://api.mem0.ai')}（${path}）`);
    const embeddings = asObject(asObject(data['rag'])['embeddings']);
    if (embeddings['provider']) lines.push(`代码 embeddings：${String(embeddings['provider'])}:${String(embeddings['model'])}（${path}）`);
    if (Array.isArray(allow) && allow.length) lines.push(`权限 allow 规则：${allow.join(', ')}（${path}）`);
  }
  return lines;
}

export function runTrust(cwd: string): string {
  const lines = trustSummary(cwd);
  trustProject(cwd);
  const detail = lines.length ? `信任后以下仓库配置将会生效（含会执行的命令，请确认来源可靠）：\n${lines.map((l) => `  - ${l}`).join('\n')}\n` : '';
  return `${detail}已信任项目：${cwd}`;
}
