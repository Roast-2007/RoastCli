/**
 * 影子 git 检查点：独立的 git 目录（<cwd>/.roast/shadow.git）+ 工作区 = 项目目录。
 * 非 git 项目也可用，且能捕获 bash 造成的改动（整树快照）；不触碰项目自己的 .git。
 * - snapshot：add -A + commit（允许空提交），返回 commit hash
 * - restore：先给当前状态打快照，再删除目标快照之后新增的文件、checkout 目标快照的全部文件
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FileSnapshots } from './file-snapshots.js';

const DEFAULT_EXCLUDES = ['.roast/', 'node_modules/', '.git/', 'logs/', '*.log'];

function git(args: string[], cwd: string, command = 'git'): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export interface RestoreResult {
  /** rewind 前当前状态的安全快照（可用于撤销 rewind） */
  backup: string;
  deleted: string[];
}

export class ShadowGit {
  readonly gitDir: string;
  private ready: Promise<boolean> | null = null;
  private readonly fallback: FileSnapshots;

  constructor(
    readonly cwd: string,
    gitDir?: string,
    private readonly opts: { gitCommand?: string } = {},
  ) {
    this.gitDir = gitDir ?? path.join(cwd, '.roast', 'shadow.git');
    this.fallback = new FileSnapshots(cwd);
  }

  private run(args: string[]) {
    return git(['--git-dir', this.gitDir, '--work-tree', this.cwd, ...args], this.cwd, this.opts.gitCommand);
  }

  /** 初始化（幂等）；git 不可用时返回 false */
  init(): Promise<boolean> {
    this.ready ??= (async () => {
      if ((await git(['--version'], this.cwd, this.opts.gitCommand)).code !== 0) return false;
      if (!existsSync(path.join(this.gitDir, 'HEAD'))) {
        mkdirSync(this.gitDir, { recursive: true });
        if ((await git(['--git-dir', this.gitDir, 'init', '-q'], this.cwd, this.opts.gitCommand)).code !== 0) return false;
        mkdirSync(path.join(this.gitDir, 'info'), { recursive: true });
        writeFileSync(path.join(this.gitDir, 'info', 'exclude'), DEFAULT_EXCLUDES.join('\n') + '\n', 'utf8');
      }
      for (const [k, v] of [
        ['core.autocrlf', 'false'],
        ['core.longpaths', 'true'],
        ['core.quotepath', 'false'],
        ['user.name', 'roast-checkpoint'],
        ['user.email', 'checkpoint@roast.local'],
        ['commit.gpgsign', 'false'],
      ] as const) {
        await this.run(['config', k, v]);
      }
      return true;
    })();
    return this.ready;
  }

  async snapshot(label: string): Promise<string | null> {
    if (!(await this.init())) return this.fallback.snapshot(label);
    await this.run(['add', '-A']);
    const commit = await this.run(['commit', '-q', '--allow-empty', '--no-verify', '-m', label]);
    if (commit.code !== 0) return null;
    const head = await this.run(['rev-parse', 'HEAD']);
    return head.code === 0 ? head.stdout.trim() : null;
  }

  async restore(hash: string): Promise<RestoreResult> {
    if (hash.startsWith('files:')) return this.fallback.restore(hash);
    const backup = await this.snapshot(`pre-rewind to ${hash.slice(0, 8)}`);
    if (!backup) throw new Error('无法创建 rewind 前的安全快照');
    const added = await this.run(['diff', '--name-only', '--diff-filter=A', '-z', hash, backup]);
    const deleted = added.stdout.split('\0').filter(Boolean);
    for (const rel of deleted) {
      const abs = path.resolve(this.cwd, rel);
      if (abs.startsWith(path.resolve(this.cwd) + path.sep)) rmSync(abs, { force: true, maxRetries: 3, retryDelay: 100 });
    }
    const files = await this.run(['ls-tree', '-r', '--name-only', hash]);
    if (files.stdout.trim()) {
      const co = await this.run(['checkout', hash, '--', '.']);
      if (co.code !== 0) throw new Error(`恢复失败: ${co.stderr.trim()}`);
    }
    return { backup, deleted };
  }
}
