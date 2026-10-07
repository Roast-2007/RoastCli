import { addUsage, emptyUsage } from '../../core/types.js';
import type { UsageEntry } from '../../core/usage-cost.js';
import type { Line } from './lines.js';
import { pricingSourceLabel } from '../../providers/pricing/index.js';
export function missionUsage(entries: UsageEntry[], turn: number, agents: string[]): Line[] {
  const selected = entries.filter((entry) => (entry.agent === 'main' ? entry.turn === turn : agents.includes(entry.agent)));
  const total = selected.reduce((sum: number | null, entry) => (sum === null || entry.cost === null ? null : sum + entry.cost), 0);
  const group = (key: (entry: UsageEntry) => string): Line[] => {
    const groups = new Map<string, { cost: number | null; usage: ReturnType<typeof emptyUsage> }>();
    for (const entry of selected) {
      const id = key(entry),
        previous = groups.get(id) ?? { cost: 0, usage: emptyUsage() };
      groups.set(id, {
        cost: previous.cost === null || entry.cost === null ? null : previous.cost + entry.cost,
        usage: addUsage(previous.usage, entry.usage),
      });
    }
    return [...groups].map(([id, item]) => ({
      text: `${id} · ${item.cost === null ? '未知' : `$${item.cost.toFixed(6)}`} · ↑${item.usage.input + item.usage.cacheRead + item.usage.cacheWrite} ↓${item.usage.output}`,
      tone: 'text',
    }));
  };
  const models = group((entry) => `${entry.provider}:${entry.model}`).map((line) => {
    const id = line.text.split(' · ')[0];
    const sources = [
      ...new Set(
        selected
          .filter((e) => `${e.provider}:${e.model}` === id && e.priceSource)
          .map((e) => pricingSourceLabel({ source: e.priceSource!, updatedAt: e.priceDate }, true)),
      ),
    ];
    return { ...line, text: `${line.text}${sources.length ? ` · ${sources.join('/')}` : ''}` };
  });
  return [
    { text: `本任务费用：${total === null ? '未知' : `$${total.toFixed(6)}`}`, tone: 'accent' },
    ...group((entry) => entry.agent),
    ...models,
  ];
}
