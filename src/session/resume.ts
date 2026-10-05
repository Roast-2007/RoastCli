/**
 * 会话恢复：从运行日志重建运行时状态。
 * - v1 日志：折叠全部事件得到历史；在同一文件上继续追加（seq 接续）
 * - v0 日志 / 被其他存活进程持有的日志：新开一份 v1 日志并以 history/import 导入历史
 * - 崩溃留下的未配对 tool-call：恢复时补合成结果（v1 落 tool/result 事件；导入时直接补进消息）
 * - 文件读写状态：从 read/edit 结果 metadata.fileState 重建（edit 的"先读后改"校验在 resume 后仍有效）
 */
import { canonicalPath } from '../core/paths.js';
import type { ContentBlock, Message, ToolResultBlock } from '../core/types.js';
import type { FileState } from '../tools/fs-state.js';
import type { LogHeader, SessionEvent, SessionEventBody } from './events.js';
import { foldHistory, initialHistory, type HistoryState } from './history.js';
import { isLogLocked, RunLogWriter, type RunLogInfo } from './log-writer.js';
import { deriveMessages, loadRunLog } from './projection.js';
import { listRuns, type RunSummary } from '../cli/logs.js';
import type { PermissionMode } from '../tools/permissions/engine.js';
import { foldPermissionEvents } from '../tools/permissions/settings.js';

const INTERRUPTED_TEXT = (name: string) => `工具 ${name} 的执行因会话中断而结果未知（可能已产生部分副作用），请按需重新检查。`;

export interface DanglingCall {
  turn: number;
  step: number;
  callId: string;
  name: string;
}

export interface ResumeState {
  header: LogHeader;
  logPath: string;
  /** v1 且未被他人持有：可直接在原文件上续写；否则需新开日志并导入 */
  appendable: boolean;
  history: HistoryState;
  /** 导入用的消息（appendable=false 时有效，已补齐悬空调用） */
  importMessages: Message[];
  /** 需要补合成结果的悬空调用（appendable=true 时有效） */
  dangling: DanglingCall[];
  fileStates: [string, FileState][];
  lockedByOther: boolean;
  /** 会话级授权与最后的权限模式 */
  permissions: PermissionState;
  /** 原日志的全部事件（检查点索引等由调用方按需折叠） */
  events: SessionEvent[];
}

export interface PermissionState {
  grants: string[];
  mode?: PermissionMode;
}

function isFileState(v: unknown): v is FileState {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o['sha1'] === 'string' && typeof o['mtimeMs'] === 'number' && typeof o['size'] === 'number';
}

/** 从成功的 read/edit/write 结果重建文件状态（后出现的覆盖先出现的） */
export function rebuildFileStates(events: SessionEvent[]): [string, FileState][] {
  const map = new Map<string, [string, FileState]>();
  for (const ev of events) {
    if (ev.type !== 'tool/result' || ev.isError || !ev.metadata) continue;
    const p = ev.metadata['path'];
    const fs = ev.metadata['fileState'];
    if (typeof p === 'string' && isFileState(fs)) map.set(canonicalPath(p), [p, fs]);
    const states = ev.metadata['fileStates'];
    if (states && typeof states === 'object') for (const [file, state] of Object.entries(states)) if (isFileState(state)) map.set(canonicalPath(file), [file, state]);
  }
  return [...map.values()];
}

/** assistant 消息发起、但日志里没有对应 tool/result 的调用 */
export function danglingToolCalls(events: SessionEvent[]): DanglingCall[] {
  const pending = new Map<string, DanglingCall>();
  for (const ev of events) {
    if (ev.type === 'assistant/message') {
      for (const b of ev.message.content) {
        if (b.type === 'tool-call') pending.set(b.id, { turn: ev.turn, step: ev.step, callId: b.id, name: b.name });
      }
    } else if (ev.type === 'tool/result') {
      pending.delete(ev.callId);
    }
  }
  return [...pending.values()];
}

function interruptedBlock(callId: string, name: string): ToolResultBlock {
  return { type: 'tool-result', toolCallId: callId, name, content: [{ type: 'text', text: INTERRUPTED_TEXT(name) }], isError: true };
}

/** 消息层面补齐配对：assistant 的每个 tool-call 后面紧跟的 user 消息里都要有对应结果 */
export function repairPairing(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    out.push(m);
    if (m.role !== 'assistant') continue;
    const calls = m.content.filter((b) => b.type === 'tool-call') as { id: string; name: string }[];
    if (calls.length === 0) continue;
    const next = messages[i + 1];
    const have = new Set(
      next?.role === 'user' ? next.content.filter((b) => b.type === 'tool-result').map((b) => (b as ToolResultBlock).toolCallId) : [],
    );
    const missing: ContentBlock[] = calls.filter((c) => !have.has(c.id)).map((c) => interruptedBlock(c.id, c.name));
    if (missing.length === 0) continue;
    if (next?.role === 'user') {
      out.push({ role: 'user', content: [...missing, ...next.content] });
      i++; // 已合并下一条
    } else {
      out.push({ role: 'user', content: missing });
    }
  }
  return out;
}

export function loadResumeState(logPath: string): ResumeState {
  const { header, events } = loadRunLog(logPath);
  const fileStates = rebuildFileStates(events);
  const lockedByOther = isLogLocked(logPath);
  const permissions = foldPermissionEvents(events);
  if (header.version >= 1 && !lockedByOther) {
    return {
      header,
      logPath,
      appendable: true,
      history: foldHistory(events),
      importMessages: [],
      dangling: danglingToolCalls(events),
      fileStates,
      lockedByOther,
      permissions,
      events,
    };
  }
  const messages = header.version >= 1 ? [...foldHistory(events).messages] : deriveMessages([header, ...events]);
  const maxTurn = events.reduce((n, e) => ('turn' in e && typeof e.turn === 'number' ? Math.max(n, e.turn) : n), 0);
  return {
    header,
    logPath,
    appendable: false,
    history: { ...initialHistory(), turn: maxTurn },
    importMessages: repairPairing(messages),
    dangling: [],
    fileStates,
    lockedByOther,
    permissions,
    events,
  };
}

export interface OpenedRunLog {
  log: RunLogWriter;
  initialHistory: HistoryState;
  fileStates: [string, FileState][];
  /** 运行时创建后调用：落 session/resume（+ 悬空调用的合成结果）或 history/import 事件 */
  finalize(commit: (body: SessionEventBody) => unknown): void;
  resumedFrom?: { runId: string; messageCount: number };
  /** 原日志正被另一个进程使用，已分叉到新日志 */
  forkedFromLocked?: boolean;
  permissions?: PermissionState;
  /** 恢复来源日志的事件（新会话为空） */
  events: SessionEvent[];
}

/** 新建运行日志，或从已有日志恢复（v1 续写同一文件；v0 或被占用时新开文件并导入历史） */
export async function openRunLog(params: { logsRoot: string; info: RunLogInfo; resumeLogPath?: string }): Promise<OpenedRunLog> {
  if (!params.resumeLogPath) {
    const log = await RunLogWriter.create(params.logsRoot, params.info);
    return { log, initialHistory: initialHistory(), fileStates: [], finalize: () => {}, events: [] };
  }
  const state = loadResumeState(params.resumeLogPath);
  const at = () => new Date().toISOString();
  if (state.appendable) {
    const log = RunLogWriter.openForAppend(state.logPath, state.header, state.history.lastSeq);
    return {
      log,
      initialHistory: state.history,
      fileStates: state.fileStates,
      finalize: (commit) => {
        commit({ type: 'session/resume', at: at(), pid: process.pid });
        for (const d of state.dangling) {
          commit({
            type: 'tool/result',
            turn: d.turn,
            step: d.step,
            at: at(),
            callId: d.callId,
            name: d.name,
            isError: true,
            content: [{ type: 'text', text: INTERRUPTED_TEXT(d.name) }],
            durationMs: 0,
            metadata: { interrupted: true },
          });
        }
      },
      resumedFrom: { runId: state.header.runId, messageCount: state.history.messages.length },
      permissions: state.permissions,
      events: state.events,
    };
  }
  const log = await RunLogWriter.create(params.logsRoot, params.info);
  return {
    log,
    initialHistory: state.history,
    fileStates: state.fileStates,
    finalize: (commit) => commit({ type: 'history/import', at: at(), fromRunId: state.header.runId, messages: state.importMessages }),
    resumedFrom: { runId: state.header.runId, messageCount: state.importMessages.length },
    ...(state.lockedByOther ? { forkedFromLocked: true } : {}),
    permissions: state.permissions,
    events: state.events,
  };
}

/** 当前目录最近写入的一次运行（-c）：先按 cwd 过滤，再按日志修改时间倒序 */
export function findLatestRunFor(logsRoot: string, cwd: string): RunSummary | null {
  const target = canonicalPath(cwd);
  const mine = listRuns(logsRoot, Number.POSITIVE_INFINITY).filter((r) => r.cwd && canonicalPath(r.cwd) === target);
  mine.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return mine[0] ?? null;
}
