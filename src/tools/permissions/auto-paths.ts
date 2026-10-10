/**
 * 「帮我审批」的路径判断（纯字符串计算；只在首次使用时取一次临时目录的长路径）：
 * - resolveArg：把命令参数解析为绝对路径（~、$HOME、%USERPROFILE%、git-bash 的 /d/…、临时目录变量、cd 之后的目录）
 * - writeRisk：写入工作区外、CI / agent 配置、.env 与凭据文件属于高风险；系统临时目录内的写入放行
 * - isCredentialPath：读取或改动凭据文件属于高风险
 */
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { resolveUserPath } from '../../core/paths.js';

export interface RiskEnv {
  /** 工作区根目录 */
  cwd: string;
  home: string;
  tmp: string;
  /** 临时目录的其他写法（Windows 的 8.3 短路径与长路径） */
  tmpAliases?: string[];
  /** 命令里 cd 之后的当前目录：未设置时等于 cwd，null 表示无法确定 */
  dir?: string | null;
}

let tmpLong: string | undefined;

function longTmp(tmp: string): string {
  if (tmpLong === undefined) {
    try {
      tmpLong = realpathSync.native(tmp);
    } catch {
      tmpLong = tmp;
    }
  }
  return tmpLong;
}

export function riskEnv(cwd: string): RiskEnv {
  const tmp = tmpdir();
  const long = longTmp(tmp);
  return { cwd, home: homedir(), tmp, ...(long !== tmp ? { tmpAliases: [long] } : {}) };
}

export type ResolvedArg = { kind: 'path' | 'temp'; abs: string } | { kind: 'unknown' };

const HOME_VARS = /^(?:\$HOME|\$\{HOME\}|\$env:(?:USERPROFILE|HOME)|%USERPROFILE%)(?=[\\/]|$)/i;
const TEMP_VARS = /^(?:\$\{?(?:TMPDIR|TEMP|TMP)\}?|\$env:(?:TEMP|TMP)|%(?:TEMP|TMP)%)(?=[\\/]|$)/i;
const CWD_VARS = /^(?:\$PWD|\$\{PWD\}|\$pwd)(?=[\\/]|$)/;
/** 临时目录本身不算，只有其中的条目才放行 */
const POSIX_TEMP = /^\/(?:var\/)?tmp\/[^/]/;

const UNKNOWN: ResolvedArg = { kind: 'unknown' };
const isAbsoluteArg = (p: string) => p.startsWith('/') || path.isAbsolute(p) || /^[a-zA-Z]:/.test(p);

/** 命令参数 → 路径（相对路径按 cd 之后的目录解析）；以未知变量开头或当前目录未知时无法确定位置 */
export function resolveArg(value: string, env: RiskEnv): ResolvedArg {
  const base = env.dir === undefined ? env.cwd : env.dir;
  if (value.startsWith('/') && POSIX_TEMP.test(path.posix.normalize(value))) return { kind: 'temp', abs: resolveUserPath(env.cwd, value) };
  let input = value;
  if (input === '~' || /^~[\\/]/.test(input)) input = env.home + input.slice(1);
  else if (HOME_VARS.test(input)) input = input.replace(HOME_VARS, () => env.home);
  else if (TEMP_VARS.test(input)) input = input.replace(TEMP_VARS, () => env.tmp);
  else if (CWD_VARS.test(input)) {
    if (base === null) return UNKNOWN;
    input = input.replace(CWD_VARS, () => base);
  } else if (/^[$%~]/.test(input)) return UNKNOWN;
  if (base === null && !isAbsoluteArg(input)) return UNKNOWN;
  const abs = resolveUserPath(base ?? env.cwd, input);
  return { kind: isTempPath(abs, env) ? 'temp' : 'path', abs };
}

export function isInside(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isStrictlyInside(dir: string, target: string): boolean {
  return isInside(dir, target) && path.relative(dir, target) !== '';
}

const toPosix = (p: string) => p.split(path.sep).join('/');

const CREDENTIAL_PATTERNS: RegExp[] = [
  /(?:^|[\\/=:])\.ssh(?:[\\/]|$)/i,
  /(?:^|[\\/=:])\.aws[\\/](?:credentials|config)$/i,
  /(?:^|[\\/=:])(?:\.npmrc|\.netrc|_netrc|\.pypirc|\.git-credentials|\.dockercfg)$/i,
  /(?:^|[\\/=:])id_(?:rsa|dsa|ecdsa|ed25519)$/i,
  /(?:^|[\\/=:])\.roast[\\/]credentials\.json$/i,
  /(?:^|[\\/=:])\.docker[\\/]config\.json$/i,
  /(?:^|[\\/=:])\.kube[\\/]config$/i,
  /(?:^|[\\/=:])\.config[\\/](?:gh[\\/]hosts\.yml|gcloud(?:[\\/]|$))/i,
  /(?:^|[\\/=:])\.(?:azure|gnupg)(?:[\\/]|$)/i,
];

/** .env、.env.local、.env* 等可能含密钥；.env.example 一类模板不算 */
const ENV_FILE = /(?:^|[\\/=:])\.env(?:[*?]+|\.(?!(?:example|sample|template|dist|defaults?)$)[\w.*?-]+)?$/i;

/** 通配符可能展开成的凭据文件名（如 ~/.s*、id_*） */
const CREDENTIAL_NAMES = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.env',
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.git-credentials',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
];

function globSegmentRegex(segment: string): RegExp {
  const body = segment
    .replace(/[.+^${}()|\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
    .replace(/\[!/g, '[^');
  return new RegExp(`^${body}$`, 'i');
}

/** 带通配符、且至少有两个字面字符的路径段能匹配凭据文件名（`*`、`.*` 不算，避免 cat src/* 误判） */
function globHitsCredential(text: string): boolean {
  return text
    .split(/[\\/]/)
    .filter((s) => /[*?[]/.test(s) && s.replace(/[*?[\]!]/g, '').length >= 2)
    .some((s) => {
      try {
        const re = globSegmentRegex(s);
        return CREDENTIAL_NAMES.some((name) => re.test(name));
      } catch {
        return false;
      }
    });
}

export function isCredentialPath(text: string): boolean {
  return ENV_FILE.test(text) || CREDENTIAL_PATTERNS.some((re) => re.test(text)) || globHitsCredential(text);
}

/** 工作区内的敏感位置（相对路径，posix 分隔符）；Windows 与 macOS 的文件名不区分大小写，这里一律忽略大小写 */
function sensitiveReason(rel: string): string | null {
  if (/(?:^|\/)\.git(?:\/|$)/i.test(rel)) return '修改 .git 内部文件';
  if (/^\.github\/workflows(?:\/|$)/i.test(rel) || /^\.gitlab-ci\.ya?ml$/i.test(rel)) return '修改 CI 配置';
  if (/^\.roast(?:\/|$)/i.test(rel) || /^roastcli\.config\.json$/i.test(rel)) return '修改 RoastCli 项目配置';
  if (/^\.claude(?:\/|$)/i.test(rel)) return '修改 Claude Code 项目配置';
  if (/^\.husky(?:\/|$)/i.test(rel)) return '修改 git hooks';
  if (ENV_FILE.test(rel)) return '修改 .env 文件（可能含密钥）';
  return null;
}

export function isTempPath(abs: string, env: RiskEnv): boolean {
  return [env.tmp, ...(env.tmpAliases ?? [])].some((dir) => isStrictlyInside(dir, abs)) || (path.sep === '/' && POSIX_TEMP.test(abs));
}

/** 写入 / 删除某个绝对路径的风险；outside 是工作区外时的说明。系统临时目录中的条目放行 */
export function writeRisk(abs: string, env: RiskEnv, outside = '修改工作区外的文件'): string | null {
  if (isTempPath(abs, env)) return null;
  if (!isInside(env.cwd, abs)) return isCredentialPath(abs) ? '修改凭据文件' : outside;
  const sensitive = sensitiveReason(toPosix(path.relative(env.cwd, abs)));
  if (sensitive) return sensitive;
  return isCredentialPath(abs) ? '修改凭据文件' : null;
}

/** 命令参数形式的写入目标 */
export function argWriteRisk(value: string, env: RiskEnv, outside?: string): string | null {
  const resolved = resolveArg(value, env);
  if (resolved.kind === 'temp') return null;
  if (resolved.kind === 'unknown') return '无法确定命令写入的位置';
  return writeRisk(resolved.abs, env, outside);
}
