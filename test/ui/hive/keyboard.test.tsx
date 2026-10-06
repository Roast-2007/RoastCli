import { describe, expect, it, vi } from 'vitest';
import { nextFocus } from '../../../src/ui/hive/focus.js';
import { deckFixture, tick } from './fixture.js';
describe('Hive completion and panel keyboard routing', () => {
  it('cycles forward and backward while skipping absent signals', () => {
    expect(nextFocus('input', true, true)).toBe('signals');
    expect(nextFocus('input', false, true)).toBe('mission');
    expect(nextFocus('signals', true, true)).toBe('mission');
    expect(nextFocus('mission', false, true)).toBe('colony');
  });
  it('keeps Tab in the editor with no candidate and completes a command with a candidate', async () => {
    const f = await deckFixture();
    try {
      await f.send('draft'); await f.send('\t'); await f.send('m');
      expect(f.draft.state?.lines.join('')).toBe('draftm');
      await f.send('\x15'); await f.send('/sta'); await f.send('\t');
      expect(f.draft.state?.lines.join('')).toBe('/status ');
      const mode = vi.spyOn(f.controller, 'cycleMode');
      await f.send('\x1b[Z'); expect(mode).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });
  it('handles F6, reverse F6 and panel Tab separately from permission mode', async () => {
    const f = await deckFixture();
    try {
      const root = f.store.getState().meta.swarm[0]!;
      f.store.setMeta({ swarm: [root, { ...root, id: 'w1', role: 'worker', depth: 1, parentId: 'main', state: 'done', brief: 'task' }] }); await tick();
      const mode = vi.spyOn(f.controller, 'cycleMode');
      await f.send('\x1b[17~'); await f.send('j'); expect(f.store.getState().focus).toBe('w1');
      await f.send('\t'); await f.send('\x1b[Z'); await f.send('k'); expect(f.store.getState().focus).toBe('main');
      expect(mode).not.toHaveBeenCalled();
      await f.send('\x1b[17;2~'); await f.send('mpxdi123'); expect(f.draft.state?.lines.join('')).toBe('mpxdi123');
      await f.send('\x1b[57369u'); await f.send('z'); expect(f.draft.state?.lines.join('')).toBe('mpxdi123z');
      await f.send('\x1b[17~'); await f.send('i'); await f.send('a'); expect(f.draft.state?.lines.join('')).toBe('mpxdi123za');
    } finally { await f.close(); }
  });
});
