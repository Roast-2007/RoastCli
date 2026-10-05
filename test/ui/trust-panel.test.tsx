import { render, cleanup } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isProjectTrusted, trustProject, trustState } from '../../src/core/config.js';
import { TrustPanel } from '../../src/ui/components/TrustPanel.js';
import { tempWorkspace } from '../fixtures/workspace.js';

vi.mock('ink', async (original) => ({ ...await original<typeof import('ink')>(), useWindowSize: () => ({ columns: 40, rows: 10 }) }));
const saved = process.env['ROAST_HOME'];
let ws: ReturnType<typeof tempWorkspace>;
const tick = () => new Promise((resolve) => setTimeout(resolve, 40));
const frame = (view: { lastFrame(): string | undefined }, text: string) => vi.waitFor(() => expect(view.lastFrame()).toContain(text), { timeout: 3000 });
beforeEach(() => { process.env['ROAST_HOME'] = tempWorkspace().dir; ws = tempWorkspace(); });
afterEach(() => { cleanup(); if (saved === undefined) delete process.env['ROAST_HOME']; else process.env['ROAST_HOME'] = saved; });

describe('startup trust panel', () => {
  it('trusts the folder with Enter and fits a 40×10 terminal', async () => {
    const onExit = vi.fn();
    const view = render(<TrustPanel cwd={ws.dir} onExit={onExit} />);
    await frame(view, '信任此文件夹并继续');
    view.stdin.write('\r'); await tick();
    expect(onExit).toHaveBeenCalledWith(true);
    expect(isProjectTrusted(ws.dir)).toBe(true);
    expect(view.frames.every((output) => output.split('\n').length <= 9)).toBe(true);
  });

  it('shows full project details before approval and leaves no trust record on cancellation', async () => {
    ws.file('.roast/config.json', JSON.stringify({ hooks: { Stop: [{ command: 'echo review-hook' }] } }));
    const onExit = vi.fn();
    const view = render(<TrustPanel cwd={ws.dir} onExit={onExit} />);
    await frame(view, '信任此文件夹并继续');
    view.stdin.write('\x1b[B'); await tick(); view.stdin.write('\r');
    await frame(view, '文件夹信任 · 项目配置');
    view.stdin.write('\x1b[F'); await frame(view, 'review-hook');
    expect(isProjectTrusted(ws.dir)).toBe(false);
    view.stdin.write('\x1b'); await frame(view, '信任此文件夹并继续');
    view.stdin.write('\x1b'); await tick();
    expect(onExit).toHaveBeenCalledWith(false);
    expect(isProjectTrusted(ws.dir)).toBe(false);
  });

  it('explains that changed project configuration needs a new confirmation', async () => {
    trustProject(ws.dir);
    ws.file('.roast/config.json', JSON.stringify({ mcp: { servers: { newServer: { command: 'unused' } } } }));
    const view = render(<TrustPanel cwd={ws.dir} onExit={() => {}} />);
    await frame(view, '相关配置已变化');
    view.stdin.write('\x1b'); await tick();
    expect(trustState(ws.dir)).toBe('changed');
  });
});
