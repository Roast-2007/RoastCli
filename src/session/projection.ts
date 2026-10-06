/**
 * 投影层：从 JSONL 事件流重建模型可见的 Message[]，以及日志文件读取。
 * v1 日志走 history reducer（与运行时同一实现）；v0 日志走旧投影算法（只读兼容）。
 */
import { readFileSync } from 'node:fs';
import { RoastError } from '../core/errors.js';
import type { Message, ToolResultBlock } from '../core/types.js';
import type { LogHeader, SessionEvent } from './events.js';
import { KNOWN_EVENT_TYPES, SUPPORTED_LOG_VERSIONS } from './events.js';
import { foldHistory } from './history.js';

/** 从事件流投影模型历史；header（若在数组里）决定版本，否则以事件是否带 seq 判断 */
export function deriveMessages(events: (LogHeader | SessionEvent)[]): Message[] {
  const header = events.find((e): e is LogHeader => e.type === 'session');
  const body = events.filter((e): e is SessionEvent => e.type !== 'session');
  const isV1 = header ? header.version >= 1 : body.some((e) => e.seq !== undefined);
  return isV1 ? [...foldHistory(body).messages] : deriveMessagesV0(body);
}

/** Terminal history hides internal attachments and projects missions as goals. */
export function deriveDisplayMessages(events: SessionEvent[]): Message[] {
  return [...foldHistory(events.filter((event) => event.type !== 'attachment/injected').map((event): SessionEvent => event.type === 'hive/mission'
    ? { type: 'user/message', turn: event.turn, at: event.at, seq: event.seq, message: { role: 'user', content: [{ type: 'text', text: `⬡ 任务 #${event.missionId.slice(1)} · ${event.strategy} · ${event.goal}` }] } }
    : event)).messages];
}

/**
 * 从事件流投影出模型历史：
 * - user/message → user 消息
 * - assistant/message → assistant 消息（含 tool-call blocks）
 * - tool/result → user 角色消息中的 tool-result blocks；
 *   同一 (turn, step) 的连续 tool/result 合并进一条 user 消息，顺序按 callId 出现顺序
 * - chunk / usage / header 等事件被忽略
 */
function deriveMessagesV0(events: SessionEvent[]): Message[] {
  const messages: Message[] = [];
  /** 当前正在累积 tool-result 的 user 消息及其 (turn, step) 键 */
  let pendingKey: string | null = null;

  for (const ev of events) {
    if (ev.type === 'user/message') {
      pendingKey = null;
      messages.push(ev.message);
    } else if (ev.type === 'assistant/message') {
      pendingKey = null;
      messages.push(ev.message);
    } else if (ev.type === 'tool/result') {
      const key = `${ev.turn}:${ev.step}`;
      const block: ToolResultBlock = {
        type: 'tool-result',
        toolCallId: ev.callId,
        name: ev.name,
        content: ev.content,
        ...(ev.isError ? { isError: true } : {}),
      };
      const last = messages[messages.length - 1];
      if (pendingKey === key && last && last.role === 'user') {
        last.content.push(block);
      } else {
        pendingKey = key;
        messages.push({ role: 'user', content: [block] });
      }
    }
    // 其余事件（chunk / usage / turn/step / request/* / error / header）不进入模型历史
  }
  return messages;
}

/**
 * 读取 log.jsonl：第一行必须是 version 匹配的 header；
 * 未知事件 type 抛 RoastError('CONFIG')；
 * 容忍最后一行截断（torn line，崩溃时常见）。
 */
export function loadRunLog(logPath: string): { header: LogHeader; events: SessionEvent[] } {
  let raw: string;
  try {
    raw = readFileSync(logPath, 'utf8');
  } catch (err) {
    throw new RoastError('CONFIG', `无法读取运行日志: ${logPath}`, { cause: err });
  }

  const lines = raw.split('\n');
  // 去掉末尾空行（split 尾部分隔符产生的 ''）
  while (lines.length > 0) {
    const tail = lines[lines.length - 1];
    if (tail === undefined || tail.trim() === '') lines.pop();
    else break;
  }
  if (lines.length === 0) {
    throw new RoastError('CONFIG', `运行日志为空: ${logPath}`);
  }
  const headerLine = lines[0];
  if (headerLine === undefined) {
    throw new RoastError('CONFIG', `运行日志为空: ${logPath}`);
  }

  // header
  let header: LogHeader;
  try {
    header = JSON.parse(headerLine) as LogHeader;
  } catch (err) {
    throw new RoastError('CONFIG', `运行日志 header 不是合法 JSON: ${logPath}`, { cause: err });
  }
  if (header.type !== 'session') {
    throw new RoastError('CONFIG', `运行日志首行不是 session header: ${logPath}`);
  }
  if (!SUPPORTED_LOG_VERSIONS.includes(header.version)) {
    throw new RoastError(
      'CONFIG',
      `日志格式版本不匹配: 支持 ${SUPPORTED_LOG_VERSIONS.join('/')}，实际 ${String(header.version)} (${logPath})`,
    );
  }

  // events
  const known = new Set<string>(KNOWN_EVENT_TYPES);
  const events: SessionEvent[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      // torn line：仅当位于文件末尾时丢弃（进程崩溃写了一半）
      if (i === lines.length - 1) break;
      throw new RoastError('CONFIG', `运行日志第 ${i + 1} 行 JSON 解析失败: ${logPath}`, { cause: err });
    }
    const type = (parsed as { type?: unknown }).type;
    if (typeof type !== 'string' || !known.has(type)) {
      throw new RoastError('CONFIG', `运行日志第 ${i + 1} 行包含未知事件类型: ${String(type)} (${logPath})`);
    }
    events.push(parsed as SessionEvent);
  }

  return { header, events };
}
