import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appendHistory, historyPath, loadHistory } from '../../src/ui/input/history.js';
import { tempWorkspace } from '../fixtures/workspace.js';

describe('bounded persisted input history', () => {
  it('repairs corrupt lines and retains only the newest 500 records on disk', () => {
    const cwd = tempWorkspace().dir;
    appendHistory(cwd, 'seed');
    writeFileSync(historyPath(cwd), ['broken', '{}', ...Array.from({ length: 550 }, (_, i) => JSON.stringify(`entry-${i}`))].join('\n'));
    appendHistory(cwd, 'last');
    expect(loadHistory(cwd)).toHaveLength(500);
    expect(loadHistory(cwd)[0]).toBe('entry-51');
    expect(loadHistory(cwd).at(-1)).toBe('last');
    expect(readFileSync(historyPath(cwd), 'utf8').trim().split('\n')).toHaveLength(500);
  });
});
