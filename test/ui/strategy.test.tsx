import { render } from 'ink-testing-library';
import { expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createSession } from '../../src/agent/session.js';
import { ConfigSchema } from '../../src/core/config.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { StrategyPanel } from '../../src/ui/components/StrategyPanel.js';
import { createUiStore } from '../../src/ui/store/store.js';
import { runSlash } from '../../src/ui/commands.js';
import { loadStrategies, strategyUsesN } from '../../src/swarm/strategies.js';
import { strategyLabel } from '../../src/ui/strategy.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));
it('recognizes n in builtins and custom YAML, including whitespace placeholders', () => {
  const ws = tempWorkspace(),
    dir = path.join(ws.dir, 'strategies');
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'by-n.yaml'), 'name: by-n\nn: 6\nplaybook: Do the work\n');
  writeFileSync(path.join(dir, 'by-prompt.yaml'), 'name: by-prompt\nplaybook: Use {{ n }} agents\n');
  const strategies = loadStrategies('', ws.dir);
  for (const name of ['fanout', 'best-of-n', 'research', 'by-n', 'by-prompt']) expect(strategyUsesN(strategies.get(name)!)).toBe(true);
  for (const name of ['auto', 'critique']) expect(strategyUsesN(strategies.get(name)!)).toBe(false);
});
it('shows the two-step panel, preserves current n and applies non-n strategies directly', async () => {
  const store = createUiStore();
  store.setMeta({ strategy: 'best-of-n', n: 5, overlay: 'strategy', strategyStep: 'best-of-n' });
  const strategies = loadStrategies('', '');
  strategies.set('custom', { name: 'custom', source: 'user', description: '{{n}} 个任务', playbook: 'tasks', n: 6 });
  const ui = render(<StrategyPanel store={store} strategies={strategies} height={18} />);
  try {
    await tick();
    expect(ui.lastFrame()).toContain('并行数');
    expect(ui.lastFrame()).toContain('5 · 5 个 worker');
    ui.stdin.write('\r');
    await tick();
    expect(store.getState().meta).toMatchObject({ strategy: 'best-of-n', n: 5, overlay: null, toast: { text: '策略 best-of-n · n 5' } });
  } finally {
    ui.unmount();
  }
  store.setMeta({ overlay: 'strategy', strategyStep: 'custom' });
  const custom = render(<StrategyPanel store={store} strategies={strategies} height={18} />);
  try {
    await tick();
    custom.stdin.write('\r');
    await tick();
    expect(store.getState().meta.n).toBe(6);
  } finally {
    custom.unmount();
  }
  store.setMeta({ overlay: 'strategy', strategyStep: undefined, strategy: 'critique' });
  const simple = render(<StrategyPanel store={store} strategies={strategies} height={18} />);
  try {
    await tick();
    simple.stdin.write('\r');
    await tick();
    expect(store.getState().meta).toMatchObject({ strategy: 'critique', n: 6, overlay: null, toast: { text: '策略 critique' } });
  } finally {
    simple.unmount();
  }
});
it('validates text commands without changing state on errors and opens named n selection', async () => {
  const ws = tempWorkspace(),
    providers = new ProviderRegistry();
  providers.register('p', new ScriptedProvider([]));
  const session = await createSession({
    cwd: ws.dir,
    providers,
    config: ConfigSchema.parse({
      providers: { p: { driver: 'openai-compat', auth: 'none' } },
      default: 'p:m',
      swarm: { worktrees: false },
    }),
  });
  const store = createUiStore();
  store.setMeta({ strategy: 'auto', n: 3 });
  const ctx = { session, store, exit() {}, openOverlay: (overlay: 'strategy') => store.setMeta({ overlay }) };
  try {
    await runSlash('/strategy best-of-n 5', ctx);
    expect(store.getState().meta).toMatchObject({ strategy: 'best-of-n', n: 5 });
    expect(strategyLabel(session, store.getState().meta)).toBe('策略 best-of-n · n 5');
    await runSlash('/strategy 4', ctx);
    expect(store.getState().meta.n).toBe(4);
    await runSlash('/strategy critique 7', ctx);
    expect(store.getState().meta).toMatchObject({ strategy: 'critique', n: 7 });
    expect(strategyLabel(session, store.getState().meta)).toBe('策略 critique');
    for (const command of ['/strategy best-of-n 9', '/strategy 1', '/strategy unknown', '/strategy auto NaN']) await runSlash(command, ctx);
    expect(store.getState().meta).toMatchObject({ strategy: 'critique', n: 7 });
    expect(
      store
        .getState()
        .agents.main!.items.map((item) => ('text' in item ? item.text : ''))
        .join('\n'),
    ).toContain('未知策略');
    await runSlash('/strategy best-of-n', ctx);
    expect(store.getState().meta).toMatchObject({ strategyStep: 'best-of-n', overlay: 'strategy', strategy: 'critique', n: 7 });
  } finally {
    await session.shutdown();
  }
});
