import { render, cleanup } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderWizard } from '../../src/ui/providers/ProviderWizard.js';
import { tempWorkspace } from '../fixtures/workspace.js';
vi.mock('ink', async (original) => ({ ...await original<typeof import('ink')>(), useWindowSize: () => ({ columns: 40, rows: 10 }) }));
afterEach(cleanup);
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
describe('small provider wizard', () => {
  it('always shows the selected connection field and the navigation footer', async () => {
    const before = process.env['ROAST_HOME']; process.env['ROAST_HOME'] = tempWorkspace().dir;
    try {
      const screen = render(<ProviderWizard cwd={tempWorkspace().dir} onExit={() => {}} />);
      await tick();
      screen.stdin.write('\r'); await tick();
      screen.stdin.write('\r'); await tick();
      screen.stdin.write('\t'); await tick();
      screen.stdin.write('\t'); await tick();
      expect(screen.lastFrame()).toContain('模型 ID');
      expect(screen.lastFrame()).toContain('Enter');
      expect(screen.lastFrame()!.split('\n').length).toBeLessThan(10);
      screen.unmount();
    } finally { if (before === undefined) delete process.env['ROAST_HOME']; else process.env['ROAST_HOME'] = before; }
  });
  it('keeps credentials, review pages, validation errors and saved navigation visible', async () => {
    const before = process.env['ROAST_HOME']; process.env['ROAST_HOME'] = tempWorkspace().dir;
    try {
      const screen = render(<ProviderWizard cwd={tempWorkspace().dir} onExit={() => {}} />);
      const press = async (key: string) => { screen.stdin.write(key); await tick(); expect(screen.lastFrame()!.split('\n').length).toBeLessThan(10); };
      await tick(); await press('\r'); await press('\r');
      await press('\r'); await press('\r'); await press('\r');
      expect(screen.lastFrame()).toContain('API Key');
      await press('test-secret'); await press('\t');
      expect(screen.lastFrame()).toContain('Reasoning effort');
      await press('\u001b[C'); expect(screen.lastFrame()).toContain('none');
      await press('\t'); expect(screen.lastFrame()).toContain('设为默认');
      await press('\r'); expect(screen.lastFrame()).toContain('确认并保存');
      expect(screen.lastFrame()).toContain('Enter 保存');
      await press('\u001b[6~'); expect(screen.lastFrame()).toContain('Reasoning effort');
      await press('\u001b[6~'); expect(screen.lastFrame()).toContain('默认模型');
      expect(screen.lastFrame()).not.toContain('test-secret');
      await press('\r'); expect(screen.lastFrame()).toContain('保存成功');
      expect(screen.lastFrame()).toContain('Esc 完成');
      screen.unmount();
    } finally { if (before === undefined) delete process.env['ROAST_HOME']; else process.env['ROAST_HOME'] = before; }
  });
});
