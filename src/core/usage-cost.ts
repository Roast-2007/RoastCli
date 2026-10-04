import type { ModelPricing, ModelRef, RoastConfig } from './config.js';
import type { TokenUsage } from './types.js';
import type { SessionEvent } from '../session/events.js';

export function costOf(usage: TokenUsage, pricing: ModelPricing): number {
  return (usage.input * pricing.input + usage.output * pricing.output + usage.cacheRead * (pricing.cacheRead ?? pricing.input) + usage.cacheWrite * (pricing.cacheWrite ?? pricing.input)) / 1_000_000;
}

/** Prices usage at its original model; rewind does not refund spent tokens. */
export class UsageCost {
  private total = 0;
  private unknown = false;
  constructor(private ref: ModelRef, private readonly config: RoastConfig) {}
  setModel(ref: ModelRef): void { this.ref = { ...ref }; }
  observe(event: SessionEvent): void {
    if (event.type === 'model/change') this.setModel(event);
    const usage = event.type === 'usage' ? event.usage : event.type === 'context/compact' ? event.auxUsage : undefined;
    if (!usage || !Object.values(usage).some((n) => n > 0)) return;
    const pricing = this.config.providers[this.ref.provider]?.models?.[this.ref.model]?.pricing;
    if (pricing) this.total += costOf(usage, pricing);
    else this.unknown = true;
  }
  value(): number | null {
    return this.unknown || (!this.total && !this.config.providers[this.ref.provider]?.models?.[this.ref.model]?.pricing) ? null : this.total;
  }
}
