import { useRef, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { terminalText } from '../../core/terminal-text.js';
import { wrapDisplay } from '../../core/text-width.js';
import { useTheme } from '../theme.js';
import { useTerminal } from '../terminal.js';
import { Field } from '../providers/ProviderWizard.js';
import { panelLayout, useScroll } from '../scroll.js';
import { motionColor, useEntrance } from '../motion.js';

export function MessagePanel({ title, text, height, onClose }: { title: string; text: string; height: number; onClose(): void }) {
  const theme = useTheme(), { ascii } = useTerminal(), { columns } = useWindowSize();
  const layout = panelLayout(height, columns), { border, count } = layout;
  const lines = wrapDisplay(terminalText(text), layout.width);
  const scroll = useScroll(lines.length, count), { start } = scroll;
  const progress = useEntrance(title);
  const accent = motionColor(theme.border, theme.accent, progress);
  useInput((input, key) => {
    if (key.escape || key.return || (key.ctrl && input === 'c')) return onClose();
    scroll.onKey(input, key);
  });
  return <Box flexDirection="column" height={height} overflow="hidden" flexShrink={0} borderStyle={border ? ascii ? 'classic' : 'round' : undefined} borderColor={accent} paddingX={border ? 1 : 0}>
    {layout.header ? <Text bold color={accent} wrap="truncate-end">{terminalText(title).replace(/\s+/g, ' ')}</Text> : null}
    <Box flexDirection="column" height={count} flexShrink={0}>{lines.slice(start, start + count).map((line, index) => <Text key={index} wrap="truncate-end">{line || ' '}</Text>)}</Box>
    {layout.footer ? <Text dimColor wrap="truncate-end">{scroll.max ? `${ascii ? 'j/k' : '↑↓'} 滚动 · ${start + 1}–${Math.min(lines.length, start + count)}/${lines.length} · ` : ''}Esc 返回</Text> : null}
  </Box>;
}

export function PromptPanel({ title, height, label, optional, onSubmit, onClose }: { title: string; height: number; label: string; optional?: boolean; onSubmit(text: string): void | Promise<void>; onClose(): void }) {
  const theme = useTheme();
  const { columns } = useWindowSize();
  const accent = motionColor(theme.border, theme.accent, useEntrance(title));
  const [value, setValue] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const valueRef = useRef(value); valueRef.current = value;
  const pending = useRef(false);
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return onClose();
    if (pending.current) return;
    if (key.return) {
      const text = valueRef.current.trim();
      if (!text && !optional) return setError('请输入内容');
      pending.current = true; setBusy(true);
      try {
        void Promise.resolve(onSubmit(text)).catch((err) => setError(err instanceof Error ? err.message : '操作失败')).finally(() => { pending.current = false; setBusy(false); });
      } catch (err) { pending.current = false; setBusy(false); setError(err instanceof Error ? err.message : '操作失败'); }
    }
  });
  const showTitle = height >= 4, showLabel = height >= 3;
  return <Box flexDirection="column" height={height} overflow="hidden" paddingX={columns >= 8 ? 1 : 0}>
    {showTitle ? <Text bold color={accent} wrap="truncate-end">{terminalText(title)}</Text> : null}
    <Field label={label} showLabel={showLabel} value={value} active={!busy} acceptInput={() => !pending.current} onChange={(text) => { valueRef.current = text; setValue(text); }} />
    {height >= 2 ? <Text color={error ? theme.danger : theme.muted} wrap="truncate-end">{error ? terminalText(error) : busy ? '处理中…' : 'Enter 确认 · Esc 返回'}</Text> : null}
  </Box>;
}
