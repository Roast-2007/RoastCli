/**
 * 路径工具（Windows 安全）：
 * - canonicalPath：身份键（Map key / 租约 / worktree 归属判断用），解析 8.3 短路径与符号链接，
 *   win32 下统一小写；不用于实际文件读写
 * - resolveUserPath：模型/用户给出的路径 → 绝对路径；兼容 git-bash 的 /d/x 写法
 */
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const isWin = process.platform === 'win32';

function realOrSelf(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

/**
 * 路径不存在时：找到最近的已存在祖先目录做 realpath，再拼回不存在的部分。
 * （只规范化直接父目录不够：同一棵不存在的子树里，深浅不同的两个路径会得到不一致的结果）
 */
function realOfNearestAncestor(abs: string): string {
  const missing: string[] = [];
  for (let cur = abs; ; cur = path.dirname(cur)) {
    const real = realOrSelf(cur);
    if (real) return path.join(real, ...missing.reverse());
    if (path.dirname(cur) === cur) return abs;
    missing.push(path.basename(cur));
  }
}

/** UNC / 设备路径（\\host\share、//host/share、\\?\…） */
export function isUncPath(p: string): boolean {
  return /^[\\/]{2}/.test(p);
}

/**
 * 规范化身份键。UNC 路径只做字符串规范化、绝不触碰文件系统：
 * 对攻击者给出的 \\host\share 做 realpath 会发起 SMB / WebDAV 连接（Windows 上可能泄露 NTLM 哈希），
 * 而这里常在权限审批之前被调用。
 */
export function canonicalPath(p: string): string {
  const abs = path.resolve(p);
  const real = isWin && isUncPath(abs) ? abs : realOfNearestAncestor(abs);
  return isWin ? real.toLowerCase() : real;
}

/** target 是否位于 dir 之内（含 dir 本身）；按规范化路径比较（Windows 下不区分大小写、展开短路径） */
export function isPathInside(dir: string, target: string): boolean {
  const rel = path.relative(canonicalPath(dir), canonicalPath(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * git-bash 路径 → Windows 路径（仅 win32）：
 * - /d/foo → D:\foo（单字母盘符后接 / 或结尾）
 * - /tmp/x → %TEMP%\x（与 git-bash 中 /tmp 的挂载一致，bash 工具写的临时文件 read/edit 能找到）
 */
function fromGitBashPath(p: string): string {
  const tmp = /^\/tmp(?:\/(.*))?$/.exec(p);
  if (tmp) return path.join(tmpdir(), ...(tmp[1] ?? '').split('/').filter(Boolean));
  const m = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(p);
  if (!m) return p;
  const drive = m[1]!.toUpperCase();
  const rest = (m[2] ?? '').replace(/\//g, '\\');
  return `${drive}:\\${rest}`;
}

export function resolveUserPath(cwd: string, p: string): string {
  const input = isWin ? fromGitBashPath(p) : p;
  return path.resolve(cwd, input);
}
