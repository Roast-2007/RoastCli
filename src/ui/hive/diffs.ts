import { useEffect } from 'react';
import type { Session } from '../../agent/session.js';
import type { AgentInfo } from '../../swarm/types.js';
import { readDiff, type DiffReview } from '../../swarm/diff.js';
import type { UiStore, UiStoreState } from '../store/store.js';
export interface DiffCacheEntry { key: string; result?: DiffReview; error?: string; loading?: boolean }
export function diffStateKey(agent: AgentInfo | undefined, ui: UiStoreState): string {
  return JSON.stringify([agent?.state, agent?.waitingFor, agent?.report?.status, agent?.worktree, agent?.id === 'main' ? ui.agents.main?.running : undefined]);
}
export function useDiffReviews(session: Session, store: UiStore, ui: UiStoreState, selected: string, enabled: boolean): void {
  const states = JSON.stringify(ui.meta.swarm.map((agent) => [agent.id, diffStateKey(agent, ui)]));
  useEffect(() => {
    const state = store.getState(), valid = Object.fromEntries(Object.entries(state.meta.diffs ?? {}).filter(([id, entry]) => entry.key === diffStateKey(state.meta.swarm.find((agent) => agent.id === id), state)));
    if (Object.keys(valid).length !== Object.keys(state.meta.diffs ?? {}).length) store.setMeta({ diffs: valid });
  }, [states, store]);
  useEffect(() => {
    if (!enabled) return;
    const state = store.getState(), key = diffStateKey(state.meta.swarm.find((agent) => agent.id === selected), state), previous = state.meta.diffs?.[selected];
    if (previous?.key === key && !previous.loading) return;
    const abort = new AbortController(), target = session.swarm.diffTarget(selected);
    store.setMeta((meta) => ({ diffs: { ...meta.diffs, [selected]: { key, loading: true } } }));
    const finish = (entry: DiffCacheEntry) => { if (!abort.signal.aborted) store.setMeta((meta) => ({ diffs: { ...meta.diffs, [selected]: entry } })); };
    if (target) void readDiff(target, abort.signal).then((result) => finish({ key, result }), (error: unknown) => finish({ key, error: error instanceof Error ? error.message : String(error) }));
    else finish({ key, error: '工作区不可用' });
    return () => { abort.abort(); const live = store.getState().meta.diffs?.[selected]; if (live?.key === key && live.loading) store.setMeta((meta) => { const diffs = { ...meta.diffs }; delete diffs[selected]; return { diffs }; }); };
  }, [session, store, selected, enabled, states]);
}
