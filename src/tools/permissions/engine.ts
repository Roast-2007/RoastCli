/**
 * PermissionEngine：工具调用的 allow / ask / deny 决策（纯逻辑；只有 readRoots 的路径比较会做 realpath 规范化）。
 *
 * 判定顺序：
 * 1. deny 规则 → deny
 * 2. plan 模式：非只读（且非交互类/白名单）→ deny
 * 3. 高危（bash 高危命令、改 .git 或 shadow 仓库）→ 强制 ask（yolo 与 allow 规则都不能跳过）
 * 4. yolo → allow
 * 5. allow 规则（会话授权 + 配置）→ allow；bash 复合命令要求每段都命中 allow 或为只读命令
 * 6. ask 规则 → ask
 * 7. 默认：工作区内读取 / 只读 bash / 交互类 → allow；acceptEdits 下工作区内编辑 → allow；其余 ask
 */
import path from 'node:path';
import { isPathInside } from '../../core/paths.js';
import { dangerReason, isReadOnlyCommand, isReadOnlyRoleCommand, parseCommand } from './bash-parse.js';
import { commandMatches, matchesRule, parseRule, suggestRule, type PermissionRequest, type Rule } from './rules.js';

export type { PermissionRequest } from './rules.js';
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'yolo';
export type Behavior = 'allow' | 'ask' | 'deny';

export const MODE_CYCLE: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'yolo'];

/** plan 模式下仍可用的非只读工具 */
const PLAN_ALLOWED = new Set(['exit_plan_mode', 'todo_write', 'ask_user']);

export interface Evaluation {
  behavior: Behavior;
  reason: string;
  /** 高危强制询问：UI 不提供"始终允许" */
  forced?: boolean;
  suggestedRule?: string;
}

export interface PermissionSettings {
  allow: string[];
  ask: string[];
  deny: string[];
  mode: PermissionMode;
  /** 额外的免审批读取根目录（如蜂群 worktree：都是用户仓库的副本） */
  readRoots?: string[];
}

function isInside(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function protectedPath(req: PermissionRequest): string | null {
  if (req.kind !== 'edit' || !req.target) return null;
  const rel = path.relative(req.cwd, req.target).split(path.sep).join('/');
  if (rel === '.git' || rel.startsWith('.git/') || rel.includes('/.git/')) return '修改 .git 内部文件';
  if (rel.startsWith('.roast/shadow.git')) return '修改检查点仓库';
  return null;
}

export class PermissionEngine {
  private mode_: PermissionMode;
  private readonly allow: Rule[];
  private readonly ask: Rule[];
  private readonly deny: Rule[];
  private readonly sessionAllow: Rule[] = [];
  private readonly readRoots: string[];

  constructor(settings: PermissionSettings) {
    this.mode_ = settings.mode;
    this.allow = settings.allow.map(parseRule);
    this.ask = settings.ask.map(parseRule);
    this.deny = settings.deny.map(parseRule);
    this.readRoots = settings.readRoots ?? [];
  }

  get mode(): PermissionMode {
    return this.mode_;
  }

  private readonly modeListeners = new Set<(mode: PermissionMode) => void>();

  /** 订阅模式变化（会话落 mode/change 日志、UI 刷新模式胶囊）；返回退订函数 */
  onModeChange(listener: (mode: PermissionMode) => void): () => void {
    this.modeListeners.add(listener);
    return () => this.modeListeners.delete(listener);
  }

  setMode(mode: PermissionMode): void {
    if (mode === this.mode_) return;
    this.mode_ = mode;
    for (const l of this.modeListeners) l(mode);
  }

  cycleMode(): PermissionMode {
    const i = MODE_CYCLE.indexOf(this.mode_);
    this.setMode(MODE_CYCLE[(i + 1) % MODE_CYCLE.length]!);
    return this.mode_;
  }

  /** 记住授权（会话级存内存；项目级由调用方持久化后也在此登记） */
  grant(rule: string, _scope: 'session' | 'project'): void {
    this.sessionAllow.push(parseRule(rule));
  }

  evaluate(req: PermissionRequest): Evaluation {
    const suggestedRule = suggestRule(req);
    if (this.deny.some((r) => this.matches(r, req))) return { behavior: 'deny', reason: '命中 deny 规则' };
    if (this.mode_ === 'plan' && !this.isReadOnly(req) && !PLAN_ALLOWED.has(req.tool) && req.kind !== 'interact') {
      return { behavior: 'deny', reason: 'plan 模式下只允许只读操作；请先用 exit_plan_mode 提交计划' };
    }
    const danger = this.dangerOf(req);
    if (danger) return { behavior: 'ask', reason: `高危操作：${danger}`, forced: true };
    if (req.readOnlyRole && req.kind === 'execute' && (req.tool !== 'bash' || !req.target || !isReadOnlyRoleCommand(req.target))) {
      return { behavior: 'ask', forced: true, reason: `只读角色 ${req.readOnlyRole}：无法确认这条命令是否只读取或验证，需要用户批准本次执行` };
    }
    if (req.executionRoot && req.kind === 'execute') {
      return { behavior: 'ask', forced: true, reason: `此 agent 的工作区是 ${req.executionRoot}；shell / 外部执行工具能越过目录边界，需要明确批准本次命令` };
    }
    if (this.mode_ === 'yolo') return { behavior: 'allow', reason: 'yolo 模式' };
    if (this.allowedByRules(req)) return { behavior: 'allow', reason: '命中 allow 规则' };
    if (this.ask.some((r) => this.matches(r, req))) return { behavior: 'ask', reason: '命中 ask 规则', suggestedRule };
    return this.defaultDecision(req, suggestedRule);
  }

  private matches(rule: Rule, req: PermissionRequest): boolean {
    return matchesRule(rule, req);
  }

  private dangerOf(req: PermissionRequest): string | null {
    if (req.tool === 'bash' && req.target) return dangerReason(req.target);
    return protectedPath(req);
  }

  private isReadOnly(req: PermissionRequest): boolean {
    if (req.kind === 'read') return true;
    if (req.tool !== 'bash' || !req.target) return false;
    const parsed = parseCommand(req.target);
    return !parsed.hasSubshell && !parsed.writesFiles && parsed.segments.every(isReadOnlyCommand);
  }

  private allowedByRules(req: PermissionRequest): boolean {
    const rules = [...this.allow, ...this.sessionAllow];
    if (req.tool !== 'bash' || !req.target) return rules.some((r) => this.matches(r, req));
    if (rules.some((r) => r.tool === 'bash' && r.pattern === undefined)) return true;
    const parsed = parseCommand(req.target);
    if (parsed.hasSubshell) return false;
    const bashPatterns = rules.filter((r) => r.tool === 'bash' && r.pattern !== undefined).map((r) => r.pattern!);
    const segmentAllowed = (seg: string) =>
      bashPatterns.some((p) => commandMatches(p, seg)) || (!parsed.writesFiles && isReadOnlyCommand(seg));
    return parsed.segments.length > 0 && parsed.segments.every(segmentAllowed) && bashPatterns.length > 0;
  }

  private defaultDecision(req: PermissionRequest, suggestedRule: string): Evaluation {
    const inside = req.target !== undefined && isInside(req.cwd, req.target);
    switch (req.kind) {
      case 'interact':
        return { behavior: 'allow', reason: '交互类工具' };
      case 'read':
        if (req.targetKind === 'label') return { behavior: 'allow', reason: '只读资源' };
        return inside || req.target === undefined || this.readRoots.some((r) => isPathInside(r, req.target!))
          ? { behavior: 'allow', reason: '工作区内读取' }
          : { behavior: 'ask', reason: '读取工作区外的路径', suggestedRule };
      case 'edit':
        if (this.mode_ === 'acceptEdits' && inside) return { behavior: 'allow', reason: 'acceptEdits 模式' };
        return { behavior: 'ask', reason: inside ? '修改文件' : '修改工作区外的文件', suggestedRule };
      case 'execute':
        if (this.isReadOnly(req)) return { behavior: 'allow', reason: '只读命令' };
        return { behavior: 'ask', reason: '执行命令', suggestedRule };
      case 'network':
        return { behavior: 'ask', reason: '访问网络', suggestedRule };
    }
  }
}
