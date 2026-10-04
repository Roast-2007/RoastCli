/**
 * 流式 markdown 分块：把尚未提交的文本切成"已完成的块"与"仍在生成的尾巴"。
 * 已完成的块可以立即进入 <Static>（只渲染一次），活动区只需反复渲染尾巴，
 * 保证活动区高度受控（不触发 Ink 的整屏清空）且每帧只重新解析很少的文本。
 * 规则：marked.lexer 的最后一个 token 视为未完成；未闭合的代码块天然是最后一个 token。
 */
import { marked } from 'marked';

export interface SplitResult {
  complete: string[];
  rest: string;
}

export function splitStreaming(pending: string): SplitResult {
  if (!pending) return { complete: [], rest: '' };
  const tokens = marked.lexer(pending);
  if (tokens.length <= 1) return { complete: [], rest: pending };
  const done = tokens.slice(0, -1);
  const complete: string[] = [];
  let consumed = 0;
  for (const t of done) {
    consumed += t.raw.length;
    if (t.type === 'space') continue;
    complete.push(t.raw);
  }
  return { complete, rest: pending.slice(consumed) };
}
