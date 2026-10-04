import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Session } from '../../agent/session.js';
import type { UiStore, OverlayKind } from '../store/store.js';
import type { UiController } from '../controller.js';
import { COMMANDS, KEYS_HELP } from '../commands.js';
import { formatContextStats } from '../format-context.js';
import { useTheme } from '../theme.js';
import { useTerminal, useGlyphs } from '../terminal.js';
import { terminalText } from '../../core/terminal-text.js';
import { listRuns } from '../../cli/logs.js';
import { logsRootOf } from '../../agent/session.js';
import { canonicalPath } from '../../core/paths.js';

export function Overlay({ kind, session, store, controller, height }: { kind: OverlayKind; session: Session; store: UiStore; controller: UiController; height: number }) {
  const theme = useTheme();
  const { ascii } = useTerminal();
  const glyph = useGlyphs();
  const [selected, setSelected] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const close = () => store.setMeta({ overlay: null });
  const turns = session.listTurns().slice().reverse();
  const stats = session.contextStats();
  const runs = kind === 'sessions' ? listRuns(logsRootOf(session.config, session.log.header.cwd), 100).filter((r) => canonicalPath(r.cwd) === canonicalPath(session.log.header.cwd) && r.runId !== session.log.header.runId).sort((a, b) => b.mtimeMs - a.mtimeMs) : [];
  const entries = kind === 'help' ? [...KEYS_HELP.split('\n'), '', ...COMMANDS.map((c) => `/${c.name} ${c.args ?? ''}  ${c.description}`)] : kind === 'rewind' ? turns.map((t) => `${t.turn}. ${t.text}`) : kind === 'sessions' ? runs.map((r) => `${r.runId} · ${r.provider}:${r.model} · ${new Date(r.mtimeMs).toLocaleString()}`) : formatContextStats(stats).split('\n');
  const border = height >= 6;
  const count = Math.max(1, height - (border ? 2 : 0) - 2);
  const index = Math.min(selected, Math.max(0, entries.length - 1));
  const first = Math.max(0, index - count + 1);
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c') || input === '?') { if (confirm) setConfirm(false); else close(); return; }
    if (key.upArrow || input === 'k') { setConfirm(false); return setSelected(Math.max(0, index - 1)); }
    if (key.downArrow || input === 'j') { setConfirm(false); return setSelected(Math.min(entries.length - 1, index + 1)); }
    if (key.pageUp) return setSelected(Math.max(0, index - count));
    if (key.pageDown) return setSelected(Math.min(entries.length - 1, index + count));
    if (key.return && kind === 'rewind' && turns[index]) {
      if (!confirm) return setConfirm(true);
      close(); controller.runCommand(`/rewind ${turns[index]!.turn}`);
    }
    if (key.return && kind === 'sessions' && runs[index]) { close(); controller.resumeSession(runs[index]!.logPath); }
    if (kind === 'context' && ['p', 'u', 'd'].includes(input)) {
      const item = stats.largest.find((entry) => entries[index]?.includes(entry.id));
      if (item) controller.runCommand(`/context ${input === 'p' ? 'pin' : input === 'u' ? 'unpin' : 'drop'} ${item.id}`);
    }
  });
  return <Box flexDirection="column" borderStyle={border ? ascii ? 'classic' : 'round' : undefined} borderColor={theme.accent} paddingX={border ? 1 : 0} height={height} overflow="hidden" flexShrink={0}>
    <Text bold color={theme.accent} wrap="truncate-end">{kind === 'help' ? '帮助 · ROAST' : kind === 'rewind' ? '可回退的轮次 · 文件 + 对话' : kind === 'sessions' ? '恢复会话 · 最近活动优先' : '上下文 · Context'}</Text>
    {entries.length ? entries.slice(first, first + count).map((line, i) => <Text key={i} wrap="truncate-end" color={first + i === index ? theme.accent2 : undefined}>{(kind === 'rewind' || kind === 'sessions') && first + i === index ? `${glyph.pointer} ` : '  '}{terminalText(line)}</Text>) : <Text dimColor>{kind === 'sessions' ? '没有其他历史会话' : '还没有可回退的轮次'}</Text>}
    <Text color={confirm ? theme.warn : theme.muted} wrap="truncate-end">{confirm ? `再按 Enter 回退至第 ${turns[index]?.turn} 轮开始前；Esc 取消` : `↑↓ 选择 · PgUp/PgDn 翻页${kind === 'rewind' ? ' · Enter 回退' : kind === 'context' ? ' · p 钉住 / u 取消 / d 折叠' : ''} · Esc 关闭`}</Text>
  </Box>;
}
