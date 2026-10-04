/**
 * BlockAssembler：把 StreamChunk 流聚合为一条 assistant Message。
 * 契约：block-start 先于其 delta；block-end 后无该 index delta；恰好一个 finish。
 */
import { RoastError } from '../core/errors.js';
import type { ContentBlock, FinishReason, Message, StreamChunk, TokenUsage } from '../core/types.js';
import { emptyUsage } from '../core/types.js';

interface InProgressBlock {
  kind: 'text' | 'reasoning' | 'tool-call';
  text: string;
  toolCall?: { id: string; name: string };
  signature?: string;
  redactedData?: string;
}

export class BlockAssembler {
  private blocks = new Map<number, InProgressBlock>();
  private order: number[] = [];
  finishReason: FinishReason | null = null;
  finishError: RoastError | null = null;
  usage: TokenUsage = emptyUsage();

  push(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'block-start': {
        this.blocks.set(chunk.index, {
          kind: chunk.block,
          text: '',
          ...(chunk.toolCall ? { toolCall: chunk.toolCall } : {}),
          ...(chunk.redactedData !== undefined ? { redactedData: chunk.redactedData } : {}),
        });
        this.order.push(chunk.index);
        break;
      }
      case 'text-delta':
      case 'reasoning-delta': {
        const b = this.blocks.get(chunk.index);
        if (b) b.text += chunk.text;
        break;
      }
      case 'reasoning-signature': {
        const b = this.blocks.get(chunk.index);
        if (b) b.signature = (b.signature ?? '') + chunk.signature;
        break;
      }
      case 'tool-call-delta': {
        const b = this.blocks.get(chunk.index);
        if (b) b.text += chunk.argsText;
        break;
      }
      case 'block-end':
        break; // 块内容已在 delta 中累积，无需动作
      case 'usage':
        this.usage = chunk.usage;
        break;
      case 'finish':
        this.finishReason = chunk.reason;
        if (chunk.error) this.finishError = chunk.error;
        break;
    }
  }

  /** 聚合为 assistant 消息。tool-call 参数 JSON 解析失败时保留原文（{__raw}）。 */
  message(): Message {
    const content: ContentBlock[] = [];
    for (const index of this.order) {
      const b = this.blocks.get(index);
      if (!b) continue;
      if (b.kind === 'text') {
        if (b.text) content.push({ type: 'text', text: b.text });
      } else if (b.kind === 'reasoning') {
        if (b.text || b.signature || b.redactedData !== undefined) {
          content.push({
            type: 'reasoning',
            text: b.text,
            ...(b.signature ? { signature: b.signature } : {}),
            ...(b.redactedData !== undefined ? { redactedData: b.redactedData } : {}),
          });
        }
      } else {
        let args: unknown;
        try {
          args = b.text ? JSON.parse(b.text) : {};
        } catch {
          args = { __raw: b.text };
        }
        content.push({
          type: 'tool-call',
          id: b.toolCall?.id ?? `call_${index}`,
          name: b.toolCall?.name ?? 'unknown',
          args,
        });
      }
    }
    return { role: 'assistant', content };
  }
}
