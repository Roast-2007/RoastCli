/**
 * 运行日志的浏览能力：扫描 logs/ 目录、按 runId 定位 log.jsonl。
 * 只读第一层 header 行做列表（不解析整份日志）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../core/config.js';

export interface RunSummary {
  runId: string;
  createdAt: string;
  provider: string;
  model: string;
  cwd: string;
  logPath: string;
  /** 日志文件最后修改时间（续写的会话按它判断"最近"） */
  mtimeMs: number;
}

/** 解析日志根目录：有配置用 config.logsDir，否则回退 cwd/logs。配置损坏也回退，不让 logs 命令崩溃。 */
export function resolveLogsRoot(cwd: string = process.cwd()): string {
  let logsDir = 'logs';
  try {
    const config = loadConfig(cwd);
    if (config) logsDir = config.logsDir;
  } catch {
    // 配置损坏：logs 命令保持只读浏览能力
  }
  return path.isAbsolute(logsDir) ? logsDir : path.join(cwd, logsDir);
}

/** 读取 log.jsonl 的 header 行；失败返回 null（容忍残缺/非日志目录） */
export function readHeader(logPath: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(logPath, 'utf8');
    const nl = raw.indexOf('\n');
    const first = nl === -1 ? raw : raw.slice(0, nl);
    const header = JSON.parse(first) as Record<string, unknown>;
    if (header['type'] !== 'session') return null;
    return header;
  } catch {
    return null;
  }
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** 扫描 <logsRoot>/<date>/<runId>/log.jsonl，按时间倒序返回最近 limit 条 */
export function listRuns(logsRoot: string, limit = 20): RunSummary[] {
  if (!existsSync(logsRoot)) return [];
  const runs: RunSummary[] = [];
  for (const dateDir of readdirSync(logsRoot, { withFileTypes: true })) {
    if (!dateDir.isDirectory()) continue;
    const datePath = path.join(logsRoot, dateDir.name);
    for (const runDir of readdirSync(datePath, { withFileTypes: true })) {
      if (!runDir.isDirectory()) continue;
      const logPath = path.join(datePath, runDir.name, 'log.jsonl');
      if (!existsSync(logPath)) continue;
      const header = readHeader(logPath);
      if (!header) continue;
      runs.push({
        runId: String(header['runId'] ?? runDir.name),
        createdAt: String(header['createdAt'] ?? ''),
        provider: String(header['provider'] ?? '?'),
        model: String(header['model'] ?? '?'),
        cwd: String(header['cwd'] ?? ''),
        logPath,
        mtimeMs: mtimeOf(logPath),
      });
    }
  }
  // ISO 时间字符串可直接按字典序排序；runId 时间有序，createdAt 为空时用它兜底
  runs.sort((a, b) => (b.createdAt || b.runId).localeCompare(a.createdAt || a.runId));
  return runs.slice(0, limit);
}

/** 按 runId 定位 log.jsonl 完整路径；找不到返回 null */
export function findRunLog(logsRoot: string, runId: string): string | null {
  if (!existsSync(logsRoot)) return null;
  for (const dateDir of readdirSync(logsRoot, { withFileTypes: true })) {
    if (!dateDir.isDirectory()) continue;
    const candidate = path.join(logsRoot, dateDir.name, runId, 'log.jsonl');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
