import { displayWidth, graphemes } from '../core/text-width.js';
import type { EditorState } from './input/editor.js';

/** Allocate physical rows, keeping the footer and editor reachable before optional panels. */
export function inlineLayout(rows: number, content: { tools: number; todos: number; agents: number; interaction: boolean; detail: boolean }) {
  let left = Math.max(1, rows);
  const take = (want: number) => { const n = Math.min(left, Math.max(0, want)); left -= n; return n; };
  const status = take(left >= 4 ? 1 : 0);
  const interaction = content.interaction ? take(Math.min(16, left)) : 0;
  const input = content.interaction ? 0 : take(Math.min(7, Math.max(3, Math.floor(rows / 6))));
  const detail = content.detail ? take(left) : 0;
  const stream = take(content.interaction || content.detail ? 0 : Math.max(1, Math.floor(left / 2)));
  const tools = take(content.tools ? Math.min(left, rows >= 40 ? 9 : 4) : 0);
  const todos = take(content.todos ? Math.min(5, left) : 0);
  const agents = take(content.agents ? Math.min(5, left) : 0);
  return { status, interaction, input, detail, stream, tools, todos, agents };
}

/** Fullscreen keeps one spare terminal row so Windows never scrolls a painted frame. */
export function fullscreenLayout(rows: number, content: { interaction: boolean; detail: boolean; todos: boolean; agents: boolean; hints?: boolean }) {
  const height = Math.max(1, rows);
  const header = height >= 5 ? 1 : 0;
  const status = height >= 3 ? 1 : 0;
  let left = height - header - status;
  const input = Math.min(Math.max(1, left - 1), content.interaction ? 16 : Math.max(1, Math.min(7, Math.floor(rows / 6))));
  left -= input;
  const take = (want: number) => { const n = Math.max(0, Math.min(Math.max(0, left - 1), want)); left -= n; return n; };
  const keybar = take(height >= 14 && content.hints !== false ? 1 : 0);
  const todos = !content.interaction && !content.detail && content.todos ? take(rows >= 32 ? 4 : rows >= 20 ? 2 : 0) : 0;
  const agents = !content.interaction && !content.detail && content.agents ? take(rows >= 32 ? 4 : rows >= 20 ? 2 : 0) : 0;
  return { height, header, status, input, keybar, todos, agents, body: Math.max(0, left) };
}

export interface EditorRow { text: string; sourceRow: number; start: number }

/** Soft wraps without changing the draft. The visible window follows the caret. */
export function editorViewport(state: EditorState, width: number, height: number) {
  width = Math.max(1, width);
  height = Math.max(1, height);
  const rows: EditorRow[] = [];
  let caret = { x: 0, y: 0 };
  state.lines.forEach((line, sourceRow) => {
    let text = '';
    let used = 0;
    let start = 0;
    for (const ch of graphemes(line + ' ')) {
      const size = Math.min(width, displayWidth(ch.text));
      if (used + size > width) { rows.push({ text, sourceRow, start }); text = ''; used = 0; start = ch.start; }
      if (sourceRow === state.row && ch.start === state.col) caret = { x: used, y: rows.length };
      text += displayWidth(ch.text) > width ? '?' : ch.text;
      used += size;
    }
    rows.push({ text, sourceRow, start });
  });
  const first = Math.max(0, Math.min(caret.y - height + 1, rows.length - height));
  return { lines: rows.slice(first, first + height), caret: { x: caret.x, y: caret.y - first }, hidden: Math.max(0, rows.length - height) };
}
