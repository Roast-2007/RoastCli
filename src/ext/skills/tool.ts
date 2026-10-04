/**
 * skill 工具：读取技能正文（渐进披露）。依赖 ToolServices 中的 SKILLS_KEY → SkillRegistry。
 */
import { z } from 'zod';
import { defineTool, textResult, toolErrorResult, type ToolResult } from '../../tools/tool.js';
import type { SkillRegistry } from '../skills.js';

export const SKILLS_KEY = 'skills';

export const skillTool = defineTool({
  name: 'skill',
  description: '读取一个技能（Skill）的完整指令后按指令执行。可用技能见 system prompt 的"可用技能"列表。',
  parameters: z.object({
    name: z.string().min(1),
    args: z.string().optional().describe('传给技能的参数（可选）'),
  }),
  isReadOnly: true,
  isConcurrencySafe: true,
  permission: { kind: 'interact' },
  async execute(args, ctx): Promise<ToolResult> {
    const registry = ctx.services.get<SkillRegistry>(SKILLS_KEY);
    const meta = registry?.get(args.name);
    if (!registry || !meta) {
      const names = registry?.list().map((s) => s.name).join(', ') || '（无）';
      return toolErrorResult('skill', `没有名为 ${args.name} 的技能。可用：${names}`);
    }
    const body = await registry.readBody(args.name);
    const allowed = meta.allowedTools?.length ? `\n允许使用的工具：${meta.allowedTools.join(', ')}` : '';
    const extra = args.args ? `\n\n本次参数：${args.args}` : '';
    return textResult(`技能 ${meta.name}（${meta.path}）${allowed}\n\n${body}${extra}`, { skill: meta.name });
  },
});
