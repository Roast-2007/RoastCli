import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { useTerminal } from '../terminal.js';
import { truncateDisplay } from '../../core/text-width.js';
export const EMPTY_GUIDES = ['Queen 制定计划后显示在这里（黑板 /mission/plan）', '选中的成员还没有输出 · 在蜂群栏点击其他成员', '选中写代码的成员（worker / lead）查看它的改动', '成员之间的消息', '成员共享的中间结果', '本任务的 token 与费用', '审批请求、成员消息和黑板更新会显示在这里'];
function GuideText({ text }: { text: string }) {
  const theme = useTheme();
  return <>{text.split(/(Enter|@成员|\/strategy|\?)/g).map((part, index) => <Text key={index} color={index % 2 ? theme.accent : theme.muted}>{part}</Text>)}</>;
}
export function MissionGuide({ height, width, strategy, n }: { height: number; width: number; strategy: string; n: number }) {
  const theme = useTheme(), { ascii } = useTerminal();
  const lines = [
    { key: '', text: `${ascii ? '*' : '⬡'}  H I V E` }, { key: '', text: '' },
    { key: '1', text: '在下方写下目标，按 Enter 发起任务' },
    { key: '2', text: 'Queen 拆解计划，派出成员并行工作' },
    { key: '3', text: '在这里看计划、输出和改动，用 @成员 随时指挥' },
    { key: '', text: '' }, { key: '', text: `策略 ${strategy} · n ${n}    /strategy 更换 · ? 全部操作` },
  ].slice(0, height);
  return <Box height={height} flexDirection="column" justifyContent="center" alignItems="center" overflow="hidden">{lines.map((line, index) => <Text key={index} color={theme.muted} wrap="truncate-end"><Text color={theme.accent}>{line.key ? `${line.key}   ` : ''}</Text><GuideText text={truncateDisplay(line.text, Math.max(0, width - (line.key ? 4 : 0)))} /></Text>)}</Box>;
}
