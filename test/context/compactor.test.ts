import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/core/types.js';
import { extractSummary } from '../../src/context/compactor.js';

const msgs: Message[] = [
  { role: 'user', content: [{ type: 'text', text: '把登录接口改成 JWT' }] },
  {
    role: 'assistant',
    content: [
      { type: 'tool-call', id: 'a', name: 'read', args: { path: 'src/auth.ts' } },
      { type: 'tool-call', id: 'b', name: 'bash', args: { command: 'npm test' } },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool-result', toolCallId: 'a', name: 'read', content: [{ type: 'text', text: '...' }] },
      { type: 'tool-result', toolCallId: 'b', name: 'bash', content: [{ type: 'text', text: '3 failing' }], isError: true },
    ],
  },
  { role: 'assistant', content: [{ type: 'tool-call', id: 'c', name: 'edit', args: { path: 'src/auth.ts' } }] },
  { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c', name: 'edit', content: [{ type: 'text', text: 'ok' }] }] },
  { role: 'assistant', content: [{ type: 'text', text: '已改为 JWT，测试待修复' }] },
];

describe('extractSummary', () => {
  it('抽取请求、文件（含动作）、命令、错误与结论', () => {
    const s = extractSummary(msgs, '重点关注测试失败');
    expect(s).toContain('重点关注测试失败');
    expect(s).toContain('把登录接口改成 JWT');
    expect(s).toContain('src/auth.ts（读取、修改）');
    expect(s).toContain('`npm test`');
    expect(s).toContain('bash: 3 failing');
    expect(s).toContain('已改为 JWT');
  });

  it('包含此前摘要时保留其要点', () => {
    const s = extractSummary([{ role: 'user', content: [{ type: 'text', text: '<summary>\n旧的要点\n</summary>' }] }]);
    expect(s).toContain('此前已有摘要');
    expect(s).toContain('旧的要点');
  });
});
