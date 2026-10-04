import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/core/types.js';
import { estimateMessages, estimateText, Calibrator } from '../../src/context/estimator.js';
import { buildView, stubText } from '../../src/context/view.js';
import { foldHistory } from '../../src/session/history.js';
import type { SessionEvent } from '../../src/session/events.js';
import { pairingErrors } from '../fixtures/history.js';

const at = 't';
let seq = 0;
const e = <T extends SessionEvent>(ev: T): T => ({ ...ev, seq: ++seq, agentId: 'main' });

function conversation(): SessionEvent[] {
  return [
    e({ type: 'turn/start', turn: 1, at }),
    e({ type: 'user/message', turn: 1, at, message: { role: 'user', content: [{ type: 'text', text: '读 a.ts' }] } }),
    e({ type: 'assistant/message', turn: 1, step: 1, at, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'r1', name: 'read', args: { path: 'a.ts' } }] } }),
    e({ type: 'tool/result', turn: 1, step: 1, at, callId: 'r1', name: 'read', isError: false, content: [{ type: 'text', text: 'A'.repeat(4000) }], durationMs: 1 }),
    e({ type: 'assistant/message', turn: 1, step: 2, at, message: { role: 'assistant', content: [{ type: 'text', text: '读完' }] } }),
    e({ type: 'turn/start', turn: 2, at }),
    e({ type: 'user/message', turn: 2, at, message: { role: 'user', content: [{ type: 'text', text: '第二问' }] } }),
    e({ type: 'assistant/message', turn: 2, step: 1, at, message: { role: 'assistant', content: [{ type: 'text', text: '第二答' }] } }),
  ];
}

describe('estimator', () => {
  it('CJK 每字约 1 token，ASCII 约 4 字符 1 token', () => {
    expect(estimateText('你好世界')).toBe(4);
    expect(estimateText('abcdefgh')).toBe(2);
    const msgs: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'abcd'.repeat(100) }] }];
    expect(estimateMessages(msgs)).toBeGreaterThanOrEqual(100);
  });

  it('Calibrator 按真实 usage 做 EMA 校准', () => {
    const c = new Calibrator(0.5);
    expect(c.factor).toBe(1);
    c.observe(100, 150);
    expect(c.factor).toBeCloseTo(1.25);
    expect(c.adjust(100)).toBe(125);
  });
});

describe('buildView', () => {
  it('无上下文变换时视图 == 历史', () => {
    const state = foldHistory(conversation());
    expect(buildView(state)).toEqual(state.messages);
  });

  it('elide：tool-result 内容替换为存根，block 保留（配对合法），原文仍在历史中', () => {
    const events = [...conversation(), e({ type: 'context/transform', at, ops: [{ op: 'elide', ids: ['r1'], reason: 'aging' }] })];
    const state = foldHistory(events);
    const view = buildView(state);
    expect(pairingErrors(view)).toEqual([]);
    const result = view[2]!.content[0] as { content: { text: string }[]; toolCallId: string };
    expect(result.toolCallId).toBe('r1');
    expect(result.content[0]!.text).toContain('⟦ctx:r1⟧');
    expect(JSON.stringify(view)).not.toContain('AAAA');
    expect(JSON.stringify(state.messages)).toContain('AAAA');
  });

  it('elide 可带预览：保留头尾', () => {
    expect(stubText({ callId: 'x', name: 'read', tokens: 900, preview: 'HEAD\n…\nTAIL' })).toContain('HEAD');
  });

  it('compact：用摘要替换切点之前的消息，摘要并入切点处的 user 消息', () => {
    const events = [...conversation(), e({ type: 'context/compact', at, upTo: 4, summary: '## 目标\n读 a.ts 并回答' })];
    const state = foldHistory(events);
    const view = buildView(state);
    expect(view).toHaveLength(2);
    expect(view[0]!.role).toBe('user');
    expect((view[0]!.content[0] as { text: string }).text).toContain('读 a.ts 并回答');
    expect((view[0]!.content[1] as { text: string }).text).toBe('第二问');
    expect(pairingErrors(view)).toEqual([]);
  });

  it('rewind 到压缩点之前：压缩失效', () => {
    const events = [
      ...conversation(),
      e({ type: 'context/compact', at, upTo: 4, summary: 's' }),
      e({ type: 'rewind', at, toTurn: 1 }),
    ];
    const state = foldHistory(events);
    expect(state.context.compaction).toBeNull();
    expect(buildView(state)).toEqual(state.messages);
  });
});
