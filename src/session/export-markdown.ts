import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LogHeader, SessionEvent } from './events.js';
import type { Message } from '../core/types.js';
import { deriveDisplayMessages, deriveMessages } from './projection.js';
import { terminalText } from '../core/terminal-text.js';

export function toolSummary(args: unknown): string {
  const a = args as { path?: string; command?: string; query?: string; url?: string; pattern?: string } | null;
  return terminalText(String(a?.path ?? a?.command ?? a?.query ?? a?.url ?? a?.pattern ?? ''))
    .replace(/\s+/g, ' ')
    .slice(0, 140);
}

export function transcriptMessages(header: LogHeader, events: readonly SessionEvent[]): Message[] {
  const main = events.filter((event) => !event.agentId || event.agentId === 'main');
  return header.version === 0 ? deriveMessages([header, ...main]) : deriveDisplayMessages([...main]);
}

export function assistantAnswers(header: LogHeader, events: readonly SessionEvent[]): string[] {
  return transcriptMessages(header, events)
    .filter((message) => message.role === 'assistant')
    .map((message) =>
      message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n'),
    )
    .filter((text) => text.trim());
}

function fenced(text: string): string {
  const lines = text.split(/\r?\n/),
    omitted = Math.max(0, lines.length - 30);
  const body = lines.slice(0, 30).join('\n') + (omitted ? `\n…（省略 ${omitted} 行）` : '');
  const longest = Math.max(2, ...Array.from(body.matchAll(/`+/g), (m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${body}\n${fence}`;
}

export function renderTranscriptMarkdown(header: LogHeader, events: readonly SessionEvent[]): string {
  const output = [
    `# RoastCli 会话 ${header.runId}`,
    `时间：${header.createdAt}\n模型：${header.provider}:${header.model}\ncwd：${header.cwd}`,
  ];
  for (const message of transcriptMessages(header, events)) {
    const text = message.content
      .filter((b) => b.type === 'text' || b.type === 'image')
      .map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? `[图片 ${b.mediaType}]` : ''))
      .join('\n');
    if (text) output.push(`## ${message.role === 'assistant' ? 'RoastCli' : '用户'}\n\n${text}`);
    for (const block of message.content) {
      if (block.type === 'tool-call') output.push(`**工具** \`${block.name}\` ${toolSummary(block.args)}`.trimEnd());
      if (block.type === 'tool-result') {
        const result = block.content
          .filter((b) => b.type === 'text' || b.type === 'image')
          .map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? `[图片 ${b.mediaType}]` : ''))
          .join('\n');
        output.push(`${block.isError ? '✗\n\n' : ''}${fenced(result)}`);
      }
    }
  }
  if (events.some((event) => event.type === 'tool/result' && (event.name === 'spawn_agent' || event.name === 'task') && !event.isError))
    output.push('子 agent 日志：本次运行日志目录下的 `agents/<agentId>.jsonl`。');
  return output.join('\n\n').replace(/\r\n/g, '\n') + '\n';
}

export function writeTranscript(cwd: string, runId: string, markdown: string, file?: string): string {
  for (let n = 1; ; n++) {
    const target = path.resolve(cwd, file ?? `roast-export-${runId}${n > 1 ? `-${n}` : ''}.md`);
    try {
      writeFileSync(target, markdown, { encoding: 'utf8', flag: 'wx' });
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (file) throw new Error(`文件已存在，拒绝覆盖：${target}`);
    }
  }
}
