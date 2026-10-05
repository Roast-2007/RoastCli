import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureFolderTrust } from '../../src/cli/startup.js';
import { isProjectTrusted, trustProject } from '../../src/core/config.js';
import { tempWorkspace } from '../fixtures/workspace.js';

const saved = process.env['ROAST_HOME'];
let ws: ReturnType<typeof tempWorkspace>;
beforeEach(() => { process.env['ROAST_HOME'] = tempWorkspace().dir; ws = tempWorkspace(); });
afterEach(() => { if (saved === undefined) delete process.env['ROAST_HOME']; else process.env['ROAST_HOME'] = saved; });

describe('startup folder trust', () => {
  it('prompts once, remembers approval and prompts again after a sensitive config change', async () => {
    const confirm = vi.fn(async (cwd: string) => { trustProject(cwd); return true; });
    expect(await ensureFolderTrust(ws.dir, true, confirm)).toBe(true);
    expect(isProjectTrusted(ws.dir)).toBe(true);
    expect(await ensureFolderTrust(ws.dir, true, confirm)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    ws.file('.roast/config.json', JSON.stringify({ hooks: { Stop: [{ command: 'changed' }] } }));
    expect(await ensureFolderTrust(ws.dir, true, confirm)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('cancellation prevents startup and leaves the folder untrusted', async () => {
    expect(await ensureFolderTrust(ws.dir, true, async () => false)).toBe(false);
    expect(isProjectTrusted(ws.dir)).toBe(false);
  });

  it('does not prompt or auto-trust a folder in noninteractive mode', async () => {
    const confirm = vi.fn(async () => true);
    expect(await ensureFolderTrust(ws.dir, false, confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(isProjectTrusted(ws.dir)).toBe(false);
  });
});
