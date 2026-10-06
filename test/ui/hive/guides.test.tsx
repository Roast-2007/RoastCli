import { describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../../../src/core/config.js';
import { fitKeyHints, keyHints } from '../../../src/ui/components/KeyBar.js';
import { deckHelpText } from '../../../src/ui/hive/DeckHelp.js';
import { displayWidth } from '../../../src/core/text-width.js';
import { diffStateKey } from '../../../src/ui/hive/diffs.js';
import { deckFixture, tick } from './fixture.js';
const press = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M`;
async function clickHint(f: Awaited<ReturnType<typeof deckFixture>>, text: string) {
  await vi.waitFor(() => expect(f.tty.frame()).toContain(text));
  const lines = f.tty.frame().split('\n'), y = lines.length - 3;
  const line = lines[y]!, index = line.indexOf(text);
  expect(index).toBeGreaterThanOrEqual(0);
  await f.send(press(displayWidth(line.slice(0, index)), y));
}
describe('Hive guides, shared key bar and help', () => {
  it('keeps only a complete priority prefix and removes unsafe approval actions', () => {
    const items = keyHints({ screen: 'hive' });
    expect(fitKeyHints(items, 11)).toEqual([]);
    expect(fitKeyHints(items, 14).map(item => item.action)).toEqual(['submit']);
    expect(fitKeyHints(items, 200).map(item => item.action)).toEqual(['submit', 'mention', 'commands', 'focus-next', 'switch', 'help']);
    const forced = keyHints({ screen: 'hive', card: { kind: 'permission', id: 'p', agentId: 'main', tool: 'bash', title: 'danger', reason: 'danger', forced: true, suggestedRule: 'bash:*' } });
    expect(forced.map(item => item.action)).toEqual(['approve:0', 'approve:1', 'approval-next']);
    expect(forced.map(item => item.label)).not.toContain('本项目');
    const base = { providers: { p: { driver: 'openai-compat', auth: 'none' } }, default: 'p:m' };
    expect(ConfigSchema.parse(base).ui).toBeUndefined();
    expect(ConfigSchema.parse({ ...base, ui: {} }).ui?.hints).toBe('full');
    expect(ConfigSchema.safeParse({ ...base, ui: { hints: 'bad' } }).success).toBe(false);
  });
  it.each(['full', 'compact', 'off'] as const)('shows only the configured guidance at %s', async hints => {
    const f = await deckFixture(160, 40, { hints });
    try {
      await vi.waitFor(() => expect(f.tty.frame()).toContain('输入目标'));
      const frame = f.tty.frame();
      expect(frame.includes('Enter 发起任务')).toBe(hints !== 'off');
      expect(frame.includes('在下方写下目标')).toBe(hints === 'full');
      expect(frame.includes('派出的成员会')).toBe(hints === 'full');
      expect(frame.includes('审批请求、成员消息')).toBe(hints === 'full');
      await f.send('\x1b[17~'); expect(f.tty.frame()).toMatch(/[>▸] 蜂群/);
      await f.send('\t'); await f.send('2'); expect(f.tty.frame()).toContain('queen queen');
      expect(f.tty.frame().includes('选中的成员还没有输出')).toBe(hints === 'full');
    } finally { await f.close(); }
  });
  it('hides the key bar below 14 viewport rows and omits lower guide lines first', async () => {
    const f = await deckFixture(80, 14);
    try {
      expect(f.tty.frame()).not.toContain('点击/F6');
      expect(f.tty.frame()).toContain('在下方写下目标');
      expect(f.tty.frame()).not.toContain('/strategy 更换');
    } finally { await f.close(); }
  });
  it('clicks hints without losing the draft and submits through command completion', async () => {
    const f = await deckFixture(160, 40);
    try {
      const submit = vi.spyOn(f.controller, 'submit');
      await clickHint(f, '/ 命令'); expect(f.draft.state?.lines).toEqual(['/']);
      await f.send('strat'); await clickHint(f, 'Enter 发起任务');
      expect(submit).toHaveBeenCalledWith('/strategy', '/strategy'); expect(f.draft.state?.lines).toEqual(['']);
      expect(f.store.getState().meta.overlay).toBe('strategy');
      await f.send('\x1b'); await f.send('未发送草稿');
      await clickHint(f, '点击/F6 面板'); expect(f.tty.frame()).toContain('Space 菜单');
      await clickHint(f, 'Space 菜单'); expect(f.tty.frame()).toContain('查看输出');
      await f.send('\x1b'); expect(f.draft.state?.lines).toEqual(['未发送草稿']);
      await clickHint(f, 'Esc 返回输入'); expect(f.tty.frame()).toContain('Enter 发起任务');
    } finally { await f.close(); }
  });
  it('uses visible key bar choices for forced approval with one response', async () => {
    const f = await deckFixture(160, 40);
    try {
      const response = f.session.broker.request({ kind: 'permission', agentId: 'main', tool: 'bash', title: 'dangerous', reason: '高危操作', forced: true, suggestedRule: 'bash:*' }, new AbortController().signal);
      await tick(); expect(f.tty.frame()).not.toContain('本会话');
      const respond = vi.spyOn(f.controller, 'respond');
      const lines = f.tty.frame().split('\n'), y = lines.findIndex(line => line.includes('4 拒绝 (Esc)'));
      await f.send(`\x1b[<4;4;${y + 1}M`); expect(respond).not.toHaveBeenCalled();
      await clickHint(f, '4 拒绝'); expect(await response).toEqual({ kind: 'permission', decision: 'deny' });
      expect(respond).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });
  it('keeps the Queen working-directory diff visible without a worktree', async () => {
    const f = await deckFixture(160, 40);
    try {
      const ui = f.store.getState();
      f.store.setMeta({ diffs: { main: { key: diffStateKey(ui.meta.swarm[0], ui), result: { files: 1, added: 1, removed: 0, stat: 'queen-change.ts | +1', diff: '+queen-existing-diff' } } } });
      await f.send('\x1b[17~'); await f.send('\t'); await f.send('3');
      expect(f.tty.frame()).toContain('+queen-existing-diff');
      expect(f.tty.frame()).not.toContain('选中写代码的成员');
    } finally { await f.close(); }
  });
  it('opens Deck help from click, panel question mark and every F1 sequence', async () => {
    const f = await deckFixture(160, 40);
    try {
      await clickHint(f, '? 帮助'); expect(f.tty.frame()).toContain('帮助 · HIVE Deck');
      expect(f.tty.frame()).toContain('Tab 补全'); expect(f.tty.frame()).toContain('Shift 拖动');
      await f.send('\x1b'); await f.send('\x1b[17~'); await f.send('?'); expect(f.store.getState().meta.overlay).toBe('help');
      for (const key of ['\x1bOP', '\x1b[11~', '\x1b[57364u']) { await f.send('\x1b'); await f.send(key); expect(f.store.getState().meta.overlay).toBe('help'); }
      expect(f.draft.state?.lines).toEqual(['']);
      expect(deckHelpText(50, true).split('\n')[0]).toBe('蜂群 | 任务区 | 信号');
      expect(deckHelpText(80, true)).toContain('+ 蜂群 +');
      expect(deckHelpText(80, false)).toContain('4 信号');
    } finally { await f.close(); }
  });
});
