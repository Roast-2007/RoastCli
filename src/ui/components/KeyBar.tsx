import { useRef } from 'react';
import { Box, Text, useInput, useBoxMetrics, type DOMElement } from 'ink';
import type { InteractionRequest } from '../../core/interaction.js';
import { displayWidth } from '../../core/text-width.js';
import { useTheme } from '../theme.js';
import { useTerminal } from '../terminal.js';
import { absoluteOrigin } from '../input/cursor.js';
import { parseMouse } from '../mouse.js';
export interface KeyHint {
  key: string;
  label: string;
  action: string;
}
export interface KeyContext {
  screen: 'hive' | 'chat';
  focus?: string;
  running?: boolean;
  reading?: boolean;
  detail?: boolean;
  zoom?: boolean;
  output?: boolean;
  card?: InteractionRequest;
  tabs?: number;
}
const item = (key: string, label: string, action: string): KeyHint => ({ key, label, action });
export function keyHints(context: KeyContext): KeyHint[] {
  const { screen, focus = 'input', running, reading, detail, card } = context;
  if (card) {
    if (card.kind === 'question') return (card.options ?? []).map((label, index) => item(String(index + 1), label, `approve:${index}`));
    const remember = !card.forced && card.suggestedRule !== undefined;
    return [
      item('1', '允许一次', 'approve:0'),
      ...(remember ? [item('2', '本会话', 'approve:1'), item('3', '本项目', 'approve:2')] : []),
      item('4', '拒绝', `approve:${remember ? 3 : 1}`),
      item('↑↓ Enter', '选择', 'approval-next'),
    ];
  }
  if (detail)
    return [
      item('←', '上一个', 'tool-previous'),
      item('→', '下一个', 'tool-next'),
      item('↑↓', '滚动', 'tool-scroll'),
      item('Esc/Ctrl+O', '关闭', 'tool-close'),
    ];
  if (context.zoom)
    return [
      item('双击工具', '详情', 'tool-open'),
      item('↑↓', '滚动', 'scroll'),
      item('PgUp/PgDn', '翻页', 'page'),
      item('g/G', '顶/底', 'top'),
      item('Esc', '返回', 'zoom-close'),
    ];
  if (screen === 'chat') {
    if (reading)
      return [item('↑↓', '滚动', 'read-scroll'), item('PgUp/PgDn', '翻页', 'read-page'), item('End/Esc', '返回输入', 'read-close')];
    if (running)
      return [
        item('Esc', '中断', 'interrupt'),
        item('Enter', '排队插话', 'submit'),
        item('Shift+↑↓', '阅读', 'read-page'),
        item('Ctrl+O', '工具输出', 'tool-open'),
      ];
    return [
      item('Enter', '发送', 'submit'),
      item('Shift+Enter', '换行', 'newline'),
      item('/', '命令', 'commands'),
      item('@', '文件', 'mention'),
      item('Ctrl+G', 'Hive', 'switch'),
      item('?', '帮助', 'help'),
    ];
  }
  if (focus === 'colony')
    return [
      item('↑↓', '选择', 'select-next'),
      item('Enter', '看输出', 'output'),
      item('Space', '菜单', 'menu'),
      item('m', '指示', 'steer'),
      item('p', '暂停', 'pause'),
      item('x×2', '取消', 'cancel'),
      item('d', '改动', 'diff'),
      item('Esc', '返回输入', 'input'),
    ];
  if (focus === 'mission')
    return [
      ...(context.output ? [item('双击/Enter', '全屏输出', 'zoom-open')] : []),
      item(`1-${context.tabs ?? 6}`, '切页', 'tab-next'),
      item('↑↓', '滚动', 'scroll'),
      item('PgUp/PgDn', '翻页', 'page'),
      item('g/G', '顶/底', 'top'),
      item('Tab', '下一栏', 'focus-next'),
      item('Esc', '返回输入', 'input'),
    ];
  if (focus === 'signals')
    return [
      item('↑↓', '滚动', 'scroll'),
      item('Enter', '打开', 'signal'),
      item('Tab', '下一栏', 'focus-next'),
      item('Esc', '返回输入', 'input'),
    ];
  return running
    ? [
        item('Enter', '插话', 'submit'),
        item('Esc', '中断', 'interrupt'),
        item('@', '指挥成员', 'mention'),
        item('点击/F6', '面板', 'focus-next'),
        item('Ctrl+O', '工具输出', 'tool-open'),
        item('?', '帮助', 'help'),
      ]
    : [
        item('Enter', '发起任务', 'submit'),
        item('@', '指挥成员', 'mention'),
        item('/', '命令', 'commands'),
        item('点击/F6', '面板', 'focus-next'),
        item('Ctrl+G', '对话', 'switch'),
        item('?', '帮助', 'help'),
      ];
}
/** Whole items only; lower-priority items disappear from the right. */
export function fitKeyHints(items: KeyHint[], columns: number) {
  const shown: (KeyHint & { x: number; width: number })[] = [];
  let x = 0;
  for (const hint of items) {
    const width = displayWidth(`${hint.key} ${hint.label}`);
    if (x + width > columns) break;
    shown.push({ ...hint, x, width });
    x += width + 2;
  }
  return shown;
}
export function KeyBar({ items, columns, onAction }: { items: KeyHint[]; columns: number; onAction?(action: string): void }) {
  const theme = useTheme(),
    { mouse } = useTerminal(),
    box = useRef<DOMElement>(null);
  useBoxMetrics(box);
  const shown = fitKeyHints(items, columns);
  useInput(
    (input) => {
      if (!onAction || mouse === false) return;
      const origin = absoluteOrigin(box.current);
      if (!origin) return;
      for (const event of parseMouse(input)) {
        if (event.kind !== 'press' || event.button !== 'left' || event.shift || event.y !== origin.y) continue;
        const hint = shown.find((hint) => event.x >= origin.x + hint.x && event.x < origin.x + hint.x + hint.width);
        if (hint) onAction(hint.action);
      }
    },
    { isActive: Boolean(onAction) },
  );
  return (
    <Box ref={box} height={1} flexShrink={0}>
      <Text wrap="truncate-end">
        {shown.map((hint, index) => (
          <Text key={hint.action}>
            {index ? '  ' : ''}
            <Text color={theme.accent} bold>
              {hint.key}
            </Text>
            <Text color={theme.muted}> {hint.label}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}
