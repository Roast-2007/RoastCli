/**
 * 无 ripgrep 时的 JS 回退：tinyglobby 遍历（默认忽略 .git / node_modules），
 * 逐行正则匹配文本文件（跳过二进制与超大文件）。
 */
import { readFile, stat } from 'node:fs/promises';
import { glob } from 'tinyglobby';

export const DEFAULT_IGNORES = ['**/.git/**', '**/node_modules/**', '**/.roast/shadow.git/**'];
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export async function walkFiles(root: string, pattern = '**/*'): Promise<string[]> {
  return glob(pattern, { cwd: root, dot: true, ignore: DEFAULT_IGNORES, onlyFiles: true, absolute: false });
}

export interface LineMatch {
  file: string;
  line: number;
  text: string;
}

export async function grepFiles(root: string, files: string[], re: RegExp, signal: AbortSignal, limit: number): Promise<LineMatch[]> {
  const out: LineMatch[] = [];
  for (const rel of files) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    const abs = `${root}/${rel}`;
    try {
      if ((await stat(abs)).size > MAX_FILE_BYTES) continue;
      const buf = await readFile(abs);
      if (buf.subarray(0, 8192).includes(0)) continue;
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i]!)) {
          out.push({ file: rel, line: i + 1, text: lines[i]!.replace(/\r$/, '') });
          if (out.length >= limit) return out;
        }
      }
    } catch {
      // 读不了的文件跳过
    }
  }
  return out;
}
