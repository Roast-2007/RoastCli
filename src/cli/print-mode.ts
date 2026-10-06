/**
 * 管道（print）模式核心：消费 AsyncGenerator<UiEvent>，纯文本流式输出。
 * 抽成纯函数便于单测 —— out/err 只要求可写流接口（{ write }）。
 */
import type { UiEvent } from '../agent/ui-events.js';
import { terminalText } from '../core/terminal-text.js';
import type { RuntimeInput } from '../agent/runtime.js';

export interface WritableLike {
  write(chunk: string): unknown;
}

/** 结构上与 AgentLoop 对齐的最小接口（方便测试用 mock） */
export interface PrintLoop {
  run(userText: RuntimeInput, signal?: AbortSignal): AsyncGenerator<UiEvent>;
}

/**
 * 跑一个 turn 并把事件流转成纯文本：
 * - text-delta → 直接写 stdout（reasoning-delta 不输出）
 * - tool-call-start → `> tool: <name>`
 * - tool-call-end → `  ✓ <preview>` / `  ✗ <preview>`
 * - error → stderr，退出码置 1
 * 返回退出码：completed → 0；error/aborted/max-steps → 1
 */
export async function runPrintMode(
  loop: PrintLoop,
  prompt: RuntimeInput,
  out: WritableLike,
  err: WritableLike,
  signal?: AbortSignal,
): Promise<number> {
  let exitCode = 0;
  /** 是否处于未换行的流式文本中间（工具行/错误行前需要补换行） */
  let textOpen = false;
  const closeText = () => {
    if (textOpen) {
      out.write('\n');
      textOpen = false;
    }
  };

  for await (const ev of loop.run(prompt, signal)) {
    switch (ev.type) {
      case 'text-delta':
        out.write(ev.text);
        textOpen = true;
        break;
      case 'reasoning-delta':
        break;
      case 'tool-call-start':
        closeText();
        const args = ev.args as { path?: string; command?: string; query?: string; url?: string; pattern?: string } | null;
        const summary = terminalText(String(args?.path ?? args?.command ?? args?.query ?? args?.url ?? args?.pattern ?? '')).replace(/\s+/g, ' ').slice(0, 140);
        out.write(`> tool: ${ev.name}${summary ? ` · ${summary}` : ''}\n`);
        break;
      case 'tool-call-end':
        closeText();
        out.write(`  ${ev.isError ? '✗' : '✓'} ${ev.preview}\n`);
        break;
      case 'usage':
      case 'hive/mission':
      case 'turn-start':
      case 'user-injected':
      case 'queue-restored':
        break;
      case 'stream-reset':
        closeText();
        err.write('[流中断，已丢弃部分输出，重试中]\n');
        break;
      case 'retry':
        err.write(`[重试 #${ev.attempt} ${ev.code}，${Math.round(ev.delayMs / 100) / 10}s 后]\n`);
        break;
      case 'notice':
        closeText();
        err.write(`[${ev.text}]\n`);
        break;
      case 'waiting':
        closeText();
        err.write(`[等待: ${ev.reason}]\n`);
        break;
      case 'error':
        closeText();
        err.write(`error [${ev.error.code}] ${ev.error.message}\n`);
        exitCode = 1;
        break;
      case 'turn-end':
        closeText();
        if (ev.reason !== 'completed') exitCode = 1;
        break;
    }
  }
  return exitCode;
}

/** stream-json 的最小会话接口（主 agent 事件流 + 子 agent 事件订阅） */
export interface StreamJsonSession {
  loop: PrintLoop;
  onAgentEvent(listener: (agentId: string, ev: UiEvent) => void): () => void;
}

/**
 * stream-json 输出：每行一个 {"agent": id, "event": UiEvent}，包含主会话与全部子 agent。
 * 返回退出码规则同 runPrintMode。
 */
export async function runStreamJson(session: StreamJsonSession, prompt: RuntimeInput, out: WritableLike, signal?: AbortSignal): Promise<number> {
  const write = (agent: string, event: UiEvent) => out.write(JSON.stringify({ agent, event }) + '\n');
  const off = session.onAgentEvent(write);
  let exitCode = 0;
  try {
    for await (const ev of session.loop.run(prompt, signal)) {
      write('main', ev);
      if (ev.type === 'error') exitCode = 1;
      if (ev.type === 'turn-end' && ev.reason !== 'completed') exitCode = 1;
    }
  } finally {
    off();
  }
  return exitCode;
}
