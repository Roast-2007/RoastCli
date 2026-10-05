# RoastCli 实现设计

> 本文描述架构与设计意图。M0–M8 已实现，具体文件名与精确验收记录以 STATUS.md 为准；早期接口示意不要求一对一对应独立类。
> 进度见 [STATUS.md](STATUS.md)，功能清单见 [ROADMAP.md](ROADMAP.md)。Mem0 / embeddings 已在 M8 接入，早期扩展表中的本地实现是默认驱动，具体接入见 §9。

---

## 0. 总原则与不变量

1. **日志是唯一事实来源**。所有状态变更都经过 `Committer.commit(ev)`：先写日志（分配 seq / agentId），再交给 reducer。实时运行和 resume / 投影共用同一组 reducer。
2. **只记录决策，回放时不重算**。策略类的结果（折叠、压缩、授权、模式）一律以事件形式落日志，resume 时直接回放，不重新执行策略。
3. **一致性不变量**：每次请求都落 `request/digest.viewHash`。测试 `replayMismatches(log)` 要求"折叠到该事件为止的历史 hash == viewHash"。新增的任何 reducer 或视图变换都必须保持这一点。
4. **配对不变量**：assistant 发起的每个 tool-call，后面都要有对应的 tool-result。中断、崩溃、恢复、折叠都不能破坏它。
5. **工具列表恒定**：整场会话的 schema 不变，限制由权限引擎通过"拒绝并说明原因"实现，以保护前缀缓存。
6. **结构上避免死锁**：只允许"父 agent 阻塞等待后代"这一种阻塞关系，所以等待图是一棵树；同级 agent 之间只能异步通信。

---

## 1. 运行时与日志（已实现）

- `AgentRuntime`（`src/agent/runtime.ts`）：
  - `run(text)` 等于入队加 `drive()`。
  - 每个 turn 依次循环：边界处理（送达插话 → `beforeRequest` 注入附件）→ 检查有无新内容 → `buildRequest`（必要时落 system / tools 快照，落 `request/digest`）→ `runStep`（流式 + 重试）→ 提交 `assistant/message` → 有工具调用就走 `runToolPhase`，没有就进入 `decideEndOfTurn`（可能 wait）。
- `runStep`（`src/agent/step.ts`）：产出 UiEvent 的 generator；可重试错误按 `retryDelay` 退避，并记录 `step/retry` 与 `stream-reset`。
- 日志：
  - 路径为 `logs/<date>/<runId>/log.jsonl`，写锁文件是 `log.jsonl.lock`。
  - 写入批量化：同一 tick 的事件用 `setImmediate` 合并成一次 `appendFileSync`；进程退出时由 exit hook 落盘。
  - 子 agent 日志（M5）放在同一目录：`agents/<agentId>.jsonl`。
- History reducer（`src/session/history.ts`）的合并规则：
  - 连续的 user 内容合并成一条；
  - 同一 `turn:step` 的 tool-result 合并成一条；
  - attachment 追加到末尾那条 user 消息里。

---

## 2. 权限与交互（M2）

### 2.1 已实现组件

| 组件 | 文件 | 要点 |
|---|---|---|
| 命令分析 | `permissions/bash-parse.ts` | 识别引号、`;` `&&` `\|\|` `\|` `&`、换行、`$()`/反引号、写文件重定向（排除 `2>&1` 和 `/dev/null`）；只读白名单；高危正则 |
| 规则 | `permissions/rules.ts` | `Tool(pattern)`：bash 支持 `前缀:*`、精确和 `*` 通配；路径用 picomatch，相对 cwd；网络用 `domain:` |
| 引擎 | `permissions/engine.ts` | 判定顺序：deny → plan 模式（只读和交互类放行）→ 高危强制询问 → yolo → allow（复合命令逐段判断）→ ask → 默认策略 |
| 钩子 | `permissions/hook.ts` | preExecute：allow / deny / 经 broker 询问；可"记住"；无界面时拒绝并提示 |
| 来源 | `permissions/settings.ts` | 用户级、`~/.roast/projects/<hash>/settings.json`、仓库层（allow 需 trust）；用 `foldPermissionEvents` 从日志恢复 |
| Broker | `core/interaction.ts` | 处理 permission 和 question 两类请求；有 pending 列表；支持 abort；没有订阅者时返回 `unavailable` |

### 2.2 会话接线（待做，`src/agent/session.ts`）

```ts
const rules = loadPermissionRules(cwd);
const engine = new PermissionEngine({
  ...rules,
  mode: opts.permissionMode ?? opened.permissions?.mode ?? rules.defaultMode ?? 'default',
});
for (const g of opened.permissions?.grants ?? []) engine.grant(g, 'session');
const broker = new InteractionBroker();
services.set(BROKER_KEY, broker);
services.set(PERMISSIONS_KEY, engine);
hooks.preExecute.push(
  permissionHook({
    engine,
    broker,
    onGrant: (rule, scope) => {
      loop.committer.commit({ type: 'permission/grant', at, rule, scope });
      if (scope === 'project') addProjectGrant(cwd, rule);
    },
  }),
);
engine.onModeChange = (mode) => loop.committer.commit({ type: 'mode/change', at, mode });
// Session 对外暴露：broker、permissions、ignoredRepoAllow
```

### 2.3 UI（M2 先做最小版，M4 重做）

- App 用 `useEffect` 订阅 `broker.onRequest`，请求进入 pending 队列。卡片显示时替换掉输入框。
- **权限卡片**：
  - 显示标题、detail 的前 10 行和 reason；
  - 按键：`1`/`y` 允许一次；`2` 本会话始终允许（有 `suggestedRule` 才出现）；`3` 本项目始终允许；`4`/`n`/ESC 拒绝；
  - 高危操作（`forced`）只提供"允许一次"和"拒绝"。
- **提问卡片**：数字键选择选项，也可以直接输入文字后回车。
- Shift+Tab：调用 `engine.cycleMode()`，状态栏显示模式胶囊。
- 管道模式下 broker 没有订阅者，需要询问的操作直接拒绝；要放行可用 `--permission-mode acceptEdits|yolo`。

### 2.4 检查点与 rewind（待做）

- **ShadowGit**（`src/ext/audit/shadow-git.ts`）：
  - 仓库位置 `--git-dir=<cwd>/.roast/shadow.git --work-tree=<cwd>`；首次使用时 `init`，并设置 `core.autocrlf=false`、`core.longpaths=true` 和 user 信息。
  - `info/exclude` 写入 `.roast/`、`node_modules/`、`.git/`、`logs/`；项目自身的 `.gitignore` 同样生效。
  - `snapshot(label)`：`add -A` 后 `commit --allow-empty -q -m label`，返回 commit hash。
  - `restore(hash)`：
    1. 先对当前状态打一个"rewind 前"快照；
    2. 用 `diff --name-only --diff-filter=A <hash> <pre>` 找出之后新增的文件并删除；
    3. 执行 `checkout <hash> -- .`；
    4. 遇到 EBUSY 时退避重试。
- **触发时机**：每个 turn 第一次执行写操作工具（edit 类或非只读 bash）之前，由 preExecute 钩子打快照。快照 hash 记入 `checkpoint {turn, hash}` 事件。
- **rewind 事件**：`{ type: 'rewind', toTurn, toSeq, checkpoint? }`。
  - history reducer 在每个 `turn/start` 时保存一份 messages 引用（不可变，开销很小）；遇到 rewind 时把 messages 恢复成 `toTurn` 开始时的那份。
  - turn 编号继续递增，不复用。
  - 恢复后的读状态以文件 sha 为准，不一致时 edit 会要求重新 read，属于安全失败。
- **命令**：`/rewind` 列出各 turn 的首句；`/rewind n` 同时回退文件和对话。Esc Esc 打开回退菜单的交互放到 M4。
- **测试**：用临时工作区执行"写 → 下一个 turn 再写 → rewind 到第 1 个 turn"，检查文件内容、history 和可重放性。

---

## 3. 上下文引擎（M3）

### 3.1 数据模型

```ts
interface ContextItem {
  id: string;              // 句柄：`${agentId}/${seq}`，或者 tool-result 的 callId
  seq: number;             // 产生它的事件 seq
  kind: 'user' | 'assistant' | 'tool-result' | 'attachment' | 'summary';
  tokens: number;
  state: 'live' | 'elided' | 'summarized';
  pinned: boolean;
  prov: { callId?: string; file?: string; tool?: string; agentId: string; turn: number };
}
type ContextOp =
  | { op: 'elide'; ids: string[] }
  | { op: 'compact'; fromSeq: number; toSeq: number; summary: Message }
  | { op: 'pin' | 'unpin'; ids: string[] };
```

- **Ledger** 也是一个 reducer：输入 history 事件，外加 `context/transform` 和 `context/compact` 事件，维护条目列表和变换集合。
- **`view(quirks)`** 生成发给模型的 Message[]：
  - 被折叠的 tool-result 内容换成存根：`⟦ctx:main/142⟧ read src/a.ts (1-200 行，3.1k tokens) 已折叠，需要时调用 recall`。block 本身保留，所以配对不变。
  - `compact` 把 `[fromSeq, toSeq]` 区间的消息替换成一条 user 摘要消息，外面包 `<summary>…</summary>`。
  - 之前 turn 的 thinking 一律丢弃；当前工具循环里的 thinking 原样保留，Anthropic 要求逐字节一致。
- `viewHash = hash(view)`。`request/digest` 改为记录视图的 hash；不变量测试相应改成"折叠 history 加 ledger 后得到的视图"。

### 3.2 Token 计数（`src/context/estimator.ts`）

- 启发式：CJK 字符按每个 1 token 计，其余按 4 字符 1 token，JSON 结构另加 10%。
- **锚点加增量**：以最近一次真实 usage（`input + cacheRead + cacheWrite`）为准，加上之后新增条目的估算值。
- 校准系数 `k = 真实值 / 估算值`，按 provider:model 做 EMA（α=0.3），持久化到 `~/.roast/calibration.json`。

### 3.3 策略（纯函数，`src/context/policies/*`）

1. **dedup**：同一文件后来又被 read 或 edit 过时，折叠更早的那次 read 结果；有 pin 的不动。
2. **aging**：超过 N=8 个 turn、且大于 X=2k tokens 的工具结果，折叠成头尾各 20 行的预览，而不是空存根。
3. **compact**：占用超过 `context.compactAt`（默认 0.8×窗口）时触发：
   - 只在**安全切点**处理：`user/message` 之前，或某个 assistant 消息的结果已经齐全的地方；
   - 保留最近 K=3 个 turn 的原文；
   - 用辅助调用（同模型，或配置里更便宜的 `context.summarizer`）生成**锚定结构摘要**，固定六段：目标 / 约束与用户偏好 / 已做决策 / 涉及文件及其状态 / 未完成任务 / 关键报错与事实；
   - 记录 `context/compact {fromSeq, toSeq, summary, auxUsage}`。
4. **emergency**：收到 `CONTEXT_WINDOW_EXCEEDED` 时，用更激进的参数（K=1，aging 阈值减半）立即压缩，然后重试一次。在 `runStep` 外层处理，记录 `step/retry`。

### 3.4 CachePlanner

- 每个 step 前收集各策略给出的 ops，按条件决定是否立即应用：
  - 占用超过阈值 → 立即应用；
  - 距上一次请求的空闲时间超过 provider 的缓存 TTL（Anthropic 5 分钟，DeepSeek 按配置），缓存本来就冷了 → 立即应用；
  - 估算的节省量 × 剩余预计步数，大于"从改动位置往后需要重写的 tokens" → 应用；
  - 其余情况先攒着。
- 统计 `cacheBusts` 指标，显示在 `/context` 和状态栏。
- Anthropic 的 `cache_control` 打在三处：system 末尾、tools 末尾、最后一条消息的最后一个 block。

### 3.5 recall 工具

- 参数：`{ handle?: string; query?: string }`。
- 按 handle 查找：从日志里取原文，**以新的 tool-result 形式追加**，原来的存根不动，以保护缓存。
- 按 query 查找：对本会话归档日志的 tool-result 和消息建 minisearch 索引，返回前 5 条片段及其句柄。

### 3.6 `/context` 与 `/compact`

- `/context`：按类型画堆叠条（system / 工具 schema / 用户 / 助手 / 工具结果 / 摘要 / 附件），列出最大的 10 条（含句柄、状态、tokens），并显示缓存击穿次数和校准系数。
- `/compact [焦点说明]`：强制压缩，焦点说明会传给摘要 prompt。

### 3.7 测试

- 300 个 step 的模拟会话：ScriptedProvider 按请求规模生成 usage，断言占用始终 < 85%。
- 每个 view 都通过 `pairingErrors` 校验。
- dedup / aging / compact 的单元测试。
- 带 compact 的日志能够重放。
- 当前工具循环里的 thinking 逐字节相等。

---

## 4. TUI（M4）

### 4.1 Store（`src/ui/store/*`）

- `createUiStore()`：控制器把 UiEvent 写入缓冲，按 agent 分组、合并同帧连续 delta，每批约 30Hz。
- 状态：`{ agents, focus, meta }`；meta 保存模式、交互、蜂群树、消息、overlay、toast、主题、输入种子；屏幕管理器保存 printedUpTo 水位线。
- AgentView 保存定稿 items、pending、reasoning、tools、usage 与 todos。
- React 侧用 `useSyncExternalStore` 加 selector。
- 所有归约都是纯函数，单测覆盖。

### 4.2 渲染管线

- `<Static>` 只渲染 `messages[watermark..]`，消息完成即推进水位线。
- **流式 markdown**：用 `marked.lexer` 切块，已完成的块（遇到空行或代码块闭合）立即进入 Static；活动区只渲染尚未完成的尾巴，并限制在 `rows - 底部栏高度 - 2` 行以内。
- 运行中的工具卡片最多显示 3 张，其余折叠为"+N 运行中"。

### 4.3 组件

- **Markdown**：标题、列表、引用、表格（按 core/text-width.ts 的 grapheme 显示宽度对齐）；代码块用 cli-highlight 高亮。
- **Diff**：来自 `metadata.diff.hunks`；左侧行号，`-` 红底、`+` 绿底。
- **ToolCard**：同类调用聚合（如 "read ×3"）；bash 显示最后 8 行实时输出；Ctrl+O 展开最近一次的输出。
- **权限卡片 / 提问卡片**：沿用 2.3 的设计并美化。
- **StatusLine**：模式胶囊、`provider:model`、上下文量规 `▰▰▰▱▱ 38%`、缓存命中率、费用（按 pricing 配置计算）、agent 数、git 分支。
- 另有 TodoPanel、Toast、HelpOverlay。

### 4.4 输入框（`src/ui/input/*`，纯 reducer）

- 缓冲区是 `{ lines, cursor, mode }`，所有动作都是纯函数：插入、删除、按词移动、Home/End、多行（Shift+Enter 走 kitty 协议，回退用 Ctrl+J / Alt+Enter）。
- 历史按项目存储于 `~/.roast/projects/<hash>/history.jsonl`；↑↓ 浏览，Ctrl+R 反向搜索。
- 触发符：
  - `@` 弹出文件模糊搜索（fuzzysort，数据来自 glob 缓存）；
  - `/` 弹出命令面板；
  - `!` 开头的行直接执行 shell；
  - `#` 开头写入记忆。
- `usePaste`：超过 5 行的粘贴折叠成 `[粘贴 N 行]` 占位块，提交时展开。
- `useCursor`：计算 CJK 宽度后把光标放到插入点，保证输入法候选框跟随。

### 4.5 主题

- 语义 token：`accent`、`accentDim`、`fg`、`muted`、`success`、`warn`、`danger`、`userBar`、`toolName`、`diffAdd`、`diffDel`、`gaugeLow`、`gaugeMid`、`gaugeHigh`。
- Ember 主题：炭黑底配余烬橙渐变 `#ff7a18 → #ffb347`，火焰形 spinner 帧 `▁▂▃▄▅▆▇▆▅▄▃▂`。
- truecolor 不可用时降级到 256 色或 16 色，`NO_COLOR` 时使用 mono 主题。

### 4.6 斜杠命令注册表

```ts
interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  args?: string;
  run(ctx: CommandContext, args: string): Promise<void> | void;
}
```

内置命令：

| 类别 | 命令 |
|---|---|
| 会话 | help、clear、compact、resume、rewind、exit |
| 模型与设置 | model、mode、provider（别名 config）、theme |
| 上下文与记忆 | context、memory、todo |
| 扩展 | skills、mcp |
| 蜂群 | swarm、agents、board |
| 其他 | cost、init、logs；doctor / trust 为独立 CLI 命令 |

skill 也注册成斜杠命令；命令面板对 name 加 description 做模糊匹配。

### 4.7 Mission Control 交接（M6 用）

1. store 进入 `handoff` 状态，inline 活动区渲染为空；
2. `waitUntilRenderFlush()` 后 `unmount()`；
3. 用 `render(<MissionControl/>, { alternateScreen: true, incrementalRendering: true, exitOnCtrlC: false })` 渲染全屏；
4. 返回时再 unmount，然后重新渲染 inline 视图；Static 只输出水位线之后的条目。

全屏根容器高度固定为 `rows - 1`：Windows 控制台在等于 rows 时每一帧都会清屏。

### 4.8 测试

- 使用 ink-testing-library，固定 80×24 与 120×40 两种尺寸做快照。
- 输入框 reducer 单独测试。
- 伪 TTY 断言没有 `\x1b[2J`（spike 已提供这套断言）。

---

## 5. Hive 蜂群（M5）

### 5.1 结构

```
src/swarm/
  supervisor.ts   AgentHost 树、spawn / cancel / wait、quiescence、硬上限
  host.ts         AgentHost：一个 AgentRuntime + 一个 Mailbox + 状态机
  roles.ts        角色卡与模型路由（swarm.models）
  bus.ts          MessageBus：寻址、限流（令牌桶）、去重、hop 上限
  mailbox.ts      Mailbox：唤醒规则、按 token 预算批量取出
  board.ts        Blackboard：层级 KV、版本号、CAS、watch → 合并通知
  ../providers/scheduler.ts  按 profile 共享并发上限、AIMD 限流
  isolation/      lease.ts（文件租约）、worktree.ts
  strategies/     fanout、critique、verify、best-of-n（M8）
  templates.ts    feature-squad / bug-hunt / research-council
  tools/          spawn_agent send_message board_read/write/list/watch await_agents report merge_worktree task
```

### 5.2 Agent 与运行时

- **AgentSpec**：`{ id, parentId, role, depth, modelRef, brief, capsule, isolation }`。
- **AgentHost** 为每个 agent 创建独立的一组对象：
  - `RunLogWriter`（`agents/<id>.jsonl`，与主日志同一目录）；
  - 独立的 `ToolServices`（含 fs-state、jobs、todos）；
  - `AgentRuntime`，启用 `boundary` 钩子：
    - `beforeRequest`：`mailbox.drain(budget)`，渲染成 `<inbox>` 附件（落 `inbox/delivered` 事件）；
    - `onWouldEndTurn`：如果还有活跃的子 agent、又没有调用 `report`，返回 `wait`（直到 mailbox 被唤醒）；
  - ToolContext 里带上 `agentId`。
- **共享对象**：ProviderRegistry、Scheduler、MessageBus、Blackboard、LeaseManager、InteractionBroker、EventHub。
- **跨 agent 缓存共享**：所有 agent 使用同一份 system 核心和同一个工具列表（蜂群工具全员可见，权限按角色限制）；角色卡放在首条 user 消息里。
- **状态机**：queued → running → waiting → paused → done | failed | cancelled。

### 5.3 通信

- **信封**：`{ id, from, to, kind, subject, body, refs[], priority, replyTo, hop, interrupt? }`。
  - 寻址：agentId，或 parent / children / siblings / `role:x` / `topic:y`；broadcast 只有 Queen 能用。
  - body 不超过 2k 字符，大块内容用 refs（黑板键、ctx 句柄或文件路径）。
- **唤醒**：只有 `question`、`steer`、`alert` 和子 agent 的 `report` 会唤醒处于 waiting 的 agent；`info` 等到下一次自然边界再送达。
- **限流**：每个 agent 一个令牌桶（每 step 5 条、每分钟 30 条）；hop 不超过 4；按 subject+body 的 hash 去重；黑板的 watch 通知同一前缀在一个 step 内只合并成一条。
- **黑板**：键形如 `/mission/auth/api-contract`。
  - `write(key, value, { author, expect? })` 用 CAS：版本不匹配时返回 current；
  - 订阅者只收到"key vN 由 X 更新"这类通知，正文要靠 `board_read` 拉取，这就是"通信不占上下文"的实现方式；
  - 所有写入落 `board.jsonl`，resume 时重建。

### 5.4 工具语义

| 工具 | 行为 |
|---|---|
| `spawn_agent({role, brief, refs?, model?, isolation?})` | 返回 agentId；超过并发上限时进入 queued |
| `send_message({to, kind, subject, body, refs?})` | 超限、路由不通或重复时返回失败原因 |
| `await_agents({ids, mode: any \| all, timeoutMs?})` | 普通工具，执行时阻塞（不消耗 token）；收到 question、steer、alert、report 或超时都会唤醒，返回 `{reason, reports[]}` |
| `report({status, summary, artifacts?, refs?})` | 送达父 agent 的 mailbox，同时写黑板 `/reports/<id>`，本 agent 的 turn 随后结束 |
| `merge_worktree({agentId})` | 由 Lead 调用；串行合并，冲突时返回冲突文件列表 |
| `task({prompt})` | 单 agent 模式下可用，深度为 1：创建一次性子 agent，同步等待它的 report |

### 5.5 防失控

- **等待收尾**：只允许父级等待后代，消息可以唤醒，问题等待有超时；不另设全局 quiescence 扫描器。初始化失败也必须报告并结束，不留下假活跃状态。
- **无进展看门狗**：默认连续 12 个已完成步骤没有新增工具结果或产出才向父 agent 发 alert。读取、搜索、验证的新结果都算进展；重复相同参数及结果、连续工具失败才累计。模型重试、尚未完成的工具和等待用户授权不计步。提醒注明是否遇到权限拒绝，父 agent 应先检查状态及错误。
- **只读角色权限**：scout / critic / judge 的直接文件编辑由角色守卫拒绝；shell 交给统一权限引擎。已知只读命令按普通规则判断，无法确认的命令每次需要用户批准，即使 yolo 或 allow 规则也不能跳过；deny / plan 规则仍优先。审批请求进入共享 UI 队列，取消时同步移除，agent 显示等待用户授权。
- **硬上限**：agent 总数（默认 12）、最大深度（3）、总时长（默认 60 分钟），都可配置；token 不设上限。
- **AIMD**（已实现）：真实 provider registry 包装 adapter，共享 FIFO 请求名额，最多从 4 个并发开始；429 减半、profile 共享 cooldown，连续 10 次成功后加 1，受 maxConcurrency 限制。等待可中断，工具和父级等待不持有名额。
- **取消**：子 agent 的 signal 是 `AbortSignal.any([父, 自身])`。取消时补齐合成结果、释放租约、保留 worktree 供检查，并通知父 agent。

### 5.6 隔离

- **租约**：`LeaseManager.acquire(paths, agentId)`。写类工具的 preExecute 先申请租约；冲突时返回持有者，提示 agent 发消息协商。租约随 turn 结束或 agent 结束释放。
- **worktree**（已实现，`src/swarm/worktree.ts`、`isolation.ts`）：
  - 策略：`spawn_agent({isolation})` 可取三个值：
    - `auto`（默认）：worker、lead 在 git 仓库中使用 worktree；只读角色和非 git 项目共享工作区，靠租约协调；
    - `worktree`；
    - `shared`。

    `swarm.worktrees: false` 全局关闭。
  - 基线：父 agent 工作区的当前状态，包含未提交和未跟踪的改动，遵守 .gitignore，并排除 `node_modules` 与 `.roast`。临时索引从 `HEAD` 执行 `read-tree`，再 `add -A` → `write-tree` → `commit-tree -p HEAD`，不触碰用户的索引、分支和 HEAD，也不复用真实索引的 stat 缓存。所有文件按原始字节处理，CRLF 和非 UTF-8 内容都保持原样。
  - 位置：`<ROAST_HOME>/worktrees/<runId>/<agentId>`，用 detached HEAD，不建分支。顶层 `node_modules` 使用独立文件副本（支持时用 copy-on-write），pnpm 内部链接映射到副本，workspace 链接映射到 worktree，外部包复制到本工作区；不会共享可写 hardlink。复制前逐级检查链接，拒绝 UNC / 设备路径。
  - 工作目录：父 cwd 在仓库中的相对位置，映射到 worktree 内的对应目录。守卫钩子拒绝编辑 worktree 外的路径（包含符号链接逃逸），并在原仓库路径被拒绝时提示对应副本路径。长期记忆仍由项目级 provider 管理，其操作说明是 label，不当作文件路径。
  - 执行边界：worktree 是 Git 改动隔离，不是操作系统沙箱。运行测试脚本、shell 或其他外部执行工具都可能访问其他目录；权限请求携带宿主设置的 `executionRoot`，在 yolo / allow 规则之前强制审批，每次批准只针对当前调用。无界面时拒绝，建议让主会话在合并后验证。仓库 hooks 仍按信任配置执行，且工作区守卫在用户的 PreToolUse 参数改写之后检查实际参数。
  - 合并：`merge_worktree({agentId})` 只能由直接上级调用，并且要在下级 report 之后。流程：
    1. 再对子 worktree 做一次树快照；
    2. 以 Buffer 生成 `git diff-tree 基线 子树` 的二进制补丁，固定路径前缀且禁用 textconv，不受用户 diff 设置影响；
    3. 在父仓库根目录执行 `git apply --check`，通过后才真正应用。

    出现冲突时返回冲突文件列表，不会部分应用。合并是串行的，工具按 edit 类处理（会打检查点，可以 `/rewind`）。合并成功后删除 worktree。
  - 所有内部 git 调用都带 `core.autocrlf=false`，保证换行符按字节原样保留；`commit.gpgsign=false` 用于内部的悬空 commit。
  - 收尾：会话结束时删除没有改动的 worktree；有未合并改动或检查失败的保留下来，由 `shutdown()` 返回路径，CLI 在 stderr 提示。派生基线、runId、agentId 和占用 PID 保存在运行目录的 `.metadata` 中；会话结束解除占用。
  - 维护：`roast worktrees list/prune` 结合当前仓库的 `git worktree list` 与 Roast 元数据检查工作区。prune 跳过活进程占用、缺少可信基线记录、有未合并改动或无法检查的工作区；只删除当前仓库的干净副本，不处理任意未登记目录。旧版本未记录基线的 worktree 只展示，需手工检查。
  - 嵌套：Lead 在自己的 worktree 中派生 Worker 时，Worker 的基线取自 Lead 的 worktree，合并也回到 Lead 的 worktree。

### 5.7 策略模板（已实现，`src/swarm/templates.ts`）

模板是交给 Queen 的指令（一条用户消息），不是硬编码的编排器。这样 Queen 仍能根据实际情况调整，所有协作也都走同一套工具。

| 模板 | 做法 |
|---|---|
| fanout（默认） | 拆成相互独立的子任务并行派发；worker 在各自的 worktree 中完成后，审阅报告并 `merge_worktree` |
| best-of-n | 先写验收标准；N 个 worker 拿到相同任务，各自在独立 worktree 中实现，并在 report 里附验证结果；judge 读取各 worktree 比较择优（worktree 是免审批的读取根）；合并胜出者，其余用 `merge_worktree({discard: true})` 丢弃 |
| critique | worker 实现并合并；critic 在共享工作区评审，有问题时返回 `changes_requested`；再派一个新 worker 修正（它的基线已包含合并后的改动）；最多 3 轮。已经 report 的 agent 本轮已结束，所以修正由新 agent 来做 |
| research | N 个 scout 从不同角度调研，细节写入黑板 `/research/*`，Queen 汇总；只读 |

- 自定义模板：`~/.roast/templates/*.yaml` 和 `.roast/templates/*.yaml`，字段为 name / description / prompt，prompt 中可用 `{{goal}}`、`{{n}}`。未信任的项目不能覆盖已有的同名模板。
- 入口：`roast swarm -t <模板> -n <数量> "<目标>"`、`roast swarm --list-templates`，以及 TUI 中的 `/swarm [模板] <目标>`。

### 5.8 输出与测试

- `roast swarm "<目标>" -p --output-format stream-json`：每行一个 `{agentId, event}`。
- **ScriptedProvider 扩展**：按 agentId 或角色匹配脚本，脚本可以是函数（读取请求后决定输出），可以注入 429 和中途错误，并且能感知 abort。
- **测试场景**：
  - 一个父 agent 派生两个 Worker，两者都 report；
  - 子 agent 提问时父 agent 正在 await，验证死锁能化解；
  - quiescence 检测触发；
  - 取消子树；
  - 消息风暴被限流；
  - 每个 agent 的日志都能独立重放。

---

## 6. 扩展缝（M7，已实现）

装配：`src/agent/extensions-setup.ts`（skills / memory / prompts / guard / 代码索引）、`hooks-setup.ts`、`mcp-setup.ts`。子 agent 通过 `swarm-setup` 共享同一份扩展（services、pre/post 钩子、工具表）。

**前缀缓存原则**：启动时生成的内容（技能摘要、最近记忆、SessionStart 输出、MCP 工具表）在整场会话中保持不变；会话中产生的新内容只通过工具结果或日志里的注入事件进入上下文。

| 扩展缝 | 实现要点 |
|---|---|
| skills | 解析 `SKILL.md` frontmatter（yaml：name / description / allowed-tools）。来源优先级：`~/.roast/skills` < `.claude/skills` < `.roast/skills`。摘要作为 system section（order 320）；`skill({name, args?})` 工具返回正文；`/技能名 参数` 在内置命令不匹配时回退为技能（发一条让模型加载技能的用户消息）；技能也会列在命令面板中 |
| MCP | `@modelcontextprotocol/sdk` Client，支持 stdio（stderr 走管道）、streamable-http、sse，SDK 按需动态 import。`ToolDefinition.rawJsonSchema` 原样交给模型，参数校验交给 server。工具命名为 `mcp__<server>__<tool>`（≤64 字符），**在会话启动时一次性按名称排序注册**。`readOnlyHint` 的工具按 read 权限处理，其余按 execute 处理并需要询问，可用规则 `mcp__x__y` 放行。配置写在 `mcp.servers`；env、headers、args 支持 `${VAR}` 引用；仓库层的服务器需要 trust。提供 `roast mcp add/list/remove` 和 `/mcp` |
| hooks | 配置 `hooks.{PreToolUse, PostToolUse, UserPromptSubmit, Stop, SessionStart}: [{matcher?, command, timeoutMs?}]`，各配置层的钩子会累加，仓库层的钩子需要 trust。JSON 负载经 stdin 传入（字段与 Claude Code 一致）。退出码 0 表示通过，2 表示阻断（stderr 作为理由），其他退出码为非阻塞错误。各事件的接入点：PreToolUse 在权限检查之前；PostToolUse 追加反馈；UserPromptSubmit 走 inputGuard，可以拦截，也可以把 stdout 作为附加上下文（附加后的文本写进 `user/message`，回放时一致）；Stop 通过 onWouldEndTurn 和 beforeRequest 注入后继续（每个 turn 最多 3 次）；SessionStart 的 stdout 作为 system section（order 340） |
| memory | 存储在 `~/.roast/memory/<项目路径 sha1>/facts.jsonl`（追加式，记录 add 和 forget）。按关键词重叠打分，中文按双字切分（mem0 / 向量检索放到 M8）。提供 `memory({action: save \| search \| list \| forget})` 工具和 `/memory`。会话开始时，最近 20 条作为 system section（order 330）；`#` 仍然写进 ROAST.md |
| RAG | `search_code` 工具基于内存 BM25：按 40 行窗口、步长 30 切块；分词时保留整个标识符，同时按 camelCase / snake_case 拆出子词，中文按双字切分；路径中的词也计入。文件清单在 git 仓库里用 `git ls-files`，否则遍历目录，并跳过产物目录、锁文件和二进制文件。首次检索时建立索引，之后每次检索按 mtime 和 size 增量刷新（本仓库约 120ms 建好，增量约 25ms）。自动注入默认关闭 |
| guard | 规则型：对 read、web_fetch、grep、bash、bash_output 的结果匹配中英文注入特征，命中后追加警示，不拦截。OutputGuard（高危命令）由权限引擎的危险检测承担 |
| prompts | `~/.roast/prompts/<name>.md` < `.roast/prompts/<name>.md`：同名时覆盖内置 section 并保留原有 order，新名字放在 order 400。支持 `{{cwd}}`、`{{date}}`、`{{platform}}`。不记版本号，`system/snapshot` 已经按 hash 记录全文 |
| plan | 由 PermissionEngine 的 plan 模式、`exit_plan_mode` 和 `todo_write` 组成（已实现） |

---

## 7. 测试策略

- **夹具**（`test/fixtures/`）：
  - `ScriptedProvider`：确定性脚本、请求记录、感知 abort；
  - `chunks`：构造流式 chunk；
  - `tempWorkspace`：路径已规范化的临时工作区；
  - `pairingErrors`：配对校验；
  - `replayMismatches`：一致性不变量；
  - `FakeClock`：可控时钟。
- **层次**：纯函数用单元测试 → 运行时用 ScriptedProvider 做集成测试 → UI 用 ink-testing-library 或伪 TTY → 真实 provider 冒烟只在 M8 做一次。
- **覆盖率**：总体 ≥80%（`pnpm test:coverage`）。

---

## 8. Windows 注意事项

- 身份比较统一用 `canonicalPath`，它会解析 8.3 短路径并统一小写；实际读写文件仍用原路径。
- spawn 一律传参数数组，不用 `shell: true`。杀进程树：异步用 `taskkill /T /F`，退出时用 `spawnSync`。
- 遇到 EBUSY / EPERM 时退避重试（rename、unlink、恢复检查点）。
- rg 的来源依次是：`ROAST_RG_PATH` → PATH → JS 回退。
- Ink 在 Windows 控制台下，输出高度 ≥ rows 时每一帧都会清屏，所以全屏用 `rows - 1`，inline 活动区严格限高。
- 开发时，含反斜杠的代码不要用 shell heredoc 写入。

## 9. M8 落地补充（2026-10-04）

- 终端布局：inlineLayout 分配物理行预算，输入 / 审批与单行状态优先；Mission Control 在 112 / 70 列阈值切换三栏 / 两栏 / 单栏。输入使用 editorViewport 软换行视窗，按 grapheme 删除 / 移动并计算真实光标。配置向导小屏只展示选中字段，确认与保存页按预算翻页。
- 动画：useSpinner 共用一个 80ms 计时器，仅有订阅者时运行；Ink maxFps=30、incrementalRendering。TERM=dumb 或减少动画模式停止动画，ASCII 装饰通过 TerminalContext 提供，内容原文不转写。
- 历史与界面：/clear 保留上下文及完整编辑状态；/resume 加载独立候选 Session，成功后替换 controller / store，失败恢复原界面，退出等待加载收尾。replayView 只从已提交事件恢复显示，不重复 raw chunks / 内部附件；Static 水位线避免重印。
- 模型：共享 ModelRef 在空闲时切换，model/change 事件保存选择，ContextController 更新窗口并清除旧 usage 锚点；UsageCost 按每段模型定价累计 usage / auxUsage，rewind 不扣除真实消耗。
- 供应商设置：API Key 存用户 credentials.json，配置只写 apiKeyRef；旧 apiKeyEnv 不再用于供应商认证。向导默认写全局配置并展示实际路径，显式 ROASTCLI_CONFIG 则写指定文件；项目配置补充全局，用户配置优先，完整全局供应商的连接字段不继承仓库值。交互启动先用文件夹信任面板确认，再加载会话与扩展；相关项目配置变化后重新提示，管道模式不自动授权。Reasoning effort 按模型保存，null 清除继承的设置；两种协议分别发送 reasoning_effort / output_config.effort。
- Mem0：memory.driver=mem0；平台默认 v3（添加 /v3/memories/add/、POST 列表 / 搜索、v1 单条读取 / 删除），可选 v2；自托管使用 /memories、/search 与 X-API-Key。canonical cwd 的哈希作为 user_id，保存 infer=false，平台 async_mode=false；删除先检查项目归属。请求有大小限制 / 超时 / 中断，不追随重定向，不回显远端正文。
- 语义检索：rag.embeddings 指定已配置的 OpenAI 兼容 provider，继承地址 / 凭据 / headers。VectorIndex 按内容哈希缓存向量，查询先检测维度，变化重建缓存；默认分批 32、最多 2000 chunks。CodeIndex 在路径筛选后以 reciprocal rank fusion 合并 BM25 与 cosine；网络失败提示回退，取消继续传播。缓存位于用户 indexes 目录，持久化失败不丢弃有效查询结果。
- 信任：项目级 memory / rag 未信任时移除，并计入敏感配置 hash 和 roast trust 清单；未配置扩展的旧 hash 不受影响。
- 无 Git：FileSnapshots 按字节保存到 .roast/snapshots/，回退前备份，恢复删改并删除新文件。拒绝不安全路径和 symlink / junction，跳过状态 / 依赖 / 日志，单次 128 MiB 上限。
- 验收：真实 Ink 伪 TTY 覆盖 40×10 / 60×16 / 80×24 / 120×40、缩到 25×8、2000 行流式输出；20-agent / 20k 事件保持 30Hz 通知。原生 IME / conhost 与在线服务验收仍受环境限制，不能由这些测试代替。
