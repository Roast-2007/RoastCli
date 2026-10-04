import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { Markdown } from '../../src/ui/markdown/Markdown.js';
import { displayWidth } from '../../src/core/text-width.js';
import { TerminalContext } from '../../src/ui/terminal.js';

const DOC = `# 标题一

段落里有 **粗体**、*斜体*、~~删除~~、\`行内代码\` 和 [链接](https://example.com)。
第二行&amp;转义

- 第一项
- 第二项
  1. 嵌套有序
  2. 再一项

> 引用的一句话

| 名称 | 值 |
|---|---|
| 中文 | 1 |
| ascii | 22 |

\`\`\`ts
const x: number = 1;
\`\`\`

\`\`\`unknownlang
plain code
\`\`\`

---
`;

describe('Markdown', () => {
  it('renders headings, inline styles, nested lists, quotes, tables, code and rules', () => {
    const { lastFrame, unmount } = render(<TerminalContext.Provider value={{ motion: false, ascii: false }}><Markdown text={DOC} /></TerminalContext.Provider>);
    const frame = lastFrame()!;
    for (const s of ['标题一', '粗体', '斜体', '删除', '行内代码', '链接', '第二行&转义', '第一项', '嵌套有序', '引用的一句话', 'const x', 'plain code', '─'.repeat(10)]) {
      expect(frame).toContain(s);
    }
    const tableRows = frame.split('\n').filter((l) => l.includes('中文') || l.includes('ascii'));
    expect(tableRows).toHaveLength(2);
    const valueColumn = (row: string, value: string) => displayWidth(row.slice(0, row.lastIndexOf(value)));
    expect(valueColumn(tableRows[0]!, '1')).toBe(valueColumn(tableRows[1]!, '22'));
    unmount();
  });

  it('renders nothing visible for blank input', () => {
    const { lastFrame, unmount } = render(<Markdown text={'\n\n'} />);
    expect(lastFrame()!.trim()).toBe('');
    unmount();
  });
});

describe('displayWidth', () => {
  it('counts CJK and full-width characters as two columns', () => {
    expect(displayWidth('ab')).toBe(2);
    expect(displayWidth('中文')).toBe(4);
    expect(displayWidth('（）')).toBe(4);
  });
});
