/**
 * 文本 spinner hook：不引入 ink-spinner 依赖，用 braille 帧轮播。
 */
import { useCallback, useSyncExternalStore } from 'react';
import { useTerminal } from '../terminal.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ASCII = ['|', '/', '-', '\\'];
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let frame = 0;
const snapshot = () => frame;
const idle = () => 0;
const noop = () => () => {};
function subscribe(listener: () => void) {
  listeners.add(listener);
  timer ??= setInterval(() => { frame++; for (const notify of listeners) notify(); }, 80);
  return () => { listeners.delete(listener); if (!listeners.size) { clearInterval(timer); timer = undefined; } };
}

/** active 时按 80ms 轮播，返回当前帧字符 */
export function useSpinner(active: boolean): string {
  const terminal = useTerminal();
  const animate = active && terminal.motion;
  const value = useSyncExternalStore(useCallback(animate ? subscribe : noop, [animate]), animate ? snapshot : idle);
  const frames = terminal.ascii ? ASCII : FRAMES;
  return frames[value % frames.length]!;
}
