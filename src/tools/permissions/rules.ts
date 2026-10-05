/**
 * 权限规则：`Tool` 或 `Tool(pattern)`。
 * - bash：`git status:*` 前缀（整词）、`npm test` 精确、含 `*` 的通配
 * - 路径类工具（read/edit/write/multi_edit/glob/grep/ls）：相对 cwd 的 glob（picomatch）；绝对路径模式按绝对路径匹配
 * - web_fetch：`domain:example.com`（含子域）
 * - 工具名本身可含 `*`（如 `mcp__github__*`）
 */
import path from 'node:path';
import picomatch from 'picomatch';

export type PermissionKind = 'read' | 'edit' | 'execute' | 'network' | 'interact';

export interface PermissionRequest {
  /** 宿主提供的 worktree 执行边界；不来自模型参数。 */
  executionRoot?: string;
  /** Host-assigned role: unfamiliar shell commands require a one-time user approval. */
  readOnlyRole?: string;
  tool: string;
  kind: PermissionKind;
  /** bash：命令；路径类：绝对路径；web_fetch：URL */
  target?: string;
  targetKind?: 'path' | 'label';
  cwd: string;
  agentId?: string;
  callId?: string;
  args?: unknown;
}

export interface Rule {
  tool: string;
  pattern?: string;
}

export function parseRule(text: string): Rule {
  const m = /^([^()]+)\((.*)\)$/.exec(text.trim());
  if (!m) return { tool: text.trim() };
  return { tool: m[1]!.trim(), pattern: m[2]!.trim() };
}

export function formatRule(rule: Rule): string {
  return rule.pattern === undefined ? rule.tool : `${rule.tool}(${rule.pattern})`;
}

function wildcardRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 's');
}

function toolNameMatches(ruleTool: string, tool: string): boolean {
  return ruleTool.includes('*') ? wildcardRegex(ruleTool).test(tool) : ruleTool === tool;
}

/** bash 单条命令（已拆分的段）是否命中模式 */
export function commandMatches(pattern: string, command: string): boolean {
  const cmd = command.trim().replace(/\s+/g, ' ');
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2).trim();
    return cmd === prefix || cmd.startsWith(prefix + ' ');
  }
  if (pattern.includes('*')) return wildcardRegex(pattern).test(cmd);
  return cmd === pattern;
}

const toPosix = (p: string) => p.split(path.sep).join('/');

function pathMatches(pattern: string, target: string, cwd: string): boolean {
  const isAbs = path.isAbsolute(pattern) || /^[a-zA-Z]:/.test(pattern);
  const subject = isAbs ? toPosix(path.resolve(target)) : toPosix(path.relative(cwd, target));
  const pat = isAbs ? toPosix(path.resolve(pattern)) : pattern;
  return picomatch(pat, { dot: true, nocase: process.platform === 'win32' })(subject);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** 单条规则是否命中请求（bash 复合命令的逐段判断由引擎负责，这里按 target 整体匹配） */
export function matchesRule(rule: Rule, req: PermissionRequest): boolean {
  if (!toolNameMatches(rule.tool, req.tool)) return false;
  if (rule.pattern === undefined) return true;
  if (req.target === undefined) return false;
  if (req.tool === 'bash') return commandMatches(rule.pattern, req.target);
  if (req.kind === 'network') {
    const m = /^domain:(.+)$/.exec(rule.pattern);
    const host = hostOf(req.target);
    if (!m || !host) return false;
    const domain = m[1]!.toLowerCase();
    return host === domain || host.endsWith('.' + domain);
  }
  if (req.targetKind === 'label') return wildcardRegex(rule.pattern).test(req.target);
  return pathMatches(rule.pattern, req.target, req.cwd);
}

/** "始终允许此类"时建议记住的规则 */
export function suggestRule(req: PermissionRequest): string {
  if (req.targetKind === 'label') return req.tool;
  if (req.tool === 'bash' && req.target) {
    const words = req.target.trim().split(/\s+/).filter((w) => !w.startsWith('-'));
    return `bash(${words.slice(0, 2).join(' ')}:*)`;
  }
  if (req.kind === 'network' && req.target) {
    const host = hostOf(req.target);
    return host ? `${req.tool}(domain:${host})` : req.tool;
  }
  if (req.target && (req.kind === 'edit' || req.kind === 'read')) {
    const rel = toPosix(path.relative(req.cwd, req.target));
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      const top = rel.split('/')[0]!;
      return rel.includes('/') ? `${req.tool}(${top}/**)` : `${req.tool}(${rel})`;
    }
  }
  return req.tool;
}
