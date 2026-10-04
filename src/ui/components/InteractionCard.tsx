import { useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type { InteractionRequest, InteractionResponse } from '../../core/interaction.js';
import { terminalText } from '../../core/terminal-text.js';
import { wrapDisplay } from '../../core/text-width.js';
import { useTheme } from '../theme.js';
import { useTerminal, useGlyphs } from '../terminal.js';
import { InputBox } from '../input/InputBox.js';
import { textOf } from '../input/editor.js';

interface Props { request: InteractionRequest; onRespond(response: InteractionResponse): void; maxHeight?: number }

export function InteractionCard({ request, onRespond, maxHeight = 16 }: Props) {
  const theme = useTheme();
  const { ascii } = useTerminal();
  const glyph = useGlyphs();
  const { columns } = useWindowSize();
  const [selected, setSelected] = useState(0);
  const [offset, setOffset] = useState(0);
  const [draft, setDraft] = useState('');
  const border = maxHeight >= 8;
  const remember = request.kind === 'permission' && !request.forced && request.suggestedRule !== undefined;
  const permissionOptions = remember ? ['1 允许本次', '2 本会话始终允许', '3 本项目始终允许', '4 拒绝 (Esc)'] : ['1 允许本次', '4 拒绝 (Esc)'];
  const options = request.kind === 'permission' ? permissionOptions : request.options ?? [];
  const answer = (index: number) => {
    if (request.kind === 'question') return onRespond({ kind: 'question', answer: options[index]! });
    if (index === options.length - 1) return onRespond({ kind: 'permission', decision: 'deny' });
    onRespond({ kind: 'permission', decision: 'allow', ...(remember && index > 0 ? { remember: index === 1 ? 'session' as const : 'project' as const } : {}) });
  };
  const question = request.kind === 'question';
  const inputHeight = question ? Math.min(3, Math.max(1, maxHeight - 3)) : 0;
  const optionsHeight = Math.min(options.length, Math.max(0, maxHeight - (border ? 2 : 0) - 3 - inputHeight));
  const detailHeight = Math.max(0, maxHeight - (border ? 2 : 0) - 2 - optionsHeight - inputHeight);
  const detail = wrapDisplay(terminalText(question ? request.question : `${request.title}\n${request.detail ?? ''}\n原因：${request.reason}${remember ? `\n授权规则：${request.suggestedRule}` : ''}`), Math.max(1, columns - (border ? 4 : 0)));
  const start = Math.min(offset, Math.max(0, detail.length - detailHeight));
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return onRespond(question ? { kind: 'question', answer: '（用户未作答）' } : { kind: 'permission', decision: 'deny' });
    if (key.pageUp) return setOffset(Math.max(0, start - Math.max(1, detailHeight)));
    if (key.pageDown) return setOffset(Math.min(Math.max(0, detail.length - detailHeight), start + Math.max(1, detailHeight)));
    if (options.length && (key.upArrow || key.downArrow) && !draft) return setSelected((s) => (s + (key.upArrow ? options.length - 1 : 1)) % options.length);
    if (key.return && !draft && options.length) return answer(selected);
    if (question) {
      if (!draft && /^[1-9]$/.test(input) && Number(input) <= options.length) answer(Number(input) - 1);
    } else {
      if (input === '1' || input === 'y') return answer(0);
      if (remember && (input === '2' || input === '3')) return answer(Number(input) - 1);
      if (input === '4' || input === 'n') return answer(options.length - 1);
    }
  });
  const firstOption = Math.max(0, selected - optionsHeight + 1);
  const color = request.kind === 'permission' ? request.forced ? theme.danger : theme.warn : theme.info;
  return <Box flexDirection="column" borderStyle={border ? ascii ? 'classic' : 'round' : undefined} borderColor={color} paddingX={border ? 1 : 0} flexShrink={0}>
    <Text bold color={color} wrap="truncate-end">{question ? '需要你的回答' : request.forced ? `${glyph.warning} ${request.reason.startsWith('高危操作') ? '高危操作' : '操作'}需要确认` : '需要你的授权'}{request.agentId !== 'main' ? `（agent ${request.agentId}）` : ''}</Text>
    {detail.slice(start, start + detailHeight).map((line, i) => <Text key={i} wrap="truncate-end">{line || ' '}</Text>)}
    {options.slice(firstOption, firstOption + optionsHeight).map((option, i) => <Text key={i} color={firstOption + i === selected ? theme.accent : undefined} wrap="truncate-end">{firstOption + i === selected ? `${glyph.pointer} ` : '  '}{question ? `${firstOption + i + 1} ` : ''}{terminalText(option)}</Text>)}
    {question ? <InputBox active placeholder="按数字选择，或输入回答后回车" initialHistory={[]} deps={{ commands: [], files: () => [] }} maxHeight={inputHeight} onStateChange={(s) => setDraft(textOf(s))} onSubmit={(answer) => onRespond({ kind: 'question', answer })} /> : null}
    <Text dimColor wrap="truncate-end">{question ? '↑↓ 选择 · Enter 回答 · Esc 跳过' : '1/y 允许 · 4/n 拒绝 · ↑↓ 选择 · Enter 确认'}{detail.length > detailHeight ? ` · PgUp/PgDn 详情 ${start + 1}/${detail.length}` : ''}</Text>
  </Box>;
}
