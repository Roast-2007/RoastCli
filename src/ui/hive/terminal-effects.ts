import path from 'node:path';
import type { RoastConfig } from '../../core/config.js';
import { terminalText } from '../../core/terminal-text.js';
import type { UiStore, UiStoreState } from '../store/store.js';
import { missionPhase } from './phase.js';
export interface TerminalOutput { isTTY?: boolean; write(text: string): unknown }
const clean = (text: string) => terminalText(text).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
export function notificationSequence(mode: 'auto' | 'bell' | 'off', env: NodeJS.ProcessEnv, text: string): string {
  if (mode === 'off') return '';
  if (mode === 'bell') return '\x07';
  return env['WT_SESSION'] || ['iTerm.app', 'WezTerm'].includes(env['TERM_PROGRAM'] ?? '') || env['KITTY_WINDOW_ID'] ? `\x1b]9;${clean(text)}\x07` : '';
}
/** One lifecycle per interactive renderer, including screen and session handoffs. */
export function terminalEffects(output: TerminalOutput, cwd: string, ui: RoastConfig['ui'], env = process.env, now = Date.now) {
  let off = () => {}, timer: ReturnType<typeof setTimeout> | undefined, lastTitleAt = -Infinity, lastTitle = '', desired = '', running = false, started = 0, permissions = new Set<string>();
  const notify = (text: string) => { if (output.isTTY) { const sequence = notificationSequence(ui?.notify ?? 'auto', env, text); if (sequence) output.write(sequence); } };
  const title = () => { if (!output.isTTY || ui?.title === false || desired === lastTitle) return; lastTitle = desired; lastTitleAt = now(); output.write(`\x1b]2;${clean(desired)}\x07`); };
  const observe = (state: UiStoreState) => {
    if (!output.isTTY) return;
    const active = state.meta.running || state.agents.main!.running;
    if (active && !running) started = now();
    if (!active && running && now() - started >= 20_000) notify('RoastCli：任务已结束');
    running = active;
    const pending = new Set(state.meta.interactions.filter((r) => r.kind === 'permission').map((r) => r.id));
    for (const id of pending) if (!permissions.has(id)) notify('RoastCli：需要你的授权');
    permissions = pending;
    const children = state.meta.swarm.filter((agent) => agent.parentId), live = children.filter((agent) => ['running', 'waiting', 'paused', 'queued'].includes(agent.state)).length;
    desired = `roast · ${path.basename(cwd)}${active ? ` · hive ${missionPhase(state.agents.main!, state.meta.swarm)} ${live}/${children.length}` : ''}`;
    if (ui?.title === false || desired === lastTitle) return;
    if (now() - lastTitleAt >= 1000) { clearTimeout(timer); timer = undefined; title(); }
    else timer ??= setTimeout(() => { timer = undefined; title(); }, Math.max(1, 1000 - (now() - lastTitleAt)));
  };
  return {
    bind(store: UiStore) { off(); permissions = new Set(); running = false; off = store.subscribe(() => observe(store.getState())); observe(store.getState()); },
    dispose() { off(); clearTimeout(timer); if (output.isTTY && ui?.title !== false) output.write('\x1b]2;roast\x07'); },
  };
}
