/**
 * recall 工具：取回被折叠 / 压缩的原文（"无损上下文"的另一半）。
 * - handle：工具结果的 callId（存根里的 ⟦ctx:…⟧），或 msg:<下标>（检索结果给出的消息句柄）
 * - query：在完整历史（含已折叠、已压缩部分）中关键词检索，返回片段与句柄
 * 结果以新的 tool-result 追加，不修改已发送的前缀（保护 provider 前缀缓存）。
 */
import { z } from 'zod';
import type { Message } from '../core/types.js';
import type { HistoryState } from '../session/history.js';
import { defineTool, textResult, toolErrorResult, type ToolResult } from '../tools/tool.js';

export const CONTEXT_ACCESS_KEY = 'context-access';

export interface ContextAccess {
  state(): HistoryState;
}

const MAX_CHARS = 50_000;
const SNIPPET = 160;

function blockText(content: { type: string; text?: string }[]): string {
  return content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n');
}

interface Doc {
  handle: string;
  label: string;
  text: string;
}

function documents(messages: readonly Message[]): Doc[] {
  const docs: Doc[] = [];
  messages.forEach((m, i) => {
    for (const b of m.content) {
      if (b.type === 'tool-result') docs.push({ handle: b.toolCallId, label: `${b.name} 结果`, text: blockText(b.content) });
      else if (b.type === 'text' && b.text.trim()) docs.push({ handle: `msg:${i}`, label: m.role === 'user' ? '用户消息' : '助手消息', text: b.text });
    }
  });
  return docs;
}

function lookup(messages: readonly Message[], handle: string): string | null {
  const msg = /^msg:(\d+)$/.exec(handle);
  if (msg) {
    const m = messages[Number(msg[1])];
    return m ? blockText(m.content) : null;
  }
  for (const m of messages) {
    for (const b of m.content) if (b.type === 'tool-result' && b.toolCallId === handle) return blockText(b.content);
  }
  return null;
}

function search(messages: readonly Message[], query: string, limit: number): string {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = documents(messages)
    .map((d) => {
      const lower = d.text.toLowerCase();
      const score = terms.reduce((n, t) => n + (lower.split(t).length - 1), 0);
      const hits = terms.filter((t) => lower.includes(t)).length;
      return { d, score: hits * 1000 + score, at: terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0)[0] ?? 0 };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  if (scored.length === 0) return `历史中没有找到与 "${query}" 相关的内容`;
  return scored
    .map(({ d, at }) => {
      const from = Math.max(0, at - SNIPPET / 2);
      const snippet = d.text.slice(from, from + SNIPPET).replace(/\s+/g, ' ');
      return `⟦ctx:${d.handle}⟧ ${d.label}：…${snippet}…`;
    })
    .join('\n');
}

export const recallTool = defineTool({
  name: 'recall',
  description:
    '取回上下文中被折叠或压缩的原文（无损上下文）。handle 为存根中 ⟦ctx:…⟧ 里的句柄；' +
    '不知道句柄时用 query 在完整历史中检索，结果会给出句柄。',
  parameters: z.object({
    handle: z.string().optional().describe('要取回的句柄（如工具调用 id 或 msg:12）'),
    query: z.string().optional().describe('检索关键词（空格分隔）'),
    limit: z.number().int().min(1).max(20).default(5).describe('检索返回条数'),
  }),
  isReadOnly: true,
  isConcurrencySafe: true,
  permission: { kind: 'interact' },

  async execute(args, ctx): Promise<ToolResult> {
    const access = ctx.services.get<ContextAccess>(CONTEXT_ACCESS_KEY);
    if (!access) return toolErrorResult('recall', '当前会话没有可检索的上下文');
    const messages = access.state().messages;
    if (args.handle) {
      const text = lookup(messages, args.handle);
      if (text === null) return toolErrorResult('recall', `没有找到句柄 ${args.handle}`);
      const clipped = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[... 已截断，原长 ${text.length} 字符]` : text;
      return textResult(`⟦ctx:${args.handle}⟧ 原文：\n${clipped}`, { handle: args.handle });
    }
    if (args.query) return textResult(search(messages, args.query, args.limit), { query: args.query });
    return toolErrorResult('recall', '请提供 handle 或 query');
  },
});
