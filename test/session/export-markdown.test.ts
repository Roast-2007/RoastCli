import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assistantAnswers, renderTranscriptMarkdown, writeTranscript } from '../../src/session/export-markdown.js';
import { deriveDisplayMessages } from '../../src/session/projection.js';
import type { LogHeader, SessionEvent } from '../../src/session/events.js';
import { tempWorkspace } from '../fixtures/workspace.js';

const header: LogHeader = {
  type: 'session',
  version: 1,
  runId: 'r1',
  createdAt: '2026-10-09',
  cwd: '/project',
  provider: 'p',
  model: 'm',
  pid: 1,
};
describe('Markdown transcript', () => {
  it('shares committed display projection, excludes reasoning/internal content, and escapes tool fences', () => {
    const events: SessionEvent[] = [
      { type: 'turn/start', turn: 1, at: '' },
      {
        type: 'hive/mission',
        turn: 1,
        at: '',
        missionId: 'm1',
        goal: '用户目标',
        brief: 'PRIVATE BRIEF',
        strategy: 'auto',
        n: 3,
        images: [{ type: 'image', mediaType: 'image/png', data: 'SECRET BASE64' }],
      },
      { type: 'attachment/injected', turn: 1, step: 1, at: '', source: 'inbox', blocks: [{ type: 'text', text: 'INTERNAL' }] },
      {
        type: 'assistant/message',
        turn: 1,
        step: 1,
        at: '',
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'REASONING' },
            { type: 'text', text: 'Answer' },
            { type: 'tool-call', id: 'c1', name: 'bash', args: { command: 'git status' } },
          ],
        },
      },
      {
        type: 'tool/result',
        turn: 1,
        step: 1,
        at: '',
        callId: 'c1',
        name: 'bash',
        isError: true,
        durationMs: 1,
        content: [{ type: 'text', text: ['````', ...Array.from({ length: 34 }, (_, i) => `line ${i}`)].join('\n') }],
      },
      { type: 'assistant/chunk', turn: 1, step: 2, chunk: { type: 'text-delta', index: 0, text: 'RAW' } },
      {
        type: 'assistant/message',
        agentId: 'w1',
        turn: 1,
        step: 1,
        at: '',
        message: { role: 'assistant', content: [{ type: 'text', text: 'CHILD' }] },
      },
    ];
    const output = renderTranscriptMarkdown(header, events);
    expect(output).toContain('# RoastCli 会话 r1');
    expect(output).toContain('[图片 image/png]');
    expect(output).toContain('**工具** `bash` git status');
    expect(output).toContain('✗\n\n`````\n````');
    expect(output).toContain('…（省略 5 行）');
    for (const hidden of ['PRIVATE BRIEF', 'SECRET BASE64', 'INTERNAL', 'REASONING', 'RAW', 'CHILD']) expect(output).not.toContain(hidden);
    const visible = deriveDisplayMessages(events.filter((e) => !e.agentId));
    expect(output).toContain((visible[0]!.content[0] as { text: string }).text);
    expect(assistantAnswers(header, events)).toEqual(['Answer']);
  });
  it('allocates unique default files atomically and refuses explicit overwrites', () => {
    const ws = tempWorkspace();
    expect(writeTranscript(ws.dir, 'r1', 'first\n')).toBe(path.join(ws.dir, 'roast-export-r1.md'));
    expect(writeTranscript(ws.dir, 'r1', 'second\n')).toBe(path.join(ws.dir, 'roast-export-r1-2.md'));
    const file = writeTranscript(ws.dir, 'r1', '中文\n', 'custom.md');
    expect(() => writeTranscript(ws.dir, 'r1', 'overwrite', file)).toThrow('拒绝覆盖');
    expect(readFileSync(file, 'utf8')).toBe('中文\n');
  });
});
