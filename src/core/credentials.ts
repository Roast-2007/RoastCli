/** User-local credential storage. Callers only put opaque references in config. */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RoastError } from './errors.js';

export function atomicWriteJson(file: string, value: unknown, privateFile = false): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: privateFile ? 0o600 : 0o666, flag: 'wx' });
    if (privateFile && process.platform !== 'win32') chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function readCredentials(home: string): Record<string, string> {
  const file = join(home, 'credentials.json');
  if (!existsSync(file)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.values(raw).some((v) => typeof v !== 'string')) throw new Error();
    return raw as Record<string, string>;
  } catch {
    // Do not echo a parser error: it may contain secret file contents.
    throw new RoastError('CONFIG', `无法读取凭据文件 ${file}，请检查文件格式与权限`);
  }
}

export function readCredential(home: string, ref: string): string | undefined {
  const credentials = readCredentials(home);
  return Object.hasOwn(credentials, ref) ? credentials[ref] : undefined;
}

export function saveCredential(home: string, key: string): string {
  if (!key.trim()) throw new RoastError('CONFIG', 'API Key 不能为空');
  const ref = randomUUID();
  atomicWriteJson(join(home, 'credentials.json'), { ...readCredentials(home), [ref]: key.trim() }, true);
  return ref;
}
