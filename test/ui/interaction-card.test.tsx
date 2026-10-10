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
  it('folds diff previews at twelve lines and Ctrl+O opens full details without approving', async () => {
    const onRespond = vi.fn(), screen = render(<InteractionCard request={permission({ preview: Array.from({ length: 25 }, (_, i) => `+preview-${i}`), fullDetail: 'full-only-marker\ncomplete diff', forced: true, reason: 'worktree 需要明确授权' })} maxHeight={30} onRespond={onRespond} />);
    try {
      await tick(); expect(screen.lastFrame()).toContain('+preview-11'); expect(screen.lastFrame()).not.toContain('+preview-12'); expect(screen.lastFrame()).toContain('另 13 行');
      screen.stdin.write('\x0f'); await tick(); expect(screen.lastFrame()).toContain('full-only-marker'); expect(onRespond).not.toHaveBeenCalled();
      screen.stdin.write('1'); await tick(); expect(onRespond).toHaveBeenCalledWith({ kind: 'permission', decision: 'allow' });
    } finally { screen.unmount(); }
  });
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

  it('帮我审批：显示时通知开始倒计时，标题显示剩余秒数，按键暂停而不作答', async () => {
    const onRespond = vi.fn(), onShown = vi.fn(), onHold = vi.fn();
    const request = permission({ countdownMs: 10_000, deadline: Date.now() + 8_000, reason: '高风险操作：推送到远端仓库' });
    const screen = render(<InteractionCard request={request} onRespond={onRespond} onShown={onShown} onHold={onHold} />);
    try {
      await tick();
      expect(onShown).toHaveBeenCalledOnce();
      expect(screen.lastFrame()).toContain('帮我审批：8 秒后自动拒绝');
      expect(screen.lastFrame()).toContain('任意键暂停');
      screen.stdin.write('\u001B[B');
      await tick();
      expect(onHold).toHaveBeenCalled();
      expect(onRespond).not.toHaveBeenCalled();
      screen.rerender(<InteractionCard request={{ ...request, paused: true }} onRespond={onRespond} onShown={onShown} onHold={onHold} />);
      await tick();
      expect(screen.lastFrame()).toContain('倒计时已暂停');
      expect(screen.lastFrame()).not.toContain('任意键暂停');
      expect(onShown).toHaveBeenCalledOnce();
      screen.stdin.write('1');
      await tick();
      expect(onRespond).toHaveBeenCalledWith({ kind: 'permission', decision: 'allow' });
    } finally { screen.unmount(); }
  });

  it('普通审批不显示倒计时，按键也不触发暂停', async () => {
    const onHold = vi.fn();
    const screen = render(<InteractionCard request={permission()} onRespond={vi.fn()} onHold={onHold} />);
    try {
      await tick();
      expect(screen.lastFrame()).not.toContain('帮我审批');
      screen.stdin.write('\u001B[B');
      await tick();
      expect(onHold).not.toHaveBeenCalled();
    } finally { screen.unmount(); }
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
