/**
 * 扩展缝：Prompt 管理。
 *
 * 地基已就位：agent/system-prompt.ts 的 SystemPromptAssembler 按
 * section 组织全部系统 prompt。本缝在其上增加：
 * - 外部文件覆盖：prompts/<name>.md 覆盖同名内置 section（项目级 prompts/ 优先于用户级）
 * - 版本号与变更记录：每个 section 带 version，写进运行日志的 request/header，便于回溯
 *   "这次运行用的是哪版 prompt"
 * - 模板变量：{{cwd}} / {{date}} 等占位符在组装时求值
 */

export interface PromptTemplate {
  name: string;
  version: number;
  text: string;
  source: 'builtin' | 'user' | 'project';
}

export interface PromptStore {
  /** 加载外部覆盖文件并合并进 assembler */
  loadInto(assembler: import('../agent/system-prompt.js').SystemPromptAssembler): Promise<void>;
  get(name: string): PromptTemplate | undefined;
  list(): PromptTemplate[];
}
