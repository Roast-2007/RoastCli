import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, unlink, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { isPathInside } from '../../core/paths.js';

interface FileEntry { path: string; bytes: string; mode: number }
const SKIP = new Set(['.roast', '.git', 'node_modules', 'logs']);
const MAX_BYTES = 128 * 1024 * 1024;

/** Byte-preserving fallback for machines without git. Never follows symlinks or junctions. */
export class FileSnapshots {
  private directory: string;
  constructor(private readonly cwd: string) { this.directory = path.join(cwd, '.roast', 'snapshots'); }
  private async files(directory = this.cwd): Promise<string[]> {
    const result: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (SKIP.has(entry.name) || entry.name.endsWith('.log') || entry.isSymbolicLink()) continue;
      const abs = path.join(directory, entry.name);
      if (entry.isDirectory()) result.push(...await this.files(abs));
      else if (entry.isFile()) result.push(abs);
    }
    return result;
  }
  async snapshot(label: string): Promise<string> {
    const entries: FileEntry[] = [];
    let size = 0;
    for (const file of await this.files()) {
      const st = await lstat(file);
      if (!st.isFile() || !isPathInside(this.cwd, file)) throw new Error('检查点文件已变更或越过工作区');
      size += st.size;
      if (size > MAX_BYTES) throw new Error('文件检查点超过 128 MiB，请安装 git');
      entries.push({ path: path.relative(this.cwd, file), bytes: (await readFile(file)).toString('base64'), mode: st.mode });
    }
    await mkdir(this.directory, { recursive: true });
    const id = randomUUID();
    await writeFile(path.join(this.directory, `${id}.json`), JSON.stringify({ label, entries }), { flag: 'wx', mode: 0o600 });
    return `files:${id}`;
  }
  async restore(id: string) {
    if (!/^files:[0-9a-f-]{36}$/.test(id)) throw new Error('无效的文件检查点');
    const raw = JSON.parse(await readFile(path.join(this.directory, `${id.slice(6)}.json`), 'utf8')) as { entries?: FileEntry[] };
    if (!Array.isArray(raw.entries)) throw new Error('文件检查点格式无效');
    for (const entry of raw.entries) {
      if (typeof entry.path !== 'string' || typeof entry.bytes !== 'string' || !Number.isInteger(entry.mode) || path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).some((p) => p === '..' || SKIP.has(p)) || !isPathInside(this.cwd, path.resolve(this.cwd, entry.path))) throw new Error('文件检查点包含不安全路径');
      let parent = path.resolve(this.cwd, entry.path);
      while (parent !== path.resolve(this.cwd)) {
        try { if ((await lstat(parent)).isSymbolicLink()) throw new Error('检查点目标已变为符号链接'); }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
        parent = path.dirname(parent);
      }
    }
    const backup = await this.snapshot(`pre-rewind ${id}`);
    const wanted = new Set(raw.entries.map((entry) => path.resolve(this.cwd, entry.path)));
    const deleted: string[] = [];
    for (const file of await this.files()) if (!wanted.has(file)) { await unlink(file); deleted.push(path.relative(this.cwd, file)); }
    for (const entry of raw.entries) {
      const file = path.join(this.cwd, entry.path);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, Buffer.from(entry.bytes, 'base64'));
      if (process.platform !== 'win32') await chmod(file, entry.mode);
    }
    return { backup, deleted };
  }
}
