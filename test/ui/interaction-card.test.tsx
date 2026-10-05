import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { InteractionCard } from '../../src/ui/components/InteractionCard.js';
import type { InteractionRequest } from '../../src/core/interaction.js';

const tick = () => new Promise((r) => setTimeout(r, 20));

const permission = (extra: Partial<Extract<InteractionRequest, { kind: 'permission' }>> = {}): InteractionRequest => ({
  id: 'p1',
  kind: 'permission',
  agentId: 'main',
  tool: 'bash',
  title: 'bash: npm install',
  detail: 'npm install',
  reason: '执行命令',
  suggestedRule: 'bash(npm install:*)',
  ...extra,
});

describe('InteractionCard：权限', () => {
  it('显示标题、原因与建议规则；按 2 本会话始终允许', async () => {
    const onRespond = vi.fn();
    const { lastFrame, stdin } = render(<InteractionCard request={permission()} onRespond={onRespond} />);
    const frame = lastFrame()!;
    expect(frame).toContain('bash: npm install');
    expect(frame).toContain('bash(npm install:*)');
    await tick();
    stdin.write('2');
    await tick();
    expect(onRespond).toHaveBeenCalledWith({ kind: 'permission', decision: 'allow', remember: 'session' });
  });

  it('Esc 拒绝', async () => {
    const onRespond = vi.fn();
    const { stdin } = render(<InteractionCard request={permission()} onRespond={onRespond} />);
    await tick();
    stdin.write('\u001B');
    await tick();
    expect(onRespond).toHaveBeenCalledWith({ kind: 'permission', decision: 'deny' });
  });

  it('高危操作不提供"始终允许"', async () => {
    const onRespond = vi.fn();
    const { lastFrame, stdin } = render(<InteractionCard request={permission({ forced: true, suggestedRule: undefined, reason: '高危操作：强制推送' })} onRespond={onRespond} />);
    expect(lastFrame()).toContain('高危');
    expect(lastFrame()).not.toContain('始终允许');
    await tick();
    stdin.write('2');
    await tick();
    expect(onRespond).not.toHaveBeenCalled();
  });
});

describe('InteractionCard：提问', () => {
  const question: InteractionRequest = { id: 'q1', kind: 'question', agentId: 'main', question: '用哪个方案？', options: ['A 方案', 'B 方案'] };

  it('shows the question and editor on a two-row card and responds once to rapid input', async () => {
    const onRespond = vi.fn();
    const screen = render(<InteractionCard request={{ ...question, options: [] }} maxHeight={2} onRespond={onRespond} />);
    try {
      await tick(); expect(screen.lastFrame()).toContain('用哪个方案');
      expect(screen.lastFrame()!.split('\n').length).toBeLessThanOrEqual(2);
      for (const key of ['自', '定义', '\r', '\r']) screen.stdin.write(key);
      expect(onRespond).toHaveBeenCalledExactlyOnceWith({ kind: 'question', answer: '自定义' });
    } finally { screen.unmount(); }
  });

  it('数字键选择选项', async () => {
    const onRespond = vi.fn();
    const { stdin } = render(<InteractionCard request={question} onRespond={onRespond} />);
    await tick();
    stdin.write('2');
    await tick();
    expect(onRespond).toHaveBeenCalledWith({ kind: 'question', answer: 'B 方案' });
  });

  it('输入自由回答后回车', async () => {
    const onRespond = vi.fn();
    const { stdin, lastFrame } = render(<InteractionCard request={question} onRespond={onRespond} />);
    await tick();
    stdin.write('都不要');
    await tick();
    expect(lastFrame()).toContain('都不要');
    stdin.write('\r');
    await tick();
    expect(onRespond).toHaveBeenCalledWith({ kind: 'question', answer: '都不要' });
  });
});
