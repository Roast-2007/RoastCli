/**
 * shell 解析与进程树终止。
 * Windows 优先 Git Bash（bash -c），不存在则回退 cmd.exe /c；POSIX 用 /bin/bash -c。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

export interface ShellSpec {
  file: string;
  /** 追加在命令字符串之前的参数 */
  prefix: string[];
  kind: 'bash' | 'cmd';
}

let cachedShell: ShellSpec | null = null;

export function resolveShell(): ShellSpec {
  if (cachedShell) return cachedShell;
  if (process.platform === 'win32') {
    cachedShell = existsSync(GIT_BASH)
      ? { file: GIT_BASH, prefix: ['-c'], kind: 'bash' }
      : { file: 'cmd.exe', prefix: ['/c'], kind: 'cmd' };
  } else {
    cachedShell = { file: '/bin/bash', prefix: ['-c'], kind: 'bash' };
  }
  return cachedShell;
}

/** 杀整棵进程树：Windows 用 taskkill /T，POSIX 杀进程组（失败降级为杀单进程） */
export function killTree(pid: number | undefined, opts: { sync?: boolean } = {}): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    const args = ['/pid', String(pid), '/T', '/F'];
    if (opts.sync) {
      spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true });
      return;
    }
    const killer = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
    killer.on('error', () => {});
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
}

export function killChildTree(child: ChildProcess): void {
  killTree(child.pid);
}
