/**
 * 输入框编辑缓冲（纯 reducer）：多行编辑、光标移动、按词删除、历史浏览、粘贴占位。
 * UI 组件只负责把按键翻译成 action，并在 submit 时取 expand(state) 的结果。
 */
import { nextBoundary, previousBoundary } from '../../core/text-width.js';
import { terminalText } from '../../core/terminal-text.js';
import type { ImageBlock } from '../../core/types.js';

export interface EditorState {
  images: Record<string, ImageBlock>;
  imageSeq: number;
  lines: string[];
  row: number;
  col: number;
  /** 历史（旧 → 新） */
  history: string[];
  /** 正在浏览的历史下标；null 表示在编辑草稿 */
  historyIndex: number | null;
  /** 进入历史浏览前的草稿 */
  draft: string | null;
  draftImages: Record<string, ImageBlock> | null;
  draftPastes: Record<string, string> | null;
  /** 粘贴占位 → 原文 */
  pastes: Record<string, string>;
}

export type EditorAction =
  | { type: 'attach'; image: ImageBlock }
  | { type: 'insert'; text: string }
  | { type: 'paste'; text: string }
  | { type: 'newline' }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'deleteWordLeft' }
  | { type: 'killToStart' }
  | { type: 'clear' }
  | { type: 'set'; text: string }
  | { type: 'commit' };

/** 超过该行数的粘贴折叠成占位符 */
export const PASTE_COLLAPSE_LINES = 5;

export function createEditor(history: string[] = []): EditorState {
  return {
    lines: [''],
    row: 0,
    col: 0,
    history,
    historyIndex: null,
    draft: null,
    draftImages: null,
    draftPastes: null,
    pastes: {},
    images: {},
    imageSeq: 0,
  };
}

export function textOf(s: EditorState): string {
  return s.lines.join('\n');
}

/** 提交用文本：展开粘贴占位 */
export function expand(s: EditorState): string {
  let text = textOf(s);
  for (const [token, original] of Object.entries(s.pastes)) text = text.split(token).join(original);
  return text;
}

export function attachedImages(state: EditorState, text: string): ImageBlock[] {
  const seen = new Set<string>();
  const images: ImageBlock[] = [];
  for (const match of text.matchAll(/\[图片 #\d+\]/g)) {
    const token = match[0],
      image = state.images[token];
    if (image && !seen.has(token)) {
      seen.add(token);
      images.push(image);
    }
  }
  return images;
}

function withText(s: EditorState, text: string, cursorAtEnd = true): EditorState {
  const lines = text.split('\n');
  const row = cursorAtEnd ? lines.length - 1 : 0;
  return { ...s, lines, row, col: cursorAtEnd ? lines[row]!.length : 0 };
}

function insertText(s: EditorState, text: string): EditorState {
  const line = s.lines[s.row]!;
  const merged = line.slice(0, s.col) + text + line.slice(s.col);
  const parts = merged.split('\n');
  const lines = [...s.lines.slice(0, s.row), ...parts, ...s.lines.slice(s.row + 1)];
  const lastInserted = text.split('\n');
  const row = s.row + lastInserted.length - 1;
  const col = lastInserted.length === 1 ? s.col + text.length : lastInserted.at(-1)!.length;
  return { ...s, lines, row, col, historyIndex: null, draft: null, draftImages: null, draftPastes: null };
}

const WORD = /[\p{L}\p{N}_]/u;
const columnIn = (line: string, col: number) => (col >= line.length ? line.length : previousBoundary(line, nextBoundary(line, col)));

function browseHistory(s: EditorState, dir: -1 | 1): EditorState {
  if (s.history.length === 0) return s;
  const current = s.historyIndex ?? s.history.length;
  const next = current + dir;
  if (next < 0) return s;
  if (next >= s.history.length) {
    if (s.historyIndex === null) return s;
    return {
      ...withText(s, s.draft ?? ''),
      images: s.draftImages ?? {},
      pastes: s.draftPastes ?? {},
      historyIndex: null,
      draft: null,
      draftImages: null,
      draftPastes: null,
    };
  }
  return {
    ...withText(s, s.history[next]!),
    images: {},
    pastes: {},
    historyIndex: next,
    draft: s.historyIndex === null ? textOf(s) : s.draft,
    draftImages: s.historyIndex === null ? s.images : s.draftImages,
    draftPastes: s.historyIndex === null ? s.pastes : s.draftPastes,
  };
}

export function editorReducer(s: EditorState, a: EditorAction): EditorState {
  if (
    s.historyIndex !== null &&
    ['attach', 'insert', 'paste', 'newline', 'backspace', 'delete', 'deleteWordLeft', 'killToStart'].includes(a.type)
  )
    s = { ...s, historyIndex: null, draft: null, draftImages: null, draftPastes: null };
  const line = s.lines[s.row]!;
  switch (a.type) {
    case 'attach': {
      const imageSeq = s.imageSeq + 1,
        token = `[图片 #${imageSeq}]`;
      return { ...insertText(s, `${token} `), imageSeq, images: { ...s.images, [token]: a.image } };
    }
    case 'insert':
      return insertText(s, terminalText(a.text).replace(/\t/g, '    '));
    case 'paste': {
      const text = terminalText(a.text).replace(/\t/g, '    ');
      const count = text.split('\n').length;
      if (count <= PASTE_COLLAPSE_LINES) return insertText(s, text);
      const token = `[粘贴 ${count} 行 #${Object.keys(s.pastes).length + 1}]`;
      return { ...insertText(s, token), pastes: { ...s.pastes, [token]: text } };
    }
    case 'newline':
      return insertText(s, '\n');
    case 'backspace': {
      if (s.col > 0) {
        const col = previousBoundary(line, s.col);
        return { ...s, lines: s.lines.map((l, i) => (i === s.row ? l.slice(0, col) + l.slice(s.col) : l)), col };
      }
      if (s.row === 0) return s;
      const prev = s.lines[s.row - 1]!;
      const lines = [...s.lines.slice(0, s.row - 1), prev + line, ...s.lines.slice(s.row + 1)];
      return { ...s, lines, row: s.row - 1, col: prev.length };
    }
    case 'delete': {
      if (s.col < line.length)
        return { ...s, lines: s.lines.map((l, i) => (i === s.row ? l.slice(0, s.col) + l.slice(nextBoundary(line, s.col)) : l)) };
      if (s.row === s.lines.length - 1) return s;
      const lines = [...s.lines.slice(0, s.row), line + s.lines[s.row + 1]!, ...s.lines.slice(s.row + 2)];
      return { ...s, lines };
    }
    case 'left':
      if (s.col > 0) return { ...s, col: previousBoundary(line, s.col) };
      return s.row > 0 ? { ...s, row: s.row - 1, col: s.lines[s.row - 1]!.length } : s;
    case 'right':
      if (s.col < line.length) return { ...s, col: nextBoundary(line, s.col) };
      return s.row < s.lines.length - 1 ? { ...s, row: s.row + 1, col: 0 } : s;
    case 'up':
      return s.row > 0 ? { ...s, row: s.row - 1, col: columnIn(s.lines[s.row - 1]!, s.col) } : browseHistory(s, -1);
    case 'down':
      return s.row < s.lines.length - 1 ? { ...s, row: s.row + 1, col: columnIn(s.lines[s.row + 1]!, s.col) } : browseHistory(s, 1);
    case 'home':
      return { ...s, col: 0 };
    case 'end':
      return { ...s, col: line.length };
    case 'deleteWordLeft': {
      let i = s.col;
      while (i > 0 && !WORD.test(line[i - 1]!)) i--;
      while (i > 0 && WORD.test(line[i - 1]!)) i--;
      return { ...s, lines: s.lines.map((l, idx) => (idx === s.row ? l.slice(0, i) + l.slice(s.col) : l)), col: i };
    }
    case 'killToStart':
      return { ...s, lines: s.lines.map((l, i) => (i === s.row ? l.slice(s.col) : l)), col: 0 };
    case 'clear':
      return { ...createEditor(s.history), imageSeq: s.imageSeq };
    case 'set':
      return {
        ...withText({ ...s, pastes: {}, images: {}, draft: null, draftImages: null, draftPastes: null }, a.text),
        historyIndex: null,
      };
    case 'commit': {
      const text = expand(s);
      const history = text.trim() && s.history.at(-1) !== text ? [...s.history, text] : s.history;
      return { ...createEditor(history), imageSeq: s.imageSeq };
    }
  }
}
