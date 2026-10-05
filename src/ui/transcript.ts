import type { DiffMeta } from '../tools/file-ops.js';
import { terminalText } from '../core/terminal-text.js';
import { argSummary } from './components/ToolCard.js';
import { markdownRows, wrapSpans, type Row, type Span } from './markdown/rows.js';
import type { AgentView, DisplayItem, ToolView } from './store/reducer.js';

const s = (text: string, color?: Span['color'], dim = false): Span => ({ text: terminalText(text), color, dim });
function toolRows(tool: ToolView, width: number, ascii: boolean): Row[] {
  const icon = tool.status === 'done' ? ascii ? '+' : '✓' : tool.status === 'error' ? ascii ? 'x' : '✗' : tool.status === 'interrupted' ? ascii ? '-' : '⊘' : ascii ? '*' : '◌';
  const diff = tool.metadata?.['diff'] as DiffMeta | undefined;
  const rows = wrapSpans([s(`${icon} `, tool.status === 'error' ? 'danger' : tool.status === 'done' ? 'success' : 'accent'), { ...s(tool.name, 'tool'), bold: true }, s(` ${argSummary(tool.name, tool.args)}`), ...(diff ? [s(` +${diff.added} -${diff.removed}`, 'success')] : []), s(tool.status === 'running' ? '' : ` · ${(tool.durationMs / 1000).toFixed(1)}s`, undefined, true)], width);
  if (tool.status === 'error' && tool.preview) rows.push(...wrapSpans([s(tool.preview, 'danger')], width));
  if (tool.status === 'running' && tool.live) for (const line of terminalText(tool.live).split('\n').filter(Boolean).slice(-4)) rows.push(...wrapSpans([s(line, undefined, true)], width));
  if (diff && tool.status === 'done') {
    const lines = diff.hunks.flatMap((h) => h.lines);
    for (const line of lines.slice(0, 24)) rows.push(...wrapSpans([s(`  ${line}`, line.startsWith('+') ? 'success' : line.startsWith('-') ? 'danger' : undefined, line.startsWith(' '))], width));
    if (lines.length > 24 || diff.truncated) rows.push([s('… Ctrl+O 查看完整工具输出', undefined, true)]);
  }
  return rows;
}

export function itemRows(item: DisplayItem, width: number, ascii = false, spacing = 1): Row[] {
  switch (item.kind) {
    case 'user': return [[], ...wrapSpans([{ ...s(`${ascii ? '>' : '›'} ${item.text}`, 'user'), bold: true }], width)];
    case 'markdown': return markdownRows(item.text, width, ascii, spacing);
    case 'reasoning': return wrapSpans([s(`${ascii ? '...' : '💭'} ${item.text.replace(/\s+/g, ' ').slice(0, 200)}`, undefined, true)], width);
    case 'notice': return wrapSpans([s(`${ascii ? '*' : '•'} ${item.text}`, item.tone === 'error' ? 'danger' : item.tone === 'warn' ? 'warn' : item.tone === 'success' ? 'success' : 'info')], width);
    case 'tool': return toolRows(item.tool, width, ascii);
    case 'tool-group': return item.tools.flatMap((tool) => toolRows(tool, width, ascii));
    case 'turn-summary': return wrapSpans([s(`${ascii ? '*' : '✻'} 用时 ${(item.durationMs / 1000).toFixed(1)}s · ${ascii ? '^' : '↑'}${item.usage.input + item.usage.cacheRead} ${ascii ? 'v' : '↓'}${item.usage.output}${item.reason === 'completed' ? '' : item.reason === 'aborted' ? ' · 已中断' : item.reason === 'max-steps' ? ' · 步数上限' : ' · 出错'}`, undefined, true)], width);
  }
}

/** Cache immutable history blocks; only the visible rows become React elements. */
export function createTranscript() {
  let cache = new WeakMap<DisplayItem, Row[]>(), signature = '';
  return (view: AgentView, width: number, ascii: boolean, spacing = 1, after = 0): Row[] => {
    const next = `${width}:${ascii}:${spacing}`;
    if (signature !== next) { signature = next; cache = new WeakMap(); }
    const rows: Row[] = [];
    for (const item of view.items) {
      if (item.id <= after) continue;
      let block = cache.get(item);
      if (!block) { block = itemRows(item, width, ascii, spacing); cache.set(item, block); }
      for (const row of block) rows.push(row);
    }
    if (view.reasoning) rows.push(...wrapSpans([s(`思考中… ${view.reasoning.length} 字`, 'accent')], width));
    if (view.pending) rows.push(...markdownRows(view.pending, width, ascii, spacing));
    for (const tool of view.tools) rows.push(...toolRows(tool, width, ascii));
    if (view.running && !view.reasoning && !view.pending && !view.tools.length) rows.push([s('思考中…', 'accent')]);
    return rows;
  };
}
