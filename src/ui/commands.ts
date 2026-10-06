/**
 * 斜杠命令注册表：每个命令 = 名称 + 说明 + run(ctx, args)。命令面板（/ 提示）与 /help 共用这份列表。
 * 输出统一走 store.addNotice（不进入模型上下文）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Session } from '../agent/session.js';
import { MODE_CYCLE, type PermissionMode } from '../tools/permissions/engine.js';
import { renderTodos } from '../tools/interact/index.js';
import type { CommandInfo } from './input/suggest.js';
import type { UiStore, OverlayKind } from './store/store.js';
import { findRunLog } from '../cli/logs.js';
import { logsRootOf } from '../agent/session.js';
import { formatContextStats } from './format-context.js';
import { formatCost } from './status-info.js';
import { formatUsageBreakdown } from '../core/usage-cost.js';
import { parseRoleModels } from '../swarm/model-routing.js';
import { pickTheme, THEMES } from './theme.js';
import type { SkillMeta } from '../ext/skills.js';
import { isProjectTrusted, roastHome, ReasoningEffortSchema } from '../core/config.js';
import { missionInput, DEFAULT_STRATEGY, describeStrategies, loadStrategies } from '../swarm/strategies.js';
import type { RuntimeInput } from '../agent/runtime.js';

export interface CommandContext {
  session: Session;
  store: UiStore;
  exit(): void;
  /** 作为一条用户消息发给模型（/swarm 等） */
  send?(text: RuntimeInput): void;
  openProviders?(): void;
  openOverlay?(overlay: OverlayKind): void;
  clearScreen?(): void;
  resumeSession?(logPath: string): void;
  openWorkspace?(screen: 'inline' | 'hive'): void;
}

export interface SlashCommand extends CommandInfo {
  aliases?: string[];
  run(ctx: CommandContext, args: string): void | Promise<void>;
}

export const KEYS_HELP = [
  '快捷键：',
  '  Enter 发送 · Shift+Enter / Ctrl+J / 行尾 \\ 换行 · ↑↓ 选择 · Tab 补全 · Ctrl+R 搜索历史',
  '  ? / F1 帮助 · Esc 中断（空闲时连按两次：回退菜单）· Ctrl+C 中断 / 退出',
  '  Shift+Tab 切换权限模式 · Ctrl+O 最近工具的完整输出 · Ctrl+G Mission Control',
  '  鼠标滚轮翻阅聊天 · Shift+↑↓ / PgUp 阅读 · Home 顶部 · End / Enter / Esc 返回输入',
  '  前缀：/ 命令 · @ 文件 · ! shell · # 记忆',
].join('\n');

const say = (ctx: CommandContext, text: string, tone: 'info' | 'warn' | 'error' | 'success' = 'info') => ctx.store.addNotice('main', text, tone);
const importEffort = (value: string) => ReasoningEffortSchema.parse(value);

const MEMORY_HEADING = '## 记忆';
export const INIT_TEMPLATE = `# 项目说明（ROAST.md）

> RoastCli 每次会话都会读取本文件。写下项目约定、常用命令和注意事项。

## 常用命令
- 安装：
- 测试：
- 构建：

## 约定
-

${MEMORY_HEADING}
`;

/** 把一条记忆追加到 cwd/ROAST.md 的"记忆"小节（文件或小节不存在则创建） */
export function appendMemory(cwd: string, note: string): string {
  const file = path.join(cwd, 'ROAST.md');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const line = `- ${note.trim()}`;
  const next = current.includes(MEMORY_HEADING)
    ? current.replace(MEMORY_HEADING, `${MEMORY_HEADING}\n${line}`)
    : `${current.trimEnd()}${current ? '\n\n' : ''}${MEMORY_HEADING}\n${line}\n`;
  writeFileSync(file, next, 'utf8');
  return file;
}

/** /swarm [模板] <目标>：按策略模板生成给 Queen 的指令并发送；不带参数时列出模板 */
function swarm(ctx: CommandContext, args: string): void {
  const roleModels: string[] = [];
  args = args.replace(/(?:^|\s)--role-model\s+(\S+)/g, (_match, value: string) => { roleModels.push(value); return ' '; }).trim();
  if (roleModels.length) ctx.session.configureSwarmModels?.(parseRoleModels(roleModels));
  if (args === 'models' && ctx.openOverlay) return ctx.openOverlay('hive-models');
  const cwd = ctx.session.log.header.cwd;
  const templates = loadStrategies(cwd, roastHome(), { trusted: isProjectTrusted(cwd) });
  if (!args) return ctx.openWorkspace ? ctx.openWorkspace('hive') : say(ctx, describeStrategies(templates));
  const [first = '', ...rest] = args.split(/\s+/);
  const explicit = templates.has(first);
  const name = explicit ? first : ctx.store.getState().meta.strategy ?? ctx.session.config.swarm.strategy ?? DEFAULT_STRATEGY;
  let n = ctx.store.getState().meta.n ?? ctx.session.config.swarm.n;
  if (explicit && /^\d+$/.test(rest[0] ?? '')) n = Number(rest.shift());
  const goal = explicit ? rest.join(' ') : args;
  if (!goal) { ctx.store.setMeta({ strategy: name, ...(n !== undefined ? { n } : {}) }); ctx.openWorkspace?.('hive'); return; }
  if (!ctx.send) return say(ctx, '当前界面不支持直接发起蜂群任务', 'warn');
  ctx.openWorkspace?.('hive');
  ctx.send(missionInput(templates, goal, name, n));
}

async function rewind(ctx: CommandContext, arg: string): Promise<void> {
  if (!arg) {
    if (ctx.openOverlay && ctx.session.listTurns().length > 0) return ctx.openOverlay('rewind');
    const turns = ctx.session.listTurns();
    say(ctx, turns.length ? `可回退的轮次（/rewind N 回到第 N 轮开始前）：\n${turns.map((t) => `  ${t.turn}. ${t.text}`).join('\n')}` : '还没有可回退的轮次');
    return;
  }
  const turn = Number(arg);
  if (!Number.isInteger(turn) || turn < 1) return say(ctx, '用法：/rewind 或 /rewind N', 'warn');
  const r = await ctx.session.rewind(turn);
  const files = r.checkpoint ? `，文件已恢复${r.deleted.length ? `（删除 ${r.deleted.length} 个新文件）` : ''}` : '，期间无文件改动';
  say(ctx, `已回退到第 ${turn} 轮开始前${files}`, 'success');
}

export const COMMANDS: SlashCommand[] = [
  { name: 'clear', description: '清空显示，保留会话上下文和草稿', run: (ctx) => ctx.clearScreen ? ctx.clearScreen() : say(ctx, '当前界面不支持清屏') },
  { name: 'resume', description: '选择历史会话，或按运行 ID 恢复', args: '[runId]', run: (ctx, args) => {
    if (!args) return ctx.openOverlay ? ctx.openOverlay('sessions') : say(ctx, '使用 roast -c 继续最近会话，或 roast -r <runId>');
    const logPath = findRunLog(logsRootOf(ctx.session.config, ctx.session.log.header.cwd), args);
    if (!logPath) return say(ctx, `找不到会话：${args}`, 'warn');
    if (ctx.resumeSession) ctx.resumeSession(logPath);
  } },
  { name: 'provider', aliases: ['config'], description: '打开供应商配置向导（下次启动生效）', run: (ctx) => ctx.openProviders ? ctx.openProviders() : say(ctx, '运行 roast config 打开供应商配置向导') },
  {
    name: 'help',
    description: '列出所有命令与快捷键',
    run: (ctx) => ctx.openOverlay ? ctx.openOverlay('help') : say(ctx, `${COMMANDS.map((c) => `/${c.name}${c.args ? ` ${c.args}` : ''}  ${c.description}`).join('\n')}\n\n${KEYS_HELP}`),
  },
  {
    name: 'context',
    description: '上下文占用；pin / unpin / drop <id> 钉住、取消钉住或手动折叠工具结果',
    args: '[pin|unpin|drop <id...>]',
    run: (ctx, args) => {
      const [action = '', ...ids] = args.split(/\s+/).filter(Boolean);
      if (!action) return ctx.openOverlay ? ctx.openOverlay('context') : say(ctx, formatContextStats(ctx.session.contextStats()));
      if (action !== 'pin' && action !== 'unpin' && action !== 'drop') return say(ctx, '用法：/context [pin|unpin|drop <id...>]', 'warn');
      if (ids.length === 0) return say(ctx, `请给出工具结果 id（/context 查看）`, 'warn');
      say(ctx, ctx.session.contextAction(action, ids));
    },
  },
  {
    name: 'compact',
    description: '立即压缩上下文',
    args: '[关注点]',
    run: async (ctx, args) => {
      if (!args && ctx.openOverlay) return ctx.openOverlay('compact');
      const saved = await ctx.session.compact(args || undefined);
      say(ctx, saved > 0 ? `已压缩上下文，约节省 ${saved} tokens` : '暂无可压缩的内容（历史轮次太少）', saved > 0 ? 'success' : 'info');
    },
  },
  { name: 'rewind', description: '回退到某一轮之前（文件 + 对话）', args: '[N]', run: rewind },
  {
    name: 'mode',
    description: '交互式选择权限模式',
    args: '[default|acceptEdits|plan|yolo]',
    run: (ctx, args) => {
      if (!args && ctx.openOverlay) return ctx.openOverlay('mode');
      if (args && !(MODE_CYCLE as readonly string[]).includes(args)) return say(ctx, `未知模式：${args}`, 'warn');
      const mode = args ? (ctx.session.permissions.setMode(args as PermissionMode), args) : ctx.session.permissions.cycleMode();
      say(ctx, `权限模式：${mode}`);
    },
  },
  { name: 'model', description: '自动发现、选择模型与推理强度', args: '[provider:model] [effort|auto]', run: (ctx, args) => {
    if (!args && ctx.openOverlay) return ctx.openOverlay('model');
    if (args) { const [ref = '', effort] = args.split(/\s+/); const parsed = effort === 'auto' ? null : effort === undefined ? undefined : importEffort(effort); ctx.session.switchModel(ref, parsed); ctx.store.setMeta({ contextPercent: ctx.session.contextStats().percent }); }
    say(ctx, `${ctx.session.providerName}:${ctx.session.model} · effort ${ctx.session.reasoningEffort ?? '自动'}`);
  } },
  {
    name: 'cost',
    description: '按 turn / agent / provider / model 查看用量与费用',
    run: (ctx) => {
      if (ctx.openOverlay) return ctx.openOverlay('cost');
      if (ctx.session.costBreakdown) return say(ctx, formatUsageBreakdown(ctx.session.costBreakdown()));
      const u = ctx.store.getState().agents['main']!.totalUsage;
      const estimate = ctx.session.cost();
      const cost = estimate !== null ? ` · 约 ${formatCost(estimate)}` : '（部分模型缺少 pricing，无法完整估算费用）';
      say(ctx, `输入 ${u.input + u.cacheRead}（其中缓存命中 ${u.cacheRead}）· 输出 ${u.output} · 缓存写入 ${u.cacheWrite}${cost}`);
    },
  },
  {
    name: 'todo',
    description: '查看当前待办清单',
    run: (ctx) => ctx.openOverlay ? ctx.openOverlay('todo') : say(ctx, renderTodos(ctx.store.getState().agents['main']!.todos)),
  },
  {
    name: 'init',
    description: '创建 ROAST.md 项目说明模板',
    run: (ctx) => {
      if (ctx.openOverlay) return ctx.openOverlay('init');
      const file = path.join(ctx.session.log.header.cwd, 'ROAST.md');
      if (existsSync(file)) return say(ctx, `ROAST.md 已存在：${file}`, 'warn');
      writeFileSync(file, INIT_TEMPLATE, 'utf8');
      say(ctx, `已创建 ${file}（下次会话生效）`, 'success');
    },
  },
  {
    name: 'skills',
    description: '列出可用技能（/技能名 [参数] 直接调用）',
    run: (ctx) => {
      if (ctx.openOverlay) return ctx.openOverlay('skills');
      const list = ctx.session.skills.list();
      say(ctx, list.length ? list.map((s) => `/${s.name}  ${s.description}（${s.source}）`).join('\n') : '没有技能。在 .roast/skills/<名称>/SKILL.md 或 ~/.roast/skills 下添加');
    },
  },
  {
    name: 'memory',
    description: '查看 / 检索项目长期记忆',
    args: '[关键词]',
    run: async (ctx, args) => {
      if (!args && ctx.openOverlay) return ctx.openOverlay('memory');
      const facts = args ? await ctx.session.memory.recall(args) : ((await ctx.session.memory.list?.({ limit: 30 })) ?? []);
      say(ctx, facts.length ? facts.map((f) => `[${f.id}] ${f.content}`).join('\n') : '没有记忆（模型可用 memory 工具保存，或输入 # 内容 写入 ROAST.md）');
    },
  },
  {
    name: 'theme',
    description: '查看或即时切换主题',
    args: '[ember|aurora|daylight|mono]',
    run: (ctx, args) => {
      if (!args && ctx.openOverlay) return ctx.openOverlay('theme');
      if (args && !THEMES[args]) return say(ctx, `未知主题：${args}`, 'warn');
      if (args) ctx.store.setMeta({ theme: args });
      const current = pickTheme(process.env, ctx.store.getState().meta.theme ?? ctx.session.config.ui?.theme).name;
      say(ctx, Object.keys(THEMES).map((n) => `${n === current ? '●' : '○'} ${n}`).join('  '));
    },
  },
  { name: 'hive', aliases: ['swarm'], description: '进入指挥台或发起任务；models 配置角色模型', args: '[策略] [n] [目标]|models', run: swarm },
  { name: 'chat', description: '切到 Chat', run: (ctx) => ctx.openWorkspace?.('inline') },
  { name: 'strategy', description: '设置本会话的默认策略和并行数', args: '[名称] [n]', run: (ctx, args) => {
    if (!args) return ctx.openOverlay?.('strategy');
    const [name, count] = args.split(/\s+/);
    const strategies = loadStrategies(ctx.session.log.header.cwd, roastHome(), { trusted: isProjectTrusted(ctx.session.log.header.cwd) });
    const input = missionInput(strategies, '', name, count === undefined ? ctx.store.getState().meta.n : Number(count));
    ctx.store.setMeta({ strategy: input.strategy.name, n: input.n });
  } },
  { name: 'agents', description: '管理蜂群成员、状态和模型', run: (ctx) => ctx.openOverlay ? ctx.openOverlay('agents') : say(ctx, ctx.session.swarm.tree().map((agent) => `${'  '.repeat(agent.depth)}${agent.id} [${agent.role}] ${agent.state} · ${agent.model} · ${agent.brief}`).join('\n')) },
  { name: 'board', description: '列出黑板，或查看指定条目的完整值', args: '[key]', run: (ctx, key) => {
    if (!key && ctx.openOverlay) return ctx.openOverlay('board');
    if (key) {
      const entry = ctx.session.swarm.board.read(key);
      return say(ctx, entry ? `${key} v${entry.version} · ${entry.author}\n${typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value, null, 2)}` : `没有黑板条目：${key}`);
    }
    const entries = ctx.session.swarm.board.list('/');
    say(ctx, entries.length ? entries.map((entry) => `${entry.key} v${entry.version} · ${entry.author} · ${entry.chars} 字`).join('\n') : '黑板为空（/board <key> 查看完整内容）');
  } },
  {
    name: 'mcp',
    description: 'MCP 服务器连接状态',
    run: (ctx) => {
      if (ctx.openOverlay) return ctx.openOverlay('mcp');
      const list = ctx.session.mcpStatus();
      const icon = { connecting: '…', connected: '●', failed: '✗', closed: '○' } as const;
      const lines = list.map((s) => `${icon[s.state]} ${s.name}  ${s.state} · ${s.toolCount} 个工具${s.error ? `\n    ${s.error}` : ''}`);
      say(ctx, lines.length ? lines.join('\n') : '没有配置 MCP 服务器（roast mcp add <名称> -- <命令> [参数...]）');
    },
  },
  { name: 'logs', description: '本次运行日志路径', run: (ctx) => ctx.openOverlay ? ctx.openOverlay('logs') : say(ctx, ctx.session.log.path) },
  { name: 'exit', aliases: ['quit'], description: '退出', run: (ctx) => ctx.exit() },
];

export function findCommand(name: string): SlashCommand | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}

/** 执行一行斜杠命令；返回 false 表示未知命令 */
export async function runSlash(text: string, ctx: CommandContext): Promise<boolean> {
  const [head, ...rest] = text.slice(1).split(' ');
  const cmd = findCommand(head ?? '');
  if (!cmd) return false;
  try {
    await cmd.run(ctx, rest.join(' ').trim());
  } catch (err) {
    say(ctx, `/${cmd.name} 失败：${err instanceof Error ? err.message : String(err)}`, 'error');
  }
  return true;
}

/** 技能也作为斜杠命令出现在命令面板中（内置命令同名时内置优先） */
export function skillCommands(skills: readonly SkillMeta[]): CommandInfo[] {
  return skills.filter((s) => !findCommand(s.name)).map((s) => ({ name: s.name, description: `技能 · ${s.description}`, args: '[参数]' }));
}
export function mcpPromptCommands(session: Session): CommandInfo[] {
  return (session.mcpPrompts?.() ?? []).map((prompt) => ({ name: prompt.command, description: `MCP · ${prompt.description ?? prompt.name}`, args: prompt.arguments?.map((arg) => `${arg.required ? '<' : '['}${arg.name}${arg.required ? '>' : ']'}`).join(' ') }));
}

/** /技能名 参数 → 发给模型的提示 */
export function skillPrompt(name: string, args: string): string {
  return `使用 skill 工具加载技能 ${name}，并按其指令完成任务。${args ? `\n参数：${args}` : ''}`;
}
