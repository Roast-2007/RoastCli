/**
 * bash 命令的权限分析（启发式，不是完整 shell 解析器）：
 * - parseCommand：按 ; && || | & 换行拆成子命令（尊重单/双引号与转义），
 *   识别命令替换 $(...) / 反引号（无法静态分析 → 必须询问）与写文件的输出重定向
 * - isReadOnlyCommand：常见只读命令白名单（默认模式下免询问）
 * - dangerReason：高危命令（即使 yolo 模式或命中 allow 规则也强制询问）
 */

export interface ParsedCommand {
  segments: string[];
  hasSubshell: boolean;
  writesFiles: boolean;
}

/** 扫描一遍，按顶层（引号外）分隔符拆分 */
export function parseCommand(command: string): ParsedCommand {
  const segments: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let hasSubshell = false;
  let writesFiles = false;
  const push = () => {
    const s = cur.trim();
    if (s) segments.push(s);
    cur = '';
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = command[i + 1];
    if (quote) {
      if (ch === '\\' && quote === '"' && next !== undefined) {
        cur += ch + next;
        i++;
        continue;
      }
      if (quote === '"' && (ch === '`' || (ch === '$' && next === '('))) hasSubshell = true;
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '\\' && next !== undefined) {
      cur += ch + next;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '`' || (ch === '$' && next === '(')) hasSubshell = true;
    if (ch === '>' && isFileRedirect(command, i)) writesFiles = true;
    if (ch === ';' || ch === '\n') {
      push();
      continue;
    }
    if ((ch === '&' || ch === '|') && next === ch) {
      push();
      i++;
      continue;
    }
    if (ch === '|' || (ch === '&' && command[i - 1] !== '>' && next !== '>')) {
      push();
      continue;
    }
    cur += ch;
  }
  push();
  return { segments, hasSubshell, writesFiles };
}

/** `>` 是否为写文件重定向：排除 2>&1、>&2、>/dev/null */
function isFileRedirect(command: string, i: number): boolean {
  let j = i + 1;
  if (command[j] === '>') j++;
  if (command[j] === '&') return false;
  while (command[j] === ' ') j++;
  return !command.startsWith('/dev/null', j);
}

const READ_ONLY_PREFIXES = [
  'ls', 'dir', 'pwd', 'cat', 'head', 'tail', 'wc', 'echo', 'printf', 'which', 'type', 'whoami', 'date',
  'rg', 'grep', 'tree', 'stat', 'file', 'du', 'df', 'env', 'printenv', 'uname', 'hostname',
  'git status', 'git diff', 'git log', 'git show', 'git branch', 'git remote -v', 'git rev-parse', 'git blame',
  'node --version', 'node -v', 'npm --version', 'pnpm --version', 'npm ls', 'pnpm ls', 'python --version',
];

function startsWithWord(cmd: string, prefix: string): boolean {
  return cmd === prefix || cmd.startsWith(prefix + ' ');
}

export function isReadOnlyCommand(segment: string): boolean {
  const cmd = segment.trim().replace(/\s+/g, ' ');
  if (/^git (diff|log|show)\b/.test(cmd) && /\s["']?--output(?:["']?(?:\s|=|$))/.test(cmd)) return false;
  if (startsWithWord(cmd, 'git ls-files')) return true;
  if (startsWithWord(cmd, 'git stash list')) return !/\s["']?--output(?:["']?(?:\s|=|$))/.test(cmd);
  if (startsWithWord(cmd, 'git branch')) return /^git branch(?: (?:-[avr]+|--(?:all|remotes|list|verbose|show-current|no-color)))*$/.test(cmd);
  if (/^git tag(?: (?:-l|--list|--sort(?:=| )\S+|--format(?:=| )\S+))*$/.test(cmd)) return true;
  if (startsWithWord(cmd, 'sort')) return !/(?:^|\s)["']?(?:-o\S*|--output)(?:["']?(?:\s|=|$))/.test(cmd);
  if (startsWithWord(cmd, 'od')) return true;
  if (startsWithWord(cmd, 'find')) return !/\s-(delete|exec|execdir|ok|fprint)\b/.test(cmd);
  return READ_ONLY_PREFIXES.some((p) => startsWithWord(cmd, p));
}

/**
 * 验证类命令（运行测试 / 类型检查 / lint，不改源码）：只读角色（judge / critic）可以执行以核实候选方案。
 * 带自动修复或更新快照的参数（--fix / --write / -u / --update*）不算。
 */
const VERIFY_PATTERNS: RegExp[] = [
  /^(pnpm|npm|yarn|bun)( run)? (test|typecheck|type-check|lint|check)(\s|$)/,
  /^(pnpm( exec)?|npx|yarn|bunx) (vitest|jest|mocha|eslint)(\s|$)/,
  /^(vitest|jest|mocha|eslint|pytest|mypy|ruff check)(\s|$)/,
  /^(python3?|py) -m (pytest|mypy|unittest)(\s|$)/,
  /^(go (test|vet)|cargo (test|check|clippy))(\s|$)/,
  /^((pnpm( exec)?|npx|yarn) )?tsc\s.*--noEmit(?:\s|$)/,
];
// 参数可能被引号包裹；输出路径的短参数还允许 -opath 的紧凑写法。
const VERIFY_WRITES = /(?:^|\s)["']?(?:-o\S*|-u|--(?:fix\S*|write|update\S*|output\S*|basetemp|install-types|generateTrace|incremental|composite|tsBuildInfoFile|junit\S*|log-file|html|cov-report)|-(?:coverprofile|cpuprofile|memprofile|blockprofile|mutexprofile|trace))(?:["']?(?:\s|=|$))/i;

export function isVerificationCommand(segment: string): boolean {
  const cmd = segment.trim().replace(/\s+/g, ' ');
  return VERIFY_PATTERNS.some((p) => p.test(cmd)) && !VERIFY_WRITES.test(cmd) && !/--noEmit(?:=|\s+)false\b/.test(cmd);
}

/** Read-only roles may inspect or verify; cd still goes through the normal permission check. */
export function isReadOnlyRoleCommand(command: string): boolean {
  const parsed = parseCommand(command);
  return !parsed.hasSubshell && !parsed.writesFiles && parsed.segments.length > 0 && parsed.segments.every(
    (segment) => /^cd(\s|$)/.test(segment.trim()) || isReadOnlyCommand(segment) || isVerificationCommand(segment),
  );
}

const DANGER_PATTERNS: [RegExp, string][] = [
  [/\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+|-[a-zA-Z]*\s+)*(-[a-zA-Z]+\s+)*(\/|~|\*|\/\*|~\/?\*?|\$HOME)(\s|$)/, '递归删除根目录/家目录/通配全部'],
  [/\bgit\s+push\b.*(\s--force\b|\s-f\b|\s--force-with-lease\b)/, '强制推送会覆盖远端历史'],
  [/\bgit\s+reset\s+--hard\b/, 'git reset --hard 会丢弃未提交改动'],
  [/\bgit\s+clean\s+-[a-zA-Z]*f/, 'git clean -f 会删除未跟踪文件'],
  [/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, '下载并直接执行脚本'],
  [/\bdd\b.*\bof=\/dev\//, 'dd 直接写块设备'],
  [/\bmkfs(\.\w+)?\b/, '格式化文件系统'],
  [/:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/, 'fork 炸弹'],
  [/\bchmod\s+-R\s+0?777\s+\/(\s|$)/, '递归放开根目录权限'],
  [/\b(shutdown|reboot|halt|poweroff)\b/, '关机/重启'],
  [/\bformat\s+[a-zA-Z]:/i, '格式化磁盘'],
  [/\b(del|rd|rmdir)\s+\/s\b.*[a-zA-Z]:\\?\s*$/i, '递归删除整个盘符'],
  [/>\s*\/dev\/sd[a-z]\b/, '覆盖块设备'],
  [/(\.ssh\/|\.aws\/credentials|\.npmrc|\.netrc|\.git-credentials|\bid_rsa\b|\.env\b)[\s\S]*\b(curl|wget|nc|ncat|scp)\b|\b(curl|wget|nc|ncat|scp)\b[\s\S]*(\.ssh\/|\.aws\/credentials|\.npmrc|\.netrc|\.git-credentials|\bid_rsa\b)/, '疑似外传凭据'],
];

export function dangerReason(command: string): string | null {
  for (const [re, reason] of DANGER_PATTERNS) if (re.test(command)) return reason;
  return null;
}
