/**
 * Skill 注册表：SKILL.md 能力包（frontmatter: name / description / allowed-tools? + 正文指令）。
 * 来源（后者覆盖前者）：~/.roast/skills → <cwd>/.claude/skills（兼容） → <cwd>/.roast/skills
 * 渐进披露：system prompt 只列摘要；模型通过 skill 工具按需读取正文；每个 skill 也可作为 /斜杠命令 使用。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { SkillMeta, SkillRegistry } from '../skills.js';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface ParsedSkill {
  meta: Omit<SkillMeta, 'path' | 'source'>;
  body: string;
}

export function parseSkillFile(text: string, fallbackName: string): ParsedSkill | null {
  const m = FRONTMATTER.exec(text);
  let data: Record<string, unknown> = {};
  let body = text;
  if (m) {
    try {
      data = (parseYaml(m[1]!) ?? {}) as Record<string, unknown>;
    } catch {
      return null;
    }
    body = m[2]!;
  }
  const name = typeof data['name'] === 'string' && data['name'].trim() ? data['name'].trim() : fallbackName;
  const description = typeof data['description'] === 'string' ? data['description'].trim() : '';
  if (!/^[\w.-]+$/.test(name)) return null;
  const allowed = data['allowed-tools'];
  const allowedTools = Array.isArray(allowed) ? allowed.filter((x): x is string => typeof x === 'string') : typeof allowed === 'string' ? allowed.split(/[,\s]+/).filter(Boolean) : undefined;
  return { meta: { name, description, ...(allowedTools ? { allowedTools } : {}) }, body: body.trim() };
}

export function skillDirs(cwd: string, home: string): { dir: string; source: SkillMeta['source'] }[] {
  return [
    { dir: path.join(home, 'skills'), source: 'user' },
    { dir: path.join(cwd, '.claude', 'skills'), source: 'project' },
    { dir: path.join(cwd, '.roast', 'skills'), source: 'project' },
  ];
}

/** 读取并解析一个 SKILL.md；不存在、不是文件或读不了时返回 null（坏掉的技能不阻止会话启动） */
function readSkill(file: string, fallbackName: string): ParsedSkill | null {
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return null;
    return parseSkillFile(readFileSync(file, 'utf8'), fallbackName);
  } catch {
    return null;
  }
}

export class FileSkillRegistry implements SkillRegistry {
  private skills = new Map<string, SkillMeta>();

  constructor(
    private readonly cwd: string,
    private readonly home: string,
    /** 未信任的项目不能用同名技能顶替用户自己的技能 */
    private readonly opts: { trusted?: boolean } = {},
  ) {}

  async load(): Promise<void> {
    this.skills = new Map();
    for (const { dir, source } of skillDirs(this.cwd, this.home)) {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = path.join(dir, entry.name, 'SKILL.md');
        const parsed = readSkill(file, entry.name);
        if (!parsed) continue;
        const shadowsUser = source === 'project' && this.skills.get(parsed.meta.name)?.source === 'user';
        if (shadowsUser && !this.opts.trusted) continue;
        this.skills.set(parsed.meta.name, { ...parsed.meta, path: file, source });
      }
    }
  }

  list(): SkillMeta[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): SkillMeta | undefined {
    return this.skills.get(name);
  }

  async readBody(name: string): Promise<string> {
    const meta = this.skills.get(name);
    if (!meta) throw new Error(`没有名为 ${name} 的技能`);
    return parseSkillFile(readFileSync(meta.path, 'utf8'), name)?.body ?? '';
  }

  async reload(): Promise<void> {
    await this.load();
  }
}

/** system prompt 中的技能摘要段（稳定前缀） */
export function renderSkillsSection(skills: SkillMeta[]): string {
  if (skills.length === 0) return '';
  const lines = skills.map((s) => `- ${s.name}：${s.description || '（无描述）'}`);
  return `## 可用技能（Skills）\n需要时调用 skill 工具读取完整指令后再执行：\n${lines.join('\n')}`;
}
