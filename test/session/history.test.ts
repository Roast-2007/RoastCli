import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../src/session/events.js';
import { foldHistory, hashMessages, packTurnStarts, stableStringify, unpackTurnStarts } from '../../src/session/history.js';

const at = '2026-01-01T00:00:00.000Z';
let seq = 0;
const e = <T extends SessionEvent>(ev: T): T => ({ ...ev, seq: ++seq, agentId: 'main' });

describe('history reducer', () => {
  it('同 step 的 tool/result 合并，attachment 追加在其后', () => {
    const state = foldHistory([
      e({ type: 'turn/start', turn: 1, at }),
      e({ type: 'user/message', turn: 1, at, message: { role: 'user', content: [{ type: 'text', text: 'q' }] } }),
      e({
        type: 'assistant/message',
        turn: 1,
        step: 1,
        at,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool-call', id: 'a', name: 'read', args: {} },
            { type: 'tool-call', id: 'b', name: 'read', args: {} },
          ],
        },
      }),
      e({ type: 'tool/result', turn: 1, step: 1, at, callId: 'a', name: 'read', isError: false, content: [{ type: 'text', text: 'A' }], durationMs: 1 }),
      e({ type: 'tool/result', turn: 1, step: 1, at, callId: 'b', name: 'read', isError: true, content: [{ type: 'text', text: 'B' }], durationMs: 1 }),
      e({ type: 'attachment/injected', turn: 1, step: 2, at, source: 'todo', blocks: [{ type: 'text', text: '<reminder/>' }] }),
    ]);
    expect(state.turn).toBe(1);
    expect(state.messages).toHaveLength(3);
    expect(state.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool-result', toolCallId: 'a', name: 'read', content: [{ type: 'text', text: 'A' }] },
        { type: 'tool-result', toolCallId: 'b', name: 'read', content: [{ type: 'text', text: 'B' }], isError: true },
        { type: 'text', text: '<reminder/>' },
      ],
    });
    expect(state.lastSeq).toBe(seq);
  });

  it('连续 user/message（插话/上一轮无回复）合并为一条', () => {
    const state = foldHistory([
      e({ type: 'user/message', turn: 1, at, message: { role: 'user', content: [{ type: 'text', text: 'a' }] } }),
      e({ type: 'user/message', turn: 2, at, message: { role: 'user', content: [{ type: 'text', text: 'b' }] }, source: 'steer' }),
    ]);
    expect(state.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }]);
  });

  it('history/import 整体替换', () => {
    const state = foldHistory([
      e({ type: 'user/message', turn: 1, at, message: { role: 'user', content: [{ type: 'text', text: 'x' }] } }),
      e({ type: 'history/import', at, fromRunId: 'r', messages: [{ role: 'user', content: [{ type: 'text', text: 'y' }] }] }),
    ]);
    expect(state.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'y' }] }]);
  });

  it('reducer 不修改输入（不可变）', () => {
    const msg = { role: 'user' as const, content: [{ type: 'text' as const, text: 'a' }] };
    const s1 = foldHistory([e({ type: 'user/message', turn: 1, at, message: msg })]);
    foldHistory([e({ type: 'user/message', turn: 1, at, message: { role: 'user', content: [{ type: 'text', text: 'b' }] } })], s1);
    expect(s1.messages).toEqual([msg]);
    expect(msg.content).toHaveLength(1);
  });
});

describe('stableStringify / hashMessages', () => {
  it('键顺序与 undefined 字段不影响 hash（与 JSON 往返一致）', () => {
    const a = [{ role: 'user', content: [{ type: 'text', text: 'x', extra: undefined }] }];
    const b = JSON.parse(JSON.stringify([{ content: [{ text: 'x', type: 'text' }], role: 'user' }]));
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(hashMessages(a as never)).toBe(hashMessages(b));
  });
  it('分叉导入的 turnStarts 按引用去重成线性体积，并能回退到来源轮次', () => {
    const text = (role: 'user' | 'assistant', value: string) => ({ role, content: [{ type: 'text' as const, text: value }] });
    const events: SessionEvent[] = [];
    for (let turn = 1; turn <= 30; turn++) {
      events.push(e({ type: 'turn/start', turn, at }));
      events.push(e({ type: 'user/message', turn, at, message: text('user', `q${turn} ${'x'.repeat(200)}`) }));
      events.push(e({ type: 'assistant/message', turn, step: 1, at, message: text('assistant', `a${turn}`) }));
      events.push(e({ type: 'turn/end', turn, at, reason: 'completed' }));
    }
    const source = foldHistory(events);
    const packed = packTurnStarts(source.turnStarts);
    expect(packed.pool).toHaveLength(58);
    expect(JSON.stringify(packed).length).toBeLessThan(JSON.stringify(source.messages).length * 2);
    expect(unpackTurnStarts(JSON.parse(JSON.stringify(packed)))).toEqual(source.turnStarts);
    expect(Object.keys(unpackTurnStarts({ pool: packed.pool, turns: { ...packed.turns, 31: [0, 99] } }))).toHaveLength(30);
    const fork = foldHistory([
      e({ type: 'history/import', at, fromRunId: 'r0', messages: [...source.messages], turn: 30, turnStarts: JSON.parse(JSON.stringify(packed)) }),
      e({ type: 'rewind', at, toTurn: 3 }),
    ]);
    expect(fork.messages).toEqual(source.turnStarts[3]);
    expect(Object.keys(fork.turnStarts)).toEqual(['1', '2']);
  });
});
