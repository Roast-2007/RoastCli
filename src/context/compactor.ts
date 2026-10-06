/**
 * 抽取式兜底摘要器。会话装配默认使用 model-summary.ts 的模型摘要，失败时回退到这里：
 * 从被压缩的历史中抽取 用户请求 / 涉及文件 / 执行过的命令 / 错误 / 最近结论 五类信息。
 * 原文仍完整保存在日志中，模型可用 recall 检索。
 */
import type { Message, TokenUsage, ToolCallBlock } from '../core/types.js';
import { emptyUsage } from '../core/types.js';
import type { ModelRef } from '../core/config.js';

export interface Summarizer {
  summarize(messages: readonly Message[], focus: string | undefined, signal: AbortSignal): Promise<{ summary: string; usage: TokenUsage; model?: ModelRef }>;
}

const MAX_LINE = 200;
const MAX_ITEMS = 40;
const RECENT_CONCLUSIONS = 3;
const FILE_VERBS: Record<string, string> = { read: '读取', edit: '修改', multi_edit: '修改', write: '写入' };

const clip = (s: string, n = MAX_LINE) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

function textOf(m: Message): string {
  return m.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n').trim();
}

function section(title: string, items: string[]): string {
  if (items.length === 0) return '';
  const shown = items.slice(-MAX_ITEMS);
  const more = items.length > shown.length ? [`- …（更早的 ${items.length - shown.length} 项已省略）`] : [];
  return `## ${title}\n${[...more, ...shown].join('\n')}`;
}

export function extractSummary(messages: readonly Message[], focus?: string): string {
  const requests: string[] = [];
  const files = new Map<string, Set<string>>();
  const commands: string[] = [];
  const errors: string[] = [];
  const conclusions: string[] = [];
  const calls = new Map<string, ToolCallBlock>();

  for (const m of messages) {
    if (m.role === 'user') {
      const raw = textOf(m);
      const text = /<goal>\s*([\s\S]*?)\s*<\/goal>/.exec(raw)?.[1] ?? raw;
      if (text && !text.startsWith('<summary>')) requests.push(`- ${clip(text)}`);
      if (text.startsWith('<summary>')) requests.push(`- （此前已有摘要）${clip(text.replace(/<\/?summary>/g, ''), 600)}`);
    }
    for (const b of m.content) {
      if (b.type === 'tool-call') {
        calls.set(b.id, b);
        const args = b.args as { path?: unknown; command?: unknown };
        if (typeof args.path === 'string' && FILE_VERBS[b.name]) {
          const verbs = files.get(args.path) ?? new Set<string>();
          verbs.add(FILE_VERBS[b.name]!);
          files.set(args.path, verbs);
        }
        if (b.name === 'bash' && typeof args.command === 'string') commands.push(`- \`${clip(args.command, 120)}\``);
      } else if (b.type === 'tool-result' && b.isError) {
        const first = b.content.find((c) => c.type === 'text');
        errors.push(`- ${b.name}: ${clip(first && first.type === 'text' ? first.text : '（无内容）')}`);
      }
    }
    if (m.role === 'assistant') {
      const text = textOf(m);
      if (text) conclusions.push(`- ${clip(text, 500)}`);
    }
  }

  const fileItems = [...files].map(([p, verbs]) => `- ${p}（${[...verbs].join('、')}）`);
  return [
    focus ? `## 本次压缩的关注点\n${focus}` : '',
    section('用户请求（按时间）', requests),
    section('涉及文件', fileItems),
    section('执行过的命令', commands),
    section('错误与失败', errors),
    section('最近的结论', conclusions.slice(-RECENT_CONCLUSIONS)),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export const extractiveSummarizer: Summarizer = {
  async summarize(messages, focus) {
    return { summary: extractSummary(messages, focus), usage: emptyUsage() };
  },
};
