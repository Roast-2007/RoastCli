/**
 * git worktree 隔离：写入型子 agent 在独立的 worktree 中工作，完成后由父 agent 合并。
 *
 * - 基线 = 父 agent 工作区的当前状态（含未提交 / 未跟踪的改动），按字节原样快照：
 *   临时索引从 HEAD 读树（不复用真实索引的 stat 缓存，否则干净文件会沿用规范化后的 blob）→ add -A → write-tree → commit-tree。
 *   不触碰用户的索引、分支与 HEAD。
 * - worktree 以 detached HEAD 检出在 <ROAST_HOME>/worktrees/<runId>/<agentId>（不运行用户的 git 钩子）；
 *   顶层 node_modules 复制为独立依赖（快照时排除），内部链接映射到副本
 * - 合并：对子 worktree 再做一次字节快照，用 plumbing `git diff-tree` 生成补丁（不受用户 diff.* 配置 / textconv 影响，
 *   以 Buffer 处理，非 UTF-8 文件不失真），先 `git apply --check` 再应用；冲突时返回冲突文件且不做任何修改
 * - 所有内部调用 core.autocrlf=false：快照、检出、应用都按字节处理，与用户文件现有的换行符保持一致
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalPath } from '../core/paths.js';
import { copyDependencies } from './dependencies.js';

/**
 * 内部 git 调用的固定配置：
 * - core.autocrlf=false：按字节快照 / 检出 / 应用补丁（配合"不复用真实索引"，CRLF 与 LF 文件都原样往返）
 * - commit.gpgsign=false：内部基线 commit 是对象库里的悬空对象，不应触发签名（可能弹出 pinentry 卡住）
 */
const GIT_CONFIG = ['-c', 'core.longpaths=true', '-c', 'core.quotepath=false', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false'];
const IDENTITY = { GIT_AUTHOR_NAME: 'roast', GIT_AUTHOR_EMAIL: 'swarm@roast.local', GIT_COMMITTER_NAME: 'roast', GIT_COMMITTER_EMAIL: 'swarm@roast.local' };
const SHARED_DIRS = ['node_modules'];
/** 不进快照的目录：共享目录 + RoastCli 自己的状态（影子 git、日志、配置），即使项目没有 gitignore 它们 */
const SNAPSHOT_EXCLUDES = [...SHARED_DIRS, '.roast'];
const MAX_BUFFER = 256 * 1024 * 1024;

interface GitResult<T> {
  code: number;
  stdout: T;
  stderr: string;
}

function exitCode(err: unknown): number {
  if (!err) return 0;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' ? code : 1;
}

function git(args: string[], cwd: string, env: Record<string, string> = {}): Promise<GitResult<string>> {
  return new Promise((resolve) => {
    execFile('git', [...GIT_CONFIG, ...args], { cwd, windowsHide: true, maxBuffer: MAX_BUFFER, env: { ...process.env, ...env } }, (err, stdout, stderr) =>
      resolve({ code: exitCode(err), stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

/** stdout 以 Buffer 返回（补丁内容不能按 UTF-8 解码，否则非 UTF-8 文件会被替换字符破坏） */
function gitBuffer(args: string[], cwd: string): Promise<GitResult<Buffer>> {
  return new Promise((resolve) => {
    execFile('git', [...GIT_CONFIG, ...args], { cwd, windowsHide: true, maxBuffer: MAX_BUFFER, encoding: 'buffer' }, (err, stdout, stderr) =>
      resolve({ code: exitCode(err), stdout, stderr: stderr.toString('utf8') }),
    );
  });
}

async function gitOk(args: string[], cwd: string, env?: Record<string, string>): Promise<string> {
  const r = await git(args, cwd, env);
  if (r.code !== 0) throw new Error(`git ${args[0]} 失败：${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
}

export interface Worktree {
  agentId: string;
  /** worktree 根目录 */
  root: string;
  /** 子 agent 的工作目录（父工作目录在仓库中的相对位置，映射到 worktree 内） */
  cwd: string;
  /** 基线 commit */
  base: string;
  /** 父 agent 的仓库根目录（合并目标） */
  parentRoot: string;
}

export interface SavedWorktree extends Worktree {
  runId: string;
  ownerPid: number | null;
  active: boolean;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export type MergeResult =
  | { ok: true; files: string[] }
  | { ok: false; conflicts: string[]; detail: string };

/** 解析 git apply 的错误输出，得到冲突文件 */
export function parseApplyConflicts(stderr: string): string[] {
  const files = new Set<string>();
  for (const line of stderr.split('\n')) {
    const m = /^error: (?:patch failed: (.+):\d+|(.+): (?:already exists in working directory|does not exist in index|No such file or directory|patch does not apply))/.exec(line.trim());
    const file = m?.[1] ?? m?.[2];
    if (file) files.add(file);
  }
  return [...files];
}

function removeLink(p: string): void {
  try {
    if (!lstatSync(p).isSymbolicLink()) return;
  } catch {
    return;
  }
  try {
    unlinkSync(p);
  } catch {
    rmdirSync(p);
  }
}

/** 本次运行的 worktree 根目录（权限引擎据此放行读取：只限本次运行，不跨项目 / 跨运行） */
export function runWorktreesDir(home: string, runId: string): string {
  return path.join(home, 'worktrees', runId);
}

export class WorktreeManager {
  private readonly repoInfo = new Map<string, Promise<{ top: string; prefix: string } | null>>();

  constructor(private readonly opts: { runId: string; home: string }) {
    if (!SAFE_ID.test(opts.runId)) throw new Error('无效的 worktree runId');
  }

  private recordPath(wt: Worktree): string {
    return path.join(path.dirname(wt.root), '.metadata', `${wt.agentId}.json`);
  }

  /** 运行结束后解除占用；未合并的工作区保留元数据，供其他进程安全检查。 */
  async release(wt: Worktree): Promise<void> {
    writeFileSync(this.recordPath(wt), JSON.stringify({ ...wt, runId: this.opts.runId, ownerPid: null }));
  }

  /** 只列当前仓库登记的、位于 Roast 目录里的工作区。旧工作区缺少基线记录时只展示，不自动删除。 */
  async list(cwd: string): Promise<SavedWorktree[]> {
    const repo = await this.repoOf(cwd);
    if (!repo) return [];
    const registered = await gitOk(['worktree', 'list', '--porcelain', '-z'], repo.top);
    const result: SavedWorktree[] = [];
    const storage = path.resolve(this.opts.home, 'worktrees');
    for (const match of registered.matchAll(/(?:^|\0)worktree ([^\0]+)/g)) {
      const root = path.resolve(match[1]!);
      const parts = path.relative(storage, root).split(path.sep);
      if (parts.length !== 2 || !parts.every((s) => SAFE_ID.test(s))) continue;
      try {
        if (lstatSync(path.dirname(root)).isSymbolicLink() || lstatSync(root).isSymbolicLink()) continue;
        const runId = parts[0]!; const agentId = parts[1]!;
        const recordPath = path.join(path.dirname(root), '.metadata', `${agentId}.json`);
        if (lstatSync(path.dirname(recordPath)).isSymbolicLink() || lstatSync(recordPath).isSymbolicLink()) continue;
        const data = JSON.parse(readFileSync(recordPath, 'utf8')) as SavedWorktree;
        if (data.runId !== runId || data.agentId !== agentId || typeof data.root !== 'string' || canonicalPath(data.root) !== canonicalPath(root)) continue;
        if (typeof data.base !== 'string' || !/^[a-f0-9]{40,64}$/.test(data.base)) continue;
        if (data.ownerPid !== null && (!Number.isInteger(data.ownerPid) || data.ownerPid < 1)) continue;
        result.push({ agentId, root, cwd: root, parentRoot: repo.top, base: data.base, runId, ownerPid: data.ownerPid, active: data.ownerPid !== null && pidAlive(data.ownerPid) });
      } catch {
        result.push({ agentId: parts[1]!, root, cwd: root, parentRoot: repo.top, base: '', runId: parts[0]!, ownerPid: null, active: true });
      }
    }
    return result.sort((a, b) => a.root.localeCompare(b.root));
  }

  /** cwd 所在的 git 仓库（有 HEAD）；不可用时返回 null（调用方回退为共享工作区 + 租约） */
  repoOf(cwd: string): Promise<{ top: string; prefix: string } | null> {
    const key = canonicalPath(cwd);
    let p = this.repoInfo.get(key);
    if (!p) {
      p = (async () => {
        const top = await git(['rev-parse', '--show-toplevel'], cwd);
        const head = await git(['rev-parse', '--verify', '-q', 'HEAD'], cwd);
        if (top.code !== 0 || head.code !== 0) return null;
        const prefix = (await git(['rev-parse', '--show-prefix'], cwd)).stdout.trim();
        return { top: path.resolve(top.stdout.trim()), prefix };
      })();
      this.repoInfo.set(key, p);
    }
    return p;
  }

  /** 用临时索引把 root 工作区的当前状态按字节写成树对象（遵守 .gitignore，排除共享目录与 .roast） */
  async snapshotTree(root: string): Promise<string> {
    const index = path.join(tmpdir(), `roast-index-${randomBytes(6).toString('hex')}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      // 从 HEAD 读树而不是复制真实索引：没有 stat 缓存，add -A 会重新读取每个文件的实际字节
      await gitOk(['read-tree', 'HEAD'], root, env);
      await gitOk(['add', '-A'], root, env);
      await gitOk(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...SNAPSHOT_EXCLUDES], root, env);
      return await gitOk(['write-tree'], root, env);
    } finally {
      rmSync(index, { force: true });
    }
  }

  async create(agentId: string, parentCwd: string): Promise<Worktree | null> {
    if (!SAFE_ID.test(agentId)) throw new Error('无效的 worktree agentId');
    const repo = await this.repoOf(parentCwd);
    if (!repo) return null;
    const tree = await this.snapshotTree(repo.top);
    const base = await gitOk(['commit-tree', tree, '-p', 'HEAD', '-m', `roast swarm base for ${agentId}`], repo.top, IDENTITY);
    const root = path.join(runWorktreesDir(this.opts.home, this.opts.runId), agentId);
    mkdirSync(path.dirname(root), { recursive: true });
    await git(['worktree', 'prune'], repo.top);
    const noHooks = path.join(tmpdir(), 'roast-no-hooks');
    mkdirSync(noHooks, { recursive: true });
    // 不运行用户的 post-checkout 等钩子（husky / lfs 钩子失败会让创建半途而废）
    await gitOk(['-c', `core.hooksPath=${noHooks}`, 'worktree', 'add', '--detach', '-f', root, base], repo.top);
    const wt: Worktree = { agentId, root, cwd: path.resolve(root, repo.prefix || '.'), base, parentRoot: repo.top };
    try {
      for (const dir of SHARED_DIRS) {
        const target = path.join(repo.top, dir);
        let present = false;
        try { lstatSync(target); present = true; } catch { /* 没有安装依赖 */ }
        if (present && !existsSync(path.join(root, dir))) await copyDependencies(target, path.join(root, dir), repo.top, root);
      }
      mkdirSync(path.dirname(this.recordPath(wt)), { recursive: true });
      writeFileSync(this.recordPath(wt), JSON.stringify({ ...wt, runId: this.opts.runId, ownerPid: process.pid }));
      return wt;
    } catch (err) {
      await this.remove(wt);
      throw err;
    }
  }

  private async diffNames(wt: Worktree, tree: string): Promise<string[]> {
    const out = await gitOk(['diff-tree', '-r', '--name-only', '-z', '--no-renames', wt.base, tree], wt.root);
    return out.split('\0').filter(Boolean);
  }

  /** 子 worktree 相对基线改动的文件 */
  async changedFiles(wt: Worktree): Promise<string[]> {
    return this.diffNames(wt, await this.snapshotTree(wt.root));
  }

  /** 把子 worktree 的改动应用到父工作区；先整体检查，冲突时不做任何修改 */
  async merge(wt: Worktree): Promise<MergeResult> {
    const tree = await this.snapshotTree(wt.root);
    const files = await this.diffNames(wt, tree);
    if (files.length === 0) return { ok: true, files };
    // plumbing diff-tree：不读取 diff.noprefix / textconv 等用户配置；固定 a/ b/ 前缀，二进制补丁按字节处理
    const patch = await gitBuffer(['diff-tree', '-p', '--binary', '--full-index', '--no-renames', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', wt.base, tree], wt.root);
    if (patch.code !== 0) throw new Error(`git diff-tree 失败：${patch.stderr.trim()}`);
    const patchFile = path.join(tmpdir(), `roast-merge-${randomBytes(6).toString('hex')}.patch`);
    writeFileSync(patchFile, patch.stdout);
    const apply = ['apply', '--binary', '--whitespace=nowarn', '-p1'];
    try {
      const check = await git([...apply, '--check', patchFile], wt.parentRoot);
      if (check.code !== 0) return { ok: false, conflicts: parseApplyConflicts(check.stderr), detail: check.stderr.trim() };
      await gitOk([...apply, patchFile], wt.parentRoot);
      return { ok: true, files };
    } finally {
      rmSync(patchFile, { force: true });
    }
  }

  /** 删除 worktree（先拆掉共享目录链接，避免递归删除到链接目标） */
  async remove(wt: Worktree): Promise<void> {
    for (const dir of SHARED_DIRS) removeLink(path.join(wt.root, dir));
    const r = await git(['worktree', 'remove', '--force', wt.root], wt.parentRoot);
    if (r.code !== 0 && existsSync(wt.root)) rmSync(wt.root, { recursive: true, force: true });
    await git(['worktree', 'prune'], wt.parentRoot);
    rmSync(this.recordPath(wt), { force: true });
  }
}
