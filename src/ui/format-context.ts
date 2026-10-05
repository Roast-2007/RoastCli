/**
 * /context 的文本渲染：占用量规 + 分类明细 + 折叠/压缩状态（纯函数，M4 换成彩色组件前先用文本）。
 */
import type { ContextStats } from '../context/controller.js';

const BAR_WIDTH = 20;
const fmt = (n: number) => n.toLocaleString('en-US');

export function gauge(percent: number, width = BAR_WIDTH): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

export function formatContextStats(s: ContextStats): string {
  const rows: [string, number, string?][] = [
    ['系统与工具', s.breakdown.overhead],
    ['用户消息', s.breakdown.user],
    ['助手消息', s.breakdown.assistant],
    ['工具结果', s.breakdown.toolResults, s.elidedCount ? `已折叠 ${s.elidedCount} 项，可 recall` : undefined],
    ['压缩摘要', s.breakdown.summary, s.compactedUpTo !== null ? `已压缩前 ${s.compactedUpTo} 条消息` : undefined],
  ];
  const width = Math.max(...rows.map(([, n]) => fmt(n).length));
  const lines = rows.map(([label, n, note]) => `  ${label.padEnd(6, '　')} ${fmt(n).padStart(width)}${note ? `（${note}）` : ''}`);
  const meta = [`校准 ×${s.calibration}`, s.anchored ? '已用真实用量锚定' : '估算值'].join('，');
  const largest = s.largest.length
    ? [
        '最大的工具结果（/context pin|unpin|drop <id>）：',
        ...s.largest.map((x) => `  ${x.pinned ? '📌' : x.elided ? '◌' : '·'} ${x.id}  ${x.name}${x.path ? ` ${x.path}` : ''}  ${fmt(x.tokens)}${x.elided ? '（已折叠）' : ''}`),
      ]
    : [];
  const cache = s.cache ? [`缓存命中 ${(s.cache.hitRate * 100).toFixed(1)}% · ${fmt(s.cache.read)} / ${fmt(s.cache.input)} input tokens · ${s.cache.requests} 次请求 · ${s.cache.prefixChanges} 次前缀调整`] : [];
  return [`上下文 ${s.percent}%（约 ${fmt(s.estimated)} / ${fmt(s.window)} tokens，${meta}）`, gauge(s.percent), ...cache, ...lines, ...largest].join('\n');
}
