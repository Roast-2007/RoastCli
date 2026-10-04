/**
 * 蜂群策略模板：把"怎么组织蜂群"写成给 Queen 的指令（主会话的一条用户消息），而不是硬编码的编排器 ——
 * Queen 仍可根据实际情况调整，所有协作走同一套工具（spawn_agent / await_agents / merge_worktree / 黑板）。
 *
 * 内置：fanout（拆分并行）、best-of-n（N 个独立方案 + Judge 择优）、critique（实现 → 评审 → 修正，最多 3 轮）、
 * research（多角度调研 + 汇总）。
 * 自定义：~/.roast/templates/<name>.yaml 与 .roast/templates/<name>.yaml（字段 description / prompt，
 * prompt 中可用 {{goal}} {{n}}）。未信任的项目不能覆盖内置或用户级同名模板。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface SwarmTemplate {
  name: string;
  description: string;
  source: 'builtin' | 'user' | 'project';
  /** 含 {{goal}} / {{n}} 占位符的指令 */
  prompt: string;
}

export const DEFAULT_TEMPLATE = 'fanout';
export const DEFAULT_N = 3;

const BUILTIN: readonly Omit<SwarmTemplate, 'source'>[] = [
  {
    name: 'fanout',
    description: '拆解为相互独立的子任务并行完成（默认）',
    prompt: `请以 Hive 蜂群方式完成下面的目标：先调研并拆解任务，用 spawn_agent 把相互独立的部分并行派发给合适的角色（scout 调研、worker 实现、critic 评审），等待并汇总它们的报告；在独立 worktree 中工作的 worker 完成后，审阅其报告并用 merge_worktree 合并改动；必要时再派发修正任务，最后给出总结。

目标：{{goal}}`,
  },
  {
    name: 'best-of-n',
    description: '{{n}} 个 worker 独立实现同一任务，Judge 评审择优后合并胜出方案',
    prompt: `请用 best-of-N 策略完成下面的目标：
1. 先自己弄清需求，写出明确的验收标准。
2. 用 spawn_agent 派出 {{n}} 个 worker，给它们完全相同、自包含的任务描述（含验收标准），隔离方式用默认（各自独立的 worktree，互不可见）。要求每个 worker 在 report 中写明实现思路，以及运行过的验证（测试 / 命令）和结果。
3. await_agents 等它们全部完成。
4. 派出 1 个 judge：task 中给出验收标准，refs 中给出每个候选的 agentId 与 worktree 路径（见各报告末尾）。让它逐个阅读改动，并 cd 到各 worktree 运行测试 / 类型检查（这类验证命令对 judge 开放），从正确性、完整性、简洁性、风险几方面比较，选出最佳并说明理由。
5. 用 merge_worktree 合并胜出者；其余候选用 merge_worktree({ agentId, discard: true }) 丢弃。
6. 在你的工作区复核（必要时运行测试），总结：谁胜出、为什么、改了什么。

目标：{{goal}}`,
  },
  {
    name: 'critique',
    description: '实现 → 对抗式评审 → 修正，最多 3 轮',
    prompt: `请用"实现—评审—修正"循环完成下面的目标（最多 3 轮）：
1. 派出 1 个 worker 实现（独立 worktree），任务中写清验收标准；await 它完成后，审阅报告并用 merge_worktree 合并。
2. 派出 1 个 critic（与你共享工作区）做对抗式评审：检查你工作区中的改动（如 git diff）并运行测试 / 类型检查，判断是否满足验收标准，找出缺陷、风险和遗漏。没有问题时 report status=done，否则用 changes_requested 并列出可执行的修改意见。
3. 如果需要修改：把 critic 的意见作为任务派给一个新的 worker（它基于你当前的工作区，包含已合并的改动），合并后再次评审。
4. 评审通过或已满 3 轮时停止，总结结果与仍存在的问题。

目标：{{goal}}`,
  },
  {
    name: 'research',
    description: '{{n}} 个 scout 从不同角度调研，汇总成结论（不改代码）',
    prompt: `请用多角度调研完成下面的问题（只读，不修改任何文件）：
1. 把问题拆成 {{n}} 个互补的角度（例如：实现代码路径、配置与文档、测试与历史改动、外部依赖）。
2. 为每个角度派出 1 个 scout，要求把详细发现写入黑板 /research/<角度>，report 中只给结论摘要和键名。
3. await_agents 等全部完成，用 board_read 阅读需要的细节；结论之间有矛盾时，派 scout 核实。
4. 给出结论：答案、依据（文件与行号）、不确定之处。

问题：{{goal}}`,
  },
];

export function renderTemplate(t: SwarmTemplate, goal: string, n = DEFAULT_N): string {
  return t.prompt.replace(/\{\{\s*(goal|n)\s*\}\}/g, (_, key: string) => key === 'goal' ? goal : String(n));
}

function readYamlTemplates(dir: string, source: SwarmTemplate['source']): SwarmTemplate[] {
  if (!existsSync(dir)) return [];
  const out: SwarmTemplate[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    try {
      const data = parseYaml(readFileSync(path.join(dir, entry.name), 'utf8')) as Record<string, unknown> | null;
      const prompt = typeof data?.['prompt'] === 'string' ? data['prompt'].trim() : '';
      if (!prompt) continue;
      const name = typeof data?.['name'] === 'string' && /^[\w.-]+$/.test(data['name']) ? data['name'] : entry.name.replace(/\.ya?ml$/, '');
      const description = typeof data?.['description'] === 'string' ? data['description'] : '';
      out.push({ name, description, prompt: prompt.includes('{{goal}}') ? prompt : `${prompt}\n\n目标：{{goal}}`, source });
    } catch {
      // 格式错误的模板跳过
    }
  }
  return out;
}

export function loadTemplates(cwd: string, home: string, opts: { trusted?: boolean } = {}): Map<string, SwarmTemplate> {
  const all = new Map<string, SwarmTemplate>(BUILTIN.map((t) => [t.name, { ...t, source: 'builtin' as const }]));
  for (const t of readYamlTemplates(path.join(home, 'templates'), 'user')) all.set(t.name, t);
  for (const t of readYamlTemplates(path.join(cwd, '.roast', 'templates'), 'project')) {
    if (all.has(t.name) && !opts.trusted) continue;
    all.set(t.name, t);
  }
  return all;
}

/** 按模板名生成给 Queen 的指令；未知模板时抛错并列出可用模板 */
export function buildSwarmPrompt(templates: Map<string, SwarmTemplate>, goal: string, name = DEFAULT_TEMPLATE, n = DEFAULT_N): string {
  const t = templates.get(name);
  if (!t) throw new Error(`未知的蜂群模板 ${name}。可用：\n${describeTemplates(templates, n)}`);
  return renderTemplate(t, goal, n);
}

export function describeTemplates(templates: Map<string, SwarmTemplate>, n = DEFAULT_N): string {
  return [...templates.values()].map((t) => `${t.name}  ${t.description.replace(/\{\{\s*n\s*\}\}/g, String(n))}${t.source === 'builtin' ? '' : `（${t.source}）`}`).join('\n');
}
