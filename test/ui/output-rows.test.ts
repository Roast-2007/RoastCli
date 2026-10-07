import { describe, expect, it } from 'vitest';
import { createOutputRows } from '../../src/ui/output-rows.js';
import { latestTool, toolsOf } from '../../src/ui/tool-nav.js';
import { emptyAgentView, type ToolView } from '../../src/ui/store/reducer.js';
import { displayWidth } from '../../src/core/text-width.js';
const tool = (callId: string, more: Partial<ToolView> = {}): ToolView => ({
  callId,
  name: 'read',
  args: { path: callId },
  status: 'done',
  preview: '',
  durationMs: 1,
  ...more,
});
describe('共享输出行与工具导航', () => {
  it('renders markdown styles and recalculates wrapping and compact previews by width', () => {
    const view = emptyAgentView();
    view.items = [
      { id: 1, kind: 'markdown', text: '# 标题\n\n**加粗** 与 `代码`\n\n一段很长的中文正文，一段很长的中文正文。' },
      {
        id: 2,
        kind: 'tool',
        tool: tool('edit', {
          name: 'edit',
          metadata: { diff: { added: 1, removed: 1, hunks: [{ oldStart: 1, newStart: 1, lines: ['-old', '+new'] }] } },
        }),
      },
      { id: 3, kind: 'tool-group', tools: [tool('a'), tool('b')] },
      { id: 4, kind: 'tool', tool: tool('err', { status: 'error', preview: 'bad\nsecond\nthird' }) },
    ];
    view.tools = [tool('live', { status: 'running', live: 'one\ntwo\nthree\nfour\nfive' })];
    const output = createOutputRows(),
      wide = output(view, 60, false),
      compact = output(view, 60, false, 0, 0, true);
    const text = (rows: typeof wide) => rows.map((row) => row.spans.map((part) => part.text).join('')).join('\n');
    expect(text(wide)).not.toMatch(/\*\*|# 标题/);
    expect(wide.some((row) => row.spans.some((span) => span.bold))).toBe(true);
    expect(wide.filter((row) => row.callId).map((row) => row.callId)).toEqual(expect.arrayContaining(['edit', 'a', 'b', 'err', 'live']));
    expect(text(compact)).toContain('+1 -1');
    expect(text(compact)).not.toContain('-old');
    expect(text(compact)).not.toContain('+new');
    expect(compact.filter((row) => row.callId === 'live')).toHaveLength(3);
    expect(compact.filter((row) => row.callId === 'err')).toHaveLength(2);
    const narrow = output(view, 10, false);
    expect(narrow.length).toBeGreaterThan(wide.length);
    expect(narrow.every((row) => displayWidth(row.spans.map((span) => span.text).join('')) <= 10)).toBe(true);
    expect(output(view, 10, false)[0]).toBe(narrow[0]);
  });
  it('deduplicates grouped and active calls while preserving order and latest status', () => {
    const view = emptyAgentView();
    view.items = [
      { id: 1, kind: 'tool-group', tools: [tool('a'), tool('b')] },
      { id: 2, kind: 'tool', tool: tool('a', { preview: 'final' }) },
    ];
    view.tools = [tool('c', { status: 'running' })];
    expect(toolsOf(view).map((tool) => tool.callId)).toEqual(['a', 'b', 'c']);
    expect(toolsOf(view)[0]?.preview).toBe('final');
    expect(latestTool(view)?.callId).toBe('c');
    view.tools = [];
    expect(latestTool(view)?.callId).toBe('a');
  });
});
