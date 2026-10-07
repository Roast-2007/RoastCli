/**
 * Blackboard：蜂群共享的层级 KV（如 /mission/auth/api-contract）。
 * - 版本号 + CAS 写入（expect 不匹配时返回当前版本，防止覆盖他人更新）
 * - watch(prefix)：写入时只通知"键 vN 由谁更新"，正文由订阅者按需 board_read —— 通信不占上下文
 */

export interface BoardEntry {
  key: string;
  value: string;
  version: number;
  author: string;
  at: number;
}

export type BoardMeta = Omit<BoardEntry, 'value'> & { chars: number };

export type WriteResult = { ok: true; version: number } | { ok: false; current: number };

export type WatchNotify = (watcher: string, entry: BoardMeta) => void;

function normalizeKey(key: string): string {
  const k = `/${key}`.replace(/\/+/g, '/');
  return k.length > 1 && k.endsWith('/') ? k.slice(0, -1) : k;
}

export class Blackboard {
  private readonly entries = new Map<string, BoardEntry>();
  private readonly watches: { prefix: string; agentId: string }[] = [];
  private readonly writeListeners = new Set<(e: BoardEntry) => void>();

  constructor(
    private readonly notify: WatchNotify = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  onWrite(l: (e: BoardEntry) => void): () => void {
    this.writeListeners.add(l);
    return () => this.writeListeners.delete(l);
  }
  /** 整体恢复，不触发 watch 或持久化监听。 */
  restore(entries: readonly BoardEntry[]): void {
    this.entries.clear();
    for (const entry of entries) this.entries.set(entry.key, { ...entry });
  }

  read(key: string): BoardEntry | undefined {
    return this.entries.get(normalizeKey(key));
  }

  list(prefix = '/'): BoardMeta[] {
    const p = normalizeKey(prefix);
    return [...this.entries.values()]
      .filter((e) => p === '/' || e.key === p || e.key.startsWith(`${p}/`))
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(({ value, ...meta }) => ({ ...meta, chars: value.length }));
  }

  write(key: string, value: string, opts: { author: string; expect?: number }): WriteResult {
    const k = normalizeKey(key);
    const current = this.entries.get(k);
    const version = current?.version ?? 0;
    if (opts.expect !== undefined && opts.expect !== version) return { ok: false, current: version };
    const entry: BoardEntry = { key: k, value, version: version + 1, author: opts.author, at: this.now() };
    this.entries.set(k, entry);
    for (const l of this.writeListeners) l(entry);
    const meta: BoardMeta = { key: k, version: entry.version, author: entry.author, at: entry.at, chars: value.length };
    const notified = new Set<string>();
    for (const w of this.watches) {
      if (w.agentId === opts.author || notified.has(w.agentId)) continue;
      if (k === w.prefix || k.startsWith(`${w.prefix === '/' ? '' : w.prefix}/`)) {
        notified.add(w.agentId);
        this.notify(w.agentId, meta);
      }
    }
    return { ok: true, version: entry.version };
  }

  watch(prefix: string, agentId: string): () => void {
    const w = { prefix: normalizeKey(prefix), agentId };
    this.watches.push(w);
    return () => {
      const i = this.watches.indexOf(w);
      if (i >= 0) this.watches.splice(i, 1);
    };
  }
}
