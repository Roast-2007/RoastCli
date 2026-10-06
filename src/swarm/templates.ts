/** Legacy import and YAML compatibility; Hive uses strategies and mission events. */
import { describeStrategies, loadStrategies, renderBrief, substitute, DEFAULT_STRATEGY, DEFAULT_N, type HiveStrategy } from './strategies.js';
export { DEFAULT_N };
export const DEFAULT_TEMPLATE = DEFAULT_STRATEGY;
export interface SwarmTemplate extends HiveStrategy { prompt: string }
export function loadTemplates(cwd: string, home: string, opts: { trusted?: boolean } = {}): Map<string, SwarmTemplate> {
  return new Map([...loadStrategies(cwd, home, opts)].map(([name, s]) => [name, { ...s, prompt: s.playbook.includes('{{goal}}') ? s.playbook : `${s.playbook}\n\n目标：{{goal}}` }]));
}
export function renderTemplate(t: Pick<SwarmTemplate, 'prompt'>, goal: string, n = DEFAULT_N): string {
  return substitute(t.prompt, { goal, n: String(n) });
}
export function describeTemplates(templates: Map<string, SwarmTemplate>, n = DEFAULT_N): string {
  return describeStrategies(templates, n);
}
export function buildSwarmPrompt(templates: Map<string, SwarmTemplate>, goal: string, name = DEFAULT_TEMPLATE, n = DEFAULT_N): string {
  const strategy = templates.get(name);
  if (!strategy) throw new Error(`未知的蜂群模板 ${name}。可用：\n${describeTemplates(templates, n)}`);
  return renderBrief({ missionId: 'm1', goal, strategy: name, n, playbook: strategy.playbook, readOnly: strategy.readOnly });
}
