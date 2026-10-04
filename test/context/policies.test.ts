import { describe, expect, it } from 'vitest';
import { agingCandidates, chooseCut, dedupCandidates, DEFAULT_CONTEXT_CONFIG } from '../../src/context/policies.js';
import { foldHistory } from '../../src/session/history.js';
import type { SessionEvent } from '../../src/session/events.js';

const at = 't';
let seq = 0;
const e = <T extends SessionEvent>(ev: T): T => ({ ...ev, seq: ++seq, agentId: 'main' });

/** 生成一个 turn：用户提问 → 一次工具调用 → 文本回答 */
function turn(n: number, tool: string, args: unknown, result: string, isError = false): SessionEvent[] {
  const id = `c${n}`;
  return [
    e({ type: 'turn/start', turn: n, at }),
    e({ type: 'user/message', turn: n, at, message: { role: 'user', content: [{ type: 'text', text: `问题 ${n}` }] } }),
    e({ type: 'assistant/message', turn: n, step: 1, at, message: { role: 'assistant', content: [{ type: 'tool-call', id, name: tool, args }] } }),
    e({ type: 'tool/result', turn: n, step: 1, at, callId: id, name: tool, isError, content: [{ type: 'text', text: result }], durationMs: 1 }),
    e({ type: 'assistant/message', turn: n, step: 2, at, message: { role: 'assistant', content: [{ type: 'text', text: `回答 ${n}` }] } }),
  ];
}

describe('dedupCandidates', () => {
  it('同一文件之后又被读取或成功编辑：折叠更早的读取结果', () => {
    const state = foldHistory([
      ...turn(1, 'read', { path: 'src/a.ts' }, 'old a'),
      ...turn(2, 'read', { path: 'src/b.ts' }, 'b'),
      ...turn(3, 'edit', { path: './src/a.ts', old_string: 'x', new_string: 'y' }, 'ok'),
      ...turn(4, 'read', { path: 'src\\b.ts' }, 'b again'),
    ]);
    expect(dedupCandidates(state).sort()).toEqual(['c1', 'c2']);
  });

  it('失败的后续编辑不构成"覆盖"；已折叠的不重复给出', () => {
    const events = [...turn(1, 'read', { path: 'a.ts' }, 'a'), ...turn(2, 'edit', { path: 'a.ts' }, 'fail', true)];
    expect(dedupCandidates(foldHistory(events))).toEqual([]);
    const withRead = [...turn(1, 'read', { path: 'a.ts' }, 'a'), ...turn(2, 'read', { path: 'a.ts' }, 'a2')];
    const elided = foldHistory([...withRead, e({ type: 'context/transform', at, ops: [{ op: 'elide', ids: ['c1'], reason: 'dedup' }] })]);
    expect(dedupCandidates(elided)).toEqual([]);
  });
});

describe('agingCandidates', () => {
  it('超过 N 个 turn 之前、且足够大的工具结果：折叠并保留头尾预览', () => {
    const big = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
    const events = [...turn(1, 'bash', { command: 'npm test' }, big), ...turn(2, 'read', { path: 'tiny' }, 'tiny')];
    for (let n = 3; n <= 12; n++) events.push(...turn(n, 'read', { path: `f${n}` }, 'x'));
    const out = agingCandidates(foldHistory(events), { ...DEFAULT_CONTEXT_CONFIG, agingTurns: 8, agingMinTokens: 500 });
    expect(out.ids).toEqual(['c1']);
    expect(out.previews['c1']).toContain('line 0');
    expect(out.previews['c1']).toContain('line 399');
    expect(out.tokens['c1']).toBeGreaterThan(500);
  });
});

describe('chooseCut', () => {
  it('保留最近 K 个 turn，切点落在 user 文本消息处，并晚于已有压缩点', () => {
    const events: SessionEvent[] = [];
    for (let n = 1; n <= 5; n++) events.push(...turn(n, 'read', { path: `f${n}` }, 'r'));
    const state = foldHistory(events);
    const cut = chooseCut(state, 3)!;
    expect(state.messages[cut]!.role).toBe('user');
    expect((state.messages[cut]!.content[0] as { text: string }).text).toBe('问题 3');
    const compacted = foldHistory([...events, e({ type: 'context/compact', at, upTo: cut, summary: 's' })]);
    expect(chooseCut(compacted, 3)).toBeNull();
    expect(chooseCut(compacted, 1)).toBeGreaterThan(cut);
  });

  it('turn 不足时返回 null', () => {
    expect(chooseCut(foldHistory(turn(1, 'read', { path: 'a' }, 'a')), 3)).toBeNull();
  });
});
