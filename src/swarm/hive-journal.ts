import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { BoardEntry } from './board.js';
import type { Envelope } from './types.js';

export interface HivePartial {
  turn: number;
  agentId: string;
  text: string;
  at: string;
  agentTurn?: number;
}
type BoardRecord = { type: 'board'; turn: number; entry: BoardEntry };
type MessageRecord = { type: 'message'; turn: number; envelope: Envelope; recipients: string[] };
type PartialRecord = { type: 'partial' } & HivePartial;
export type HiveRecord = (
  | BoardRecord
  | MessageRecord
  | PartialRecord
  | { type: 'rewind'; toTurn: number; at: string }
  | { type: 'snapshot'; turn: number; board: BoardRecord[]; messages: MessageRecord[]; partials: HivePartial[] }
) & { v: 1 };
export interface HiveState {
  board: BoardEntry[];
  messages: Envelope[];
  partials: HivePartial[];
}
const entry = z.object({ key: z.string(), value: z.string(), version: z.number(), author: z.string(), at: z.number() });
const envelope = z.object({
  id: z.string(),
  from: z.string(),
  to: z.union([
    z.literal('broadcast'),
    z.object({ agent: z.string() }),
    z.object({ rel: z.enum(['parent', 'children', 'siblings']) }),
    z.object({ role: z.enum(['queen', 'lead', 'worker', 'scout', 'critic', 'judge']) }),
    z.object({ topic: z.string() }),
  ]),
  kind: z.enum(['task', 'report', 'question', 'answer', 'info', 'alert', 'steer']),
  subject: z.string(),
  body: z.string(),
  refs: z.array(z.string()),
  replyTo: z.string().optional(),
  hop: z.number(),
  at: z.number(),
});
const turn = z.number().int().nonnegative();
const board = z.object({ type: z.literal('board'), turn, entry });
const message = z.object({ type: z.literal('message'), turn, envelope, recipients: z.array(z.string()) });
const partial = z.object({ turn, agentId: z.string(), text: z.string(), at: z.string(), agentTurn: turn.optional() });
const schema = z.intersection(
  z.object({ v: z.literal(1) }),
  z.discriminatedUnion('type', [
    board,
    message,
    partial.extend({ type: z.literal('partial') }),
    z.object({ type: z.literal('rewind'), toTurn: turn, at: z.string() }),
    z.object({ type: z.literal('snapshot'), turn, board: z.array(board), messages: z.array(message), partials: z.array(partial) }),
  ]),
);
export function readHiveRecords(runDir: string): HiveRecord[] {
  let raw: string;
  try {
    raw = readFileSync(path.join(runDir, 'hive.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const records: HiveRecord[] = [];
  for (const line of raw.split('\n')) {
    try {
      const parsed = schema.safeParse(JSON.parse(line));
      if (parsed.success) records.push(parsed.data);
    } catch {
      /* 坏行、未知版本不影响主会话。 */
    }
  }
  return records;
}
function history(records: readonly HiveRecord[]) {
  let boards: BoardRecord[] = [],
    messages: MessageRecord[] = [],
    partials: HivePartial[] = [];
  for (const record of records) {
    if (record.type === 'snapshot') {
      boards = [...record.board];
      messages = [...record.messages];
      partials = [...record.partials];
    } else if (record.type === 'board') boards.push(record);
    else if (record.type === 'message') {
      if (!messages.some((item) => item.envelope.id === record.envelope.id)) messages.push(record);
    } else if (record.type === 'partial') partials.push(record);
    else {
      boards = boards.filter((item) => item.turn < record.toTurn);
      messages = messages.filter((item) => item.turn < record.toTurn);
      partials = partials.filter((item) => item.turn < record.toTurn);
    }
  }
  return { boards, messages, partials };
}
export function foldHive(records: readonly HiveRecord[]): HiveState {
  const folded = history(records),
    board = new Map<string, BoardEntry>();
  for (const record of folded.boards) board.set(record.entry.key, record.entry);
  return { board: [...board.values()], messages: folded.messages.slice(-50).map((record) => record.envelope), partials: folded.partials };
}
/** 主进程单写者；落盘失败仅降级，内存状态继续服务 UI 与模型。 */
export class HiveJournal {
  private records: HiveRecord[];
  constructor(
    private readonly runDir: string,
    initial: HiveRecord[] = [],
  ) {
    this.records = [...initial];
  }
  state(): HiveState {
    return foldHive(this.records);
  }
  append(record: HiveRecord): void {
    this.records.push(record);
    try {
      appendFileSync(path.join(this.runDir, 'hive.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      /* 与主日志相同：写入失败不打断任务。 */
    }
  }
  message(turn: number, envelope: Envelope, recipients: string[]): void {
    if (!history(this.records).messages.some((item) => item.envelope.id === envelope.id))
      this.append({ v: 1, type: 'message', turn, envelope, recipients });
  }
  snapshot(turn: number): void {
    const folded = history(this.records);
    this.append({ v: 1, type: 'snapshot', turn, board: folded.boards, messages: folded.messages, partials: folded.partials });
  }
}
