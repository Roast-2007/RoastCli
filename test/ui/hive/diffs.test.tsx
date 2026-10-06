import { useSyncExternalStore } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { readDiff } from '../../../src/swarm/diff.js';
import { useDiffReviews } from '../../../src/ui/hive/diffs.js';
import { createUiStore, type UiStore } from '../../../src/ui/store/store.js';
import type { Session } from '../../../src/agent/session.js';
import type { AgentInfo } from '../../../src/swarm/types.js';
vi.mock('../../../src/swarm/diff.js', () => ({ readDiff: vi.fn() }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
function Review({ session, store, enabled }: { session: Session; store: UiStore; enabled: boolean }) {
  const ui = useSyncExternalStore(store.subscribe, store.getState); useDiffReviews(session, store, ui, 'w1', enabled); return <Text>{ui.meta.diffs?.w1?.result?.added ?? 'pending'}</Text>;
}
describe('diff review cache', () => {
  it('runs on demand, caches through tab changes, invalidates on member state and aborts pending reads', async () => {
    const store = createUiStore(), agent: AgentInfo = { id: 'w1', parentId: 'main', state: 'running', depth: 1, role: 'worker', brief: 'work', model: 'p:m', startedAt: 0, children: [] };
    store.setMeta({ swarm: [agent] });
    const session = { swarm: { diffTarget: () => ({ cwd: '/safe/worktree' }) } } as unknown as Session;
    vi.mocked(readDiff).mockReset().mockResolvedValue({ stat: 'a', diff: '+a', files: 1, added: 1, removed: 0 });
    const screen = render(<Review session={session} store={store} enabled={false} />);
    try {
      await tick(); expect(readDiff).not.toHaveBeenCalled();
      screen.rerender(<Review session={session} store={store} enabled />); await tick(); expect(screen.lastFrame()).toBe('1'); expect(readDiff).toHaveBeenCalledTimes(1);
      screen.rerender(<Review session={session} store={store} enabled={false} />); await tick(); screen.rerender(<Review session={session} store={store} enabled />); await tick(); expect(readDiff).toHaveBeenCalledTimes(1);
      vi.mocked(readDiff).mockImplementationOnce((_target, signal) => new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
      store.setMeta({ swarm: [{ ...agent, state: 'done' }] }); await tick(); expect(readDiff).toHaveBeenCalledTimes(2);
      const signal = vi.mocked(readDiff).mock.calls.at(-1)![1]!; screen.rerender(<Review session={session} store={store} enabled={false} />); await tick(); expect(signal.aborted).toBe(true); expect(store.getState().meta.diffs?.w1).toBeUndefined();
    } finally { screen.unmount(); }
  });
});
