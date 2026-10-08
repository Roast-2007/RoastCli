/**
 * 工具注册表：名称唯一、allow/deny 名单过滤（deny 优先）、
 * schemas() 编译给模型的 ToolSchema[]。
 */
import { RoastError } from '../core/errors.js';
import type { ToolSchema } from '../core/types.js';
import { toolSchemaOf, type ToolDefinition } from './tool.js';
import { matchesRule, parseRule } from './permissions/rules.js';

export interface ToolRegistryFilter {
  /** 非空时仅允许名单内的工具可见 */
  allow?: string[];
  /** deny 优先于 allow */
  deny?: string[];
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly allow: Set<string> | null;
  private readonly deny: Set<string>;

  constructor(filter: ToolRegistryFilter = {}) {
    this.allow = filter.allow ? new Set(filter.allow) : null;
    this.deny = new Set(filter.deny ?? []);
  }

  register(def: ToolDefinition): void {
    if (this.tools.has(def.name)) {
      throw new RoastError('CONFIG', `工具重复注册: ${def.name}`);
    }
    this.tools.set(def.name, def);
  }

  hide(rules: string[]): void {
    for (const name of this.tools.keys())
      if (
        rules.some((text) => {
          const rule = parseRule(text);
          return rule.pattern === undefined && matchesRule(rule, { tool: name, kind: 'read', cwd: '' });
        })
      )
        this.deny.add(name);
  }

  /** deny 优先；allow 非空时名单外不可见 */
  private visible(name: string): boolean {
    if (this.deny.has(name)) return false;
    if (this.allow && !this.allow.has(name)) return false;
    return true;
  }

  get(name: string): ToolDefinition {
    const def = this.tools.get(name);
    if (!def || !this.visible(name)) {
      throw new RoastError('UNKNOWN_TOOL', `未知或不可用的工具: ${name}`);
    }
    return def;
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].filter((d) => this.visible(d.name));
  }

  /** 编译给模型的 JSON Schema 描述列表 */
  schemas(): ToolSchema[] {
    return this.list().map(toolSchemaOf);
  }
}
