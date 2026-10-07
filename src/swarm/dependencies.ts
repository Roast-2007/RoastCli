import { constants, existsSync } from 'node:fs';
import { cp, copyFile, lstat, readFile, readlink, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalPath, isPathInside, isUncPath } from '../core/paths.js';

interface Mapping {
  source: string;
  target: string;
}

/** 逐级展开本地链接后再 realpath，避免某个中间 junction 指向 UNC 时提前访问网络。 */
async function localPath(file: string): Promise<string> {
  let absolute = path.resolve(file);
  for (let hops = 0; hops < 40; hops++) {
    if (isUncPath(absolute)) throw new Error('依赖链接指向 UNC / 设备路径，不能自动复制');
    const root = path.parse(absolute).root;
    const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
    let current = root;
    let followed = false;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]!);
      if (!(await lstat(current)).isSymbolicLink()) continue;
      const value = await readlink(current);
      if (isUncPath(value)) throw new Error('依赖链接指向 UNC / 设备路径，不能自动复制');
      absolute = path.resolve(path.dirname(current), value, ...parts.slice(i + 1));
      followed = true;
      break;
    }
    if (!followed) return realpath(absolute);
  }
  throw new Error('依赖链接循环或层数过多');
}

/** 依赖按文件复制（支持时使用 copy-on-write），不共享可写 inode；内部 pnpm 链接映射到副本。 */
export async function copyDependencies(source: string, target: string, repoRoot: string, worktreeRoot: string): Promise<void> {
  const root = await localPath(source);
  const repoMapping = { source: canonicalPath(repoRoot), target: worktreeRoot };

  async function copyTree(from: string, to: string, parents: Mapping[]): Promise<void> {
    const mappings = [{ source: canonicalPath(from), target: to }, ...parents];
    const links: { target: string; destination: string }[] = [];
    await cp(from, to, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      filter: async (file, destination) => {
        if (!(await lstat(file)).isSymbolicLink()) return true;
        links.push({ target: await localPath(file), destination });
        return false;
      },
    });
    for (const link of links) {
      const key = canonicalPath(link.target);
      const mapping = mappings.find((m) => isPathInside(m.source, key));
      const inRepo = isPathInside(repoMapping.source, key)
        ? path.join(repoMapping.target, path.relative(repoMapping.source, key))
        : undefined;
      const mapped = mapping
        ? path.join(mapping.target, path.relative(mapping.source, key))
        : inRepo && existsSync(inRepo)
          ? inRepo
          : undefined;
      if (!(await stat(link.target)).isDirectory()) {
        await copyFile(link.target, link.destination, constants.COPYFILE_FICLONE);
      } else if (mapped) {
        await symlink(mapped, link.destination, process.platform === 'win32' ? 'junction' : 'dir');
      } else {
        // 外部 workspace / 全局依赖也复制到本工作区；反向链接通过 mappings 留在副本内。
        await copyTree(link.target, link.destination, mappings);
      }
    }
  }
  await copyTree(root, target, []);
  await rewriteVirtualStore(root, target);
}

/** 只改副本中的 JSON 布局记录；未知格式 / 外部 store 保持原字节。 */
async function rewriteVirtualStore(source: string, target: string): Promise<void> {
  const file = path.join(target, '.modules.yaml');
  if (!existsSync(file) || (await lstat(file)).isSymbolicLink()) return;
  const raw = await readFile(file, 'utf8');
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!data || typeof data !== 'object') return;
  const store = data['virtualStoreDir'];
  if (typeof store !== 'string' || !path.isAbsolute(store) || !isPathInside(source, store)) return;
  data['virtualStoreDir'] = path.join(target, path.relative(canonicalPath(source), canonicalPath(store)));
  const indent = /\n([ \t]+)"/.exec(raw)?.[1] ?? '  ';
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  await writeFile(file, JSON.stringify(data, null, indent).replace(/\n/g, newline) + (raw.endsWith('\n') ? newline : ''), 'utf8');
}
