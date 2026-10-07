import { render } from 'ink-testing-library';
import { expect, it } from 'vitest';
import { ToolDetail, toolDetailRows } from '../../src/ui/components/ToolDetail.js';
import type { ToolView } from '../../src/ui/store/reducer.js';
const tick = () => new Promise((resolve) => setTimeout(resolve, 40));
const tool = (callId: string, more: Partial<ToolView> = {}): ToolView => ({
  callId,
  name: 'bash',
  args: { command: 'echo first\necho second' },
  status: 'done',
  preview: '',
  output: 'result',
  durationMs: 100,
  ...more,
});
it('switches tools, resets scrolling and resolves a running call to its final result', async () => {
  const tools = [tool('early'), tool('live', { status: 'running', live: 'live tail' })];
  const ui = render(<ToolDetail tools={tools} callId="early" maxLines={16} active />);
  try {
    await tick();
    expect(ui.lastFrame()).toContain('工具 1/2');
    expect(ui.lastFrame()).toContain('echo first');
    expect(ui.lastFrame()).toContain('echo second');
    ui.stdin.write('\x1b[C');
    await tick();
    expect(ui.lastFrame()).toContain('工具 2/2');
    expect(ui.lastFrame()).toContain('live tail');
    ui.rerender(<ToolDetail tools={[tools[0]!, tool('live', { output: 'final result' })]} callId="early" maxLines={16} active />);
    await tick();
    expect(ui.lastFrame()).toContain('final result');
    expect(ui.lastFrame()).not.toContain('live tail');
    ui.stdin.write('[');
    await tick();
    expect(ui.lastFrame()).toContain('工具 1/2');
    expect(ui.lastFrame()).toContain('行 1');
  } finally {
    ui.unmount();
  }
});
it('shows complete numbered diffs, JSON args and danger output without terminal controls', () => {
  const diff = {
    added: 40,
    removed: 1,
    truncated: true,
    hunks: [{ oldStart: 7, newStart: 9, lines: ['-old', ...Array.from({ length: 40 }, (_, i) => `+line-${i}`)] }],
  };
  const rows = toolDetailRows(
    tool('diff', {
      name: 'custom',
      args: { query: '中文', options: { limit: 10 } },
      status: 'error',
      output: '\x1b]0;evil\x07bad\x1b[2J\x00',
      metadata: { diff },
    }),
    100,
  );
  const text = rows
    .flatMap((row) => row.spans)
    .map((span) => span.text)
    .join('\n');
  expect(text).toContain('"limit": 10');
  expect(text).toContain('   7 - old');
  expect(text).toContain('  48 + line-39');
  expect(text).toContain('diff 元数据已截断');
  expect(text).not.toContain('evil');
  expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f]/);
  expect(rows.at(-1)?.spans[0]?.color).toBe('danger');
});
