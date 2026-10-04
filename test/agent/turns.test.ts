import { describe, expect, it } from 'vitest';
import { userTurns } from '../../src/agent/turns.js';
import { initialHistory, type HistoryState } from '../../src/session/history.js';
import { userMessage, type Message } from '../../src/core/types.js';

const assistant = (text: string): Message => ({ role: 'assistant', content: [{ type: 'text', text }] });

describe('userTurns', () => {
  it('lists turns still in history with their first line, truncated and sorted', () => {
    const long = 'x'.repeat(80);
    const messages = [userMessage('第一轮\n更多细节'), assistant('好'), userMessage(long), assistant('ok')];
    const state: HistoryState = { ...initialHistory(), messages, turnStarts: { 2: messages.slice(0, 2), 1: [] } };

    expect(userTurns(state)).toEqual([
      { turn: 1, text: '第一轮' },
      { turn: 2, text: `${'x'.repeat(60)}…` },
    ]);
  });

  it('skips turns whose start no longer points at a user text message', () => {
    const messages = [assistant('only')];
    const state: HistoryState = { ...initialHistory(), messages, turnStarts: { 1: [], 3: messages } };
    expect(userTurns(state)).toEqual([]);
  });
});
