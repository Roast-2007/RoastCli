import { parseMouse } from '../mouse.js';
import { absoluteOrigin } from '../input/cursor.js';
import { useViewport } from '../viewport.js';
import { useRef, useState } from 'react';
import { Box, Text, useInput, useBoxMetrics, type DOMElement } from 'ink';
import type { InteractionRequest, InteractionResponse } from '../../core/interaction.js';
import { terminalText } from '../../core/terminal-text.js';
import { wrapDisplay } from '../../core/text-width.js';
import { useTheme } from '../theme.js';
import { useTerminal, useGlyphs } from '../terminal.js';
import { InputBox } from '../input/InputBox.js';
import { textOf } from '../input/editor.js';
import { useScroll } from '../scroll.js';
import { motionColor, useEntrance } from '../motion.js';

interface Props { request: InteractionRequest; onRespond(response: InteractionResponse): void; onInterrupt?(): void; maxHeight?: number }

export function InteractionCard({ request, onRespond, onInterrupt, maxHeight = 16 }: Props) {
  const theme = useTheme();
  const { ascii, mouse } = useTerminal();
  const glyph = useGlyphs();
  const { columns } = useViewport();
  const box = useRef<DOMElement>(null);
  useBoxMetrics(box);
  const [selected, setSelected] = useState(0);
  const [draft, setDraft] = useState('');
  const [full, setFull] = useState(false);
  const selectionRef = useRef(0), draftRef = useRef(''), responded = useRef(false);
  const respond = (response: InteractionResponse) => { if (!responded.current) { responded.current = true; onRespond(response); } };
  const border = maxHeight >= 8 && columns >= 8;
  const remember = request.kind === 'permission' && !request.forced && request.suggestedRule !== undefined;
  const permissionOptions = remember ? ['1 允许本次', '2 本会话始终允许', '3 本项目始终允许', '4 拒绝 (Esc)'] : ['1 允许本次', '4 拒绝 (Esc)'];
  const options = request.kind === 'permission' ? permissionOptions : request.options ?? [];
  const answer = (index: number) => {
    if (request.kind === 'question') return respond({ kind: 'question', answer: options[index]! });
    if (index === options.length - 1) return respond({ kind: 'permission', decision: 'deny' });
    respond({ kind: 'permission', decision: 'allow', ...(remember && index > 0 ? { remember: index === 1 ? 'session' as const : 'project' as const } : {}) });
  };
  const question = request.kind === 'question';
  const inner = Math.max(1, maxHeight - (border ? 2 : 0));
  const header = inner >= (question ? 5 : 3) ? 1 : 0, footer = inner >= (question ? 3 : 2) ? 1 : 0;
  const inputHeight = question ? inner >= 9 ? 3 : 1 : 0;
  const optionsHeight = Math.min(options.length, Math.max(0, inner - header - footer - inputHeight - (inner >= (question ? 2 : 4) ? 1 : 0)));
  const detailHeight = Math.max(0, inner - header - footer - optionsHeight - inputHeight);
  const preview = !question ? request.preview ?? [] : [];
  const content = question ? request.question : full ? `${request.fullDetail ?? request.detail ?? request.title}\n原因：${request.reason}` : `${request.title}\n${request.detail ?? ''}\n原因：${request.reason}${remember ? `\n授权规则：${request.suggestedRule}` : ''}${preview.length ? `\n${preview.slice(0, 12).join('\n')}${preview.length > 12 ? `\n… 另 ${preview.length - 12} 行，Ctrl+O 查看` : ''}` : ''}`;
  const detail = wrapDisplay(terminalText(content), Math.max(1, columns - (border ? 4 : 0)));
  const scroll = useScroll(detail.length, detailHeight), { start } = scroll;
  useInput((input, key) => {
    if (responded.current) return;
    const events = parseMouse(input);
    if (events.length) {
      const origin = absoluteOrigin(box.current);
      if (mouse === false || !origin) return;
      for (const event of events) {
        if (event.x < origin.x || event.x >= origin.x + columns || event.y < origin.y || event.y >= origin.y + maxHeight) continue;
        if (event.kind === 'wheel') { scroll.move(scroll.position() + (event.delta ?? 0)); continue; }
        if (event.kind !== 'press' || event.button !== 'left') continue;
        const row = event.y - origin.y - Number(border) - header - detail.slice(start, start + detailHeight).length;
        if (row >= 0 && row < optionsHeight) answer(firstOption + row);
      }
      return;
    }
    if (key.ctrl && input === 'o') { setFull((value) => !value); scroll.move(0); return; }
    if (key.ctrl && input === 'c' && onInterrupt) return onInterrupt();
    if (key.escape || (key.ctrl && input === 'c')) return respond(question ? { kind: 'question', answer: '（用户未作答）' } : { kind: 'permission', decision: 'deny' });
    if (key.pageUp || key.pageDown) return scroll.onKey(input, key);
    if (options.length && (key.upArrow || key.downArrow) && !draftRef.current) { selectionRef.current = (selectionRef.current + (key.upArrow ? options.length - 1 : 1)) % options.length; return setSelected(selectionRef.current); }
    if (key.return && !draftRef.current && options.length) return answer(selectionRef.current);
    if (question) {
      if (!draftRef.current && /^[1-9]$/.test(input) && Number(input) <= options.length) answer(Number(input) - 1);
    } else {
      if (input === '1' || input === 'y') return answer(0);
      if (remember && (input === '2' || input === '3')) return answer(Number(input) - 1);
      if (input === '4' || input === 'n') return answer(options.length - 1);
    }
  });
  const firstOption = Math.max(0, selected - optionsHeight + 1);
  const color = request.kind === 'permission' ? request.forced ? theme.danger : theme.warn : theme.info;
  const accent = motionColor(theme.border, color, useEntrance(request.id));
  return <Box ref={box} width={columns} height={maxHeight} overflow="hidden" flexDirection="column" borderStyle={border ? ascii ? 'classic' : 'round' : undefined} borderColor={accent} paddingX={border ? 1 : 0} flexShrink={0}>
    {header ? <Text bold color={color} wrap="truncate-end">{question ? '需要你的回答' : request.forced ? `${glyph.warning} ${request.reason.startsWith('高危操作') ? '高危操作' : '操作'}需要确认` : '需要你的授权'}{request.agentId !== 'main' ? `（agent ${request.agentId}）` : ''}</Text> : null}
    {detail.slice(start, start + detailHeight).map((line, i) => <Text key={i} wrap="truncate-end">{line || ' '}</Text>)}
    {options.slice(firstOption, firstOption + optionsHeight).map((option, i) => <Text key={i} color={firstOption + i === selected ? theme.accent : undefined} wrap="truncate-end">{firstOption + i === selected ? `${glyph.pointer} ` : '  '}{question ? `${firstOption + i + 1} ` : ''}{terminalText(option).replace(/\s+/g, ' ')}</Text>)}
    {question ? <InputBox active={!responded.current} acceptInput={(input) => !responded.current && !(options.length && !draftRef.current && /^[1-9]$/.test(input ?? '') && Number(input) <= options.length)} placeholder="输入回答后回车" initialHistory={[]} deps={{ commands: [], files: () => [] }} maxHeight={inputHeight} onStateChange={(s) => { draftRef.current = textOf(s); setDraft(draftRef.current); }} onSubmit={(answer) => respond({ kind: 'question', answer })} /> : null}
    {footer ? <Text dimColor wrap="truncate-end">{question ? `${options.length && !draft ? '↑↓ 选择 · ' : ''}Enter 回答 · Esc 跳过` : '1/y 允许 · 4/n 拒绝 · ↑↓ 选择 · Enter 确认'}{detail.length > detailHeight ? ` · PgUp/PgDn 详情 ${start + 1}/${detail.length}` : ''}</Text> : null}
  </Box>;
}
