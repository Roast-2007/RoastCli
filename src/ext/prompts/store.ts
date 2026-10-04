/**
 * Prompt 管理：~/.roast/prompts/<name>.md（用户级）与 .roast/prompts/<name>.md（项目级）。
 * - 同名覆盖内置 section 并保持原有顺序；不对应内置 section 的文件作为附加 section（order 400）
 * - 项目未被信任时，项目级文件只能新增 section，不能覆盖内置或用户级 section
 *   （否则克隆来的仓库可以替换身份说明、抹掉用户自己的 ROAST.md）
 * - 支持 {{cwd}} {{date}} {{platform}} 变量；版本号 = 内容 sha1 前 8 位（system/snapshot 另按 hash 记录全文）
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { SystemPromptAssembler } from '../../agent/system-prompt.js';
import type { PromptStore, PromptTemplate } from '../prompts.js';

const EXTRA_ORDER = 400;

export function expandTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => vars[k] ?? m);
}

function readTemplates(dir: string, source: PromptTemplate['source'], vars: Record<string, string>): PromptTemplate[] {
  if (!existsSync(dir)) return [];
  const out: PromptTemplate[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    try {
      const text = expandTemplate(readFileSync(path.join(dir, entry.name), 'utf8').trim(), vars);
      const version = Number.parseInt(createHash('sha1').update(text).digest('hex').slice(0, 8), 16);
      out.push({ name: entry.name.slice(0, -3), version, text, source });
    } catch {
      // 读不了的文件跳过，不阻止会话启动
    }
  }
  return out;
}

export class FilePromptStore implements PromptStore {
  private templates = new Map<string, PromptTemplate>();
  private skippedNames: string[] = [];

  constructor(
    private readonly cwd: string,
    private readonly home: string,
    private readonly vars: Record<string, string>,
    private readonly opts: { trusted?: boolean } = {},
  ) {}

  async loadInto(assembler: SystemPromptAssembler): Promise<void> {
    this.templates = new Map();
    this.skippedNames = [];
    const builtin = new Set(assembler.sectionNames());
    const candidates = [
      ...readTemplates(path.join(this.home, 'prompts'), 'user', this.vars),
      ...readTemplates(path.join(this.cwd, '.roast', 'prompts'), 'project', this.vars),
    ];
    for (const t of candidates) {
      const overrides = builtin.has(t.name) || this.templates.has(t.name);
      if (t.source === 'project' && overrides && !this.opts.trusted) {
        this.skippedNames.push(t.name);
        continue;
      }
      this.templates.set(t.name, t);
      assembler.register({ name: t.name, order: assembler.orderOf(t.name) ?? EXTRA_ORDER, text: t.text });
    }
  }

  /** 因项目未被信任而未生效的覆盖 */
  skipped(): string[] {
    return [...this.skippedNames];
  }

  get(name: string): PromptTemplate | undefined {
    return this.templates.get(name);
  }

  list(): PromptTemplate[] {
    return [...this.templates.values()];
  }
}
