import type { DiffMeta } from '../tools/file-ops.js';
import { terminalText } from '../core/terminal-text.js';
import { argSummary } from './components/ToolCard.js';
import { markdownRows, wrapSpans, type Span } from './markdown/rows.js';
import type { AgentView, DisplayItem, ToolView } from './store/reducer.js';

export interface OutputRow {
  spans: Span[];
  callId?: string;
}
const s = (text: string, color?: Span['color'], dim = false): Span => ({ text: terminalText(text), color, dim });
const output = (rows: Span[][], callId?: string): OutputRow[] =>
  rows.map((spans) => ({ spans: spans.map((part) => ({ ...part, text: terminalText(part.text) })), ...(callId ? { callId } : {}) }));
function toolRows(tool: ToolView, width: number, ascii: boolean, compact: boolean): OutputRow[] {
  const icon =
    tool.status === 'done'
      ? ascii
        ? '+'
        : '✓'
      : tool.status === 'error'
        ? ascii
          ? 'x'
          : '✗'
        : tool.status === 'interrupted'
          ? ascii
            ? '-'
            : '⊘'
          : ascii
            ? '*'
            : '◌';
  const diff = tool.metadata?.['diff'] as DiffMeta | undefined;
  const rows = wrapSpans(
    [
      s(`${icon} `, tool.status === 'error' ? 'danger' : tool.status === 'done' ? 'success' : 'accent'),
      { ...s(tool.name, 'tool'), bold: true },
      s(` ${argSummary(tool.name, tool.args)}`),
      ...(diff ? [s(` +${diff.added} -${diff.removed}`, 'success')] : []),
      s(tool.status === 'running' ? '' : ` · ${(tool.durationMs / 1000).toFixed(1)}s`, undefined, true),
    ],
    width,
  );
  if (tool.status === 'error' && tool.preview) {
    const error = wrapSpans([s(tool.preview, 'danger')], width);
    rows.push(...(compact ? error.slice(0, 1) : error));
  }
  if (tool.status === 'running' && tool.live) {
    const live = terminalText(tool.live)
      .split('\n')
      .filter(Boolean)
      .slice(-4)
      .flatMap((line) => wrapSpans([s(line, undefined, true)], width));
    rows.push(...(compact ? live.slice(-2) : live));
  }
  if (!compact && diff && tool.status === 'done') {
    const lines = diff.hunks.flatMap((h) => h.lines);
    for (const line of lines.slice(0, 24))
      rows.push(
        ...wrapSpans(
          [s(`  ${line}`, line.startsWith('+') ? 'success' : line.startsWith('-') ? 'danger' : undefined, line.startsWith(' '))],
          width,
        ),
      );
    if (lines.length > 24 || diff.truncated) rows.push([s('… Ctrl+O 查看完整工具输出', undefined, true)]);
  }
  return output(rows, tool.callId);
}
export function itemOutputRows(item: DisplayItem, width: number, ascii = false, spacing = 1, compact = false): OutputRow[] {
  switch (item.kind) {
    case 'mission':
      return output(
        wrapSpans(
          [{ ...s(`${ascii ? '*' : '⬡'} 任务 #${item.missionId.slice(1)} · ${item.strategy} · ${item.goal}`, 'user'), bold: true }],
          width,
        ),
      );
    case 'user':
      return output([[], ...wrapSpans([{ ...s(`${ascii ? '>' : '›'} ${item.text}`, 'user'), bold: true }], width)]);
    case 'markdown':
      return [
        ...output(markdownRows(item.text, width, ascii, compact ? 0 : spacing)),
        ...(item.partial ? output(wrapSpans([s('（已中断，未发送给模型）', undefined, true)], width)) : []),
      ];
    case 'reasoning':
      return output(wrapSpans([s(`${ascii ? '...' : '💭'} ${item.text.replace(/\s+/g, ' ').slice(0, 200)}`, undefined, true)], width));
    case 'notice':
      return item.quiet
        ? []
        : output(
            wrapSpans(
              [
                s(
                  `${ascii ? '*' : '•'} ${item.text}`,
                  item.tone === 'error' ? 'danger' : item.tone === 'warn' ? 'warn' : item.tone === 'success' ? 'success' : 'info',
                ),
              ],
              width,
            ),
          );
    case 'tool':
      return toolRows(item.tool, width, ascii, compact);
    case 'tool-group':
      return item.tools.flatMap((tool) => toolRows(tool, width, ascii, compact));
    case 'turn-summary':
      return output(
        wrapSpans(
          [
            s(
              `${ascii ? '*' : '✻'} 用时 ${(item.durationMs / 1000).toFixed(1)}s · ${ascii ? '^' : '↑'}${item.usage.input + item.usage.cacheRead} ${ascii ? 'v' : '↓'}${item.usage.output}${item.reason === 'completed' ? '' : item.reason === 'aborted' ? ' · 已中断' : item.reason === 'max-steps' ? ' · 步数上限' : ' · 出错'}`,
              undefined,
              true,
            ),
          ],
          width,
        ),
      );
  }
}
/** 不可变条目按 WeakMap 缓存；换宽度或切换排版时重算。 */
export function createOutputRows() {
  let cache = new WeakMap<DisplayItem, OutputRow[]>(),
    signature = '';
  return (view: AgentView, width: number, ascii: boolean, spacing = 1, after = 0, compact = false): OutputRow[] => {
    const next = `${width}:${ascii}:${spacing}:${compact}`;
    if (signature !== next) {
      signature = next;
      cache = new WeakMap();
    }
    const rows: OutputRow[] = [];
    for (const item of view.items) {
      if (item.id <= after) continue;
      let block = cache.get(item);
      if (!block) {
        block = itemOutputRows(item, width, ascii, spacing, compact);
        cache.set(item, block);
      }
      rows.push(...block);
    }
    if (view.reasoning) rows.push(...output(wrapSpans([s(`思考中… ${view.reasoning.length} 字`, 'accent')], width)));
    if (view.pending) rows.push(...output(markdownRows(view.pending, width, ascii, compact ? 0 : spacing)));
    for (const tool of view.tools) rows.push(...toolRows(tool, width, ascii, compact));
    if (view.running && !view.reasoning && !view.pending && !view.tools.length) rows.push({ spans: [s('思考中…', 'accent')] });
    return rows;
  };
}
export function outputPadding(columns: number, configured?: number): number {
  return Math.min(configured ?? (columns >= 60 ? 2 : columns >= 30 ? 1 : 0), Math.max(0, Math.floor((columns - 12) / 2)));
}
