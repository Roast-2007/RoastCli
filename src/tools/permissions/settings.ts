/**
 * 权限规则的来源与持久化：
 * - 用户级：~/.roast/config.json 的 permissions（可信）
 * - 项目授权：~/.roast/projects/<hash>/settings.json（用户"始终允许"写在这里，可信，不进仓库）
 * - 仓库内：.roast/config.json / roastcli.config.json 的 permissions —— deny/ask 始终生效；
 *   allow 仅在项目被信任（roast trust）后生效，防止不可信仓库自带 "bash" 之类的放行规则
 * - ROASTCLI_CONFIG 指定的文件：用户显式提供，可信
 * 会话级授权与模式切换落日志（permission/grant、mode/change），resume 时折叠恢复。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configSources, isProjectTrusted, roastHome } from '../../core/config.js';
import { canonicalPath } from '../../core/paths.js';
import type { SessionEvent } from '../../session/events.js';
import { MODE_CYCLE, type PermissionMode } from './engine.js';

export interface PermissionRuleSet {
  allow: string[];
  ask: string[];
  deny: string[];
  defaultMode?: PermissionMode;
  /** 因项目未被信任而忽略的仓库 allow 规则（UI 可提示） */
  ignoredRepoAllow: string[];
}

interface RawPermissions {
  allow: string[];
  ask: string[];
  deny: string[];
  defaultMode?: PermissionMode;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function readPermissions(file: string): RawPermissions {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const p = (raw?.['permissions'] ?? {}) as Record<string, unknown>;
    const mode = p['defaultMode'];
    return {
      allow: strings(p['allow']),
      ask: strings(p['ask']),
      deny: strings(p['deny']),
      ...(typeof mode === 'string' && (MODE_CYCLE as readonly string[]).includes(mode) ? { defaultMode: mode as PermissionMode } : {}),
    };
  } catch {
    return { allow: [], ask: [], deny: [] };
  }
}

export function projectSettingsPath(cwd: string): string {
  const hash = createHash('sha1').update(canonicalPath(cwd)).digest('hex').slice(0, 16);
  return path.join(roastHome(), 'projects', hash, 'settings.json');
}

const uniq = (xs: string[]) => [...new Set(xs)];

export function loadPermissionRules(cwd: string): PermissionRuleSet {
  const trusted = isProjectTrusted(cwd);
  const out: PermissionRuleSet = { allow: [], ask: [], deny: [], ignoredRepoAllow: [] };
  const layers = [
    ...configSources(cwd).map((s) => ({ ...s, repo: s.layer === 'project' || s.layer === 'legacy' })),
    { layer: 'grants', path: projectSettingsPath(cwd), exists: existsSync(projectSettingsPath(cwd)), repo: false },
  ];
  for (const l of layers) {
    if (!l.exists) continue;
    const p = readPermissions(l.path);
    out.ask.push(...p.ask);
    out.deny.push(...p.deny);
    if (l.repo && !trusted) out.ignoredRepoAllow.push(...p.allow);
    else out.allow.push(...p.allow);
    if (p.defaultMode && !l.repo) out.defaultMode = p.defaultMode;
  }
  return {
    allow: uniq(out.allow),
    ask: uniq(out.ask),
    deny: uniq(out.deny),
    ignoredRepoAllow: uniq(out.ignoredRepoAllow),
    ...(out.defaultMode ? { defaultMode: out.defaultMode } : {}),
  };
}

/** 记住"本项目始终允许"：写入用户目录下的项目设置 */
export function addProjectGrant(cwd: string, rule: string): void {
  const file = projectSettingsPath(cwd);
  const current = existsSync(file) ? readPermissions(file) : { allow: [], ask: [], deny: [] };
  const next = { permissions: { ...current, allow: uniq([...current.allow, rule]) }, project: canonicalPath(cwd) };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

/** 从日志折叠出会话授权与最终模式（resume 用） */
export function foldPermissionEvents(events: readonly SessionEvent[]): { grants: string[]; mode?: PermissionMode } {
  const grants: string[] = [];
  let mode: PermissionMode | undefined;
  for (const ev of events) {
    if (ev.type === 'permission/grant') grants.push(ev.rule);
    else if (ev.type === 'mode/change') mode = ev.mode;
  }
  return { grants: uniq(grants), ...(mode ? { mode } : {}) };
}
