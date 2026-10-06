import { DeckHelp } from '../hive/DeckHelp.js';
import { useState } from 'react';
import { useInput } from 'ink';
import type { Session } from '../../agent/session.js';
import type { UiStore, OverlayKind } from '../store/store.js';
import type { UiController } from '../controller.js';
import { COMMANDS, KEYS_HELP, mcpPromptCommands } from '../commands.js';
import { formatContextStats } from '../format-context.js';
import { listRuns } from '../../cli/logs.js';
import { logsRootOf } from '../../agent/session.js';
import { canonicalPath } from '../../core/paths.js';
import { CommandPanel } from './CommandPanel.js';
import { MessagePanel } from './MessagePanel.js';
import { SelectPanel } from './SelectPanel.js';

type Props = { kind: OverlayKind; session: Session; store: UiStore; controller: UiController; height: number; deck?: boolean };

export function Overlay(props: Props) {
  if (props.kind === 'help' && props.deck) return <DeckHelp store={props.store} height={props.height} />;
  if (props.kind === 'help') return <HelpPanel {...props} />;
  if (props.kind === 'context') return <ContextPanel {...props} />;
  if (props.kind === 'rewind' || props.kind === 'sessions') return <HistoryPanel {...props} />;
  return <CommandPanel {...props} />;
}

function HelpPanel({ session, store, height }: Props) {
  const close = () => store.setMeta({ overlay: null });
  useInput((input) => { if (input === '?') close(); });
  return <MessagePanel title="帮助 · ROAST" text={`${KEYS_HELP}\n\n命令：\n${[...COMMANDS, ...mcpPromptCommands(session)].map((c) => `/${c.name}${c.args ? ` ${c.args}` : ''}\n  ${c.description}`).join('\n\n')}`} height={height} onClose={close} />;
}

function ContextPanel({ session, store, controller, height }: Props) {
  const [manage, setManage] = useState(false), [item, setItem] = useState<string | null>(null);
  const stats = session.contextStats();
  const close = () => store.setMeta({ overlay: null });
  useInput((input) => { if (!manage && input === 'm' && stats.largest.length) setManage(true); });
  if (!manage) return <MessagePanel title={`上下文 · Context${stats.largest.length ? ' · m 管理工具结果' : ''}`} text={formatContextStats(stats)} height={height} onClose={close} />;
  const selected = stats.largest.find((entry) => entry.id === item);
  if (selected) return <SelectPanel key={selected.id} title={`上下文 · ${selected.id}`} height={height} entries={[
    { id: selected.pinned ? 'unpin' : 'pin', label: selected.pinned ? '取消钉住' : '钉住工具结果' },
    { id: 'drop', label: '折叠工具结果（仍可 recall）' },
  ]} onClose={() => setItem(null)} onSelect={(entry) => { controller.runCommand(`/context ${entry.id} ${selected.id}`); setItem(null); }} />;
  return <SelectPanel key="tools" title="上下文 · 管理工具结果" height={height} entries={stats.largest.map((entry) => ({ id: entry.id, label: `${entry.id} · ${entry.name} · ${entry.tokens} tokens${entry.pinned ? ' · 已钉住' : entry.elided ? ' · 已折叠' : ''}` }))} onClose={() => setManage(false)} onSelect={(entry) => setItem(entry.id)} />;
}

function HistoryPanel({ kind, session, store, controller, height }: Props) {
  const [turn, setTurn] = useState<number | null>(null);
  const close = () => store.setMeta({ overlay: null });
  if (kind === 'rewind') {
    if (turn !== null) return <SelectPanel key="confirm" title={`回退至第 ${turn} 轮开始前？`} message="恢复文件与对话；回退后的轮次仍保存在日志中" height={height} entries={[{ id: 'confirm', label: `确认回退至第 ${turn} 轮` }, { id: 'back', label: '返回轮次列表' }]} onClose={() => setTurn(null)} onSelect={(entry) => { if (entry.id === 'back') return setTurn(null); close(); controller.runCommand(`/rewind ${turn}`); }} />;
    return <SelectPanel key="turns" searchable title="可回退的轮次 · 文件 + 对话" height={height} message={session.listTurns().length ? undefined : '还没有可回退的轮次'} entries={session.listTurns().slice().reverse().map((t) => ({ id: String(t.turn), label: `${t.turn}. ${t.text}` }))} onClose={close} onSelect={(entry) => setTurn(Number(entry.id))} />;
  }
  const runs = listRuns(logsRootOf(session.config, session.log.header.cwd), 100).filter((r) => canonicalPath(r.cwd) === canonicalPath(session.log.header.cwd) && r.runId !== session.log.header.runId).sort((a, b) => b.mtimeMs - a.mtimeMs);
  return <SelectPanel searchable title="恢复会话 · 最近活动优先" height={height} message={runs.length ? undefined : '没有其他历史会话'} entries={runs.map((r) => ({ id: r.logPath, label: `${r.runId} · ${r.provider}:${r.model} · ${new Date(r.mtimeMs).toLocaleString()}` }))} onClose={close} onSelect={(entry) => { close(); controller.resumeSession(entry.id); }} />;
}
