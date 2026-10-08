import { useViewport } from '../viewport.js';
/**
 * 输入框：多行编辑（editor reducer）+ 历史 + 粘贴折叠 + 斜杠命令 / @ 文件建议。
 * 按键：Enter 提交（行尾为 \ 时换行）· Shift+Enter / Ctrl+J / Alt+Enter 换行 · ↑↓ 移行或翻历史 ·
 * Tab 应用首个建议 · Ctrl+A/E 行首/行尾 · Ctrl+U 删到行首 · Ctrl+W 删词。
 */
import { useLayoutEffect, useReducer, useRef, useState, type RefObject } from 'react';
import { Box, Text, useBoxMetrics, useCursor, useInput, usePaste, type DOMElement } from 'ink';
import { attachedImages, createEditor, editorReducer, expand, textOf, type EditorAction, type EditorState } from './editor.js';
import type { ImageBlock } from '../../core/types.js';
import type { ClipboardImage } from '../../core/clipboard.js';
import { attachmentLimit, parsePastedImagePaths, readImageAttachment } from './attachments.js';
import { suggestions, type SuggestDeps } from './suggest.js';
import { absoluteOrigin } from './cursor.js';
import { useTheme } from '../theme.js';
import { useTerminal, useGlyphs } from '../terminal.js';
import { editorViewport } from '../layout.js';
import { displayWidth, graphemes, nextBoundary, previousBoundary, truncateDisplay } from '../../core/text-width.js';
import { isMouseInput } from '../mouse.js';

export interface InputActions {
  enter(): void;
  newline(): void;
  insert(text: string): void;
}
interface Props {
  actions?: RefObject<InputActions | null>;
  active: boolean;
  placeholder: string;
  initialHistory: string[];
  /** 初始文本（如中断后放回的排队插话） */
  initialText?: string;
  /** Screen handoffs preserve the full editor, including collapsed pastes and caret. */
  initialState?: EditorState;
  onStateChange?(state: EditorState): void;
  deps: SuggestDeps;
  onSubmit(text: string, raw: string, images: ImageBlock[]): void;
  attachments?: { cwd: string; readClipboard(): Promise<ClipboardImage>; notify(text: string, tone?: 'info' | 'warn'): void };
  maxHeight?: number;
  onHelp?(): void;
  /** Read synchronously when a screen or focus changes between two input events. */
  acceptInput?(input?: string): boolean;
}

type Action = EditorAction | { type: 'replace'; state: EditorState };

function reducer(s: EditorState, a: Action): EditorState {
  return a.type === 'replace' ? a.state : editorReducer(s, a);
}

export function InputBox({
  active,
  placeholder,
  initialHistory,
  initialText,
  initialState,
  onStateChange,
  deps,
  onSubmit,
  maxHeight = 9,
  onHelp,
  acceptInput,
  actions,
  attachments,
}: Props) {
  const theme = useTheme();
  const { ascii } = useTerminal();
  const glyph = useGlyphs();
  const { columns } = useViewport();
  const [state, renderAction] = useReducer(
    reducer,
    initialHistory,
    (h) => initialState ?? (initialText ? editorReducer(createEditor(h), { type: 'set', text: initialText }) : createEditor(h)),
  );
  const editorRef = useRef(state);
  editorRef.current = state;
  const pending = useRef(0),
    reads = useRef(Promise.resolve());
  const mounted = useRef(true);
  const draftVersion = useRef(0);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const dispatch = (action: Action) => {
    const next = reducer(editorRef.current, action);
    if (['clear', 'set', 'commit'].includes(action.type) || next.historyIndex !== editorRef.current.historyIndex) draftVersion.current++;
    editorRef.current = next;
    onStateChange?.(next);
    renderAction(action);
  };
  useLayoutEffect(() => {
    onStateChange?.(state);
  }, [state, onStateChange]);
  const [selected, renderSelected] = useState(0);
  const selectedRef = useRef(selected);
  const setSelected = (value: number | ((current: number) => number)) => {
    selectedRef.current = typeof value === 'function' ? value(selectedRef.current) : value;
    renderSelected(selectedRef.current);
  };
  const [search, setSearch] = useState<string | null>(null);
  const [searchIndex, setSearchIndex] = useState(0);
  const matches = search === null ? [] : [...state.history].reverse().filter((h) => h.toLowerCase().includes(search.toLowerCase()));
  const match = matches[searchIndex % Math.max(1, matches.length)];
  const hints = active && search === null ? suggestions(state, deps) : [];
  const chosen = Math.min(selected, Math.max(0, hints.length - 1));
  const border = maxHeight >= 3 && columns >= 8;
  const imageCount = attachedImages(state, expand(state)).length;
  const imageMark = imageCount > 0 && maxHeight >= 2 ? 1 : 0;
  const prefix = imageCount && !imageMark ? truncateDisplay(`图片 ${imageCount} `, Math.max(0, columns - 1)) : `${glyph.pointer} `;
  const prefixWidth = displayWidth(prefix);
  const hintCount = Math.min(hints.length, Math.max(0, maxHeight - (border ? 3 : 1) - (search === null ? 0 : 1) - imageMark));
  const bodyHeight = Math.max(1, maxHeight - (border ? 2 : 0) - hintCount - (search === null ? 0 : 1) - imageMark);
  const viewport = editorViewport(state, Math.max(1, columns - (border ? 4 : 0) - prefixWidth), bodyHeight);

  // 真实终端光标跟随插入点（输入法候选框定位）；useBoxMetrics 让布局变化时重新计算
  const boxRef = useRef<DOMElement>(null);
  useBoxMetrics(boxRef);
  const { setCursorPosition } = useCursor();
  const origin = active ? absoluteOrigin(boxRef.current) : null;
  if (active)
    setCursorPosition(
      origin
        ? { x: origin.x + (border ? 2 : 0) + prefixWidth + viewport.caret.x, y: origin.y + (border ? 1 : 0) + viewport.caret.y }
        : undefined,
    );

  const submit = () => {
    if (!active || acceptInput?.() === false) return;
    if (pending.current > 0) {
      attachments?.notify('图片读取中', 'warn');
      return;
    }
    if (search !== null) {
      if (match) dispatch({ type: 'set', text: match });
      setSearch(null);
      return;
    }
    const state = editorRef.current,
      hints = suggestions(state, deps);
    const chosen = Math.min(selectedRef.current, Math.max(0, hints.length - 1));
    const line = state.lines[state.row]!;
    if (line.endsWith('\\') && state.col === line.length) {
      dispatch({ type: 'backspace' });
      dispatch({ type: 'newline' });
      return;
    }
    const raw = textOf(state);
    if (!raw.trim()) return;
    if (/^\/\S*$/.test(raw) && hints[chosen] && !deps.commands.some((command) => `/${command.name}` === raw)) {
      const completed = expand(hints[chosen].apply(state)).trim();
      onSubmit(completed, completed, attachedImages(state, completed));
      setSelected(0);
      return dispatch({ type: 'commit' });
    }
    onSubmit(expand(state).trim(), expand(state), attachedImages(state, expand(state)));
    return dispatch({ type: 'commit' });
  };
  useLayoutEffect(() => {
    if (!actions) return;
    actions.current = {
      enter: submit,
      newline: () => {
        if (active && acceptInput?.() !== false) dispatch({ type: 'newline' });
      },
      insert: (text) => {
        if (active && acceptInput?.() !== false) dispatch({ type: 'insert', text });
      },
    };
    return () => {
      actions.current = null;
    };
  });
  const readImages = (read: () => Promise<ImageBlock[] | string>, fallback?: string) => {
    const version = draftVersion.current;
    pending.current++;
    reads.current = reads.current.then(async () => {
      try {
        if (!mounted.current || draftVersion.current !== version) return;
        const result = await read();
        if (!mounted.current || draftVersion.current !== version) return;
        const reason =
          typeof result === 'string'
            ? result
            : attachmentLimit([...attachedImages(editorRef.current, expand(editorRef.current)), ...result]);
        if (reason) {
          if (fallback !== undefined) dispatch({ type: 'paste', text: fallback });
          attachments?.notify(reason, 'warn');
        } else if (typeof result !== 'string') for (const image of result) dispatch({ type: 'attach', image });
      } catch (err) {
        if (!mounted.current || draftVersion.current !== version) return;
        if (fallback !== undefined) dispatch({ type: 'paste', text: fallback });
        attachments?.notify(`读取图片失败：${err instanceof Error ? err.message : String(err)}`, 'warn');
      } finally {
        pending.current--;
      }
    });
  };
  usePaste(
    (text) => {
      if (acceptInput?.() === false) return;
      const paths = attachments ? parsePastedImagePaths(text, attachments.cwd) : null;
      if (!paths) return dispatch({ type: 'paste', text });
      readImages(async () => {
        const images: ImageBlock[] = [];
        for (const path of paths) {
          const image = await readImageAttachment(path);
          if (typeof image === 'string') return image;
          images.push(image);
        }
        return images;
      }, text);
    },
    { isActive: active },
  );
  useInput(
    (input, key) => {
      if (isMouseInput(input)) return;
      if (acceptInput?.(input) === false) return;
      if (attachments && (key.ctrl || key.meta) && input === 'v') {
        readImages(async () => {
          const result = await attachments.readClipboard();
          return result.ok ? [result.image] : result.reason;
        });
        return;
      }
      if (key.pageUp || key.pageDown || ((key.shift || key.ctrl) && (key.upArrow || key.downArrow))) return;
      const state = editorRef.current;
      const hints = search === null ? suggestions(state, deps) : [];
      const chosen = Math.min(selectedRef.current, Math.max(0, hints.length - 1));
      if (key.ctrl && input === 'r') {
        if (search === null) {
          setSearch('');
          setSearchIndex(0);
        } else setSearchIndex((n) => n + 1);
        return;
      }
      if (search !== null) {
        if (key.escape) return setSearch(null);
        if (key.return || key.tab) {
          if (match) dispatch({ type: 'set', text: match });
          setSearch(null);
          return;
        }
        if (key.backspace) {
          setSearch((s) => (s ?? '').slice(0, previousBoundary(s ?? '', (s ?? '').length)));
          setSearchIndex(0);
          return;
        }
        if (!key.ctrl && !key.meta && input) {
          setSearch((s) => s + input);
          setSearchIndex(0);
        }
        return;
      }
      if (input === '?' && textOf(state) === '' && onHelp) return onHelp();
      if (key.return) {
        if (key.shift || key.meta) return dispatch({ type: 'newline' });
        return submit();
      }
      if (key.ctrl && input === 'j') return dispatch({ type: 'newline' });
      if (key.tab && !key.shift && hints[chosen]) {
        setSelected(0);
        return dispatch({ type: 'replace', state: hints[chosen].apply(state) });
      }
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
      if (input) {
        setSelected(0);
        dispatch({ type: 'insert', text: input });
      }
    },
    { isActive: active },
  );

  const empty = state.lines.length === 1 && state.lines[0] === '';
  return (
    <Box flexDirection="column">
      {imageMark ? (
        <Text dimColor wrap="truncate-end">
          {truncateDisplay(`图片 ${imageCount}`, columns)}
        </Text>
      ) : null}
      <Box
        ref={boxRef}
        flexDirection="column"
        borderStyle={border ? (ascii ? 'classic' : 'round') : undefined}
        borderColor={active ? theme.accent : theme.border}
        paddingX={border ? 1 : 0}
        flexShrink={0}
      >
        {empty ? (
          <Text>
            <Text color={theme.accent}>{glyph.pointer} </Text>
            {active ? <Text inverse> </Text> : null}
            <Text dimColor>{truncateDisplay(placeholder, Math.max(0, columns - (border ? 7 : 3)))}</Text>
          </Text>
        ) : (
          viewport.lines.map((row, i) => (
            <Text key={i} wrap="truncate-end">
              <Text color={theme.accent}>{i === 0 ? prefix : ' '.repeat(prefixWidth)}</Text>
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
      {search !== null ? (
        <Text color={theme.info} wrap="truncate-end">
          Ctrl+R 搜索「{search}」 · {match ?? '没有匹配'} · Enter 载入 / Esc 返回
        </Text>
      ) : null}
      {hintCount > 0 ? (
        <Box flexDirection="column" paddingLeft={2}>
          {hints.slice(Math.max(0, chosen - hintCount + 1), Math.max(0, chosen - hintCount + 1) + hintCount).map((h) => (
            <Text key={h.label} wrap="truncate-end">
              <Text color={h === hints[chosen] ? theme.accent : undefined}>
                {h === hints[chosen] ? `${glyph.pointer} ` : '  '}
                {h.label}
              </Text>
              {h.detail ? <Text dimColor> {h.detail}</Text> : null}
              {h === hints[chosen] ? <Text dimColor> (Tab / Enter)</Text> : null}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
