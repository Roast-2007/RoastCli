import { Text } from 'ink';
import { terminalText } from '../../core/terminal-text.js';
import { useTerminal } from '../terminal.js';
export function QueueLine({ texts }: { texts: string[] }) {
  const { ascii } = useTerminal();
  return texts.length ? <Text dimColor wrap="truncate-end">{ascii ? '>' : '⏵'} 已排队 {texts.length} 条：{terminalText(texts[0]!).replace(/\s+/g, ' ')}…</Text> : null;
}
