/**
 * 临时工作区：mkdtemp 后用 realpathSync.native 规范化，
 * 规避 Windows 上 os.tmpdir() 返回 8.3 短路径导致的身份键不一致。
 */
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface TempWorkspace {
  dir: string;
  file(rel: string, content: string): string;
}

export function tempWorkspace(prefix = 'roast-ws-'): TempWorkspace {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
  return {
    dir,
    file(rel: string, content: string): string {
      const abs = path.join(dir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf8');
      return abs;
    },
  };
}
