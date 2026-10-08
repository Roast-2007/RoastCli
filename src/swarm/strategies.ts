import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { BRIEF_PROMPT, PLAYBOOKS } from './prompts.js';
import type { ImageBlock } from '../core/types.js';

export interface HiveStrategy {
  name: string;
  description: string;
  source: 'builtin' | 'user' | 'project';
  playbook: string;
  n?: number;
  readOnly?: boolean;
}
export interface MissionInput {
  images?: ImageBlock[];
  kind: 'mission';
  goal: string;
  strategy: HiveStrategy;
  n: number;
}
export const DEFAULT_STRATEGY = 'auto';
export const DEFAULT_N = 3;
export function strategyUsesN(strategy: HiveStrategy): boolean {
  return strategy.n !== undefined || /\{\{\s*n\s*\}\}/.test(strategy.playbook);
}
const descriptions: Record<string, string> = {
  auto: '按任务选择最轻的协作方式（默认）',
  fanout: '拆解为独立任务并行完成',
  'best-of-n': '{{n}} 个 worker 独立实现，judge 择优',
  critique: '实现、评审、修正，最多 3 轮',
  research: '{{n}} 个 scout 只读调研',
};
export function substitute(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => values[key] ?? match);
}
export function renderBrief(input: {
  missionId: string;
  goal: string;
  strategy: string;
  n: number;
  readOnly?: boolean;
  playbook: string;
}): string {
  const playbook = substitute(input.playbook, { goal: input.goal, n: String(input.n) });
  return substitute(BRIEF_PROMPT.replace('{{#readOnly}} mode="read-only"{{/readOnly}}', input.readOnly ? ' mode="read-only"' : ''), {
    missionId: input.missionId,
    goal: input.goal,
    strategy: input.strategy,
    n: String(input.n),
    playbook,
  });
}
function readStrategies(dir: string, source: HiveStrategy['source']): HiveStrategy[] {
  if (!existsSync(dir)) return [];
  const result: HiveStrategy[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    try {
      const data = parseYaml(readFileSync(path.join(dir, entry.name), 'utf8')) as Record<string, unknown> | null;
      const playbook =
        typeof data?.['playbook'] === 'string' ? data['playbook'] : typeof data?.['prompt'] === 'string' ? data['prompt'] : '';
      if (!playbook.trim()) continue;
      const name = typeof data?.['name'] === 'string' && /^[\w.-]+$/.test(data['name']) ? data['name'] : entry.name.replace(/\.ya?ml$/, '');
      const n = data?.['n'];
      if (n !== undefined && (typeof n !== 'number' || !Number.isInteger(n) || n < 2 || n > 8)) continue;
      if (data?.['readOnly'] !== undefined && typeof data['readOnly'] !== 'boolean') continue;
      result.push({
        name,
        description: typeof data?.['description'] === 'string' ? data['description'] : '',
        source,
        playbook: playbook.trim(),
        ...(typeof n === 'number' ? { n } : {}),
        ...(typeof data?.['readOnly'] === 'boolean' ? { readOnly: data['readOnly'] } : {}),
      });
    } catch {
      /* Malformed strategies are ignored, just like legacy templates. */
    }
  }
  return result;
}
export function loadStrategies(cwd: string, home: string, opts: { trusted?: boolean } = {}): Map<string, HiveStrategy> {
  const all = new Map<string, HiveStrategy>(
    Object.entries(PLAYBOOKS).map(([name, playbook]) => [
      name,
      { name, playbook, description: descriptions[name]!, source: 'builtin', ...(name === 'research' ? { readOnly: true } : {}) },
    ]),
  );
  for (const root of [
    { dir: home, source: 'user' as const },
    { dir: path.join(cwd, '.roast'), source: 'project' as const },
  ]) {
    const local = new Map<string, HiveStrategy>();
    for (const directory of ['templates', 'strategies'])
      for (const strategy of readStrategies(path.join(root.dir, directory), root.source)) local.set(strategy.name, strategy);
    for (const strategy of local.values()) {
      if (root.source === 'project' && all.has(strategy.name) && !opts.trusted) continue;
      all.set(strategy.name, strategy);
    }
  }
  return all;
}
export function missionInput(strategies: Map<string, HiveStrategy>, goal: string, name = DEFAULT_STRATEGY, n?: number): MissionInput {
  const strategy = strategies.get(name);
  if (!strategy) throw new Error(`未知的蜂群策略 ${name}。可用：\n${describeStrategies(strategies)}`);
  const count = n ?? strategy.n ?? DEFAULT_N;
  if (!Number.isInteger(count) || count < 2 || count > 8) throw new Error('并行数应为 2–8 的整数');
  return { kind: 'mission', goal, strategy, n: count };
}
export function describeStrategies(strategies: Map<string, HiveStrategy>, n = DEFAULT_N): string {
  return [...strategies.values()]
    .map((s) => `${s.name}  ${substitute(s.description, { n: String(s.n ?? n) })}${s.source === 'builtin' ? '' : `（${s.source}）`}`)
    .join('\n');
}
