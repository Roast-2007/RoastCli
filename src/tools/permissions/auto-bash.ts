/**
 * 「帮我审批」的 bash 命令分析（离线启发式，不是完整 shell 解析器）：
 * - 逐段分析并跟踪 cd，展开 $(…)、反引号、bash -c、powershell -Command、cmd /c、find -exec、xargs
 *   以及 npx / pnpm exec 等包运行器的内层命令
 * - 去掉环境变量与包装命令（env / nohup / timeout / cross-env …）；sudo 一类提权直接算高风险
 * - 按命令名匹配规则（auto-commands），再检查凭据访问与写入目标的位置（auto-writes）
 * 返回高风险原因，低风险返回 null。
 */
import { argWriteRisk, isCredentialPath, resolveArg, type RiskEnv } from './auto-paths.js';
import { commandRule, positionals } from './auto-commands.js';
import { DELETE, mutationRisk, wholeWorkspace } from './auto-writes.js';
import { parseCommand, tokenizeCommand, type CommandToken } from './bash-parse.js';

const MAX_DEPTH = 4;

interface Context {
  env: RiskEnv;
  depth: number;
  piped: boolean;
  /** 当前命令段原文 */
  raw: string;
}

export function bashRisk(command: string, env: RiskEnv, depth = 0): string | null {
  if (depth > MAX_DEPTH) return '命令嵌套过深，无法分析';
  const { text, heredocs } = splitHeredocs(command);
  // 交给 shell 的 heredoc 正文就是要执行的命令（与 bash -c 一样分析）；交给其他命令的是数据
  for (const doc of heredocs) {
    const name = heredocCommand(doc.line);
    const windows = name === 'pwsh' || name === 'powershell' || name === 'cmd';
    if (!POSIX_SHELLS.has(name) && !windows) continue;
    const risk = bashRisk(windows ? doc.body.replace(/\\/g, '\\\\') : doc.body, env, depth + 1);
    if (risk) return risk;
  }
  for (const body of substitutions(text)) {
    const risk = bashRisk(body, env, depth + 1);
    if (risk) return risk;
  }
  const parsed = parseCommand(text);
  let current = env;
  for (const [i, segment] of parsed.segments.entries()) {
    const risk = segmentRisk(segment, { env: current, depth, piped: parsed.piped[i] === true, raw: segment });
    if (risk) return risk;
    current = afterCd(segment, current);
  }
  return null;
}

/** cmd 与 PowerShell 不把反斜杠当转义：交给 bash 分词前先加倍，保住 Windows 路径 */
function windowsRisk(text: string, ctx: Context): string | null {
  return bashRisk(text.replace(/\\/g, '\\\\'), ctx.env, ctx.depth + 1);
}

const CD = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl', 'popd']);

/** cd / pushd 之后，后续命令段的相对路径按新目录解析；无法确定新目录时相对路径都算位置未知 */
function afterCd(segment: string, env: RiskEnv): RiskEnv {
  const [first, ...args] = trimGrouping(tokenizeCommand(segment).map((t) => t.value));
  const name = first === undefined ? '' : commandName(first);
  if (!CD.has(name)) return env;
  const target = args.find((a) => !a.startsWith('-') || a === '-');
  if (name === 'popd' || target === '-') return { ...env, dir: null };
  if (target === undefined) return { ...env, dir: env.home };
  const resolved = resolveArg(target, env);
  return { ...env, dir: resolved.kind === 'unknown' ? null : resolved.abs };
}

interface Heredoc {
  /** `<<` 之前的命令文本 */
  line: string;
  body: string;
}

/** 拆出 heredoc：正文不参与逐段分析（文件内容、提交说明是数据），单独返回 */
function splitHeredocs(command: string): { text: string; heredocs: Heredoc[] } {
  const out: string[] = [];
  const heredocs: Heredoc[] = [];
  let open: { end: string; line: string; body: string[] } | null = null;
  for (const line of command.split('\n')) {
    if (open) {
      if (line.trim() === open.end) {
        heredocs.push({ line: open.line, body: open.body.join('\n') });
        open = null;
      } else open.body.push(line);
      continue;
    }
    out.push(line);
    const m = /<<-?\s*(['"]?)([\w.-]+)\1/.exec(line);
    if (m && line[m.index + 2] !== '<') open = { end: m[2]!, line: line.slice(0, m.index), body: [] };
  }
  if (open) heredocs.push({ line: open.line, body: open.body.join('\n') });
  return { text: out.join('\n'), heredocs };
}

/** 读取 heredoc 的命令名 */
function heredocCommand(line: string): string {
  const segment = parseCommand(line).segments.at(-1);
  const command = segment === undefined ? null : unwrap(splitRedirects(tokenizeCommand(segment)).words);
  return command !== null && typeof command === 'object' ? command.name : '';
}

/** $(…)、<(…)、>(…) 与反引号中的命令（单引号内不展开） */
function substitutions(command: string): string[] {
  const out: string[] = [];
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = quote === ch ? null : (quote ?? ch);
      continue;
    }
    if (ch === '`') {
      const end = command.indexOf('`', i + 1);
      out.push(command.slice(i + 1, end < 0 ? undefined : end));
      if (end < 0) break;
      i = end;
      continue;
    }
    if ('$<>'.includes(ch) && command[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      for (; j < command.length && depth > 0; j++) depth += command[j] === '(' ? 1 : command[j] === ')' ? -1 : 0;
      out.push(command.slice(i + 2, depth === 0 ? j - 1 : j));
      i = j - 1;
    }
  }
  return out;
}

function segmentRisk(segment: string, ctx: Context): string | null {
  if (/\[(?:System\.)?Environment\]::SetEnvironmentVariable/i.test(segment)) return '永久修改环境变量';
  if (/\[scriptblock\]::create/i.test(segment)) return '动态执行生成的 PowerShell 代码';
  const { words, writes, reads } = splitRedirects(tokenizeCommand(segment));
  if (reads.some(isCredentialPath)) return '访问凭据文件';
  for (const target of writes) {
    const risk = argWriteRisk(target, ctx.env, '写入工作区外的文件');
    if (risk) return risk;
  }
  const command = unwrap(words);
  if (typeof command === 'string' || command === null) return command;
  const { name, args, fromStdin } = command;
  return (
    credentialRisk(name, args) ??
    nestedRisk(name, args, ctx) ??
    commandRule(name, args) ??
    runnerRisk(name, args, ctx) ??
    stdinRisk(name, args, ctx) ??
    mutationRisk(name, args, ctx.env, fromStdin)
  );
}

const NULL_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', 'nul', '$null']);

/** 拆出重定向：写入目标与输入文件单独返回，heredoc 定界符丢弃 */
function splitRedirects(tokens: CommandToken[]): { words: string[]; writes: string[]; reads: string[] } {
  const words: string[] = [];
  const writes: string[] = [];
  const reads: string[] = [];
  const write = (target: string | undefined) => {
    if (target && !target.startsWith('&') && !NULL_SINKS.has(target.toLowerCase())) writes.push(target);
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (/^(?:\d+|&)?>>?&/.test(t.raw)) continue;
    const out = /^(?:\d+|&)?>[>|]?/.exec(t.raw);
    const input = out ? null : /^\d*<(?:<<?|&)?/.exec(t.raw);
    const op = out ?? input;
    if (op) {
      const target = t.value.slice(op[0].length) || tokens[++i]?.value;
      if (out) write(target);
      else if (target && op[0].endsWith('<') && !op[0].endsWith('<<')) reads.push(target);
      continue;
    }
    const k = t.quoted ? -1 : t.raw.indexOf('>');
    if (k > 0) {
      const word = t.raw.slice(0, k).replace(/\d+$/, '');
      if (word) words.push(word);
      const rest = t.raw.slice(k).replace(/^>[>|]?/, '');
      write(rest || tokens[++i]?.value);
      continue;
    }
    words.push(t.value);
  }
  return { words, writes, reads };
}

const PRIVILEGE = new Set(['sudo', 'doas', 'su', 'runas', 'gsudo', 'pkexec']);

export function commandName(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? value;
  return base.toLowerCase().replace(/\.(?:exe|cmd|bat|com|ps1)$/, '');
}

interface Unwrapped {
  name: string;
  args: string[];
  /** 经 xargs 调用：参数来自标准输入 */
  fromStdin: boolean;
}

/** 去掉分组符号、环境变量赋值与包装命令，得到真正执行的命令；提权直接返回原因 */
function unwrap(words: string[]): Unwrapped | string | null {
  let rest = trimGrouping(words);
  let fromStdin = false;
  while (rest.length > 0) {
    const start = rest.findIndex((w) => !/^[A-Za-z_]\w*=/.test(w));
    if (start < 0) return null;
    rest = rest.slice(start);
    const name = commandName(rest[0]!);
    if (PRIVILEGE.has(name)) return '以管理员或其他用户身份执行';
    const split = name === 'env' ? rest.findIndex((w) => w === '-S' || w === '--split-string') : -1;
    if (split > 0 && rest[split + 1] !== undefined) {
      rest = [...tokenizeCommand(rest[split + 1]!).map((t) => t.value), ...rest.slice(split + 2)];
      continue;
    }
    const skip = wrapperArgs(name, rest.slice(1));
    if (skip === undefined) return { name, args: rest.slice(1), fromStdin };
    fromStdin ||= name === 'xargs';
    rest = rest.slice(1 + skip);
  }
  return null;
}

function trimGrouping(words: string[]): string[] {
  const start = words.findIndex((w) => !/^[({!&]+$/.test(w));
  if (start < 0) return [];
  let end = words.length;
  while (end > start && /^[)}]+$/.test(words[end - 1]!)) end--;
  const out = words.slice(start, end);
  out[0] = out[0]!.replace(/^[({]+/, '');
  out[out.length - 1] = out[out.length - 1]!.replace(/[)}]+$/, '');
  return out.filter((w) => w !== '');
}

/** 选项（含需要取值的选项）之后的参数个数；`--` 也一并跳过 */
function skipOptions(args: string[], withValue: string[] = []): number {
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-') && args[i] !== '-') {
    if (args[i] === '--') return i + 1;
    i += withValue.includes(args[i]!) ? 2 : 1;
  }
  return i;
}

/** 包装命令要跳过的参数个数；不是包装命令时返回 undefined */
function wrapperArgs(name: string, args: string[]): number | undefined {
  switch (name) {
    case 'env':
      return skipOptions(args, ['-u', '--unset', '-C', '--chdir']);
    case 'nohup':
    case 'time':
    case 'builtin':
    case 'winpty':
    case 'cross-env':
    case 'cross-env-shell':
      return skipOptions(args);
    case 'command':
      return /^-[vV]$/.test(args[0] ?? '') ? args.length : skipOptions(args);
    case 'exec':
      return skipOptions(args, ['-a']);
    case 'nice':
      return skipOptions(args, ['-n', '--adjustment']);
    case 'stdbuf':
      return skipOptions(args, ['-i', '-o', '-e']);
    case 'timeout':
      return skipOptions(args, ['-s', '--signal', '-k', '--kill-after']) + 1;
    case 'dotenv':
      return skipOptions(args, ['-e', '-c', '-v']);
    case 'xargs':
      return skipOptions(args, ['-I', '-n', '-P', '-d', '-L', '-s', '-E', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file']);
    default:
      return undefined;
  }
}

/** 只看元数据或是否存在的命令不算读取凭据 */
const META_ONLY = new Set(['ls', 'dir', 'test', '[', '[[', 'stat', 'file', 'du', 'touch', 'get-item', 'test-path']);
/** 搜索类命令：第一个位置参数是搜索模式，不是文件 */
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'findstr']);

function credentialRisk(name: string, args: string[]): string | null {
  // 删除命令由写入规则判断（工作区外、整个工作区、.env 等），这里不重复
  if (META_ONLY.has(name) || DELETE.has(name)) return null;
  if (name === 'git' && args.some((a) => ['check-ignore', 'ls-files', 'status'].includes(a))) return null;
  let values = args;
  if (SEARCHERS.has(name)) {
    const patternFlags = ['-e', '-f', '--regexp', '--file'];
    const explicit = args.some((a) => patternFlags.some((f) => a === f || a.startsWith(`${f}=`)));
    const files = explicit ? positionals(args, new Set(patternFlags)) : positionals(args).slice(1);
    const globs = args.flatMap((a, i) =>
      ['-g', '--glob', '--iglob'].includes(a) ? [args[i + 1] ?? ''] : a.startsWith('--glob=') ? [a.slice(7)] : [],
    );
    values = [...files, ...globs];
  } else if (name === 'select-string' || name === 'sls') {
    values = args.filter((_, i) => args[i - 1]?.toLowerCase() !== '-pattern');
  }
  return values.some(isCredentialPath) ? '访问凭据文件' : null;
}

const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish']);
const PS_VALUE = new Set(['-executionpolicy', '-ep', '-ex', '-windowstyle', '-w', '-outputformat', '-of', '-inputformat', '-if']);
const PS_VALUE_MORE = new Set(['-workingdirectory', '-wd', '-configurationname', '-version', '-psconsolefile', '-settingsfile']);

/** 动态执行与包在 shell 里的内层命令 */
function nestedRisk(name: string, args: string[], ctx: Context): string | null {
  if (name === 'eval') return '用 eval 动态执行命令';
  if (name === 'iex' || name === 'invoke-expression') return '用 Invoke-Expression 动态执行命令';
  // 交给 shell 执行的内容由子命令或进程替换生成（如 bash <(curl …)、sh -c "$(curl …)"），无法离线判断
  if ((POSIX_SHELLS.has(name) || name === 'source' || name === '.') && /\$\(|`|<\(/.test(ctx.raw)) return '执行动态生成的命令';
  if (POSIX_SHELLS.has(name)) {
    const i = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
    if (i >= 0) return args[i + 1] === undefined ? null : bashRisk(args[i + 1]!, ctx.env, ctx.depth + 1);
    const stdin = args.includes('-s') || positionals(args).every((a) => a === '-');
    return ctx.piped && stdin ? '把管道中的内容交给 shell 执行' : null;
  }
  if (name === 'pwsh' || name === 'powershell') return powershellRisk(args, ctx);
  if (name === 'cmd') {
    const i = args.findIndex((a) => /^\/[ck]$/i.test(a));
    if (i >= 0) return windowsRisk(args.slice(i + 1).join(' '), ctx);
    return ctx.piped ? '把管道中的内容交给 shell 执行' : null;
  }
  if (name === 'find') return findRisk(args, ctx);
  return null;
}

/** 只看 PowerShell 自身的启动参数；-Command 或第一个位置参数之后都是要执行的命令 */
function powershellRisk(args: string[], ctx: Context): string | null {
  // Windows PowerShell 也接受 /Command、--EncodedCommand 这样的写法
  const isOption = (a: string) => (a.startsWith('-') && a !== '-') || /^\/[a-z]+$/i.test(a);
  let i = 0;
  while (i < args.length && isOption(args[i]!)) {
    const option = `-${args[i]!.replace(/^(?:--?|\/)/, '').toLowerCase()}`;
    const flag = (full: string) => option.length > 1 && full.startsWith(option.slice(1));
    if (flag('encodedcommand') || option === '-ec') return '执行编码过的 PowerShell 命令';
    if (flag('file')) return null;
    if (flag('command')) {
      i++;
      break;
    }
    i += PS_VALUE.has(option) || PS_VALUE_MORE.has(option) ? 2 : 1;
  }
  const text = args.slice(i).join(' ').trim();
  if (text === '' || text === '-') return ctx.piped ? '把管道中的内容交给 PowerShell 执行' : null;
  return windowsRisk(text, ctx);
}

const RUNNER_VALUE = ['-p', '--package', '-c', '--call', '--filter', '-F', '-C', '--dir', '-w', '--workspace', '--prefix', '--cwd'];

/** npx / pnpm exec / yarn <bin> 等包运行器：继续分析它们要运行的命令 */
function runnerRisk(name: string, args: string[], ctx: Context): string | null {
  let rest: string[] = [];
  if (name === 'npx' || name === 'pnpx' || name === 'bunx') rest = args.slice(skipOptions(args, RUNNER_VALUE));
  else if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
    const i = skipOptions(args, RUNNER_VALUE);
    const sub = args[i];
    if (sub === 'exec' || sub === 'x' || sub === 'dlx') rest = args.slice(i + 1).slice(skipOptions(args.slice(i + 1), RUNNER_VALUE));
    else if (name !== 'npm') rest = args.slice(i);
  }
  return rest.length > 0 ? bashRisk(rest.join(' '), ctx.env, ctx.depth + 1) : null;
}

const INTERPRETERS = new Set(['python', 'py', 'node', 'perl', 'ruby', 'php', 'deno', 'bun']);

/** 管道内容被解释器当作代码执行（没有脚本文件、-c / -e / -m 等参数） */
function stdinRisk(name: string, args: string[], ctx: Context): string | null {
  if (!ctx.piped || !INTERPRETERS.has(name.replace(/\d+(?:\.\d+)?$/, ''))) return null;
  if (args.some((a) => /^-(?:[cemprE]|pe|ne|-eval|-print)$/.test(a))) return null;
  // deno run - / bun run - 同样从标准输入读代码
  const scripts = positionals(args).filter((a, i) => !(i === 0 && (a === 'run' || a === 'eval')));
  return scripts.some((a) => a !== '-') ? null : '把管道中的内容交给解释器执行';
}

/** 不缩小范围的 find 表达式：带上它们的 -delete 仍会删掉整个目录树 */
const FIND_NEUTRAL = /^-(?:delete|depth|print0?|xdev|mount|follow|noleaf|daystart|ignore_readdir_race|type|maxdepth|mindepth)$/;

function findRisk(args: string[], ctx: Context): string | null {
  const first = args.findIndex((a) => a.startsWith('-') || a === '(' || a === '!' || a === ')');
  const roots = first < 0 ? args : args.slice(0, first);
  const expression = first < 0 ? [] : args.slice(first);
  const predicates: string[] = [];
  const commands: string[][] = [];
  for (let i = 0; i < expression.length; i++) {
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(expression[i]!)) {
      predicates.push(expression[i]!);
      continue;
    }
    const end = expression.findIndex((b, j) => j > i && (b === ';' || b === '+'));
    const stop = end < 0 ? expression.length : end;
    commands.push(expression.slice(i + 1, stop).filter((b) => b !== '{}'));
    i = stop;
  }
  const deletes = predicates.includes('-delete') || commands.some((c) => DELETE.has(commandName(c[0] ?? '')));
  if (!deletes && commands.length === 0 && !predicates.some((a) => /^-(?:fprint0?|fprintf|fls)$/.test(a))) return null;
  for (const root of roots.length > 0 ? roots : ['.']) {
    const resolved = resolveArg(root, ctx.env);
    const narrowed = predicates.some((a) => (a.startsWith('-') && !FIND_NEUTRAL.test(a)) || a === '!' || a === '(');
    if (deletes && !narrowed && resolved.kind === 'path' && wholeWorkspace(resolved.abs, ctx.env)) return '递归删除整个工作区';
    const risk = argWriteRisk(root, ctx.env);
    if (risk) return risk;
  }
  for (const command of commands) {
    const risk = bashRisk(command.join(' '), ctx.env, ctx.depth + 1);
    if (risk) return risk;
  }
  return null;
}
