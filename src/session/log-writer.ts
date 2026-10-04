/**
 * 运行日志写入器：append-only JSONL（格式 v1）。
 * 目录结构：<logsRoot>/<YYYYMMDD>/<runId>/log.jsonl（子 agent：agents/<agentId>.jsonl）
 *
 * - append 分配单调 seq 与 agentId，返回完整事件（Committer 用它喂 reducer）
 * - 批量写：同一事件循环 tick 内的事件合并为一次 appendFileSync（setImmediate 调度）；
 *   flush() 同步落盘；进程 exit 时兜底 flush。close 之后的 append 直接同步写（不丢事件）
 * - 纪律：日志写入失败绝不中断主流程；序列化失败先去掉 metadata 重试，仍失败写兜底错误行
 * - 写锁：<log>.lock 记录持有进程 pid，防止两个进程同时续写同一日志（resume 时检测）
 * - openForAppend：续写前截掉崩溃留下的末尾残行，seq 接续
 */
import { appendFileSync, mkdirSync, readFileSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { LogHeader, SessionEvent, SessionEventBody } from './events.js';
import { LOG_FORMAT_VERSION } from './events.js';

export interface RunLogInfo {
  cwd: string;
  provider: string;
  model: string;
}

export interface CreateLogOptions {
  agentId?: string;
  /** 复用已有 runId/目录（子 agent 日志与主日志同目录） */
  runDir?: string;
  runId?: string;
  /** 相对 runDir 的文件名，默认 log.jsonl */
  fileName?: string;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** runId: <YYYYMMDD>-<HHmmss>-<6位hex>，时间有序且足够避免碰撞 */
export function makeRunId(now = new Date()): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = randomBytes(3).toString('hex');
  return `${date}-${time}-${rand}`;
}

const openWriters = new Set<RunLogWriter>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const w of openWriters) {
      w.flush();
      w.releaseLock();
    }
  });
}

const lockPathOf = (logPath: string) => `${logPath}.lock`;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 日志是否正被某个存活进程持有（含本进程） */
export function isLogLocked(logPath: string): boolean {
  try {
    const pid = Number(readFileSync(lockPathOf(logPath), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 && pidAlive(pid);
  } catch {
    return false;
  }
}

function writeLock(logPath: string): void {
  try {
    writeFileSync(lockPathOf(logPath), String(process.pid), 'utf8');
  } catch {
    // 锁写失败不影响日志本身
  }
}

/** 截掉末尾不完整的行（崩溃时写了一半的事件） */
function truncateTornTail(filePath: string): void {
  try {
    const buf = readFileSync(filePath);
    if (buf.length === 0 || buf[buf.length - 1] === 0x0a) return;
    truncateSync(filePath, buf.lastIndexOf(0x0a) + 1);
  } catch {
    // 读失败：后续 append 自会失败并被吞掉
  }
}

export class RunLogWriter {
  readonly dir: string;
  readonly path: string;
  readonly header: LogHeader;
  readonly agentId: string;
  private seq: number;
  private pending: string[] = [];
  private scheduled = false;
  private closed = false;
  private locked = true;

  private constructor(filePath: string, header: LogHeader, lastSeq: number) {
    this.dir = path.dirname(filePath);
    this.path = filePath;
    this.header = header;
    this.agentId = header.agentId ?? 'main';
    this.seq = lastSeq;
    writeLock(filePath);
    openWriters.add(this);
    installExitHook();
  }

  static async create(logsRoot: string, info: RunLogInfo, opts: CreateLogOptions = {}): Promise<RunLogWriter> {
    const now = new Date();
    const runId = opts.runId ?? makeRunId(now);
    const dir = opts.runDir ?? path.join(logsRoot, runId.slice(0, 8), runId);
    const filePath = path.join(dir, opts.fileName ?? 'log.jsonl');
    mkdirSync(path.dirname(filePath), { recursive: true });

    const header: LogHeader = {
      type: 'session',
      version: LOG_FORMAT_VERSION,
      runId,
      createdAt: now.toISOString(),
      cwd: info.cwd,
      provider: info.provider,
      model: info.model,
      pid: process.pid,
      agentId: opts.agentId ?? 'main',
    };
    // header 是日志的根基，写失败直接抛（此时还没有可保护的运行状态）
    writeFileSync(filePath, JSON.stringify(header) + '\n', 'utf8');
    return new RunLogWriter(filePath, header, 0);
  }

  /** 在已有 v1 日志上继续写：截掉末尾残行，header 原样保留，seq 接续 lastSeq。调用方需先确认未被他人持有 */
  static openForAppend(filePath: string, header: LogHeader, lastSeq: number): RunLogWriter {
    truncateTornTail(filePath);
    return new RunLogWriter(filePath, header, lastSeq);
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** append-only 写一行（批量落盘；close 之后同步写）。返回带 seq/agentId 的完整事件。永不抛出。 */
  append(body: SessionEventBody): SessionEvent {
    const event: SessionEvent = { ...body, seq: ++this.seq, agentId: this.agentId };
    this.pending.push(this.serialize(event));
    if (this.closed) this.flush();
    else this.schedule();
    return event;
  }

  /** 序列化；失败时先去掉 metadata（不参与模型历史）重试，仍失败写兜底错误行 */
  private serialize(event: SessionEvent): string {
    try {
      return JSON.stringify(event);
    } catch (err) {
      if ('metadata' in event) {
        try {
          return JSON.stringify({ ...event, metadata: { dropped: '序列化失败已丢弃' } });
        } catch {
          // 落到兜底
        }
      }
      return JSON.stringify({
        type: 'error',
        at: new Date().toISOString(),
        where: 'log-writer',
        code: 'LOG_SERIALIZE',
        message: `事件序列化失败: ${err instanceof Error ? err.message : String(err)}`,
        seq: event.seq,
        agentId: this.agentId,
      });
    }
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.flush();
    });
  }

  /** 同步落盘所有待写事件 */
  flush(): void {
    if (this.pending.length === 0) return;
    const data = this.pending.join('\n') + '\n';
    this.pending = [];
    try {
      appendFileSync(this.path, data, 'utf8');
    } catch {
      // 磁盘满/权限等 IO 失败：吞掉，日志不得中断主流程
    }
  }

  /** 释放写锁（close / 进程退出时调用） */
  releaseLock(): void {
    if (!this.locked) return;
    this.locked = false;
    try {
      unlinkSync(lockPathOf(this.path));
    } catch {
      // 已不存在
    }
  }

  async close(): Promise<void> {
    this.flush();
    this.closed = true;
    this.releaseLock();
    openWriters.delete(this);
  }
}
