import { displayWidth, truncateDisplay } from '../../core/text-width.js';
import { terminalText } from '../../core/terminal-text.js';
import type { TokenUsage } from '../../core/types.js';
export const compactNumber = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
export function cachePercent(usage: TokenUsage): number | null {
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  return input > 0 ? Math.round(usage.cacheRead / input * 100) : null;
}
/** Remove optional facts in the specified order, retaining activity and help. */
export function statusText(width: number, capsuleWidth: number, p: { percent: number; total: TokenUsage; cost?: string | null; branch?: string | null; activity: string; separator: string; up: string; down: string; branchGlyph: string; ascii?: boolean }) {
  const sep = ` ${p.separator} `, cache = cachePercent(p.total);
  const optional = [p.cost === null ? '费用未知' : p.cost ?? '', `${p.up}${compactNumber(p.total.input + p.total.cacheRead + p.total.cacheWrite)} ${p.down}${compactNumber(p.total.output)}`, cache === null ? '' : `缓存 ${cache}%`, p.branch ? `${p.branchGlyph} ${terminalText(p.branch)}` : ''];
  const right = `${p.activity ? `${p.activity} ` : ''}? 帮助`;
  const percent = Math.max(0, Math.min(100, Math.round(p.percent))), filled = Math.round(percent * 6 / 100);
  const base = `ctx ${width >= 70 ? `${(p.ascii ? '#' : '▰').repeat(filled)}${(p.ascii ? '-' : '▱').repeat(6 - filled)} ` : ''}${percent}%`;
  const text = () => [base, ...optional.filter(Boolean)].join(sep);
  for (const index of [3, 2, 1, 0]) { if (displayWidth(text() + right) + capsuleWidth + 2 <= width) break; optional[index] = ''; }
  const budget = Math.max(0, width - capsuleWidth - displayWidth(right) - 1);
  return { left: truncateDisplay(text(), budget), right: truncateDisplay(right, Math.max(0, width - capsuleWidth - 1)) };
}
