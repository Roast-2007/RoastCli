/**
 * bash 输出收集与解码：
 * - 按字节、按到达顺序收集 stdout/stderr（不逐 chunk 解码，避免多字节字符被拆成 U+FFFD）
 * - 超过 MAX_KEEP_BYTES 时只保留头尾各 EDGE_BYTES，中间计数丢弃（防内存膨胀）
 * - 每个流各自判定一次编码（UTF-8 / Windows 下的 GBK），再用流式解码器按到达顺序拼接：
 *   交错的 stderr 不会拆坏 stdout 的字符；溢出时头尾使用同一编码
 * - 编码判定：去掉末尾不完整的 UTF-8 序列后合法 → UTF-8；零星非法字节（<2%）仍按 UTF-8；
 *   大量非法且 GBK 严格解码成功（仅 win32）→ GBK
 */
import { isUtf8 } from 'node:buffer';
import { TextDecoder } from 'node:util';

const MAX_KEEP_BYTES = 256 * 1024;
const EDGE_BYTES = 64 * 1024;
/** UTF-8 解码出现的替换字符占比低于此值时视为零星坏字节，仍按 UTF-8 */
const STRAY_RATIO = 0.02;

export type StreamName = 'out' | 'err';
export type OutputEncoding = 'utf-8' | 'gbk';

interface Piece {
  stream: StreamName;
  buf: Buffer;
}

export class OutputCollector {
  private head: Piece[] = [];
  private headBytes = 0;
  private tail: Piece[] = [];
  private tailBytes = 0;
  private overflow = false;
  private dropped = 0;

  push(stream: StreamName, buf: Buffer): void {
    if (!this.overflow) {
      this.head.push({ stream, buf });
      this.headBytes += buf.length;
      if (this.headBytes > MAX_KEEP_BYTES) this.spill();
      return;
    }
    this.tail.push({ stream, buf });
    this.tailBytes += buf.length;
    this.trimTail();
  }

  /** 首次溢出：head 截到 EDGE_BYTES，多余部分转入 tail */
  private spill(): void {
    const keep: Piece[] = [];
    let bytes = 0;
    const rest: Piece[] = [];
    for (const p of this.head) {
      if (bytes >= EDGE_BYTES) {
        rest.push(p);
        continue;
      }
      const room = EDGE_BYTES - bytes;
      if (p.buf.length <= room) {
        keep.push(p);
        bytes += p.buf.length;
      } else {
        keep.push({ stream: p.stream, buf: p.buf.subarray(0, room) });
        rest.push({ stream: p.stream, buf: p.buf.subarray(room) });
        bytes += room;
      }
    }
    this.head = keep;
    this.headBytes = bytes;
    this.overflow = true;
    this.tail = rest;
    this.tailBytes = rest.reduce((n, p) => n + p.buf.length, 0);
    this.trimTail();
  }

  /** tail 只保留最后 EDGE_BYTES（必要时切开首块） */
  private trimTail(): void {
    while (this.tailBytes > EDGE_BYTES && this.tail.length > 0) {
      const first = this.tail[0]!;
      const excess = this.tailBytes - EDGE_BYTES;
      if (first.buf.length <= excess) {
        this.tail.shift();
        this.tailBytes -= first.buf.length;
        this.dropped += first.buf.length;
      } else {
        this.tail[0] = { stream: first.stream, buf: first.buf.subarray(excess) };
        this.tailBytes -= excess;
        this.dropped += excess;
      }
    }
  }

  get totalBytes(): number {
    return this.headBytes + this.tailBytes + this.dropped;
  }

  /** 解码为文本；溢出时中间插入省略标记 */
  text(): string {
    const all = [...this.head, ...this.tail];
    const encodings: Record<StreamName, OutputEncoding> = {
      out: detectEncoding(concatStream(all, 'out')),
      err: detectEncoding(concatStream(all, 'err')),
    };
    const headText = decodePieces(this.head, encodings);
    if (!this.overflow) return headText;
    return `${headText}\n\n[... 中间约 ${this.dropped} 字节已丢弃 ...]\n\n${decodePieces(this.tail, encodings)}`;
  }
}

function concatStream(pieces: Piece[], stream: StreamName): Buffer {
  return Buffer.concat(pieces.filter((p) => p.stream === stream).map((p) => p.buf));
}

/** 按到达顺序、每个流用自己的流式解码器解码（非致命：边界处至多一个替换字符） */
function decodePieces(pieces: Piece[], encodings: Record<StreamName, OutputEncoding>): string {
  const decoders: Record<StreamName, TextDecoder> = {
    out: new TextDecoder(encodings.out),
    err: new TextDecoder(encodings.err),
  };
  let text = '';
  for (const p of pieces) text += decoders[p.stream].decode(p.buf, { stream: true });
  return text + decoders.out.decode() + decoders.err.decode();
}

/** 去掉结尾不完整的 UTF-8 序列（进程被杀/截断时最后一个字符可能只写了一半） */
function trimIncompleteUtf8(buf: Buffer): Buffer {
  for (let back = 1; back <= Math.min(4, buf.length); back++) {
    const b = buf[buf.length - back]!;
    if ((b & 0xc0) === 0x80) continue;
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? buf.subarray(0, buf.length - back) : buf;
  }
  return buf;
}

export function detectEncoding(buf: Buffer): OutputEncoding {
  if (buf.length === 0) return 'utf-8';
  const trimmed = trimIncompleteUtf8(buf);
  if (isUtf8(trimmed)) return 'utf-8';
  if (process.platform !== 'win32') return 'utf-8';
  const lossy = trimmed.toString('utf8');
  const bad = lossy.split('�').length - 1;
  if (bad / Math.max(1, lossy.length) < STRAY_RATIO) return 'utf-8';
  // GBK 校验用未截断的原始字节；末尾若是半个双字节字符（lead >= 0x81）则去掉再试
  const last = buf[buf.length - 1]!;
  if (isStrictGbk(buf) || (buf.length > 1 && last >= 0x81 && isStrictGbk(buf.subarray(0, -1)))) return 'gbk';
  return 'utf-8';
}

function isStrictGbk(buf: Buffer): boolean {
  try {
    new TextDecoder('gbk', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

export function decodeOutput(buf: Buffer): string {
  return new TextDecoder(detectEncoding(buf)).decode(buf);
}

/** 子进程环境：强制 UTF-8 输出（Python / git / less 等） */
export function utf8ChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    LANG: base['LANG'] && /utf-?8/i.test(base['LANG']) ? base['LANG'] : 'C.UTF-8',
    LESSCHARSET: 'utf-8',
  };
}

const MAX_OUTPUT_CHARS = 30_000;
const HEAD_CHARS = 15_000;
const TAIL_CHARS = 14_000;

export function truncateOutput(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  const omitted = s.length - HEAD_CHARS - TAIL_CHARS;
  return `${s.slice(0, HEAD_CHARS)}\n\n[... 中间 ${omitted} 字符已截断 ...]\n\n${s.slice(-TAIL_CHARS)}`;
}
