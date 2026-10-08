import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ReasoningEffortSchema, type ReasoningEffort } from '../core/config.js';
import { READ_ONLY_ROLES, type AgentRole } from './types.js';
import type { PreExecuteHook } from '../tools/tool.js';

export interface AgentProfile {
  name: string;
  description: string;
  role: Exclude<AgentRole, 'queen'>;
  body: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  tools?: string[];
  source: string;
}
const aliases: Record<string, string> = {
  multiedit: 'multi_edit',
  webfetch: 'web_fetch',
  websearch: 'web_search',
  todowrite: 'todo_write',
};
const knownTools = new Set(
  'read read_image write edit multi_edit bash bash_output kill_shell grep glob ls web_fetch web_search todo_write rename_symbol find_references search_code skill memory recall ask_user exit_plan_mode spawn_agent task report send_message await_agents board_read board_write board_list board_watch agents_status configure_swarm merge_worktree'.split(
    ' ',
  ),
);
const roles = new Set(['lead', 'worker', 'scout', 'critic', 'judge']);

/** MCP 工具按名称或前缀通配（mcp__github__*）放行 */
const isMcpTool = (name: string) => /^mcp__[A-Za-z0-9_-]+(?:__[A-Za-z0-9_.-]+)?\*?$/.test(name);

/**
 * 解析一个 profile 文件。lenient 用于 .claude/agents：Claude Code 专用的模型名（sonnet 等）和工具名
 * 本来就不适用，静默忽略，避免每次启动都给出一串警告。
 */
export function parseProfile(
  text: string,
  fallbackName: string,
  source = '',
  opts: { lenient?: boolean } = {},
): { profile?: AgentProfile; warnings: string[] } {
  const warnings: string[] = [],
    warn = (message: string) => warnings.push(`${source || fallbackName}：${message}`),
    note = (message: string) => !opts.lenient && warn(message);
  try {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text.replace(/^\uFEFF/, ''));
    if (!match) throw new Error('缺少 YAML frontmatter');
    const data: unknown = parseYaml(match[1]!);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('frontmatter 必须是对象');
    const value = data as Record<string, unknown>,
      name = value['name'] ?? fallbackName;
    if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new Error('无效的 profile name');
    if (value['description'] !== undefined && typeof value['description'] !== 'string') throw new Error('description 必须是文本');
    let tools: string[] | undefined;
    if (value['tools'] !== undefined) {
      const raw = typeof value['tools'] === 'string' ? value['tools'].split(',').map((tool) => tool.trim()) : value['tools'];
      if (!Array.isArray(raw) || raw.some((tool) => typeof tool !== 'string')) throw new Error('tools 必须是逗号分隔文本或数组');
      tools = [];
      for (const tool of raw as string[]) {
        const lower = tool.trim().toLowerCase(),
          mapped = aliases[lower] ?? lower;
        if (knownTools.has(mapped)) tools.push(mapped);
        else if (isMcpTool(tool.trim())) tools.push(tool.trim());
        else note(`忽略未知工具 ${tool}`);
      }
      tools = [...new Set(tools)];
    }
    const role =
      value['role'] ??
      (tools && !tools.some((tool) => ['edit', 'write', 'multi_edit', 'bash', 'rename_symbol'].includes(tool)) ? 'scout' : 'worker');
    if (typeof role !== 'string' || !roles.has(role)) throw new Error('无效的基础角色');
    let model: string | undefined;
    if (value['model'] !== undefined) {
      if (typeof value['model'] === 'string' && (value['model'] === 'inherit' || /^[^:\s]+:[^\s]+$/.test(value['model'])))
        model = value['model'];
      else note('忽略 model：需要 provider:model 或 inherit');
    }
    const effort = value['reasoning_effort'] === undefined ? undefined : ReasoningEffortSchema.parse(value['reasoning_effort']);
    let body = match[2]!.trim();
    if (body.length > 8000) {
      body = body.slice(0, 8000);
      warn('正文超过 8000 字符，已截断');
    }
    return {
      profile: {
        name,
        description: (value['description'] as string | undefined) ?? '',
        role: role as AgentProfile['role'],
        body,
        model,
        reasoningEffort: effort,
        tools,
        source,
      },
      warnings,
    };
  } catch (err) {
    warn(`无效 profile，已跳过：${err instanceof Error ? err.message : String(err)}`);
    return { warnings };
  }
}

export function loadProfiles(
  cwd: string,
  home: string,
  opts: { trusted?: boolean } = {},
): { profiles: Map<string, AgentProfile>; warnings: string[] } {
  const profiles = new Map<string, AgentProfile>(),
    warnings: string[] = [];
  let ignored = 0;
  // 与 skills 一致：用户级只读 ~/.roast/agents；.claude/agents 只在项目内兼容
  for (const [dir, project, lenient] of [
    [path.join(home, 'agents'), false, false],
    [path.join(cwd, '.claude', 'agents'), true, true],
    [path.join(cwd, '.roast', 'agents'), true, false],
  ] as const) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
        if (project && !opts.trusted) {
          ignored++;
          continue;
        }
        const file = path.join(dir, entry.name);
        try {
          const parsed = parseProfile(readFileSync(file, 'utf8'), entry.name.slice(0, -3), file, { lenient });
          warnings.push(...parsed.warnings);
          if (parsed.profile) profiles.set(parsed.profile.name, parsed.profile);
        } catch {
          warnings.push(`${file}：无法读取 profile，已跳过`);
        }
      }
    } catch {
      warnings.push(`${dir}：无法读取 profiles 目录`);
    }
  }
  if (ignored) warnings.push(`未信任项目，已忽略 ${ignored} 个项目级 profile（roast trust 后生效）`);
  return { profiles, warnings };
}

export function profilesSection(profiles: Map<string, AgentProfile>): string {
  if (!profiles.size) return '';
  return `## Agent profiles\nUse spawn_agent's agent parameter to select a profile:\n${[...profiles.values()]
    .map((p) => `- ${p.name} (${p.role}${READ_ONLY_ROLES.has(p.role) ? ', read-only' : ''}): ${p.description.replace(/\s+/g, ' ')}`)
    .join('\n')}`;
}
export function describeProfiles(profiles: Map<string, AgentProfile>): string {
  return (
    [...profiles.values()]
      .map((p) => `${p.name} · ${p.role} · ${p.model ?? '角色默认'} · ${p.tools?.join(', ') ?? '角色全部工具'} · ${p.source}`)
      .join('\n') || '没有自定义角色'
  );
}
const protocol = new Set(
  'report send_message await_agents board_read board_write board_list board_watch agents_status task recall todo_write'.split(' '),
);
function allowedBy(tools: string[], name: string): boolean {
  return tools.some((tool) => (tool.endsWith('*') ? name.startsWith(tool.slice(0, -1)) : tool === name));
}
export function profileGuard(id: string, profile?: AgentProfile): PreExecuteHook {
  return (tool) =>
    profile?.tools && !allowedBy(profile.tools, tool.name) && !protocol.has(tool.name)
      ? { action: 'deny', reason: `成员 ${id}（${profile.name}）不允许使用 ${tool.name}` }
      : { action: 'allow' };
}
