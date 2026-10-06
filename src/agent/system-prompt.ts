/**
 * 系统 prompt 分段组装器（借鉴 deepseek-harness 的 ctx.systemPrompt.section）。
 * 各模块（工具、skill、plan 模式、memory……）以 section 形式贡献片段，
 * 每个 step 重新组装，保证热更新生效。
 * prompt 管理（外部文件覆盖内置 section、版本号）后续在 PromptStore 上扩展。
 */

import { IDENTITY_PROMPT } from '../swarm/prompts.js';

export interface PromptSection {
  name: string;
  /** 排序权重，小的在前 */
  order: number;
  text: string;
}

export class SystemPromptAssembler {
  private sections = new Map<string, PromptSection>();

  /** 注册/替换一个 section；同名覆盖 */
  register(section: PromptSection): void {
    this.sections.set(section.name, section);
  }

  unregister(name: string): boolean {
    return this.sections.delete(name);
  }

  has(name: string): boolean {
    return this.sections.has(name);
  }

  /** 按 order 升序组装为最终系统 prompt */
  assemble(): string {
    return [...this.sections.values()]
      .sort((a, b) => a.order - b.order)
      .map((s) => s.text.trimEnd())
      .join('\n\n');
  }

  sectionNames(): string[] {
    return [...this.sections.keys()];
  }

  orderOf(name: string): number | undefined {
    return this.sections.get(name)?.order;
  }
}

/** 内置基础 section（order 约定：0-99 身份/总纲，100-199 工具，200-299 环境，300+ 扩展） */
export function registerBaseSections(assembler: SystemPromptAssembler, env: { cwd: string; platform: string; shell: string; date: string }): void {
  assembler.register({
    name: 'identity',
    order: 0,
    text: IDENTITY_PROMPT,
  });
  assembler.register({
    name: 'environment',
    order: 200,
    text: `Environment:
- Working directory: ${env.cwd}
- Platform: ${env.platform}
- Shell: ${env.shell}
- Date: ${env.date}`,
  });
}
