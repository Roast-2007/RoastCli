import { describe, expect, it } from 'vitest';
import { markdownRows, wrapSpans } from '../../src/ui/markdown/rows.js';
import { createTranscript } from '../../src/ui/transcript.js';
import { emptyAgentView, pushItems } from '../../src/ui/store/reducer.js';
import { displayWidth } from '../../src/core/text-width.js';
import { fullscreenLayout } from '../../src/ui/layout.js';

const text = (rows: ReturnType<typeof markdownRows>) => rows.map((row) => row.map((s) => s.text).join('')).join('\n');
describe('fullscreen transcript', () => {
  it('retains complete multiline messages, notices and plans instead of first-line summaries', () => {
    const view = pushItems(emptyAgentView(), { kind: 'user', text: 'first\nsecond' }, { kind: 'notice', tone: 'info', text: 'notice\nlast detail' }, { kind: 'markdown', text: '# Plan\n\n' + Array.from({ length: 100 }, (_, i) => `${i + 1}. step-${i}`).join('\n') });
    const rows = createTranscript()(view, 40, false);
    expect(text(rows)).toContain('second'); expect(text(rows)).toContain('last detail'); expect(text(rows)).toContain('100. step-99');
    expect(rows.every((r) => displayWidth(r.map((s) => s.text).join('')) <= 40)).toBe(true);
  });
  it.each([1, 2, 4, 12, 25, 76, 120])('fits rich markdown into %i columns without corrupting graphemes', (width) => {
    const source = '# 中文👩‍💻\n\n**bold** and *italic*, `code`, [link](https://example.test)\n\n- [x] 完成任务\n  - 嵌套\n\n> 引用中文\n\n```ts\n\tconst long = "中文👩‍💻";\n```\n\n| A | B | C |\n|---|---|---|\n| 中文 | 👩‍💻 | é |';
    const rows = markdownRows(source, width);
    expect(rows.every((r) => displayWidth(r.map((s) => s.text).join('')) <= width)).toBe(true);
    expect(text(rows)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    expect(rows.flat().some((s) => s.bold)).toBe(true);
    expect(rows.flat().some((s) => s.italic)).toBe(true);
  });
  it('keeps inline styles across wraps and sanitizes terminal control sequences', () => {
    const rows = wrapSpans([{ text: 'a👩‍💻é', bold: true }, { text: 'next', color: 'info' }], 3);
    expect(rows[0]!.map((s) => s.text).join('')).toBe('a👩‍💻');
    expect(rows[1]![0]).toMatchObject({ text: 'é', bold: true });
    expect(text(markdownRows('\x1b[2Jsafe\x1b[31m code\x1b[0m', 20))).not.toContain('\x1b');
  });
  it('reuses immutable history rows but invalidates them after resize and ASCII changes', () => {
    const view = pushItems(emptyAgentView(), { kind: 'markdown', text: '# hello\n\n中文'.repeat(20) });
    const transcript = createTranscript(), first = transcript(view, 40, false), second = transcript({ ...view, running: true }, 40, false);
    expect(second[0]).toBe(first[0]);
    expect(transcript(view, 10, false)[0]).not.toBe(first[0]);
    expect(text(transcript(view, 40, true))).not.toContain('▍');
    expect(transcript(view, 40, false, 1, view.items[0]!.id)).toEqual([]);
  });
  it('budgets every combination of panels for tiny through large screens', () => {
    for (const rows of [2, 3, 4, 5, 8, 10, 16, 24, 40, 80]) for (let flags = 0; flags < 16; flags++) {
      const layout = fullscreenLayout(rows, { interaction: Boolean(flags & 1), detail: Boolean(flags & 2), todos: Boolean(flags & 4), agents: Boolean(flags & 8) });
      const { height, ...parts } = layout;
      expect(Object.values(parts).reduce((a, b) => a + b, 0)).toBe(height);
      expect(height).toBeLessThan(rows);
      expect(layout.input).toBeGreaterThan(0);
      expect(Object.values(parts).every((n) => n >= 0)).toBe(true);
    }
  });
});
