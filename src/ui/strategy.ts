import { isProjectTrusted, roastHome } from '../core/config.js';
import type { Session } from '../agent/session.js';
import { loadStrategies, strategyUsesN, type HiveStrategy } from '../swarm/strategies.js';
import type { UiMeta, UiStore } from './store/store.js';
const cache = new WeakMap<Session, Map<string, HiveStrategy>>();
export function sessionStrategies(session: Session, refresh = false) {
  let strategies = cache.get(session);
  if (!strategies || refresh) {
    const cwd = session.log.header.cwd;
    strategies = loadStrategies(cwd, roastHome(), { trusted: isProjectTrusted(cwd) });
    cache.set(session, strategies);
  }
  return strategies;
}
export function strategyLabel(session: Session, meta: Pick<UiMeta, 'strategy' | 'n'>): string {
  const name = meta.strategy ?? 'auto',
    strategy = sessionStrategies(session).get(name);
  return `策略 ${name}${strategy && strategyUsesN(strategy) ? ` · n ${meta.n ?? 3}` : ''}`;
}
export function setStrategy(store: UiStore, strategy: string, n: number, showN: boolean) {
  store.setMeta({ strategy, n, strategyStep: undefined, toast: { text: `策略 ${strategy}${showN ? ` · n ${n}` : ''}`, tone: 'success' } });
}
