import { describe, expect, it } from 'vitest';
import { executeTool } from '../../src/tools/executor.js';
import { writeTool } from '../../src/tools/write/index.js';
import { readTool } from '../../src/tools/read/index.js';
import { LeaseManager, leaseHook } from '../../src/swarm/lease.js';
import { makeCtx, textOf } from '../tools/helpers.js';
import { tempWorkspace } from '../fixtures/workspace.js';

describe('文件租约锁', () => {
  it('同一文件被另一存活 agent 持有时拒绝写入；持有者结束后可写', async () => {
    const ws = tempWorkspace('roast-lease-');
    const alive = new Set(['w1', 'w2']);
    const leases = new LeaseManager((id) => alive.has(id));
    const hooks = { preExecute: [leaseHook(leases)], postExecute: [] };
    const ctx1 = { ...makeCtx(ws.dir), agentId: 'w1' };
    const ctx2 = { ...makeCtx(ws.dir), agentId: 'w2' };

    expect((await executeTool(writeTool, { path: 'a.txt', content: '1' }, ctx1, hooks)).isError).toBeFalsy();
    const denied = await executeTool(writeTool, { path: 'a.txt', content: '2' }, ctx2, hooks);
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain('正被 w1 修改');
    // 读不受影响
    expect((await executeTool(readTool, { path: 'a.txt' }, ctx2, hooks)).isError).toBeFalsy();

    alive.delete('w1');
    await executeTool(readTool, { path: 'a.txt' }, ctx2, hooks);
    expect((await executeTool(writeTool, { path: 'a.txt', content: '2' }, ctx2, hooks)).isError).toBeFalsy();
    expect(leases.heldBy('w2')).toHaveLength(1);
    leases.releaseAll('w2');
    expect(leases.heldBy('w2')).toEqual([]);
  });
});
