/**
 * 历史配对校验：每条 assistant 消息里的 tool-call，必须在紧随其后的 user 消息中
 * 有一一对应的 tool-result（provider 对未配对历史会返回 400）。
 */
import type { Message } from '../../src/core/types.js';

export function pairingErrors(messages: Message[]): string[] {
  const errors: string[] = [];
  messages.forEach((msg, i) => {
    if (msg.role !== 'assistant') return;
    const callIds = msg.content.filter((b) => b.type === 'tool-call').map((b) => (b as { id: string }).id);
    if (callIds.length === 0) return;
    const next = messages[i + 1];
    if (!next || next.role !== 'user') {
      errors.push(`消息 #${i} 的 tool-call 之后缺少 user(tool-result) 消息`);
      return;
    }
    const resultIds = next.content
      .filter((b) => b.type === 'tool-result')
      .map((b) => (b as { toolCallId: string }).toolCallId);
    for (const id of callIds) {
      if (!resultIds.includes(id)) errors.push(`消息 #${i} 的 tool-call ${id} 没有对应 tool-result`);
    }
    for (const id of resultIds) {
      if (!callIds.includes(id)) errors.push(`消息 #${i + 1} 的 tool-result ${id} 没有对应 tool-call`);
    }
  });
  return errors;
}
