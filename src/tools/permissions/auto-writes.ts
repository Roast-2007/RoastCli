/**
 * 「帮我审批」的写入与删除目标：从命令参数中找出会被删除、移动、复制、创建或覆盖的路径，
 * 再交给 auto-paths 判断位置。复制类只看目的地；curl -o、wget -O、tar -C、unzip -d、
 * PowerShell 的 -Destination / -OutFile 等都按写入处理。经 xargs 从标准输入拿路径的删除和移动无法确定位置。
 */
import path from 'node:path';
import { positionals } from './auto-commands.js';
import { argWriteRisk, resolveArg, writeRisk, type RiskEnv } from './auto-paths.js';

export const DELETE = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'unlink', 'shred', 'remove-item', 'ri', 'trash', 'trash-put']);
const MOVE = new Set(['mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rni']);
const COPY = new Set(['cp', 'copy', 'copy-item', 'cpi', 'xcopy', 'install', 'ln', 'rsync']);
const WRITE = new Set([
  ...['touch', 'mkdir', 'md', 'new-item', 'ni', 'tee', 'tee-object', 'set-content', 'add-content', 'ac', 'out-file', 'truncate'],
  ...['mklink', 'chmod', 'chown', 'chgrp', 'mkfifo', 'set-item', 'clear-content', 'clc'],
  ...['set-itemproperty', 'new-itemproperty', 'remove-itemproperty', 'rename-itemproperty', 'sp'],
]);
/** cmd 风格命令的 /s、/q 等是选项，不是路径 */
const CMD_STYLE = new Set(['rd', 'rmdir', 'del', 'erase', 'move', 'ren', 'copy', 'xcopy', 'robocopy', 'md', 'mklink']);
/** PowerShell 参数中取值不是路径的那些 */
const PS_NON_PATH = new Set([
  '-value',
  '-encoding',
  '-itemtype',
  '-type',
  '-filter',
  '-include',
  '-exclude',
  '-stream',
  '-newname',
  '-inputobject',
]);
const REGISTRY = /^(?:HKLM|HKCU|HKCR|HKU|HKCC|Registry):/i;

function pathArgs(name: string, args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') return [...out, ...args.slice(i + 1)];
    if (CMD_STYLE.has(name) && /^\/[a-z?][a-z]*(?::\S*)?$/i.test(a)) continue;
    if (a.startsWith('-') && a !== '-') {
      if (PS_NON_PATH.has(a.toLowerCase())) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function isRecursive(name: string, args: string[]): boolean {
  return args.some(
    (a) =>
      (/^-[a-zA-Z]{0,3}$/.test(a) && /[rR]/.test(a)) ||
      a === '--recursive' ||
      /^-rec(?:u(?:r(?:s(?:e)?)?)?)?$/i.test(a) ||
      (CMD_STYLE.has(name) && /^\/s$/i.test(a)),
  );
}

/** 目标是整个工作区：工作区根目录，或根目录下只由通配符组成的名字（`*`、`.*`、`?*`、`.[!.]*`、`{*,.*}`） */
export function wholeWorkspace(abs: string, env: RiskEnv): boolean {
  if (path.relative(env.cwd, abs) === '') return true;
  const base = path
    .basename(abs)
    .replace(/\[[^\]]*\]/g, '?')
    .replace(/[{},]/g, '');
  return /^[.*?]*[*?][.*?]*$/.test(base) && path.relative(env.cwd, path.dirname(abs)) === '';
}

function deleteRisk(name: string, args: string[], env: RiskEnv): string | null {
  const recursive = isRecursive(name, args);
  for (const value of pathArgs(name, args)) {
    if (REGISTRY.test(value)) return '修改注册表';
    const resolved = resolveArg(value, env);
    if (resolved.kind === 'temp') continue;
    if (resolved.kind === 'unknown') return '无法确定要删除的位置';
    if (recursive && wholeWorkspace(resolved.abs, env)) return '递归删除整个工作区';
    const risk = writeRisk(resolved.abs, env, '删除工作区外的文件');
    if (risk) return risk;
  }
  return null;
}

/**
 * 选项值：`-o X`、`--output X`、`--output=X`，以及短选项簇结尾的 `-fsSLo X` 和紧贴的 `-oX`。
 * short 是单个字母，按大小写精确匹配；long 按小写比较（兼容 PowerShell 的 -Destination）。
 */
function optionValues(args: string[], short: string[], long: string[]): string[] {
  return args.flatMap((a, i) => {
    const lower = a.toLowerCase();
    const next = args[i + 1];
    if (long.includes(lower)) return next === undefined ? [] : [next];
    const attached = long.find((f) => lower.startsWith(`${f}=`) || lower.startsWith(`${f}:`));
    if (attached) return [a.slice(attached.length + 1)];
    const m = /^-([a-zA-Z]*)$/.exec(a);
    if (m && short.includes(m[1]!.slice(-1))) return next === undefined ? [] : [next];
    const glued = short.map((s) => new RegExp(`^-[a-zA-Z]*?${s}(.+)$`).exec(a)).find(Boolean);
    return glued && !a.startsWith('--') ? [glued[1]!] : [];
  });
}

function tarTargets(args: string[]): string[] {
  // 模式字母来自短选项簇，或旧式写法的第一个参数（tar xzf a.tgz）
  const modes = args.filter((a, i) => /^-[a-zA-Z]+$/.test(a) || (i === 0 && /^[a-zA-Z]+$/.test(a))).join('');
  const extract = has(args, '--extract', '--get') || modes.includes('x');
  const create = has(args, '--create', '--append', '--update') || /[cru]/.test(modes);
  return [...(extract ? optionValues(args, ['C'], ['--directory']) : []), ...(create ? optionValues(args, ['f'], ['--file']) : [])];
}

const has = (args: string[], ...flags: string[]) => args.some((a) => flags.includes(a));

/** 写入目标：复制类取目的地，移动 / 创建 / 修改类取全部路径参数 */
function writeTargets(name: string, args: string[]): string[] {
  const values = pathArgs(name, args);
  switch (name) {
    case 'dd':
      return args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3));
    case 'curl':
      return optionValues(args, ['o'], ['--output', '--output-dir']);
    case 'git':
      return [
        ...optionValues(args, [], ['--output', '--output-directory']),
        ...(args.includes('format-patch') ? optionValues(args, ['o'], []) : []),
      ];
    case 'wget':
      return optionValues(args, ['O', 'P'], ['--output-document', '--directory-prefix']).filter((v) => v !== '-');
    case 'invoke-webrequest':
    case 'iwr':
    case 'invoke-restmethod':
    case 'irm':
      return optionValues(args, [], ['-outfile']);
    case 'expand-archive':
      return optionValues(args, [], ['-destinationpath']);
    case 'tar':
      return tarTargets(args);
    case 'unzip':
      return optionValues(args, ['d'], []);
    case '7z':
    case '7za':
      return args.filter((a) => /^-o./.test(a)).map((a) => a.slice(2));
    case 'sed':
    case 'perl':
      return inPlaceFiles(name, args);
    case 'robocopy':
      return values.slice(1, 2);
  }
  if (MOVE.has(name) || WRITE.has(name)) return values;
  if (!COPY.has(name)) return [];
  const target = optionValues(args, ['t'], ['--target-directory', '-destination']);
  return target.length > 0 ? target : values.length >= 2 ? values.slice(-1) : [];
}

/** sed -i / perl -i 原地修改的文件（跳过脚本参数） */
function inPlaceFiles(name: string, args: string[]): string[] {
  if (!args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) return [];
  if (name === 'perl') return positionals(args, new Set(args.filter((a) => /^-[a-zA-Z]*[eE]$/.test(a))));
  const scripted = args.some((a) => /^(?:-e|-f|--expression|--file)(?:=|$)/.test(a));
  const files = positionals(args, new Set(['-e', '-f', '--expression', '--file']));
  return scripted ? files : files.slice(1);
}

/** fromStdin：命令由 xargs 调用，路径来自标准输入 */
export function mutationRisk(name: string, args: string[], env: RiskEnv, fromStdin = false): string | null {
  if (fromStdin && DELETE.has(name)) return '无法确定要删除的位置';
  if (fromStdin && MOVE.has(name)) return '无法确定命令写入的位置';
  if (DELETE.has(name)) return deleteRisk(name, args, env);
  for (const target of writeTargets(name, args)) {
    if (REGISTRY.test(target)) return '修改注册表';
    const risk = argWriteRisk(target, env, MOVE.has(name) ? '移动工作区外的文件' : '修改工作区外的文件');
    if (risk) return risk;
  }
  return null;
}
