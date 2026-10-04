/**
 * 扩展缝：Skill 加载与管理。
 *
 * 约定（借鉴 ccsource 的 skills 机制）：
 * - skill 是 `skills/<name>/SKILL.md` 的 markdown 能力包：frontmatter（name/description/allowed-tools?）+ 正文指令
 * - 加载来源：内置目录 → 用户目录（~/.roastcli/skills）→ 项目目录（<cwd>/skills），后者覆盖前者
 * - 渐进披露：list() 的摘要注入系统 prompt；模型通过未来的 `skill` 工具按需加载正文
 *
 * 接入方式：实现 SkillRegistry 后挂到 ExtensionPoints.skills；
 * 启动时装配器把 list() 摘要注册为 system prompt section（order 300-399），
 * 并把 skill 正文加载工具注册进 ToolRegistry。
 */

export interface SkillMeta {
  name: string;
  description: string;
  /** 声明允许使用的工具白名单（未设置 = 不限制） */
  allowedTools?: string[];
  /** SKILL.md 文件绝对路径 */
  path: string;
  source: 'builtin' | 'user' | 'project';
}

export interface SkillRegistry {
  /** 扫描并加载所有来源的 skill 元数据 */
  load(): Promise<void>;
  list(): SkillMeta[];
  get(name: string): SkillMeta | undefined;
  /** 读取 skill 正文（markdown 全文） */
  readBody(name: string): Promise<string>;
  /** 热重载（文件变更后） */
  reload(): Promise<void>;
}
