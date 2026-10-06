import { useViewport } from '../viewport.js';
import { useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { loadConfig, trustProject, trustState } from '../../core/config.js';
import { trustSummary } from '../../cli/trust.js';
import { terminalText } from '../../core/terminal-text.js';
import { wrapDisplay } from '../../core/text-width.js';
import { pickTheme, ThemeContext } from '../theme.js';
import { TerminalContext, terminalPreferences } from '../terminal.js';
import { SelectPanel } from './SelectPanel.js';
import { MessagePanel } from './MessagePanel.js';

export interface TrustPanelProps { cwd: string; onExit(trusted: boolean): void }

export function TrustPanel(props: TrustPanelProps) {
  const theme = useMemo(() => pickTheme(process.env), []);
  const terminal = useMemo(() => {
    try { return terminalPreferences(process.env, loadConfig(props.cwd)?.ui); }
    catch { return terminalPreferences(process.env); }
  }, [props.cwd]);
  return <ThemeContext.Provider value={theme}><TerminalContext.Provider value={terminal}><FolderTrust {...props} /></TerminalContext.Provider></ThemeContext.Provider>;
}

function FolderTrust({ cwd, onExit }: TrustPanelProps) {
  const { rows, columns } = useViewport();
  const [details, setDetails] = useState(false);
  const changed = trustState(cwd) === 'changed';
  const summary = useMemo(() => {
    try { return trustSummary(cwd); }
    catch (err) { return [err instanceof Error ? err.message : '无法读取项目配置']; }
  }, [cwd]);
  const text = `${cwd}\n\n信任后允许项目的供应商连接、钩子、MCP 和权限 allow 规则生效。\n\n${summary.length ? summary.join('\n') : '当前没有需要启用的项目配置。'}`;
  if (details) return <MessagePanel title="文件夹信任 · 项目配置" text={text} height={rows} onClose={() => setDetails(false)} />;
  const pathLines = wrapDisplay(terminalText(cwd), Math.max(1, columns - 2)).slice(0, rows >= 12 ? 3 : 1);
  return <Box width={columns} flexDirection="column" height={rows} overflow="hidden" paddingX={1}>
    <Text bold wrap="truncate-end">{changed ? '文件夹的相关配置已变化，请重新确认信任' : '是否信任此文件夹？'}</Text>
    {pathLines.map((line, index) => <Text key={index} dimColor wrap="truncate-end">{line}</Text>)}
    <SelectPanel title="文件夹信任" height={Math.max(1, rows - 2 - pathLines.length)} message="仅信任你熟悉的文件夹；可先查看项目配置" entries={[
      { id: 'trust', label: '信任此文件夹并继续' },
      { id: 'details', label: '查看完整路径与项目配置' },
      { id: 'exit', label: '退出' },
    ]} onClose={() => onExit(false)} onSelect={(entry) => {
      if (entry.id === 'details') { setDetails(true); return; }
      if (entry.id === 'exit') return onExit(false);
      trustProject(cwd); onExit(true);
    }} />
  </Box>;
}
