import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/core/config.js';
import { UsageCost } from '../../src/core/usage-cost.js';
import type { SessionEventBody } from '../../src/session/events.js';
import { usageOf } from '../fixtures/chunks.js';

const config = ConfigSchema.parse({
  providers: {
    p: { driver: 'openai-compat', models: { big: { pricing: { input: 10, output: 20 } }, small: { pricing: { input: 1, output: 2 } } } },
    q: { driver: 'anthropic', models: { cheap: { pricing: { input: 1, output: 1 } } } },
  },
  default: 'p:big',
});
describe('usage cost attribution', () => {
  it('prices each original model and groups main, child and summaries; rewind does not refund', () => {
    const ledger = new UsageCost({ provider: 'p', model: 'big' }, config);
    let seq = 0;
    const observe = (body: SessionEventBody, agentId = 'main') => ledger.observe({ ...body, seq: ++seq, agentId });
    observe({ type: 'turn/start', turn: 1, at: 't' });
    observe({ type: 'usage', turn: 1, step: 1, usage: usageOf(100, 20) });
    observe({ type: 'turn/start', turn: 1, at: 't' }, 's1');
    observe({ type: 'model/change', at: 't', provider: 'q', model: 'cheap' }, 's1');
    observe({ type: 'usage', turn: 1, step: 1, usage: usageOf(200, 10) }, 's1');
    observe({
      type: 'context/compact',
      at: 't',
      upTo: 2,
      summary: 'handoff',
      auxUsage: usageOf(50, 10),
      auxModel: { provider: 'p', model: 'small' },
    });
    observe({ type: 'model/change', at: 't', provider: 'p', model: 'small' });
    observe({ type: 'usage', turn: 2, step: 1, usage: usageOf(100, 20) });
    const cost = ledger.value();
    expect(cost).toBeCloseTo(0.00182);
    observe({ type: 'rewind', at: 't', toTurn: 1 });
    expect(ledger.value()).toBe(cost);
    expect(ledger.breakdown().agents.map((g) => g.id)).toEqual(['main', 's1']);
    expect(ledger.breakdown().entries[2]).toMatchObject({ kind: 'summary', model: 'small', turn: 1 });
    expect(ledger.breakdown().turns.map((g) => g.id)).toEqual(['main:1', 's1:1', 'main:2']);
  });
  it('retains known groups while marking the total unknown if one model lacks pricing', () => {
    const ledger = new UsageCost({ provider: 'p', model: 'big' }, config);
    ledger.observe({ seq: 1, agentId: 'main', type: 'usage', turn: 1, step: 1, usage: usageOf(100, 10) });
    ledger.observe(
      { seq: 2, agentId: 's1', type: 'usage', turn: 1, step: 1, usage: usageOf(100, 10) },
      { provider: 'q', model: 'unknown' },
    );
    expect(ledger.value()).toBeNull();
    expect(ledger.breakdown().agents[0]!.cost).toBeCloseTo(0.0012);
    expect(ledger.breakdown().agents[1]!.cost).toBeNull();
  });
});
