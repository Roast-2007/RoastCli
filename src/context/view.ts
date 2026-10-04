/**
 * 视图投影：历史 + 上下文状态 → 发给模型的 Message[]（纯函数）。
 * - 被折叠的 tool-result 只替换内容为存根（block 保留，tool-call/result 配对不变）
 * - 压缩：messages[0, upTo) 由摘要替代，摘要并入切点处的 user 消息开头（切点总在 user 文本消息前）
 * 运行时与回放/不变量测试共用此函数：request/digest.viewHash = hash(buildView(state))。
 */
import type { ContentBlock, Message, ToolResultBlock } from '../core/types.js';
import type { HistoryState } from '../session/history.js';

export function stubText(info: { callId: string; name: string; tokens?: number; preview?: string; reason?: string }): string {
  const size = info.tokens ? `约 ${info.tokens} tokens` : '已省略';
  const head = `⟦ctx:${info.callId}⟧ ${info.name} 的结果已折叠（${size}${info.reason ? `，${info.reason}` : ''}）。需要原文时调用 recall({"handle":"${info.callId}"})。`;
  return info.preview ? `${head}\n预览：\n${info.preview}` : head;
}

export function summaryText(summary: string): string {
  return `<summary>\n以下是更早对话的摘要（原文已归档，可用 recall 检索）：\n\n${summary}\n</summary>`;
}

function elideBlock(b: ContentBlock, state: HistoryState): ContentBlock {
  if (b.type !== 'tool-result') return b;
  const info = state.context.elided[b.toolCallId];
  if (!info) return b;
  const stub: ToolResultBlock = {
    ...b,
    content: [{ type: 'text', text: stubText({ callId: b.toolCallId, name: b.name, ...info }) }],
  };
  return stub;
}

export function buildView(state: HistoryState): Message[] {
  const { compaction, elided } = state.context;
  const hasElided = Object.keys(elided).length > 0;
  if (!compaction && !hasElided) return [...state.messages];
  const start = compaction ? Math.min(compaction.upTo, state.messages.length) : 0;
  const body = state.messages.slice(start).map((m) =>
    hasElided && m.role === 'user' && m.content.some((b) => b.type === 'tool-result')
      ? { ...m, content: m.content.map((b) => elideBlock(b, state)) }
      : m,
  );
  if (!compaction) return body;
  const first = body[0];
  const summary: ContentBlock = { type: 'text', text: summaryText(compaction.summary) };
  if (first && first.role === 'user') return [{ role: 'user', content: [summary, ...first.content] }, ...body.slice(1)];
  return [{ role: 'user', content: [summary] }, ...body];
}
