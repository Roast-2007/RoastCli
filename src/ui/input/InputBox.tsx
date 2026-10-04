/**
 * 输入框：多行编辑（editor reducer）+ 历史 + 粘贴折叠 + 斜杠命令 / @ 文件建议。
 * 按键：Enter 提交（行尾为 \ 时换行）· Shift+Enter / Ctrl+J / Alt+Enter 换行 · ↑↓ 移行或翻历史 ·
 * Tab 应用首个建议 · Ctrl+A/E 行首/行尾 · Ctrl+U 删到行首 · Ctrl+W 删词。
 */
import { useLayoutEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useBoxMetrics, useCursor, useInput, usePaste, useWindowSize, type DOMElement } from 'ink';
import { createEditor, editorReducer, expand, textOf, type EditorAction, type EditorState } from './editor.js';
import { suggestions, type SuggestDeps } from './suggest.js';
import { absoluteOrigin } from './cursor.js';
import { useTheme } from '../theme.js';
import { useTerminal, useGlyphs } from '../terminal.js';
import { editorViewport } from '../layout.js';
import { graphemes, nextBoundary, previousBoundary, truncateDisplay } from '../../core/text-width.js';

interface Props {
  active: boolean;
  placeholder: string;
  initialHistory: string[];
  /** 初始文本（如中断后放回的排队插话） */
  initialText?: string;
  /** Screen handoffs preserve the full editor, including collapsed pastes and caret. */
  initialState?: EditorState;
  onStateChange?(state: EditorState): void;
  deps: SuggestDeps;
  onSubmit(text: string, raw: string): void;
  maxHeight?: number;
  onHelp?(): void;
}

type Action = EditorAction | { type: 'replace'; state: EditorState };

function reducer(s: EditorState, a: Action): EditorState {
  return a.type === 'replace' ? a.state : editorReducer(s, a);
}

export function InputBox({ active, placeholder, initialHistory, initialText, initialState, onStateChange, deps, onSubmit, maxHeight = 9, onHelp }: Props) {
  const theme = useTheme();
  const { ascii } = useTerminal();
  const glyph = useGlyphs();
  const { columns } = useWindowSize();
  const [state, dispatch] = useReducer(reducer, initialHistory, (h) =>
    initialState ?? (initialText ? editorReducer(createEditor(h), { type: 'set', text: initialText }) : createEditor(h)),
  );
  useLayoutEffect(() => { onStateChange?.(state); }, [state, onStateChange]);
  const [selected, setSelected] = useState(0);
  const [search, setSearch] = useState<string | null>(null);
  const [searchIndex, setSearchIndex] = useState(0);
  const matches = search === null ? [] : [...state.history].reverse().filter((h) => h.toLowerCase().includes(search.toLowerCase()));
  const match = matches[searchIndex % Math.max(1, matches.length)];
  const hints = active && search === null ? suggestions(state, deps) : [];
  const chosen = Math.min(selected, Math.max(0, hints.length - 1));
  const border = maxHeight >= 3 && columns >= 8;
  const hintCount = Math.min(hints.length, Math.max(0, maxHeight - (border ? 3 : 1) - (search === null ? 0 : 1)));
  const bodyHeight = Math.max(1, maxHeight - (border ? 2 : 0) - hintCount - (search === null ? 0 : 1));
  const viewport = editorViewport(state, Math.max(1, columns - (border ? 6 : 2)), bodyHeight);

  // 真实终端光标跟随插入点（输入法候选框定位）；useBoxMetrics 让布局变化时重新计算
  const boxRef = useRef<DOMElement>(null);
  useBoxMetrics(boxRef);
  const { setCursorPosition } = useCursor();
  const origin = active ? absoluteOrigin(boxRef.current) : null;
  if (active) setCursorPosition(origin ? { x: origin.x + (border ? 4 : 2) + viewport.caret.x, y: origin.y + (border ? 1 : 0) + viewport.caret.y } : undefined);

  usePaste((text) => dispatch({ type: 'paste', text }), { isActive: active });
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'r') {
        if (search === null) { setSearch(''); setSearchIndex(0); }
        else setSearchIndex((n) => n + 1);
        return;
      }
      if (search !== null) {
        if (key.escape) return setSearch(null);
        if (key.return || key.tab) {
          if (match) dispatch({ type: 'set', text: match });
          setSearch(null);
          return;
        }
        if (key.backspace) { setSearch((s) => (s ?? '').slice(0, previousBoundary(s ?? '', (s ?? '').length))); setSearchIndex(0); return; }
        if (!key.ctrl && !key.meta && input) { setSearch((s) => s + input); setSearchIndex(0); }
        return;
      }
      if (input === '?' && textOf(state) === '' && onHelp) return onHelp();
      if (key.return) {
        const line = state.lines[state.row]!;
        if (key.shift || key.meta) return dispatch({ type: 'newline' });
        if (line.endsWith('\\') && state.col === line.length) {
          dispatch({ type: 'backspace' });
          return dispatch({ type: 'newline' });
        }
        const raw = textOf(state);
        if (!raw.trim()) return;
        onSubmit(expand(state).trim(), expand(state));
        return dispatch({ type: 'commit' });
      }
      if (key.ctrl && input === 'j') return dispatch({ type: 'newline' });
      if (key.tab && !key.shift && hints[chosen]) { setSelected(0); return dispatch({ type: 'replace', state: hints[chosen].apply(state) }); }
      if (hints.length && key.upArrow) return setSelected((s) => (s + hints.length - 1) % hints.length);
      if (hints.length && key.downArrow) return setSelected((s) => (s + 1) % hints.length);
      if (key.upArrow) return dispatch({ type: 'up' });
      if (key.downArrow) return dispatch({ type: 'down' });
      if (key.leftArrow) return dispatch({ type: 'left' });
      if (key.rightArrow) return dispatch({ type: 'right' });
      if (key.home || (key.ctrl && input === 'a')) return dispatch({ type: 'home' });
      if (key.end || (key.ctrl && input === 'e')) return dispatch({ type: 'end' });
      if (key.ctrl && input === 'u') return dispatch({ type: 'killToStart' });
      if (key.ctrl && input === 'w') return dispatch({ type: 'deleteWordLeft' });
      if (key.backspace) return dispatch({ type: 'backspace' });
      if (key.delete) return dispatch({ type: 'delete' });
      if (key.ctrl || key.meta || key.escape || key.tab) return;
      if (input) { setSelected(0); dispatch({ type: 'insert', text: input }); }
    },
    { isActive: active },
  );

  const empty = state.lines.length === 1 && state.lines[0] === '';
  return (
    <Box flexDirection="column">
      <Box ref={boxRef} flexDirection="column" borderStyle={border ? ascii ? 'classic' : 'round' : undefined} borderColor={active ? theme.accent : theme.border} paddingX={border ? 1 : 0} flexShrink={0}>
        {empty ? (
          <Text>
            <Text color={theme.accent}>{glyph.pointer} </Text>
            {active ? <Text inverse> </Text> : null}
            <Text dimColor>{truncateDisplay(placeholder, Math.max(0, columns - (border ? 7 : 3)))}</Text>
          </Text>
        ) : (
          viewport.lines.map((row, i) => (
            <Text key={i} wrap="truncate-end">
              <Text color={theme.accent}>{i === 0 ? `${glyph.pointer} ` : '  '}</Text>
              {i === viewport.caret.y && active ? (
                <>
                  {row.text.slice(0, state.col - row.start)}
                  <Text inverse>{graphemes(row.text.slice(state.col - row.start))[0]?.text ?? ' '}</Text>
                  {row.text.slice(nextBoundary(row.text, state.col - row.start))}
                </>
              ) : (
                row.text
              )}
            </Text>
          ))
        )}
      </Box>
      {search !== null ? <Text color={theme.info} wrap="truncate-end">Ctrl+R 搜索「{search}」 · {match ?? '没有匹配'} · Enter 载入 / Esc 返回</Text> : null}
      {hintCount > 0 ? (
        <Box flexDirection="column" paddingLeft={2}>
          {hints.slice(Math.max(0, chosen - hintCount + 1), Math.max(0, chosen - hintCount + 1) + hintCount).map((h) => (
            <Text key={h.label} wrap="truncate-end">
              <Text color={h === hints[chosen] ? theme.accent : undefined}>{h === hints[chosen] ? `${glyph.pointer} ` : '  '}{h.label}</Text>
              {h.detail ? <Text dimColor>  {h.detail}</Text> : null}
              {h === hints[chosen] ? <Text dimColor>  (Tab)</Text> : null}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
