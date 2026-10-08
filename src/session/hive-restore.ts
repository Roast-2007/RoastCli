import { readdirSync } from 'node:fs';
import path from 'node:path';
import { findRunLog } from '../cli/logs.js';
import { ROLE_INFO } from '../swarm/roles.js';
import type { BoardEntry } from '../swarm/board.js';
import type { AgentInfo, AgentRole, Report } from '../swarm/types.js';
import type { LogHeader, SessionEvent } from './events.js';
import { loadRunLog } from './projection.js';

export interface RestoredMember {
  info: AgentInfo;
  events: SessionEvent[];
  spawnTurn?: number;
}
/** 分叉链仍从来源目录读成员；history/import 只服务模型，不能覆盖原显示事件。 */
export function displaySource(
  logPath: string,
  logsRoot: string,
  seen = new Set<string>(),
  throughSeq?: number,
): { events: SessionEvent[]; runDirs: string[]; header?: LogHeader } {
  if (seen.has(logPath)) return { events: [], runDirs: [] };
  seen.add(logPath);
  const loaded = loadRunLog(logPath),
    runDirs: string[] = [],
    events: SessionEvent[] = [];
  let header = loaded.header;
  for (const event of loaded.events.filter((event) => throughSeq === undefined || event.seq === undefined || event.seq <= throughSeq)) {
    if (event.type === 'history/import') {
      const source = findRunLog(logsRoot, event.fromRunId);
      if (source && !seen.has(source)) {
        try {
          const previous = displaySource(source, logsRoot, seen, event.fromSeq);
          events.push(...previous.events);
          runDirs.push(...previous.runDirs);
          header = previous.header ?? header;
        } catch {
          /* 来源已删除时保留导入内容。 */
        }
      }
      if (!events.length) events.push(event);
    } else events.push(event);
  }
  runDirs.push(path.dirname(logPath));
  return { events, runDirs: [...new Set(runDirs)], header };
}
export function restoreHiveMembers(
  runDir: string | string[],
  mainEvents: readonly SessionEvent[],
  board: readonly BoardEntry[] = [],
): RestoredMember[] {
  const logs = new Map<string, { header: LogHeader; events: SessionEvent[] }>();
  for (const dir of typeof runDir === 'string' ? [runDir] : runDir) {
    let names: string[];
    try {
      names = readdirSync(path.join(dir, 'agents'));
    } catch {
      continue;
    }
    for (const name of names.filter((name) => /^[qlwscj]\d+\.jsonl$/.test(name))) {
      try {
        logs.set(name.slice(0, -6), loadRunLog(path.join(dir, 'agents', name)));
      } catch {
        /* 损坏的子日志不能阻止主恢复。 */
      }
    }
  }
  type Spawn = { id: string; parentId: string; role: AgentRole; profile?: string; brief: string; taskId?: string; spawnTurn?: number };
  const spawns = new Map<string, Spawn>(),
    seenIds = new Set<string>();
  const scan = (parentId: string, events: readonly SessionEvent[], inherited?: number) => {
    const calls = new Map<string, Extract<SessionEvent, { type: 'tool/call' }>>();
    for (const event of events) {
      if (event.type === 'tool/call' && event.name === 'spawn_agent') calls.set(event.callId, event);
      if (event.type === 'tool/result' && !event.isError) {
        const call = calls.get(event.callId),
          id = event.metadata?.['agentId'];
        if (!call || typeof id !== 'string') continue;
        const args = (call.args ?? {}) as { role?: AgentRole; agent?: string; task?: string; task_id?: string };
        const savedRole = event.metadata?.['role'];
        const role =
          typeof savedRole === 'string' && Object.hasOwn(ROLE_INFO, savedRole)
            ? (savedRole as AgentRole)
            : args.role && Object.hasOwn(ROLE_INFO, args.role)
              ? args.role
              : inferRole(id);
        const profile = typeof event.metadata?.['profile'] === 'string' ? event.metadata['profile'] : args.agent;
        const spawnTurn = parentId === 'main' ? call.turn : inherited;
        spawns.set(id, {
          id,
          parentId,
          role,
          ...(profile ? { profile } : {}),
          brief: typeof args.task === 'string' ? args.task : '',
          taskId: args.task_id,
          spawnTurn,
        });
        seenIds.add(id);
      }
      if (parentId === 'main' && event.type === 'rewind')
        for (const [id, spawn] of spawns) if (spawn.spawnTurn !== undefined && spawn.spawnTurn >= event.toTurn) spawns.delete(id);
    }
  };
  scan('main', mainEvents);
  const visited = new Set<string>();
  const scanChild = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const log = logs.get(id);
    if (!log || (seenIds.has(id) && !spawns.has(id))) return;
    const spawn = spawns.get(id) ?? { id, parentId: 'main', role: inferRole(id), brief: '', spawnTurn: undefined };
    spawns.set(id, spawn);
    scan(id, log.events, spawn.spawnTurn);
    for (const child of spawns.values()) if (child.parentId === id) scanChild(child.id);
  };
  for (const id of [...spawns.keys()]) scanChild(id);
  const referenced = new Set(
    [...logs.values()].flatMap((log) =>
      log.events
        .filter((event) => event.type === 'tool/result' && event.name === 'spawn_agent' && !event.isError)
        .map((event) => (event.type === 'tool/result' ? event.metadata?.['agentId'] : undefined)),
    ),
  );
  for (const id of logs.keys()) if (!referenced.has(id)) scanChild(id);
  const result: RestoredMember[] = [];
  for (const [id, log] of logs) {
    if (seenIds.has(id) && !spawns.has(id)) continue;
    // 已回退的上级子树整体隐藏，不能把孙辈作为孤儿恢复。
    if (
      !spawns.has(id) &&
      [...logs.values()].some((parent) =>
        parent.events.some((event) => event.type === 'tool/result' && event.name === 'spawn_agent' && event.metadata?.['agentId'] === id),
      )
    )
      continue;
    const spawn = spawns.get(id) ?? { id, parentId: 'main', role: inferRole(id), brief: '' };
    const calls = new Map<string, Extract<SessionEvent, { type: 'tool/call' }>>();
    let report: Report | undefined;
    for (const event of log.events) {
      if (event.type === 'tool/call' && event.name === 'report') calls.set(event.callId, event);
      if (event.type === 'tool/result' && !event.isError && calls.has(event.callId)) {
        const args = (calls.get(event.callId)!.args ?? {}) as Partial<Report>;
        if (
          args.status &&
          ['done', 'partial', 'failed', 'cancelled', 'changes_requested'].includes(args.status) &&
          typeof args.summary === 'string'
        )
          report = { agentId: id, status: args.status, summary: args.summary, refs: Array.isArray(args.refs) ? args.refs : [] };
      }
    }
    const end = log.events.filter((event) => event.type === 'turn/end').at(-1);
    if (!report) {
      const saved = board.find((entry) => entry.key === `/reports/${id}` && entry.author === id)?.value;
      const match = saved && /^\[(done|partial|failed|cancelled|changes_requested)\] ([\s\S]*)$/.exec(saved);
      if (match) report = { agentId: id, status: match[1] as Report['status'], summary: match[2]!, refs: [] };
      else if (end?.type === 'turn/end' && end.reason === 'max-steps')
        report = { agentId: id, status: 'partial', summary: '未提交 report：达到步数上限后停止。', refs: [] };
    }
    const state = report
      ? report.status === 'failed'
        ? 'failed'
        : report.status === 'cancelled'
          ? 'cancelled'
          : 'done'
      : end?.type === 'turn/end'
        ? end.reason === 'completed'
          ? 'done'
          : end.reason === 'aborted'
            ? 'cancelled'
            : 'failed'
        : 'cancelled';
    const lastAt = log.events.filter((event) => 'at' in event).at(-1);
    result.push({
      info: {
        ...spawn,
        depth: 1,
        state,
        model: `${log.header.provider}:${log.header.model}`,
        startedAt: Date.parse(log.header.createdAt) || 0,
        endedAt: lastAt && 'at' in lastAt ? Date.parse(lastAt.at) || 0 : undefined,
        report,
        children: [],
        restored: true,
      },
      events: log.events,
      spawnTurn: spawn.spawnTurn,
    });
  }
  const depth = (id: string, chain = new Set<string>()): number => {
    const parent = result.find((item) => item.info.id === id)?.info.parentId;
    if (!parent || parent === 'main' || chain.has(id)) return 1;
    chain.add(id);
    return 1 + depth(parent, chain);
  };
  for (const member of result) {
    member.info.depth = depth(member.info.id);
    member.info.children = result.filter((child) => child.info.parentId === member.info.id).map((child) => child.info.id);
  }
  return result.sort((a, b) => Number(a.info.id.slice(1)) - Number(b.info.id.slice(1)) || a.info.id.localeCompare(b.info.id));
}
function inferRole(id: string): AgentRole {
  return (Object.entries(ROLE_INFO).find(([, info]) => info.prefix === id[0])?.[0] as AgentRole | undefined) ?? 'worker';
}
