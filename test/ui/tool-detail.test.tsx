import { render } from 'ink-testing-library';
import { expect, it } from 'vitest';
import { ToolDetail } from '../../src/ui/components/ToolCard.js';

it('renders tool details without executing terminal controls, preserving CJK and newlines', () => {
  const { lastFrame, unmount } = render(
    <ToolDetail
      maxLines={12}
      tool={{
        callId: 't',
        name: 'read',
        args: { path: 'file\u0007.txt' },
        status: 'done',
        durationMs: 0,
        preview: '',
        output: '\u001b]0;injected title\u0007中文\r\n\u001b[2J第二行\u0000\u0008\u009b2J',
      }}
    />,
  );
  try {
    const frame = lastFrame()!;
    expect(frame).toContain('中文');
    expect(frame).toContain('第二行');
    expect(frame).not.toContain('injected title');
    expect(frame).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  } finally {
    unmount();
  }
});
