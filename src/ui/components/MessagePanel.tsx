import { useRef, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { terminalText } from '../../core/terminal-text.js';
import { wrapDisplay } from '../../core/text-width.js';
import { useTheme } from '../theme.js';
import { useTerminal } from '../terminal.js';
import { Field } from '../providers/ProviderWizard.js';

export function MessagePanel({ title, text, height, onClose }: { title: string; text: string; height: number; onClose(): void }) {
  const theme = useTheme(), { ascii } = useTerminal(), { columns } = useWindowSize();
  const [offset, setOffset] = useState(0);
  const border = height >= 6;
  const count = Math.max(1, height - (border ? 2 : 0) - 2);
  const lines = wrapDisplay(terminalText(text), Math.max(1, columns - (border ? 4 : 0)));
  const start = Math.min(offset, Math.max(0, lines.length - count));
  useInput((input, key) => {
    if (key.escape || key.return || (key.ctrl && input === 'c')) return onClose();
    if (key.home) return setOffset(0);
    if (key.end) return setOffset(Math.max(0, lines.length - count));
    if (key.upArrow || key.pageUp) return setOffset(Math.max(0, start - (key.pageUp ? count : 1)));
    if (key.downArrow || key.pageDown) return setOffset(Math.min(Math.max(0, lines.length - count), start + (key.pageDown ? count : 1)));
  });
  return <Box flexDirection="column" height={height} overflow="hidden" flexShrink={0} borderStyle={border ? ascii ? 'classic' : 'round' : undefined} borderColor={theme.accent} paddingX={border ? 1 : 0}>
    <Text bold color={theme.accent} wrap="truncate-end">{terminalText(title)}</Text>
    <Box flexDirection="column" height={count} flexShrink={0}>{lines.slice(start, start + count).map((line, index) => <Text key={index} wrap="truncate-end">{line || ' '}</Text>)}</Box>
    <Text dimColor wrap="truncate-end">↑↓ / PgUp/PgDn 滚动 · {start + 1}/{lines.length} · Esc 返回</Text>
  </Box>;
}

export function PromptPanel({ title, height, label, optional, onSubmit, onClose }: { title: string; height: number; label: string; optional?: boolean; onSubmit(text: string): void | Promise<void>; onClose(): void }) {
  const theme = useTheme();
  const [value, setValue] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const valueRef = useRef(value); valueRef.current = value;
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return onClose();
    if (busy) return;
    if (key.return) {
      const text = valueRef.current.trim();
      if (!text && !optional) return setError('请输入内容');
      setBusy(true);
      void Promise.resolve().then(() => onSubmit(text)).catch((err) => setError(err instanceof Error ? err.message : '操作失败')).finally(() => setBusy(false));
    }
  });
  return <Box flexDirection="column" height={height} overflow="hidden" paddingX={1}>
    <Text bold color={theme.accent} wrap="truncate-end">{title}</Text>
    <Field label={label} value={value} active={!busy} onChange={(text) => { valueRef.current = text; setValue(text); }} />
    {error ? <Text color={theme.danger} wrap="truncate-end">{terminalText(error)}</Text> : null}
    <Text dimColor wrap="truncate-end">{busy ? '处理中…' : 'Enter 确认 · Esc 返回'}</Text>
  </Box>;
}
