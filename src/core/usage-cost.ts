import type { ModelPricing, ModelRef, RoastConfig } from './config.js';
import type { TokenUsage } from './types.js';
import { addUsage, emptyUsage } from './types.js';
import type { SessionEvent } from '../session/events.js';

export function costOf(usage: TokenUsage, pricing: ModelPricing): number {
  return (usage.input * pricing.input + usage.output * pricing.output + usage.cacheRead * (pricing.cacheRead ?? pricing.input) + usage.cacheWrite * (pricing.cacheWrite ?? pricing.input)) / 1_000_000;
}

/** Prices usage at its original model; rewind does not refund spent tokens. */
export class UsageCost {
  private total = 0;
  private unknown = false;
  private records: UsageEntry[] = [];
  private turns = new Map<string, number>();
  private models = new Map<string, ModelRef>();
  constructor(private ref: ModelRef, private readonly config: RoastConfig) {}
  setModel(ref: ModelRef): void { this.ref = { ...ref }; }
  observe(event: SessionEvent, agentModel?: ModelRef): void {
    const agent = event.agentId ?? 'main';
    if (event.type === 'turn/start') this.turns.set(agent, event.turn);
    if (event.type === 'model/change') { this.models.set(agent, { provider: event.provider, model: event.model }); if (agent === 'main') this.setModel(event); }
    const usage = event.type === 'usage' ? event.usage : event.type === 'context/compact' ? event.auxUsage : undefined;
    if (!usage || !Object.values(usage).some((n) => n > 0)) return;
    const ref = event.type === 'context/compact' && event.auxModel ? event.auxModel : this.models.get(agent) ?? agentModel ?? this.ref;
    const pricing = this.config.providers[ref.provider]?.models?.[ref.model]?.pricing;
    const cost = pricing ? costOf(usage, pricing) : null;
    this.records.push({ agent, turn: event.type === 'usage' ? event.turn : this.turns.get(agent) ?? 0, provider: ref.provider, model: ref.model, kind: event.type === 'usage' ? 'generation' : 'summary', usage: { ...usage }, cost });
    if (cost !== null) this.total += cost;
    else this.unknown = true;
  }
  value(): number | null {
    return this.unknown || (!this.records.length && !this.config.providers[this.ref.provider]?.models?.[this.ref.model]?.pricing) ? null : this.total;
  }
  breakdown(): UsageBreakdown {
    const group = (key: (entry: UsageEntry) => string): UsageGroup[] => {
      const groups = new Map<string, UsageGroup>();
      for (const entry of this.records) {
        const id = key(entry), group = groups.get(id) ?? { id, requests: 0, usage: emptyUsage(), cost: 0 };
        group.requests++;
        group.usage = addUsage(group.usage, entry.usage);
        group.cost = group.cost === null || entry.cost === null ? null : group.cost + entry.cost;
        groups.set(id, group);
      }
      return [...groups.values()];
    };
    return { cost: this.value(), entries: this.records.map((entry) => ({ ...entry, usage: { ...entry.usage } })), agents: group((entry) => entry.agent), turns: group((entry) => `${entry.agent}:${entry.turn}`), providers: group((entry) => entry.provider), models: group((entry) => `${entry.provider}:${entry.model}`) };
  }
}

export interface UsageEntry { agent: string; turn: number; provider: string; model: string; kind: 'generation' | 'summary'; usage: TokenUsage; cost: number | null }
export interface UsageGroup { id: string; requests: number; usage: TokenUsage; cost: number | null }
export interface UsageBreakdown { cost: number | null; entries: UsageEntry[]; agents: UsageGroup[]; turns: UsageGroup[]; providers: UsageGroup[]; models: UsageGroup[] }
export function formatUsageBreakdown(breakdown: UsageBreakdown): string {
  const money = (cost: number | null) => cost === null ? '定价未知' : `$${cost.toFixed(6)}`;
  const section = (label: string, groups: UsageGroup[]) => [label, ...groups.map((g) => `  ${g.id}: ${money(g.cost)} · ${g.requests} 次 · input ${g.usage.input + g.usage.cacheRead + g.usage.cacheWrite} · cached ${g.usage.cacheRead} · output ${g.usage.output}`)].join('\n');
  return [`全部 agent 合计：${money(breakdown.cost)}`, section('按 agent', breakdown.agents), section('按 turn（agent:turn）', breakdown.turns), section('按 provider', breakdown.providers), section('按模型（含摘要费用）', breakdown.models)].join('\n\n');
}
