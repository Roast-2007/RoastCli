import { useState } from 'react';
import type { UiStore } from '../store/store.js';
import type { HiveStrategy } from '../../swarm/strategies.js';
import { strategyUsesN, substitute } from '../../swarm/strategies.js';
import { setStrategy } from '../strategy.js';
import { SelectPanel } from './SelectPanel.js';
export function StrategyPanel({ store, strategies, height }: { store: UiStore; strategies: Map<string, HiveStrategy>; height: number }) {
  const meta = store.getState().meta;
  const [selected, select] = useState<string | undefined>(meta.strategyStep);
  const close = () => store.setMeta({ overlay: null, strategyStep: undefined });
  const strategy = selected ? strategies.get(selected) : undefined;
  if (strategy) {
    const initial = strategy.name === meta.strategy ? (meta.n ?? 3) : (strategy.n ?? meta.n ?? 3);
    return (
      <SelectPanel
        key={`n:${strategy.name}`}
        title={`并行数 · ${strategy.name}`}
        height={height}
        initialId={String(initial)}
        entries={Array.from({ length: 7 }, (_, i) => ({
          id: String(i + 2),
          label: `${i + 2} · ${substitute(strategy.description, { n: String(i + 2) })}`,
        }))}
        onClose={() => {
          select(undefined);
          store.setMeta({ strategyStep: undefined });
        }}
        onSelect={(entry) => {
          setStrategy(store, strategy.name, Number(entry.id), true);
          close();
        }}
      />
    );
  }
  return (
    <SelectPanel
      key="strategies"
      title="策略"
      entries={[...strategies.values()].map((item) => ({
        id: item.name,
        label: `${item.name} · ${substitute(item.description, { n: String(meta.n ?? 3) })}`,
      }))}
      height={height}
      initialId={meta.strategy}
      searchable
      onClose={close}
      onSelect={(entry) => {
        const item = strategies.get(entry.id)!;
        if (strategyUsesN(item)) select(entry.id);
        else {
          setStrategy(store, entry.id, meta.n ?? 3, false);
          close();
        }
      }}
    />
  );
}
