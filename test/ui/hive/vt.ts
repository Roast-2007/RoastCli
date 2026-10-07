import { displayWidth } from '../../../src/core/text-width.js';

/**
 * Minimal screen model for terminal output: absolute and relative cursor moves (CUP, CUU/CUD/CUF/CUB,
 * CNL/CPL, CHA), ED, EL and CR/LF (LF also returns, like a tty with onlcr). SGR and private modes are ignored.
 */
export class VtScreen {
  private readonly cells: string[][];
  private x = 0;
  private y = 0;
  constructor(
    private readonly columns: number,
    private readonly rows: number,
  ) {
    this.cells = Array.from({ length: rows }, () => Array<string>(columns).fill(' '));
  }
  private erase(row: number, from: number): void {
    for (let k = from; k < this.columns; k++) this.cells[row]![k] = ' ';
  }
  write(data: string): this {
    for (const m of data.matchAll(/\x1b\[([?\d;]*)([A-Za-z])|([^\x1b])/gsu)) {
      const ch = m[3];
      if (ch !== undefined) {
        this.put(ch);
        continue;
      }
      const params = m[1]!,
        command = m[2]!;
      if (params.startsWith('?')) continue;
      const [a = 0, b = 0] = params.split(';').map((value) => Number(value || 0));
      const n = a || 1;
      if (command === 'H') this.move((b || 1) - 1, (a || 1) - 1);
      else if (command === 'A') this.move(this.x, this.y - n);
      else if (command === 'B') this.move(this.x, this.y + n);
      else if (command === 'C') this.move(this.x + n, this.y);
      else if (command === 'D') this.move(this.x - n, this.y);
      else if (command === 'E') this.move(0, this.y + n);
      else if (command === 'F') this.move(0, this.y - n);
      else if (command === 'G') this.move(n - 1, this.y);
      else if (command === 'J') {
        if (a === 2) for (let row = 0; row < this.rows; row++) this.erase(row, 0);
        else for (let row = this.y; row < this.rows; row++) this.erase(row, row === this.y ? this.x : 0);
      } else if (command === 'K') this.erase(this.y, a === 2 ? 0 : this.x);
    }
    return this;
  }
  private move(x: number, y: number): void {
    this.x = Math.min(this.columns - 1, Math.max(0, x));
    this.y = Math.min(this.rows - 1, Math.max(0, y));
  }
  private put(ch: string): void {
    if (ch === '\n') {
      this.y = Math.min(this.rows - 1, this.y + 1);
      this.x = 0;
    } else if (ch === '\r') this.x = 0;
    else {
      const width = displayWidth(ch);
      if (this.x < this.columns) this.cells[this.y]![this.x] = ch;
      if (width === 2 && this.x + 1 < this.columns) this.cells[this.y]![this.x + 1] = '';
      this.x += width;
    }
  }
  lines(): string[] {
    return this.cells.map((row) => row.join('').trimEnd());
  }
}

export function screenOf(chunks: readonly string[], columns: number, rows: number): string[] {
  return new VtScreen(columns, rows).write(chunks.join('')).lines();
}

/** Every full clear must sit inside a synchronized update, so no blank frame is ever shown. */
export function clearsAreSynchronized(chunks: readonly string[]): boolean {
  let open = false;
  for (const m of chunks.join('').matchAll(/\x1b\[\?2026([hl])|\x1b\[2J/g)) {
    if (m[1] === 'h') open = true;
    else if (m[1] === 'l') open = false;
    else if (!open) return false;
  }
  return true;
}
