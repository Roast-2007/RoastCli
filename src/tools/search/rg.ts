/**
 * ripgrep 定位与调用：ROAST_RG_PATH → PATH 上的 rg → null（调用方走 JS 回退）。
 * 结果缓存；doctor 可通过 ripgrepSource() 报告实际来源。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

let cached: { path: string | null; source: string } | null = null;

export function locateRipgrep(): { path: string | null; source: string } {
  if (cached) return cached;
  const explicit = process.env['ROAST_RG_PATH'];
  if (explicit && existsSync(explicit)) return (cached = { path: explicit, source: 'ROAST_RG_PATH' });
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    if (existsSync(candidate)) return (cached = { path: candidate, source: `PATH (${candidate})` });
  }
  return (cached = { path: null, source: 'JS 回退（未找到 rg）' });
}

/** 测试用：清除缓存 */
export function resetRipgrepCache(): void {
  cached = null;
}

export interface RgResult {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

const MAX_RG_OUTPUT = 2 * 1024 * 1024;

export function runRipgrep(rg: string, args: string[], cwd: string, signal: AbortSignal): Promise<RgResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const child = spawn(rg, args, { cwd, windowsHide: true });
    const out: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let stderr = '';
    const onAbort = () => child.kill();
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => {
      if (bytes >= MAX_RG_OUTPUT) {
        truncated = true;
        child.kill();
        return;
      }
      out.push(d);
      bytes += d.length;
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr, truncated });
    });
  });
}
