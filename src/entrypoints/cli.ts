#!/usr/bin/env node
/**
 * CLI 入口：
 * - roast / roast chat            → Ink REPL
 * - roast -p "<prompt>"           → 管道模式（纯文本流式输出，不进 Ink）
 * - roast -c / roast -r [runId]   → 继续本目录最近会话 / 恢复指定会话
 * - roast logs list / show <id>   → 运行日志浏览（无需配置）
 * - roast mcp add / list / remove  → 管理 MCP 服务器
 * - roast doctor                   → 环境自检
 * - roast init                     → 生成最小可用配置
 * 全局选项：-m, --model <provider:model> 覆盖 config.default
 */
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { VERSION } from '../core/version.js';
import { asRoastError, RoastError } from '../core/errors.js';
import { createSession, type Session } from '../agent/session.js';
import { deriveMessages, loadRunLog } from '../session/projection.js';
import type { ContentBlock } from '../core/types.js';
import { runPrintMode, runStreamJson } from '../cli/print-mode.js';
import { findRunLog, listRuns, readHeader, resolveLogsRoot } from '../cli/logs.js';
import { findLatestRunFor } from '../session/resume.js';
import { canonicalPath } from '../core/paths.js';
import { runTrust } from '../cli/trust.js';
import { ensureFolderTrust } from '../cli/startup.js';
import { MODE_CYCLE, type PermissionMode } from '../tools/permissions/engine.js';
import { mcpAdd, mcpList, mcpRemove, type McpAddOptions } from '../cli/mcp.js';
import { collectChecks, renderChecks } from '../cli/doctor.js';
import { initConfig, type InitOptions } from '../cli/init.js';
import { configSources, isProjectTrusted, roastHome } from '../core/config.js';
import { buildSwarmPrompt, DEFAULT_N, DEFAULT_TEMPLATE, describeTemplates, loadTemplates } from '../swarm/templates.js';
import { listWorktrees, pruneWorktrees, savedWorktreesText } from '../cli/worktrees.js';
import { terminalText } from '../core/terminal-text.js';

/**
 * 把 `roast -p ...` / `roast` 归一化为 `roast chat -p ...` / `roast chat`，
 * 避免依赖 commander 默认命令对选项的解析行为。
 */
function normalizeArgv(argv: string[]): string[] {
  const args = argv.slice(2);
  const first = args[0];
  if (first === undefined) return [...argv.slice(0, 2), 'chat'];
  if (first === 'chat' || first === 'logs' || first === 'help' || first === 'trust' || first === 'swarm' || first === 'mcp' || first === 'doctor' || first === 'init' || first === 'config' || first === 'worktrees') return argv;
  if (first.startsWith('-')) {
    // --help / -h / --version 交给 program 级处理，其余选项归 chat
    if (first === '--help' || first === '-h' || first === '--version' || first === '-V') return argv;
    return [...argv.slice(0, 2), 'chat', ...args];
  }
  return argv;
}

interface ChatOptions {
  prompt?: string;
  model?: string;
  continue?: boolean;
  resume?: string | true;
  permissionMode?: string;
  outputFormat?: string;
  /** 交互模式启动后自动提交的首条消息（roast swarm） */
  initialPrompt?: string | (() => string);
}

interface SwarmOptions {
  template?: string;
  n?: string;
  listTemplates?: boolean;
  print?: boolean;
  outputFormat?: string;
  model?: string;
  permissionMode?: string;
}

function swarmTemplates() {
  const cwd = process.cwd();
  return loadTemplates(cwd, roastHome(), { trusted: isProjectTrusted(cwd) });
}

const MIN_N = 2;
const MAX_N = 8;

function parseN(value: string | undefined): number {
  if (value === undefined) return DEFAULT_N;
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_N || n > MAX_N) throw new RoastError('INVALID_REQUEST', `--n 应为 ${MIN_N}–${MAX_N} 的整数`);
  return n;
}

function parsePermissionMode(value: string | undefined): PermissionMode | undefined {
  if (value === undefined) return undefined;
  if ((MODE_CYCLE as readonly string[]).includes(value)) return value as PermissionMode;
  return fail(`未知的权限模式 "${value}"（可选: ${MODE_CYCLE.join(' / ')}）`);
}

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/** -c / -r 解析为要恢复的日志路径；-r 不带 id 时列出本目录最近会话后退出 */
function resolveResumeLog(opts: ChatOptions): string | undefined {
  if (!opts.continue && opts.resume === undefined) return undefined;
  const cwd = process.cwd();
  const logsRoot = resolveLogsRoot(cwd);
  if (opts.continue) {
    const latest = findLatestRunFor(logsRoot, cwd);
    return latest ? latest.logPath : fail('当前目录没有可继续的会话');
  }
  if (opts.resume === true) {
    const target = canonicalPath(cwd);
    const runs = listRuns(logsRoot, 200).filter((r) => r.cwd && canonicalPath(r.cwd) === target).slice(0, 20);
    if (runs.length === 0) fail('当前目录没有历史会话');
    for (const r of runs) {
      process.stdout.write(`${r.runId}  ${r.createdAt.replace('T', ' ').slice(0, 19)}  ${r.provider}:${r.model}\n`);
    }
    process.stdout.write('\n用 roast -r <runId> 恢复指定会话\n');
    process.exit(0);
  }
  const found = findRunLog(logsRoot, opts.resume as string) ?? fail(`未找到会话 "${String(opts.resume)}"（目录: ${logsRoot}）`);
  const recordedCwd = readHeader(found)?.['cwd'];
  if (typeof recordedCwd === 'string' && canonicalPath(recordedCwd) !== canonicalPath(cwd)) {
    process.stderr.write(`注意：该会话记录于 ${recordedCwd}，当前目录是 ${cwd}；工具将在当前目录执行。\n`);
  }
  return found;
}

/** createSession 的错误出口：配置缺失提示 example 并 exit 2，其余 exit 1 */
async function openSession(opts: { modelRef?: string; resumeLogPath?: string; permissionMode?: PermissionMode }): Promise<Session> {
  try {
    return await createSession({
      ...(opts.modelRef ? { modelRef: opts.modelRef } : {}),
      ...(opts.resumeLogPath ? { resumeLogPath: opts.resumeLogPath } : {}),
      ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
    });
  } catch (err) {
    const e = asRoastError(err);
    process.stderr.write(`error [${e.code}] ${e.message}\n`);
    if (e.code === 'CONFIG') {
      process.stderr.write('提示：运行 roast config 使用供应商配置向导，或参考 roastcli.config.example.json 创建配置文件\n');
      process.exit(2);
    }
    if (e.code === 'UNTRUSTED_CONFIG') process.exit(3);
    process.exit(1);
  }
}


async function runChat(opts: ChatOptions): Promise<void> {
  const permissionMode = parsePermissionMode(opts.permissionMode);
  const interactive = opts.prompt === undefined && !!process.stdin.isTTY && !!process.stdout.isTTY;
  if (interactive) {
    const { runTrustPrompt, runProviderWizard } = await import('../ui/screens.js');
    if (!await ensureFolderTrust(process.cwd(), true, runTrustPrompt)) return;
    if (!configSources().some((source) => source.exists) && !await runProviderWizard(process.cwd())) return;
  }
  const initialPrompt = typeof opts.initialPrompt === 'function' ? opts.initialPrompt() : opts.initialPrompt;
  const resumeLogPath = resolveResumeLog(opts);
  const session = await openSession({
    ...(opts.model ? { modelRef: opts.model } : {}),
    ...(resumeLogPath ? { resumeLogPath } : {}),
    ...(permissionMode ? { permissionMode } : {}),
  });
  if (opts.prompt !== undefined) {
    // 管道模式：SIGINT → 优雅中断当前 turn（loop 走 aborted 收尾并落日志），再退出
    const controller = new AbortController();
    process.on('SIGINT', () => {
      if (!controller.signal.aborted) {
        controller.abort();
      } else {
        process.exit(130); // 第二次 Ctrl+C 强退
      }
    });
    const code =
      opts.outputFormat === 'stream-json'
        ? await runStreamJson(session, opts.prompt, process.stdout, controller.signal)
        : await runPrintMode(session.loop, opts.prompt, process.stdout, process.stderr, controller.signal);
    process.stderr.write(savedWorktreesText((await session.shutdown()).worktrees));
    process.exit(controller.signal.aborted && code === 0 ? 130 : code);
  }
  // inline 对话 ⇄ Mission Control（Ctrl+G）的屏幕管理；退出时中断进行中的 turn 并等它收尾再关日志
  const { runInteractive } = await import('../ui/screens.js');
  await runInteractive(session, initialPrompt ? { initialPrompt } : {});
}

function runLogsList(): void {
  const logsRoot = resolveLogsRoot();
  const runs = listRuns(logsRoot, 20);
  if (runs.length === 0) {
    process.stdout.write(`没有找到运行日志（目录: ${logsRoot}）\n`);
    return;
  }
  for (const r of runs) {
    const time = r.createdAt ? r.createdAt.replace('T', ' ').slice(0, 19) : '-';
    process.stdout.write(`${r.runId}  ${time}  ${r.provider}:${r.model}  ${r.cwd}\n`);
  }
}

function blockSummary(block: ContentBlock): string {
  switch (block.type) {
    case 'text': {
      const t = block.text;
      return `  text: ${t.length > 500 ? t.slice(0, 500) + '…' : t}`;
    }
    case 'reasoning':
      return `  reasoning: ${block.text.slice(0, 200)}`;
    case 'tool-call':
      return `  tool-call: ${block.name} ${JSON.stringify(block.args)}`;
    case 'tool-result': {
      const first = block.content.find((b) => b.type === 'text');
      const preview = first && first.type === 'text' ? first.text.replace(/\s+/g, ' ').slice(0, 200) : '';
      return `  tool-result: ${block.name} ${block.isError ? '✗' : '✓'} ${preview}`;
    }
    case 'image':
      return '  image: (略)';
  }
}

function runLogsShow(runId: string, raw: boolean): void {
  const logsRoot = resolveLogsRoot();
  const logPath = findRunLog(logsRoot, runId);
  if (!logPath) {
    process.stderr.write(`未找到 runId "${runId}"（目录: ${logsRoot}）\n`);
    process.exit(1);
  }
  if (raw) {
    process.stdout.write(readFileSync(logPath, 'utf8'));
    return;
  }
  try {
    const { header, events } = loadRunLog(logPath);
    process.stdout.write(`runId: ${header.runId}\n`);
    process.stdout.write(`time:  ${header.createdAt}\n`);
    process.stdout.write(`model: ${header.provider}:${header.model}\n`);
    process.stdout.write(`cwd:   ${header.cwd}\n\n`);
    const messages = deriveMessages(events);
    messages.forEach((msg, i) => {
      process.stdout.write(`[${i}] ${msg.role}\n`);
      for (const block of msg.content) {
        process.stdout.write(blockSummary(block) + '\n');
      }
    });
    if (messages.length === 0) process.stdout.write('(无可重建的消息)\n');
  } catch (err) {
    const e = err instanceof RoastError ? err : asRoastError(err);
    process.stderr.write(`error [${e.code}] ${e.message}\n`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('roast')
    .description('roast —— coding CLI（agent loop + 可插拔 provider）')
    .version(VERSION)
    .option('-m, --model <provider:model>', '覆盖 config.default 的模型引用');

  program
    .command('chat', { isDefault: true })
    .description('启动交互式 REPL（默认命令）')
    .option('-p, --prompt <prompt>', '管道模式：直接输出结果，不进 Ink')
    .option('-m, --model <provider:model>', '覆盖 config.default 的模型引用')
    .option('-c, --continue', '继续当前目录最近一次会话')
    .option('-r, --resume [runId]', '恢复指定会话（不带 id 时列出本目录最近会话）')
    .option('--permission-mode <mode>', '权限模式：default / acceptEdits / plan / yolo')
    .option('--output-format <format>', '管道模式输出格式：text（默认）/ stream-json（含全部子 agent 事件）')
    .action(async (opts: ChatOptions) => {
      const model = opts.model ?? (program.opts()['model'] as string | undefined);
      await runChat({ ...opts, ...(model !== undefined ? { model } : {}) });
    });

  program
    .command('swarm')
    .description('以 Hive 蜂群方式完成一个目标（多 agent 并行）')
    .argument('[goal...]', '目标描述')
    .option('-t, --template <name>', '策略模板：fanout（默认）/ best-of-n / critique / research / 自定义')
    .option('-n, --n <count>', 'best-of-n 的候选数 / research 的角度数（默认 3）')
    .option('--list-templates', '列出可用的策略模板')
    .option('-p, --print', '管道模式：不进入 TUI')
    .option('--output-format <format>', 'text（默认）/ stream-json')
    .option('-m, --model <provider:model>', '覆盖默认模型')
    .option('--permission-mode <mode>', '权限模式：default / acceptEdits / plan / yolo')
    .action(async (goal: string[], opts: SwarmOptions) => {
      const n = parseN(opts.n);
      if (opts.listTemplates) return void process.stdout.write(describeTemplates(swarmTemplates(), n) + '\n');
      if (goal.length === 0) throw new RoastError('INVALID_REQUEST', '请给出目标，例如：roast swarm -t best-of-n "实现 LRU 缓存"');
      const prompt = () => buildSwarmPrompt(swarmTemplates(), goal.join(' '), opts.template ?? DEFAULT_TEMPLATE, n);
      const headless = opts.print === true || opts.outputFormat !== undefined;
      await runChat({
        ...(headless ? { prompt: prompt() } : { initialPrompt: prompt }),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
        ...(opts.outputFormat ? { outputFormat: opts.outputFormat } : {}),
      });
    });

  program
    .command('trust')
    .description('信任当前项目（允许其配置文件设置 provider 连接信息）')
    .action(() => {
      process.stdout.write(runTrust(process.cwd()) + '\n');
    });

  program
    .command('config')
    .description('终端内供应商配置向导（保存 API Key、模型与推理强度）')
    .action(async () => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new RoastError('INVALID_REQUEST', 'roast config 需要交互终端；脚本配置请使用 roast init 或编辑配置文件');
      const { runProviderWizard } = await import('../ui/screens.js');
      await runProviderWizard(process.cwd());
    });

  program
    .command('init')
    .description('生成最小可用配置（默认 ~/.roast/config.json）')
    .option('--provider <name>', 'deepseek（默认）/ anthropic / openai / qwen / zhipu / kimi / kimi-code / doubao / hunyuan / siliconflow / gemini / openrouter')
    .option('--model <model>', '覆盖默认模型名')
    .option('--api-key-stdin', '从标准输入读取 API Key，并保存到用户凭据文件')
    .option('--reasoning-effort <effort>', '推理强度：none / minimal / low / medium / high / xhigh / max（需模型支持）')
    .option('--project', '写入项目级 .roast/config.json')
    .option('--force', '覆盖已存在的配置文件')
    .action((opts: InitOptions) => {
      if (opts.apiKeyStdin && process.stdin.isTTY) throw new RoastError('INVALID_REQUEST', '请通过管道传入 API Key，或使用 roast config 交互输入');
      process.stdout.write(initConfig(process.cwd(), { ...opts, ...(opts.apiKeyStdin ? { apiKey: readFileSync(0, 'utf8') } : {}) }).text + '\n');
    });

  program
    .command('doctor')
    .description('环境自检：配置、凭据、shell、git、ripgrep、扩展')
    .action(async () => {
      const checks = await collectChecks(process.cwd());
      process.stdout.write(renderChecks(checks) + '\n');
      if (checks.some((c) => c.level === 'fail')) process.exitCode = 1;
    });

  const mcp = program.command('mcp').description('管理 MCP 服务器');
  mcp
    .command('add')
    .description('添加服务器：roast mcp add <名称> -- <命令> [参数...] 或 --url <地址>')
    .argument('<name>')
    .argument('[command...]', 'stdio 服务器的启动命令（放在 -- 之后）')
    .option('--project', '写入项目级 .roast/config.json（默认用户级）')
    .option('--url <url>', 'http / sse 服务器地址')
    .option('--transport <type>', 'stdio / http / sse（默认按 url 推断）')
    .option('-e, --env <KEY=VALUE...>', '环境变量（值可写 ${VAR} 引用）')
    .option('-H, --header <KEY=VALUE...>', 'HTTP 头（值可写 ${VAR} 引用）')
    .action((name: string, command: string[], opts: McpAddOptions) => {
      process.stdout.write(mcpAdd(process.cwd(), name, { ...opts, command }) + '\n');
    });
  mcp
    .command('list')
    .description('列出已配置的服务器')
    .action(() => {
      process.stdout.write(mcpList(process.cwd()) + '\n');
    });
  mcp
    .command('remove')
    .description('移除服务器')
    .argument('<name>')
    .option('--project', '从项目级配置移除')
    .action((name: string, opts: { project?: boolean }) => {
      process.stdout.write(mcpRemove(process.cwd(), name, opts.project) + '\n');
    });

  const worktrees = program.command('worktrees').description('查看和清理当前仓库的蜂群工作区');
  worktrees.command('list').description('列出保留的工作区').action(async () => {
    const entries = await listWorktrees(process.cwd());
    process.stdout.write(entries.length ? entries.map((w) => `${w.runId} / ${w.agentId} · ${w.active ? '使用中或缺少基线记录' : '已结束'} · ${terminalText(w.root)}`).join('\n') + '\n' : '当前仓库没有保留的蜂群工作区。\n');
  });
  worktrees.command('prune').description('清理已结束且无改动的工作区；保留未合并改动').action(async () => {
    const result = await pruneWorktrees(process.cwd());
    process.stdout.write(`已清理 ${result.removed.length} 个工作区；跳过 ${result.active.length} 个使用中或缺少记录的工作区。\n` + savedWorktreesText(result.kept));
  });

  const logs = program.command('logs').description('运行日志浏览');
  logs
    .command('list')
    .description('列出最近 20 次运行')
    .action(() => runLogsList());
  logs
    .command('show')
    .description('重建并打印某次运行的会话')
    .argument('<runId>')
    .option('--raw', '原样打印 log.jsonl')
    .action((runId: string, opts: { raw?: boolean }) => runLogsShow(runId, opts.raw ?? false));

  await program.parseAsync(normalizeArgv(process.argv));
}

main().catch((err: unknown) => {
  const e = asRoastError(err);
  process.stderr.write(`error [${e.code}] ${e.message}\n`);
  process.exit(1);
});
