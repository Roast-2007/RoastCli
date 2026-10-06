/**
 * 输入建议（纯函数）：
 * - 以 / 开头且尚未输入空格：斜杠命令候选，Tab 补全为 "/name "
 * - 光标前的词以 @ 开头：文件候选，Tab 替换为 "@path "
 */
import { editorReducer, textOf, type EditorState } from './editor.js';

export interface CommandInfo {
  name: string;
  description: string;
  args?: string;
}

export interface Suggestion {
  label: string;
  detail?: string;
  apply(state: EditorState): EditorState;
}

export interface SuggestDeps {
  commands: readonly CommandInfo[];
  files(query: string): string[];
  members?(query: string): string[];
}

const MAX = 6;

export function suggestions(state: EditorState, deps: SuggestDeps): Suggestion[] {
  const text = textOf(state);
  if (state.lines.length === 1 && /^\/\S*$/.test(text)) {
    const q = text.slice(1).toLowerCase();
    return deps.commands
      .filter((c) => c.name.startsWith(q))
      .slice(0, MAX)
      .map((c) => ({
        label: `/${c.name}${c.args ? ` ${c.args}` : ''}`,
        detail: c.description,
        apply: (s) => editorReducer(s, { type: 'set', text: `/${c.name} ` }),
      }));
  }
  const line = state.lines[state.row]!;
  const before = line.slice(0, state.col);
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return [];
  const query = m[2]!;
  const start = before.length - query.length - 1;
  return [...(deps.members?.(query) ?? []), ...deps.files(query)].slice(0, MAX).map((file) => ({
    label: `@${file}`,
    apply: (s) => {
      const cur = s.lines[s.row]!;
      const nextLine = `${cur.slice(0, start)}@${file} ${cur.slice(s.col)}`;
      const lines = s.lines.map((l, i) => (i === s.row ? nextLine : l));
      return { ...s, lines, col: start + file.length + 2 };
    },
  }));
}
