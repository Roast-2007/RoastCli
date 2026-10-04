/**
 * read/edit 工具的共享文件状态：edit 要求同一 ctx 内文件先被 read 读过，
 * 且自读后未被外部修改（以内容 sha1 为准）。
 *
 * 键一律经 canonicalPath 规范化：同一文件的不同写法（8.3 短路径、大小写、/d/x）
 * 命中同一条记录。
 */
import { createHash } from 'node:crypto';
import { canonicalPath } from '../core/paths.js';
import type { ToolServices } from './tool.js';

export const FS_STATE_KEY = 'fs-state';

export interface FileState {
  mtimeMs: number;
  size: number;
  sha1: string;
}

export function sha1Of(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

export class FileStateStore {
  /** key: canonicalPath */
  private readonly states = new Map<string, FileState>();

  record(absPath: string, state: FileState): void {
    this.states.set(canonicalPath(absPath), state);
  }

  get(absPath: string): FileState | undefined {
    return this.states.get(canonicalPath(absPath));
  }
}

/** 从 ctx.services 取共享 store；没有则创建并写回 */
export function getFileStateStore(services: ToolServices): FileStateStore {
  const existing = services.get<FileStateStore>(FS_STATE_KEY);
  if (existing) return existing;
  const store = new FileStateStore();
  services.set(FS_STATE_KEY, store);
  return store;
}
