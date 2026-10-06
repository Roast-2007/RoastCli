/**
 * 从历史状态列出当前仍在历史中的用户 turn（/rewind 选择列表用）。
 */
import type { HistoryState } from '../session/history.js';

export interface TurnSummary {
  turn: number;
  /** 该 turn 用户输入的首行（截断） */
  text: string;
}

const MAX_TEXT = 60;

export function userTurns(state: HistoryState): TurnSummary[] {
  return Object.entries(state.turnStarts)
    .map(([t, before]) => {
      const msg = state.messages[before.length];
      const first = msg?.role === 'user' ? msg.content.find((b) => b.type === 'text') : undefined;
      const text = first && first.type === 'text' ? first.text : '';
      const raw = (/<goal>\s*([\s\S]*?)\s*<\/goal>/.exec(text)?.[1] ?? text).split('\n')[0]!.trim();
      return { turn: Number(t), text: raw.length > MAX_TEXT ? `${raw.slice(0, MAX_TEXT)}…` : raw };
    })
    .filter((t) => t.text !== '')
    .sort((a, b) => a.turn - b.turn);
}
