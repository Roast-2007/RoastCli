# 使用指南

安装和入门见 [README](../README.md)。本文按功能说明 RoastCli 的全部用法。

## Hive

`roast` 默认打开 Hive Deck，输入目标即可发起任务。Queen 负责理解、规划、派发、整合与验证，子 agent 通过消息和黑板协作；等待子 agent 时不发模型请求，不消耗 token。简单或耦合紧密的工作可以由 Queen 自己完成。

`Ctrl+G` 在 Deck 和 [Chat](#chat) 之间切换，两边分别保留输入草稿。`ui.home: "chat"` 把 Chat 设为首页；`--chat`（别名 `--solo`）或 `--hive` 只覆盖本次启动。首次配置和文件夹信任流程不变。Ignition 铺满窗口的 ASCII 蜂巢动画最多 900 毫秒，任意键跳过，可打印字符会进入输入框；reduced motion 或 `TERM=dumb` 直接进入首页。带目标启动 Hive 时跳过动画。动画直接按差分写入终端，结束时在同一次同步刷新中清屏并画出工作面，不会留下上一帧的色块；支持同步输出的终端（Windows Terminal、iTerm2、WezTerm、Kitty 等）切换时不会闪烁。

```sh
roast hive                                          # 打开 Deck
roast hive "给登录接口加上限流"                        # 立即发起任务
roast hive --strategy best-of-n -n 4 "实现一个 LRU 缓存"
roast hive --strategy research --print "调研项目里的错误处理方式"
```

`roast swarm` 是兼容命令；`--strategy` 的旧别名 `-t/--template` 仍可用。`roast -p` 保持单 agent 管道语义；`roast hive --print` 和 `roast swarm --print` 使用 Hive 任务。非 TTY 必须提供目标。

### 任务与输入

| Deck 输入 | 行为 |
|---|---|
| 空闲时发送目标 | 用当前策略和并行数发起新任务 |
| 运行中发送文字 | 排队给 Queen，在下一个 step 送达 |
| `@w2 文本` | 向成员 w2 发 steer 指示；`@queen` 给 Queen 插话 |
| `/hive [策略] [n] [目标]` | 无参数进入 Deck；带目标发起任务；`/swarm` 是别名 |
| `/strategy [名称] [n]` | 设置本会话默认策略；无参数打开选择面板 |
| `/chat` | 切换到 Chat |

`@` 补全优先列出成员，其次是文件；文件补全只插入路径文本。两种工作面都显示排队消息的数量和首条摘要；中断后排队内容回到输入框。Deck 输入区右侧显示策略，使用 n 的策略还显示当前并行数。界面和 `logs show` 显示你输入的目标，发给模型的任务简报保存在日志中，恢复时使用原文。

任务状态由事件推导：尚未派出成员时为“计划中”，有活跃子 agent 时为“执行中”，子 agent 全部结束而 Queen 仍在运行时为“整合中”；turn 结束后显示“完成”“中断”“出错”或“步数上限”。

### 策略

| 策略 | 做法 |
|---|---|
| `auto`（默认） | Queen 按任务选择最轻的结构：自行完成、fanout、critique、best-of-n 或 research |
| `fanout` | 分拆独立任务，写入范围分开；合并后按改动风险安排 critic |
| `best-of-n` | N 个 worker 独立实现同一目标，judge 比较和验证，合并胜者并丢弃其余方案 |
| `critique` | worker 实现、Queen 合并、critic 评审，再修正，最多 3 轮 |
| `research` | N 个 scout 从互补角度只读调研，写黑板，由 Queen 汇总 |

`swarm.strategy` 默认 `auto`；`swarm.n` 默认 3，`-n` 范围 2–8。`roast hive --list-strategies` 列出策略，`--list-templates` 仍可用。策略是交给 Queen 的指令，Queen 使用同一套协作工具执行，可以按实际情况调整。

`/strategy` 或点击 Deck 的策略标记先选择策略。fanout、best-of-n、research，以及 playbook 含 `{{n}}`（允许空格）或 YAML 定义了 n 的自定义策略，再选择 2–8 的并行数；Enter 或双击确认，Esc 返回策略列表。当前策略预选本会话的 n，其他策略优先用 YAML 的 n，否则沿用本会话的 n。auto、critique 直接确认并保留 n。

`/strategy best-of-n` 直接进入该策略的并行数列表；`/strategy best-of-n 5` 同时设置两者；`/strategy 4` 只改当前策略的 n。未知策略或越界数字不会改变状态。所有策略都接受显式 n，它也作为任务简报中“最多 n 个并发 writer”的上限；`/hive` 面板使用本会话当前的 n。

自定义 YAML 放在 `~/.roast/strategies/` 或 `.roast/strategies/`，也兼容原 `templates/` 目录及 `prompt` 字段；同一配置层同名时 `strategies/` 优先。项目策略覆盖同名内置或用户策略需要文件夹信任。

```yaml
name: bug-hunt
description: 分头定位问题，再汇总证据
n: 3
readOnly: true
prompt: |
  目标：{{goal}}
  派 {{n}} 个 scout 分别排查不同模块，把证据写到 /research/ 下。
  最后汇总原因、证据和不确定性。
```

也可以把 `prompt` 写成 `playbook`。`n` 是可选的策略默认并行数；`readOnly: true` 标记只读任务。只读任务运行期间，supervisor 拒绝派生 worker / lead，返回“本任务为只读调研”；Queen 自己的写请求仍由权限引擎判断。

### Deck 与计划板

以下尺寸均指扣除右侧留白和底部一行后的视口。宽度 ≥112 列时，Deck 是蜂群、任务、信号三栏；70–111 列保留蜂群与任务，把信号放在中栏第 4 页；<70 列只显示一栏，用 `[` / `]` 切换蜂群、计划、输出、改动、信号。高度 <12 行隐藏头部，<8 行只保留摘要、输入和状态栏。默认空闲画布显示发起任务、Queen 派发成员、查看结果与指挥成员的三步说明；恢复会话时还显示最近任务。

| 宽屏任务页 | 内容 |
|---|---|
| `1` 计划 | Queen 的任务计划，以及 Queen 和选中成员的待办；没有有效计划时按子 agent 生成任务 |
| `2` 输出 | 选中成员的 Markdown 与流式输出，默认 Queen；工具显示摘要和增删统计 |
| `3` 改动 | 成员 worktree 相对基线的 diffstat / diff；Queen 显示当前工作区的 git diff |
| `4` 消息 | 消息时间线 |
| `5` 黑板 | 键、版本、作者和值 |
| `6` 用量 | 本任务按 agent / 模型聚合的 token 和费用；缺少定价时总价显示“未知” |

中屏插入信号页后，消息、黑板、用量依次为 `5`、`6`、`7`。改动页打开时才读取 git，切页可中断，结果缓存到成员下一次状态变化，不修改索引、HEAD 或文件。大型 diff 会截断。

计划格式为 `{"tasks":[{"id":"t1","title":"实现限流","role":"worker","acceptance":"测试通过","dependsOn":[]}]}`，也接受顶层数组。只有 id 和非空标题必需，数字 id 会转为字符串，标题可用 task、name、description 代替；无效或重复任务单独跳过。Queen 派发时传 `task_id`，Deck 按成员的 `taskId` 关联任务并推导状态，不需要 Queen 反复改写计划。头行显示 id、成员、状态和已缓存的 `+增 −删`；标题按内宽换行，小窗格最多三行，超出显示“Enter 展开”。

任务区聚焦时按 Enter，或双击计划 / 待办行，展开整宽计划详情。详情完整显示标题、验收、依赖、关联成员和报告前三行，随后显示 Queen 与所有成员的完整待办；双击任务进入时将该任务头行置顶。按 Esc 返回原页签、成员与滚动位置，双击成员行切到其输出，双击其他行返回计划。详情保留输入框、排队行、审批和状态栏，使用与全屏输出相同的滚动按键与滚轮；窄屏可用，高度 <8 行不能进入。计划页下方显示 Queen 和选中成员的待办、完成数量；进行中项目优先显示 activeForm，完成项目弱化。没有计划也能查看待办，`/todo` 继续可用。黑板、计划和工具结果中的待办随会话恢复。

输出页保留 Markdown 的标题、强调、列表和代码着色。小窗格省略 diff 正文，运行中的工具最多显示两行尾部。双击输出窗格任意位置，或在任务区输出页按 Enter，进入整宽全屏输出，显示与 Chat 相同的段落间距、留白和 diff 预览。全屏保留输入框、排队行、审批与状态栏；窄屏同样可用，高度 <8 行时不能进入。

全屏中 `↑↓` / `j k` 逐行，`PgUp/PgDn` / `b f` 翻页，`g/G` / `Home/End` 到顶 / 到底，也可用滚轮。上翻后新输出不会拉回视图，到底后恢复跟随。面板聚焦时按 Esc 或双击非工具行返回，保留原页签、成员和小窗格滚动位置；双击工具行查看该工具详情，关闭后回到原全屏位置。可打印字符回到输入框插入草稿。

### Deck 按键

默认聚焦输入框，`Tab` 只补全命令、文件和成员，没有候选时保持焦点。点击面板，或用 `F6` 按输入框 → 蜂群 → 任务区 → 信号循环；`Shift+F6` 反向循环，布局没有独立信号栏时跳过。在面板中，`Tab` / `Shift+Tab` 正向 / 反向切换焦点。聚焦面板的边框高亮，标题前显示 `▸`（ASCII 为 `>`）。单字母快捷键只在面板聚焦时生效；其他可打印字符会把焦点移回输入框并插入草稿。

| 按键 | 作用 |
|---|---|
| `Enter` | 输入框发送；蜂群栏打开成员输出；任务区计划页展开详情，输出页进入全屏 |
| `Tab` | 输入框仅补全；面板中切到下一栏 |
| `Shift+Tab` | 输入框切换权限模式；面板中切到上一栏 |
| `F6` / `Shift+F6` | 正向 / 反向切焦点 |
| `Space`（蜂群栏） | 打开选中成员的操作菜单 |
| `i` 或 `Esc` | 面板返回输入框 |
| `↑↓`、`j` / `k` | 面板选择成员或滚动 |
| `PgUp` / `PgDn`、`g` / `G` | 翻页、到顶 / 到底 |
| `1`–`6` | 面板聚焦时切任务页；中屏用量为 `7` |
| `[` / `]` | 窄屏面板切页 |
| `m` | 在输入框预填 `@选中成员 ` |
| `p` | 暂停或继续选中成员 |
| 连按两次 `x` | 取消选中成员及其子树 |
| `d` | 查看选中成员改动 |
| `Ctrl+O` | 查看选中成员最近工具的详情，再按一次或 Esc 关闭 |
| 双击输出窗格 | 全屏阅读；全屏中双击非工具行返回，双击工具行查看该工具 |
| 双击计划 / 待办行 | 展开计划详情并定位；详情中双击成员看输出，双击其他行返回 |
| `←→`、`[` / `]`（工具详情） | 切换上一个 / 下一个工具 |
| `↑↓` / `j k`、`PgUp/PgDn` / `b f`、`g/G` / `Home/End`（全屏） | 逐行、翻页、到顶 / 到底；Esc 返回 |
| `Ctrl+G` | 切到 Chat |
| 鼠标滚轮 | 滚动指针下的面板；指针在输入区时滚动任务区，不切成员或输入历史 |
| `?`、`F1` | 打开 Deck 专属帮助；输入框中的 `?` 仅在草稿为空时打开 |
| `Esc`（输入框） | 运行中中断 Queen；空闲时 600 毫秒内按两次打开回退菜单 |
| `Ctrl+C` | 运行中中断；空闲有草稿时清空；无草稿时提示，两秒内再按一次退出 |

`Ctrl+C` 清草稿后也会提示“已清空 · 再按 Ctrl+C 退出”。暂停在 step 之间生效，正在执行的工具会正常完成。换行、编辑、输入历史、斜杠命令与 Chat 共用，见下文。

### Deck 鼠标与引导

单击面板聚焦；单击成员或计划行选中对应成员。双击成员打开输出，双击计划或待办行展开计划详情；任务区计划页也可按 Enter 展开。右键成员或计划行打开“查看输出 / 查看改动 / 发送指示 / 暂停或继续 / 取消”菜单，取消需要再次确认。点击页签切换任务页，输出和改动页右侧显示当前成员；点击信号打开对应审批、消息发送者或黑板键。点击策略标记打开策略选择，点击状态栏权限胶囊切换权限模式。

浮层列表支持单击选择、双击确认和滚轮滚动；审批卡点击可见选项即可回答。强制审批仍只能允许一次或拒绝，不能保存授权规则。Chat 的成员栏也可点击进入 Deck。

`ui.mouse` 默认 `true`。`/mouse [on|off]` 只切换本会话的鼠标报告，无参数时切换当前状态；关闭后可直接拖选文字。开启时按住 `Shift` 拖动也能选择文字。不支持 SGR 鼠标的终端可用全部键盘操作。

`ui.hints` 默认 `"full"`：显示空状态说明和 KeyBar；`"compact"` 只显示 KeyBar；`"off"` 关闭两者。蜂群栏解释成员出现的位置，各任务页与信号栏说明将显示什么内容，不提供示例任务。KeyBar 位于输入区与状态栏之间，在视口高度 ≥14 时显示，每项可以点击；内容随输入、面板焦点、审批、工具详情或 Chat 阅读状态变化，窄屏从右侧省略。`?`、`F1` 或点击帮助打开当前工作面的说明，Deck 帮助包含布局图、焦点切换、成员操作和鼠标用法。

### 提醒与状态栏

统一状态栏显示权限模式、活跃成员 HIVE 胶囊、上下文、费用、tokens、按 token 加权的缓存命中率与分支；运行中显示计时和 step。宽度不足时依次省略分支、缓存、tokens、费用，帮助入口在最右侧。更新提醒固定在 Deck 信号栏顶部并用 accent 色显示，启动警告去重；Chat 显示六秒 toast，切回 Deck 可回看信号。提醒属于界面元数据，回退或重放不会清除，重新启动时重新检测更新。

`ui.notify` 默认 `auto`：Windows Terminal、iTerm、WezTerm 和 Kitty 中使用 OSC 9；其他终端静默。`bell` 使用响铃，`off` 关闭。需要审批或用时 ≥20 秒的 turn / 任务结束时提醒，管道模式不发。`ui.title` 默认 `true`，设置目录与运行状态标题，每秒最多更新一次，退出时重置为 `roast`。这两个配置项仅用户配置生效，项目配置和 `ROASTCLI_CONFIG` 的其他配置层不生效。

### 成员角色

| 角色 | 职责 |
|---|---|
| Queen | 主 agent，负责整个任务的规划、整合、验证与最终答复 |
| lead | 负责一个子目标，可以继续派生 worker |
| worker | 按任务范围实现和验证 |
| scout | 只读调研，报告证据和不确定性 |
| critic | 只读评审，按严重程度列出问题和修正建议 |
| judge | 只读比较候选方案，返回评分和胜者理由 |

### 角色模型

可以为每个角色指定模型：

- `/hive models` 打开面板，为 lead、worker、scout、critic、judge 选择模型和推理强度，保存在配置的 `swarm.models` 和 `swarm.efforts` 中。值为 `inherit` 表示跟随主会话。
- 命令行临时指定，可以重复使用，不写入配置：

  ```sh
  roast swarm "修复测试并评审" --role-model worker=deepseek:deepseek-chat --role-model critic=claude:claude-sonnet-5-5
  ```

  `/hive`（`/swarm`）里同样可以加 `--role-model`。Queen 的模型用 `-m`、`/model` 或 `--role-model queen=…` 设置。

没有指定模型的角色，由 Queen 根据已配置模型的价格和上下文长度选择，信息不够时跟随主会话。你指定过的角色（包括 `inherit`）Queen 不能更改。

### 自定义角色

在内置角色之外，可以用 Markdown 文件定义自己的成员，例如专门审查安全问题的评审员。Queen 会在 system prompt 中看到这些角色的名称和说明，按需派生。

```markdown
---
name: security-reviewer
description: 审查改动中的注入、越权和密钥泄露
role: critic
model: deepseek:deepseek-reasoner
reasoning_effort: high
tools: read, grep, glob, bash
---
逐个检查改动涉及的输入边界，按严重程度列出问题，每条附上代码位置和修改建议。
```

| 字段 | 说明 |
|---|---|
| `name` | 小写字母开头，可含数字和连字符，最长 40 字符。省略时用文件名 |
| `description` | 一句话说明用途，Queen 据此决定何时使用 |
| `role` | 基础角色：`lead`、`worker`（默认）、`scout`、`critic`、`judge`。只读与否由基础角色决定 |
| `model`、`reasoning_effort` | 可选，`provider:model` 或 `inherit`。指定后 Queen 不能更改 |
| `tools` | 可选，逗号分隔或 YAML 数组，MCP 工具可写 `mcp__github__*`。省略时可用基础角色的全部工具 |

正文是角色说明，追加在基础角色的职责后面，最多 8000 字符。

文件放在 `~/.roast/agents/` 或项目的 `.roast/agents/` 下，同名时项目级优先。项目中的 `.claude/agents/` 也会读取，Claude Code 的工具名（Read、Edit、Bash 等）会自动转换；它特有的模型名（如 `sonnet`）和工具会被忽略，不提示。项目级角色可以选择付费模型和工具，所以项目没有信任时全部不加载，启动时会提示忽略的数量。`roast hive --list-agents` 列出当前可用的角色，格式有误的文件在启动警告和 `roast doctor` 中报告。

- 模型的优先级：角色文件的 `model` → `swarm.models` 中为基础角色设置的模型 → Queen 选择 → 主会话模型。
- `tools` 只能在基础角色的范围内收窄，不能让只读角色写文件。协作必需的工具（`report`、`send_message`、`await_agents`、黑板工具、`task`、`recall`、`todo_write`）始终可用，权限规则照常生效。
- 蜂群树和 `/agents` 中显示为 `c1·security-reviewer`。

### worktree

在 git 仓库中，worker 和 lead 默认各自在独立的 worktree 里改代码，完成后由上级审阅合并。合并前会先检查冲突，有冲突时一个文件也不会写入。只读角色和非 git 项目共用工作目录，通过文件租约避免两个 agent 同时改同一个文件。设置 `swarm.worktrees: false` 可以关闭 worktree。

- worktree 位于 `~/.roast/worktrees/<runId>/<agentId>`，基于父 agent 工作区的当前状态创建，包括未提交的改动。整个过程不会动你的分支、索引和 HEAD。
- 顶层的 `node_modules` 会复制一份到 worktree（文件系统支持时使用写时复制），这会增加启动时间和磁盘占用。副本中可识别的 pnpm JSON 布局路径会同步到 worktree，避免因原仓库的绝对路径而要求重装。
- worktree 中的命令与普通命令遵循同样的权限模式和规则，yolo 下直接执行，帮我审批模式下只询问高风险命令；高危命令和只读角色限制仍然生效。普通审批可保存会话或项目授权，并显示 worktree 路径。worktree 只隔离文件改动，不是沙箱，shell 等外部命令仍能访问其他目录。成员读取主工作区文件无需额外审批。
- 会话结束时，没有改动的 worktree 会被删除，有未合并改动的会保留，并在 stderr 列出路径。`roast worktrees list` 查看保留的 worktree，`roast worktrees prune` 删除已结束且没有改动的。正在使用、有未合并改动或缺少基线记录的不会被删除。

### 只读角色

scout、critic 和 judge 不能直接修改文件。它们执行的命令中，能确认是只读的（如 `git log`、`rg`、`cat`）按普通规则处理；无法确认的每次都要你批准，不能设为始终允许。MCP 等其他执行类工具也一样。等待批准时，agent 在蜂群树中显示为"等待用户授权"。deny 规则和 plan 模式仍然有效。

一个 agent 连续 12 个 step 没有新进展（重复同样的调用，或者一直失败）时，会提醒它的上级检查。读取、搜索和验证得到新结果都算作进展，所以长时间的调研不会被误判。

### 限制

- `swarm.maxAgents`：一次会话最多派生的 agent 数（包括已结束的），默认 12。
- `swarm.maxDepth`：最大层级，默认 3。
- `maxSteps`：主会话 / Queen / Chat 每 turn 的模型步骤上限，默认 100。
- `swarm.maxSteps`：子 agent 每 turn 的模型步骤上限，默认 150，与主会话独立。
- `swarm.maxMinutes`：单个子 agent 的最长有效运行时间，默认 60 分钟，超时后取消它和它的子 agent。任意成员或 Queen 等待用户审批 / 回答时，所有成员的时限与 `await_agents` 超时计时暂停。
- 不限制 token 用量。

接近步骤上限时模型会收到收尾提醒，最后一步要求子 agent 调用 report，主会话给出当前结论。子 agent 未 report 就耗尽步骤时，自动生成 partial 报告，包含停止原因、最后说明、未完成待办和 worktree 改动文件，保留成果供审阅或续做。`await_agents` 超时表示仍在运行，会返回步骤、最近活动、工具和等待原因；可以继续等待或发消息询问。

供应商的 `maxConcurrency` 是主会话和蜂群共享的并发上限，默认是 16 和 `maxAgents + 1` 中较小的一个。实际并发从最多 4 个开始，遇到 429 减半并遵守 `retry-after`，连续成功 10 次后加 1。等待中的 agent 不占用并发名额。

### Hive 会话恢复

`roast -c` 或恢复指定日志会重放 Queen 和成员输出、成员树与终态，并恢复黑板（含计划板）、最近 50 条消息及中断文本。恢复出有效计划时 Deck 默认打开计划页，否则有最近任务时选中 Queen 打开输出页并跟随底部。旧版 0.5.0 的成员和输出可从主日志与子日志推导；没有 `hive.jsonl` 时，黑板、消息和中断文本为空。损坏的子日志跳过，不影响主会话。

历史成员带 `↺` 标记（ASCII 为 `~`），可查看输出和关联计划，不能暂停、取消、发指示、路由或合并，也不占新会话的成员限额。历史工作区不可直接操作；未合并 worktree 保留在磁盘，可用 `roast worktrees list` 查看。中断时未提交的文本标记“（已中断，未发送给模型）”，仅供界面回看，不进入模型历史。恢复后的黑板继续供 Queen 的 `board_read` / `board_list` 使用。

## 配置供应商

运行 `roast config` 打开配置向导（对话中用 `/provider` 或 `/config`）。依次选择供应商、填写地址和模型、输入 API Key 和推理强度，最后确认保存。

| 预设 | 默认地址 | 默认模型 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-plus` |
| Kimi / Moonshot | `https://api.moonshot.cn/v1` | `kimi-k2` |
| Kimi Code | `https://api.kimi.com/coding/v1` | `kimi-for-coding` |
| 豆包 | `https://ark.cn-beijing.volces.com/api/v3` | 无，需填写 |
| 腾讯混元 | `https://api.hunyuan.cloud.tencent.com/v1` | `hunyuan-turbos-latest` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen3-32B` |
| OpenAI | `https://api.openai.com/v1` | `gpt-5` |
| Claude | `https://api.anthropic.com` | `claude-sonnet-5-5` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-pro` |
| OpenRouter | `https://openrouter.ai/api/v1` | `openai/gpt-5` |
| 自定义 | 自填 | 自填 |

Claude 使用 Anthropic 协议，其余都是 OpenAI 兼容协议。自定义端点可以选择其中任一种。预设里的模型只是建议，以你账号实际可用的为准。豆包需要填写控制台里的模型 ID 或 Endpoint ID（`ep-…`）。

向导操作：

- `Tab`/`Shift+Tab` 或 `↑↓` 切换字段，`←→` 或空格切换推理强度、默认模型和认证方式，`Esc` 返回。
- 模型可以填多个 ID，用逗号分隔，第一个作为默认模型。留空时，输入密钥后会自动获取模型列表；也可以在密钥页或确认页按 `Ctrl+L` 打开列表。在列表中输入文字搜索，`Enter` 勾选，`Ctrl+R` 刷新，选完后选"完成选择"。
- 本地服务不需要密钥时，在密钥页把认证设为"无密钥"。
- 同一个供应商可以添加多次（比如两个自定义端点），向导会分配不同的 ID。
- 窗口很小时只显示当前字段，确认页用 `PgUp`/`PgDn` 翻页。

配置默认保存在 `~/.roast/config.json`，设置了 `ROASTCLI_CONFIG` 时保存到那个文件，页首和确认页会显示实际路径。修改在下次启动时生效。没有任何配置时，交互式启动会自动打开向导。

### API Key

密钥保存在 `~/.roast/credentials.json`，格式是 `{"引用 ID": "密钥"}`，**明文存储**。配置文件里只记录引用 `apiKeyRef`。macOS 和 Linux 上这个文件的权限是 `0600`，Windows 上继承用户目录的权限。密钥不会出现在对话历史和日志里。

旧版本中的 `apiKeyEnv`（从环境变量读取密钥）已经不再用于供应商认证，请在向导中重新输入密钥。

### 推理强度

推理强度按模型保存在 `models.<模型>.reasoningEffort`。选"自动"时不发送这个参数，由服务端决定。OpenAI 兼容协议发送 `reasoning_effort`，Anthropic 发送 `output_config.effort`。

可选值取决于模型。可以在模型配置中用 `reasoningEfforts: ["low", "high"]` 限定选项，或用 `reasoning: false` 隐藏这一项。Kimi Code 提供 none、low、high、max。参数说明见 [OpenAI](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Anthropic](https://platform.claude.com/docs/en/build-with-claude/effort) 和 [Kimi Code](https://www.kimi.com/code/docs/kimi-code/models.html) 的文档。

### 模型列表

OpenAI 兼容协议请求 `GET <baseURL>/models`，Anthropic 请求 `GET <baseURL>/v1/models`（地址已经以 `/v1` 结尾也可以）。请求超时 10 秒，结果在会话内缓存 5 分钟，不跟随重定向。

标准接口通常只返回模型 ID，不包含上下文长度、是否支持推理等信息，这些以配置中填写的为准。获取失败、接口不支持或项目连接未受信任时，可以手动输入模型 ID。

### 不用向导

在脚本或非交互环境中可以用 `roast init` 生成配置：

```sh
roast init --provider kimi-code --reasoning-effort high
roast config                                        # 之后再输入密钥
echo "$API_KEY" | roast init --provider deepseek --api-key-stdin   # 或者从标准输入读取密钥
```

`roast init` 默认写入用户配置，加 `--project` 写入 `.roast/config.json`，文件已存在时需要加 `--force`。`--model` 指定模型，豆包必须指定；自定义端点请用 `roast config`。

## 文件夹信任

第一次在某个目录交互启动 `roast` 或 `roast swarm` 时，会询问是否信任这个文件夹：`↑↓` 选择，`Enter` 确认，`Esc` 或 `Ctrl+C` 退出。确认前可以查看完整路径和项目配置。在确认之前，RoastCli 不会创建会话，也不会加载项目的扩展。

信任记录保存在 `~/.roast/trusted.json`，同时记下项目配置中敏感部分的 hash。以下内容发生变化后会再次询问：

- 供应商的连接字段：`driver`、`baseURL`、`headers`、`auth`、`apiKeyRef`。这是为了防止一个仓库把你的密钥发到别的地址。
- hooks、MCP 服务器和 `permissions.allow`。
- `memory`、`rag`、`webSearch`、`debugLog`，以及指向项目目录之外的 `logsDir`。未受信任时这些设置会被忽略。

未受信任的项目也不能覆盖同名的 prompt、skill 和 Hive 策略（包括旧模板）。deny 和 ask 规则不需要信任，始终生效。

非交互模式（`-p`）不会询问，也不会自动信任；如果项目配置改了供应商连接，会直接拒绝启动。脚本中可以先运行 `roast trust`，它会列出信任后将启用的内容。

## 命令行

| 命令 | 说明 |
|---|---|
| `roast` | 按 `ui.home` 打开首页，默认 Hive Deck |
| `roast --chat`（`--solo`） / `roast --hive` | 本次启动进入 Chat / Deck |
| `roast -p "<任务>"` | 非交互执行，输出结果后退出。可以从管道读取输入，见[管道模式](#管道模式) |
| `roast -c` | 继续当前目录最近的会话 |
| `roast -r [runId]` | 恢复指定会话；不带 ID 时列出当前目录最近 20 个会话 |
| `roast -m provider:model` | 本次使用指定的模型 |
| `roast --permission-mode <模式>` | 以指定权限模式启动：`default`、`acceptEdits`、`auto`（帮我审批）、`plan`、`yolo` |
| `roast --max-steps <n>` | 本次主会话每个 turn 的步数上限，1–1000 |
| `roast --allowed-tools <规则>` / `--disallowed-tools <规则>` | 本次运行额外放行 / 禁止的工具，见[临时工具规则](#临时工具规则) |
| `roast hive [目标]`（`roast swarm`） | 打开 Deck 或立即发起任务，见 [Hive](#hive) |
| `roast hive --strategy <名称> -n <数量> <目标>` | 指定策略和并行数，旧 `-t/--template` 仍可用 |
| `roast hive --list-strategies` | 列出策略，旧 `--list-templates` 仍可用 |
| `roast hive --list-agents` | 列出自定义角色，见[自定义角色](#自定义角色) |
| `roast config` | 配置向导 |
| `roast init` | 不经向导生成配置，见[不用向导](#不用向导) |
| `roast doctor` | 检查 Node.js 版本、配置、密钥、信任状态、shell、git、ripgrep、项目说明、skills、自定义角色、hooks 和 MCP |
| `roast pricing [list] [--all]` / `update` / `path` | 查看模型价格或整份价目、主动更新官方价目、查看价目路径 |
| `roast trust` | 信任当前目录 |
| `roast mcp add` / `list` / `remove` | 管理 MCP 服务器，见 [MCP](#mcp) |
| `roast logs list` | 列出最近 20 次运行 |
| `roast logs show <runId> [--raw]` | 从日志还原某次运行的对话，`--raw` 输出原始事件 |
| `roast logs export <runId> [文件]` | 把某次运行的对话导出为 Markdown，不给文件时输出到 stdout |
| `roast worktrees list` / `prune` | 查看或清理蜂群保留下来的 worktree |
| `roast update` | 从官方 GitHub Release 更新全局安装；`--check` 只检查、不安装 |
| `roast --version` | 显示版本 |

在 CI、管道等非 TTY 环境中必须用 `-p` 提供任务，蜂群用 `roast swarm --print "<目标>"`，否则直接报错。非交互模式下，需要用户确认的操作一律拒绝。按一次 `Ctrl+C` 中断当前任务，再按一次退出。

退出码：`2` 缺少配置，`3` 项目配置未受信任，`130` 被中断，其他错误为 `1`。

Windows 上 bash 工具和 `!命令` 优先使用 Git Bash（`C:\Program Files\Git\bin\bash.exe`），找不到时使用 cmd。

每次启动交互式 `roast`、`roast hive` 或 `roast swarm`，都会在后台从官方 GitHub Releases 检查最新正式版本，超时 3 秒，不缓存到下次启动。有更新时在 Deck 信号栏或 Chat toast / notice 显示当前版本、新版本和更新指令，不打断输入或任务。断网、超时、限流时静默跳过；管道模式、`--help`、`--version` 不自动联网检查。

更新完全自愿：退出会话后运行 `roast update`，它会调用 npm 安装对应版本的官方发布附件。`roast update --check` 只检查。npm 不可用或安装失败时会给出手动安装指令，不自动提权。Windows 执行策略拦截命令时用 `roast.cmd update`、`npm.cmd`。

### 管道模式

`roast -p` 和 `roast hive --print`（`roast swarm --print`）不进入界面，直接执行并输出结果，可以从管道读取输入：

```sh
git diff | roast -p "审查这个补丁"     # 管道内容作为附带材料
git diff | roast -p                    # 管道内容就是任务
roast -p "总结失败原因" < test.log
cat goal.txt | roast hive --print
```

- 同时给了任务和管道输入时，管道内容放在 `<stdin>` 标签里，接在任务后面。
- 给了任务时，如果 3 秒内管道没有任何输出，RoastCli 会忽略 stdin 继续执行，避免 CI 中一直不关闭的 stdin 卡住运行。输出很慢的命令，先写到文件再用 `< 文件` 传入。只用管道内容作为任务时会一直等到输入结束。
- 管道输入最多 10 MiB。交互模式不读取 stdin。
- Windows PowerShell 5.1 默认用 ASCII 编码传给外部程序，管道里的中文会变成问号。先运行 `$OutputEncoding = [Text.UTF8Encoding]::new()`，或改用 `< 文件`。

`--output-format` 控制输出：

| 格式 | 输出 |
|---|---|
| `text`（默认） | 流式输出回答，工具调用显示为一行摘要 |
| `stream-json` | 每行一个 JSON 事件，包括所有子 agent |
| `json` | 运行期间 stdout 不输出，结束时输出一行结果 |

`json` 的结果格式：

```json
{"type":"result","subtype":"success","isError":false,"result":"最后一条回答","runId":"…","logPath":"…","model":"provider:model","durationMs":1234,"steps":2,"usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0},"costUsd":0.00002,"worktrees":[]}
```

`subtype` 可能是 `success`、`error`、`aborted`、`max-steps` 或 `budget`，其中 `error` 和 `budget` 会另带 `error: {"code", "message"}` 字段。`usage` 和 `costUsd` 包括主会话、子 agent 和上下文摘要；用到的模型中有任何一个缺少定价，`costUsd` 为 `null`。错误和重试提示仍写到 stderr，退出码与 `text` 相同。

`--max-budget-usd <金额>` 为本次运行设置费用上限，只能在管道模式使用。主模型没有定价时直接拒绝运行。每次请求返回用量后检查累计费用，达到上限，或者某个用到的模型缺少定价时，中断主会话并取消所有成员，退出码为 1。由于是在请求结束后检查，实际花费可能超出上限，超出的部分最多是最后一次请求的费用。

### 临时工具规则

`--allowed-tools` 和 `--disallowed-tools` 为本次运行追加 allow / deny 规则，语法和[规则](#规则)相同，Chat、Deck 和管道模式都可以用：

```sh
roast -p "修复 lint 错误" --allowed-tools "edit(src/**),bash(pnpm lint:*)" --disallowed-tools web_fetch,web_search
```

- 一个参数里可以用逗号写多条规则，括号内的逗号不拆开；也可以重复使用同一个参数。
- 不带括号的禁止项（如 `web_fetch`、`mcp__github__*`）还会把这些工具从模型的工具列表中移除，主会话和所有成员都看不到。
- deny 规则优先级最高；plan 模式、高危命令确认、只读角色和 worktree 边界照常生效。
- 规则只在本次进程中有效，不写入配置、项目授权或会话日志，恢复会话时需要重新指定。

## Chat

Chat 是单 agent 对话工作面，用 `--chat`、`/chat` 或 `Ctrl+G` 进入。标题只占一行，输入框和状态栏固定在底部，空白页只显示暗色字标。完整环境与配置状态用 `/status` 查看。

### 按键

| 按键 | 作用 |
|---|---|
| `Enter` | 发送 |
| `Alt+V` / `Ctrl+V` | 附加剪贴板中的图片，见[图片附件](#图片附件) |
| `Shift+Enter`、`Alt+Enter`、`Ctrl+J`，或在行尾输入 `\` | 换行 |
| `Esc` | 运行中：中断。空闲时在 600 毫秒内按两次：打开回退菜单 |
| `Ctrl+C` | 运行中中断；空闲清草稿；无草稿时提示，两秒内再按一次退出 |
| `Shift+Tab` | 切换权限模式：default → acceptEdits → auto → plan → yolo |
| `Ctrl+O` | 阅读时查看视口内最后一个工具，否则查看最近工具；再按一次或 Esc 返回 |
| 双击工具行 | 查看该工具的参数、完整 diff 与结果 |
| `←→`、`[` / `]`（工具详情） | 切换工具，切换后回到顶部 |
| `↑↓` / `j k`、`PgUp/PgDn`、`g/G` / `Home/End`（工具详情） | 滚动详情；Esc / Ctrl+O 关闭 |
| `Shift+↑↓`、`Ctrl+↑↓`、`PgUp` | 进入阅读模式 |
| 鼠标滚轮 | 滚动对话，每格 3 行 |
| `↑↓` | 有补全候选时选择候选，否则移动光标或翻看输入历史 |
| `Tab` | 应用补全 |
| `Ctrl+R` | 搜索输入历史；再按一次找更早的匹配，`Enter` 载入，`Esc` 取消 |
| `Ctrl+A` / `Ctrl+E` | 移到行首 / 行尾 |
| `Ctrl+U` / `Ctrl+W` | 删除到行首 / 删除前一个词 |
| `Ctrl+G` | 切到 Hive Deck，保留两边草稿 |
| `F1`，或输入框为空时按 `?` | 帮助 |

阅读模式下，`↑↓` 或 `j`/`k` 逐行滚动，`PgUp`/`PgDn` 翻页，`Home` 或 `g` 到顶部，`End`、`G`、`Enter` 或 `Esc` 回到输入框。阅读时新的输出不会把视图拉回底部，回到底部后恢复跟随。

工具详情标题显示 `i/N`、工具名称、状态和耗时。参数区保留 bash 的完整多行命令、文件工具路径，其他工具显示 JSON；有 diff 元数据时显示完整行号 diff，元数据本身截断时提示。结果区显示运行中的 live 文本或最终输出，失败用错误色。详情可用滚轮，页脚显示可见行范围；关闭后保留 Chat 阅读位置或 Deck 全屏状态。

鼠标报告默认开启。按住 `Shift` 拖动可选择文字，或用 `/mouse off` 关闭鼠标报告后直接拖选；`/mouse on` 恢复。Chat 和 Deck 共用本会话的鼠标开关。

### 输入

- `/` 开头是斜杠命令。输入命令前缀后可以直接按 `Enter` 执行高亮的候选。
- `@` 补全文件路径。它只插入路径文本，不附带文件内容，模型需要时会自己读取。
- `!` 开头直接在当前目录执行 shell 命令，结果只显示在界面上，**不会发给模型**。默认超时 600 秒，可以用 `ui.shellTimeoutMs` 调整（1 秒到 24 小时）。完整输出在 `Ctrl+O` 里查看。agent 运行时不能执行。
- `#` 开头会把这句话追加到当前目录 `ROAST.md` 的 `## 记忆` 一节，下次会话生效。
- 超过 5 行的粘贴会折叠成 `[粘贴 N 行]`，发送时展开。
- 粘贴或拖入图片文件路径会变成图片附件，见[图片附件](#图片附件)。

agent 运行时输入的消息会排队，在下一个 step 送达，不用先中断。中断时，排队的内容会放回输入框。

输入历史按项目保存，最多 500 条。

### 图片附件

Chat 和 Deck 都可以把截图、设计稿或报错图片直接发给模型，模型需要支持视觉。

- **剪贴板**：按 `Alt+V` 或 `Ctrl+V`。Windows Terminal 会把 `Ctrl+V` 当作文本粘贴自己处理，Windows 上请用 `Alt+V`；macOS 的 Option 键默认不发送 Alt，请用 `Ctrl+V`。在 Windows 资源管理器中复制的图片文件也可以这样附加。
- **图片路径**：把图片文件拖进终端，或粘贴图片路径，会自动变成附件。粘贴的内容必须全部是存在的图片路径（可以多行，每行一个），否则按普通文本粘贴。

附加后输入框中出现 `[图片 #1]` 这样的占位符，上方显示图片数量。删掉占位符就不会发送这张图片；占位符本身会保留在消息里，方便在文字中指代“图片 #1”。支持 PNG、JPEG、GIF 和 WebP，单张不超过 5 MiB，一条消息最多 8 张、合计不超过 20 MiB。

- 图片只发给主会话（Deck 中是 Queen）。Deck 空闲时随新任务发送，运行中随插话排队；`@成员` 的指示不能带图片。
- `/`、`!`、`#` 开头的输入会忽略图片。输入历史只保存文字。
- 图片还在读取时按 `Enter` 不会发送。切换 Deck / Chat 时，草稿中的图片会保留。
- 如果模型返回请求无效的错误，会提示当前模型可能不支持图片。

读取剪贴板时，Windows 使用系统自带的 PowerShell，macOS 使用 `osascript`，Linux 需要安装 `wl-clipboard`（Wayland）或 `xclip`（X11）。

### 生成项目说明

`/init` 让 agent 分析当前仓库并写出项目说明：它会阅读 README、包清单、CI、测试和格式化配置、目录结构以及已有的说明文件，整理出项目概述、常用命令、目录结构、约定和注意事项，控制在 150 行左右。只写配置中确认过的命令，分析过程中不运行安装或构建。

- 写入当前目录中第一个存在的 `ROAST.md`、`AGENTS.md` 或 `CLAUDE.md`，都没有时新建 `ROAST.md`。
- 文件已存在时在原有内容上改进，`## 记忆` 一节原样保留。
- 写文件照常经过权限确认。需要主会话空闲，plan 模式下不能使用。新的说明在下次会话生效。
- 只想要一个空模板时用 `/init template`，`ROAST.md` 已存在时不会覆盖。

### 导出与复制

`/export [路径]` 把主会话的对话导出为 Markdown，包括你的消息、回答和工具调用，工具输出每个最多保留 30 行，不包含模型的思考过程。不给路径时写到当前目录的 `roast-export-<runId>.md`，重名时自动加 `-2`、`-3`；指定的文件已存在时不会覆盖。导出文件在项目目录里，注意不要误提交。

`roast logs export <runId> [文件]` 在会话外导出任意一次运行，不给文件时输出到 stdout。

`/copy [N]` 把倒数第 N 条回答（默认最后一条）复制到系统剪贴板。Windows、macOS 和 Linux 分别使用 PowerShell、`pbcopy` 和 `wl-copy` / `xclip` / `xsel`。通过 SSH 连接或系统剪贴板不可用时，改用终端的 OSC 52 复制，需要终端支持；内容较长时会提示改用 `/export`。

### 斜杠命令

| 命令 | 作用 |
|---|---|
| `/help` | 快捷键和命令说明 |
| `/model [provider:model] [effort\|auto]` | 切换模型和推理强度，只对当前会话有效 |
| `/provider`（`/config`） | 配置向导 |
| `/mode [模式]` | 切换权限模式 |
| `/theme [名称]` | 切换主题。在面板中选择会保存到配置，带名称时只对当前会话有效 |
| `/clear` | 清空屏幕，保留上下文和输入框内容 |
| `/resume [runId]` | 恢复会话，不带参数时打开会话列表 |
| `/rewind [N]` | 回退到第 N 个 turn 开始之前，见[检查点与回退](#检查点与回退) |
| `/context [pin\|unpin\|drop <id>…]` | 查看上下文占用和缓存命中率，按 `m` 管理工具结果 |
| `/compact [关注点]` | 立即压缩上下文，关注点会交给摘要模型 |
| `/cost` | 费用明细 |
| `/todo` | 任务清单 |
| `/init [template]` | 分析仓库，生成或更新项目说明，见[生成项目说明](#生成项目说明)；`template` 只创建空模板 |
| `/export [路径]` | 把对话导出为 Markdown，见[导出与复制](#导出与复制) |
| `/copy [N]` | 复制倒数第 N 条回答，默认最后一条 |
| `/memory [关键词]` | 查看或搜索长期记忆 |
| `/skills` | 选择并运行技能 |
| `/mcp` | MCP 服务器的连接状态 |
| `/logs` | 运行日志 |
| `/hive [策略] [n] [目标]`（`/swarm`） | 无参数进入 Deck，带目标发起任务；`/hive models` 设置角色模型 |
| `/strategy [名称] [n]` | 设置本会话默认策略，无参数打开面板 |
| `/chat` | 切到 Chat |
| `/mouse [on|off]` | 切换本会话鼠标报告；关闭后可直接拖选文字 |
| `/status` | 查看版本、模型、cwd、分支、信任、权限、首页、策略、maxAgents 和 worktree |
| `/agents` | 蜂群成员：查看任务和报告，暂停、发送指示或取消 |
| `/board [key]` | 查看黑板 |
| `/exit`（`/quit`） | 退出 |

每个技能都可以用 `/技能名 参数` 调用（和内置命令重名时内置命令优先），MCP prompt 用 `/mcp__<服务器>__prompt_<名称>` 调用。

不带参数的命令大多会打开面板：`↑↓` 选择，`Enter` 确认，`Esc` 返回，列表中可以直接输入文字搜索。

`/model` 面板会自动获取供应商的模型列表，可以搜索，`Ctrl+R` 刷新，选好模型后再选推理强度。也可以直接输入 `/model deepseek:deepseek-chat high`，只写模型名时使用当前供应商。主会话和子 agent 都空闲时才能切换。切换会写入会话日志，恢复会话时沿用，但不会修改配置中的默认模型。

### 外观

- 主题：`aurora`（默认）、`ember`、`daylight`（适合浅色终端）、`mono`。环境变量 `ROAST_THEME` 优先于配置。设置了 `NO_COLOR`、`FORCE_COLOR=0` 或 `TERM=dumb` 时使用 `mono`。
- `ui.ascii: true` 或 `ROAST_ASCII=1`：边框和装饰只用 ASCII 字符。
- `ui.motion: "reduced"` 或 `ROAST_REDUCED_MOTION=1`：关闭动画，不播放启动动画。`TERM=dumb` 会同时开启这两项。
- `ui.gutter`：全屏右侧留白 0–4 列，默认 2；`ROAST_GUTTER` 优先，原始窗口宽度 <30 列时自动归零。动画、Deck、Chat、浮层、审批、向导与信任确认都使用这块留白。
- 所有窗口尺寸变化都会在短暂防抖后清屏重绘；输入草稿、动画进度、面板焦点、成员、页签、滚动位置和浮层保留。变窄导致信号栏隐藏时，焦点回到任务区。
- `ui.mouse` 和 `ui.hints`：见 [Deck 鼠标与引导](#deck-鼠标与引导)。
- `ui.markdown.padding`：回答左右的留白，0–8 列，默认 2，窗口窄时自动减小。`ui.markdown.spacing`：段落之间的空行数，0–2，默认 1。

## 权限与回退

### 权限模式

| 模式 | 行为 |
|---|---|
| `default` | 读取工作区内的文件和执行只读命令不询问，修改文件、执行其他命令时询问 |
| `acceptEdits` | 在 default 的基础上，自动允许修改工作区内的文件 |
| `auto`（帮我审批） | 按离线规则判断风险：常规操作自动允许，高风险操作询问，10 秒内不回复就自动拒绝，见[帮我审批](#帮我审批) |
| `plan` | 只允许只读操作。模型用 `exit_plan_mode` 提交计划，你批准后才能修改 |
| `yolo` | 除了高危命令，全部自动允许 |

文件 edit / multi_edit / write 审批卡片会在读权限允许且文件状态有效时预览 diff，最多 12 行，超出部分用 `Ctrl+O` 查看完整详情。新文件可以直接预览；越界、UNC、未读取或过大的现有文件不自动预览。merge_worktree 审批显示 diffstat；bash 显示完整命令、worktree 执行路径和高危或只读角色触发强制询问的原因。预览和 `Ctrl+O` 不会批准操作。

审批时，`1` 或 `y` 允许一次，`2` 本会话内始终允许，`3` 本项目始终允许，`4`、`n` 或 `Esc` 拒绝；也可以用 `↑↓` 选择后按 `Enter`。高危操作只能选允许一次或拒绝。本会话的授权写在会话日志里，恢复会话后仍然有效。本项目的授权保存在 `~/.roast/projects/<hash>/settings.json`，不会进入仓库。

### 帮我审批

`auto` 模式在本地按规则判断风险，不把命令发给模型审核，也不联网。用 `Shift+Tab`、`/mode auto`、`--permission-mode auto` 进入，也可以在用户配置中设 `permissions.defaultMode: "auto"`。状态栏显示「帮我审批」。

以下操作属于高风险，需要你确认：

| 类别 | 例子 |
|---|---|
| 删除与丢弃 | 删除工作区外的文件、递归删除整个工作区（含 `find . -delete`）、`git restore`、`git checkout -- 路径`、`git switch --discard-changes`、`git reset --hard`、`git clean -f`、`git stash drop`、`git branch -D`、`git rebase`、`git config --global` |
| 对外 | `git push`、`npm` / `pnpm` / `cargo` / `twine` 等的发布、`docker push`、`gh release create`、`gh pr merge`、`gh api -X POST`、`kubectl apply`、`terraform apply`、`helm upgrade`、`vercel --prod` 等部署命令、`aws` / `gcloud` / `az` 的部署与变更 |
| 安装 | 全局安装、`brew` / `apt` / `winget` / `choco` 等系统软件、新增依赖（`pnpm add`、`npm i 包名`、`pip install 包名`、`uv add`）、`pnpm dlx`、`npx -y`、`uvx`、`pipx run` |
| 系统 | `sudo` / `runas`、`Start-Process -Verb RunAs`、`chmod -R`、`chmod 777`、`chown`、注册表、`setx`、系统服务（含 `net stop`）、系统账户、计划任务、`kill -9`、`pkill`、`taskkill /f`、防火墙、Defender 设置、磁盘 |
| 凭据与外传 | 读取或修改 `~/.ssh`、`~/.aws`、`.env`、`.npmrc`、`~/.roast/credentials.json` 等凭据文件，用 grep 在整个用户目录中搜索；`curl -d / -F / -T / -X POST`、`scp`、远端 `rsync`、`ssh`、`nc`（发往 localhost 的请求除外） |
| 混淆 | `eval`、`Invoke-Expression`、`powershell -EncodedCommand`、把管道内容交给 `sh` / `bash` / `cmd` / `python` / `node` 执行（如 `curl … \| sh`）、执行子命令生成的内容（如 `bash <(curl …)`）、用 `git -c alias.…` 或 `core.hooksPath` 等配置执行命令 |
| 敏感文件 | 写入或移动到工作区外（重定向、`cp`、`mv`、`tee`、`sed -i`、`curl -o`、`wget -O`、`tar -C`、`unzip -d`、PowerShell 的 `-Destination` / `-OutFile` 和编辑工具都算）；修改 `.github/workflows`、`.gitlab-ci.yml`、`.roast/`、`roastcli.config.json`、`.claude/`、`.husky/`、`.git/` 和 `.env*`（不区分大小写） |
| 其他 | MCP 工具声明了 `destructiveHint`；命中你的 `permissions.ask` 规则；原有的高危命令 |

其余操作自动允许，包括工作区内的读写和删除、构建、测试、lint、`git add` / `commit` / `switch`、按锁文件安装依赖、网页抓取和搜索，以及读取工作区外的普通文件。系统临时目录中的读写也不询问。`ls .env`、`test -f .env`、`git check-ignore .env` 这类只看文件是否存在的命令，以及 grep 的搜索模式里出现 `.env`，都不算读取凭据。

分析会展开 `bash -c`、`powershell -Command`、`cmd /c`、交给 shell 的 heredoc、`$(…)`、`find -exec`、`xargs`、`env` / `cross-env` 等包装命令，以及 `npx`、`pnpm exec`、`yarn <命令>` 实际运行的命令，并跟踪命令中的 `cd`。以未知变量开头的路径、经 `xargs` 从标准输入传入的删除和移动目标，都按位置未知处理。

确认时：

- 审批卡显示出来后开始 10 秒倒计时，排队中的审批不提前计时。在卡片上按任意键、滚动或点击会暂停倒计时，等你明确选择。审批卡没作答就被移走（切换 Chat / Deck，或在信号栏点开另一条审批）时也会暂停。
- 10 秒内没有回复，这次操作被拒绝，agent 会收到「用户没有响应、不代表反对，可以稍后再试」的说明。agent 再次发起同样的操作时，会重新询问。
- 你选择拒绝（`4`、`n` 或 `Esc`）后，本会话中完全相同的操作会自动拒绝，不再询问，agent 会收到说明。命令按完整文本匹配，忽略多余空格和开头的环境变量赋值，参数不同就会重新询问。文件操作按路径匹配，edit、write、multi_edit 视为同一操作。拒绝记录写在会话日志里，`roast -c` 恢复后仍然有效，Hive 中所有成员共用，`/rewind` 不会撤销。
- 拒绝记录只在帮我审批模式下生效。切换到 default 模式会弹出普通审批卡，可以手动批准。
- 原有的高危命令仍然只能允许一次。其他高风险操作可以选本会话或本项目始终允许，`permissions.allow` 规则也能为这些操作免除询问。
- 管道模式（`-p`）没有界面，高风险操作直接拒绝。

和 yolo 一样，每条 bash 命令执行前都会打检查点，工作区内的误操作可以用 `/rewind` 恢复。离线规则无法检查脚本文件和 `node -e`、`python -c` 等内联代码在做什么，重要的仓库建议配合 `permissions.deny` 使用。

### 规则

在配置中写 `permissions`：

```json
{
  "permissions": {
    "allow": ["bash(git status:*)", "bash(pnpm test)", "edit(src/**)", "mcp__github__*"],
    "ask": ["bash(git push:*)"],
    "deny": ["web_fetch(domain:example.com)"]
  }
}
```

- `bash(git status:*)` 匹配以 `git status` 开头的命令（按整词匹配），`bash(pnpm test)` 只匹配这条命令，`*` 是通配符。只写 `bash` 表示所有 bash 命令。
- 路径规则使用 glob，相对路径相对于当前目录。
- `domain:example.com` 匹配该域名及其子域名。
- 包含 `&&`、`|`、`;` 的复合命令会拆开判断，allow 要求每一段已获授权或只读，并且不能含子 shell；deny 也逐段检查。
- 单独的 `cd` / `cd <路径>` 视为只读，后续命令段仍独立判断。匹配前忽略连续环境变量赋值，例如 `CI=true pnpm.cmd vitest run` 按 `pnpm.cmd vitest run` 匹配，引号内的空格不会拆开路径。
- 审批按未放行的命令段生成去重规则，如 `bash(pnpm.cmd vitest:*)`、`bash(sed:*)`；保存授权时逐条写入会话日志或项目设置，恢复后全部有效。含子 shell 时不建议可记住的规则。
- 判断顺序是 deny → plan 模式 → 高危强制询问 → 只读角色强制询问 → yolo → allow → ask → 默认（帮我审批模式用离线风险规则代替默认）。高危命令和直接修改 `.git/` 内文件的编辑属于强制询问，在 yolo 模式下或匹配了 allow 规则也会询问。
- 仓库配置中的 allow 规则需要信任后才生效。`permissions.defaultMode` 只在用户配置中生效。

### 检查点与回退

每个 turn 第一次修改文件之前，RoastCli 会给工作目录打一个快照：

- 有 git 时使用影子仓库 `.roast/shadow.git`，不影响项目自己的仓库、索引和分支。
- 没有 git 时把文件按字节保存到 `.roast/snapshots/`，二进制内容和 CRLF 都原样保留。跳过符号链接、依赖目录和日志，单次最多 128 MiB。
- yolo 和帮我审批模式下每条 bash 命令执行前都会打快照，因为无法可靠判断一条命令会不会改文件。

`/rewind` 或空闲时连按两次 `Esc` 打开回退菜单，选择要回到的 turn，按两次 `Enter` 确认。`/rewind N` 直接回到第 N 个 turn 开始之前。Queen 必须空闲，且所有成员都已结束；queued、running、waiting、paused 成员存在时不能回退。文件和对话会一起回退，Chat / Deck 同步重放，并回滚对应轮次派生的成员、黑板、消息与中断文本。回退前会先备份当前状态，期间新建的文件会被删除。共享工作区成员的写入也使用 Queen 当前轮次的首个检查点，适用于关闭 worktree 的 git 仓库与非 git 目录。未合并 worktree 仍保留，成员 id 不复用。回退不会退还已经消耗的费用。

## 上下文、缓存与费用

上下文快满时，RoastCli 分两步处理：

1. **折叠旧的工具输出。** 被同一文件后续读取或修改取代的读取结果，以及 8 个 turn 之前、超过 2000 tokens 的输出，会换成一行占位符；后者保留头尾各 20 行预览。为了不频繁改写前缀，折叠会先攒着，等能省下至少 4000 tokens，并且占用超过窗口的 70% 时再一起应用。如果距上次请求已超过 5 分钟（缓存已经过期），占用超过 56% 就会应用。
2. **压缩。** 占用超过 80% 时，保留最近 3 个 turn，把更早的对话换成一份摘要。

折叠和压缩掉的原文都还在，模型可以用 `recall` 按句柄或关键词取回。`/context` 查看占用情况，`/context pin <id>` 防止某个工具结果被折叠，`/context drop <id>` 手动折叠，`/compact` 立即压缩。

摘要默认由已配置、有定价的模型中最便宜的一个生成，都没有定价时使用当前模型。也可以指定：

```json
{ "context": { "summaryModel": "deepseek:deepseek-chat", "summaryMaxTokens": 2048 } }
```

`summaryModel` 设为 `"extractive"` 时不调用模型，直接从原文中抽取用户请求、涉及的文件、命令、错误和最近的结论。模型摘要失败时也会退回这种方式。其他参数见[配置参考](#配置参考)。

### 缓存

- OpenAI 官方端点会自动发送稳定的 `prompt_cache_key`，其他 OpenAI 兼容端点需要在供应商配置中设置 `promptCaching: true`。
- Anthropic 默认开启缓存断点，设置 `promptCaching: false` 关闭。
- `reasoningReplay` 控制 OpenAI 兼容模型的推理内容如何回传：`drop`（默认，不回传）、`field`（通过 `reasoning_content` 字段回传全部历史推理，前缀稳定，对缓存友好）、`current`（只回传当前回合，适用于要求丢弃旧推理的服务）。

`/context` 显示按 token 加权的缓存命中率、请求次数（含重试）和前缀变化次数。只有一次请求的会话没有可复用的前缀，命中率为 0 是正常的。供应商的缓存有效期和最小缓存长度也会影响命中率。

### 费用

价格单位是美元 / 百万 tokens，按以下顺序解析：

1. 模型配置中的 `providers.<id>.models.<模型>.pricing`。
2. 用户价目 `~/.roast/pricing.json`，只读用户目录，不读取项目价目。
3. 下载价目 `~/.roast/pricing-catalog.json` 与随包内置价目中日期较新的那份，按端点 hostname 和模型匹配。
4. 同一价目中的模型精确匹配参考价；`vendor/model` 也尝试去掉 vendor 前缀。

获取模型列表时会解析 OpenRouter 格式的每 token 价格，转换后存入模型 metadata；向导选中的模型会随配置保存，当前会话也立即使用。已有配置价格优先，无效或可变价格不猜测。也可在模型配置中填写价格：

```json
"models": {
  "deepseek-chat": { "pricing": { "input": 0.27, "output": 1.1, "cacheRead": 0.07 } }
}
```

上面是示例数值，请按供应商当前的价格填写。用户价目与内置价目使用相同格式，例如 `~/.roast/pricing.json`：

```json
{
  "version": 1, "updatedAt": "2026-10-08", "currency": "USD", "unit": "1M tokens",
  "entries": [{ "provider": "example", "hosts": ["api.example.com"], "models": ["model", "model-v*"],
    "pricing": { "input": 1, "output": 2, "cacheRead": 0.1 }, "source": "https://example.com/pricing"
  }]
}
```

模型匹配不区分大小写并支持 `*`。用户条目省略 hosts 时可匹配任意端点；内置 / 下载价目只有 hostname 匹配才视为该端点价格。参考价只允许精确模型匹配，是官方标价，用于第三方代理估算，**非该端点实际价格**。baseURL 未填写时不会匹配官方 host。缺少 cacheRead / cacheWrite 时按 input 回退。

`roast pricing` 列出已配置模型的价格与来源，`--all` 查看生效价目，`path` 查看文件位置。`roast pricing update` 主动从官方 GitHub 仓库下载、校验并原子替换下载价目；失败保留旧文件，启动时不会自动联网取价。用户文件在进程内缓存，编辑后重启生效。`roast doctor` 报告生效日期、条目数与无效文件原因。

状态栏和 `/cost` 按供应商返回的实际 usage 计价，普通输入、cache read、cache write 分开累计。`/cost` 按 turn、agent、供应商和模型列出主会话、子 agent 和摘要费用，并标注“配置 / 用户价目 / 内置价目日期 / 参考价”。恢复重新读取相同价格源时累计费用一致，回退不会扣减已消费用量。只要有一个用过的模型缺少定价，总价显示未知。

## 工具

| 工具 | 作用 |
|---|---|
| `read`、`glob`、`grep`、`ls` | 读取和搜索文件 |
| `read_image` | 读取 PNG、JPEG、GIF、WebP 图片，单张最多 5 MiB，需要模型支持视觉 |
| `edit`、`multi_edit`、`write` | 修改文件，保持原有的换行风格。修改前必须先读过该文件，且文件没有被外部改动 |
| `bash`、`bash_output`、`kill_shell` | 执行命令，支持后台运行 |
| `search_code` | 代码检索，见[代码检索](#代码检索) |
| `find_references`、`rename_symbol` | TS/JS 的引用查找和重命名 |
| `web_fetch`、`web_search` | 抓取网页、网页搜索 |
| `todo_write`、`ask_user`、`exit_plan_mode` | 任务清单、向你提问、提交计划 |
| `skill`、`memory`、`recall` | 加载技能、长期记忆、取回被折叠的上下文 |
| `spawn_agent`、`task`、`send_message` 等 | 蜂群协作 |

### 网页搜索

`web_search` 默认使用 DuckDuckGo，不需要密钥，遇到验证码或限流时会报错。可以换成自建的 SearXNG，`baseURL` 要写完整的 `/search` 地址：

```json
{ "webSearch": { "driver": "searxng", "baseURL": "https://search.example.com/search", "timeoutMs": 30000 } }
```

Brave 和 Tavily 需要密钥。目前没有命令可以添加，需要手动在 `~/.roast/credentials.json` 中加一项，比如 `"brave-search": "你的密钥"`，再在配置中引用它：

```json
{ "webSearch": { "driver": "brave", "apiKeyRef": "brave-search" } }
```

搜索返回标题、链接和摘要，模型再用 `web_fetch` 读取正文。网络访问受权限规则控制。

### 引用查找与重命名

`find_references` 和 `rename_symbol` 使用 TypeScript 语言服务，支持 TS/JS 文件和 tsconfig/jsconfig 项目。位置参数 `line` 和 `column` 从 1 开始，列按 UTF-16 计。

`rename_symbol` 默认只预览改动，`apply: true` 时先检查所有文件的权限和内容，再一起写入，任何一个文件失败都会全部回滚。重命名会保持 CRLF 和导入别名，跳过注释和字符串里的同名文本。

其他语言可以通过 MCP 接入对应的语义工具。

### 修改后自动诊断

`edit`、`multi_edit` 或 `write` 改完 TS/JS 文件后，RoastCli 会用 TypeScript 检查这个文件，把这次修改**新引入**的错误附在工具结果后面，模型可以当场修正：

```
诊断：新增 1 个 TypeScript 错误
src/app.ts:12:5 TS2304 Cannot find name 'foo'.
```

- 只在文件所在目录或上级目录（不超出工作区）有 `tsconfig.json` 或 `jsconfig.json` 时检查。
- 修改前就存在的错误不会报告，位置移动了也能识别。没有新增错误时不附加任何内容。
- 只检查改动的这个文件，不检查其他文件因此产生的错误。
- 检查在后台线程中进行，不会卡住界面，主会话和所有成员共用一个检查进程。读取 TS/JS 文件时会提前加载项目，第一次修改不用等太久。单次检查超时就跳过，连续超时三次后本次会话不再检查。
- `Ctrl+O` 的工具详情中也能看到诊断结果。

用 `diagnostics` 配置调整，或设置环境变量 `ROAST_DIAGNOSTICS=0` 关闭：

```json
{ "diagnostics": { "enabled": true, "maxItems": 10, "timeoutMs": 8000 } }
```

`maxItems` 是每次最多列出的错误数（1–50），`timeoutMs` 是单次检查的超时（1000–60000 毫秒）。

### 提示注入检查

`read`、`grep`、`bash`、`bash_output`、`web_fetch`、`web_search`、`search_code` 和所有 MCP 工具的结果中，如果出现疑似提示注入的内容，会在结果后面附加警告。只提示，不拦截。

## 扩展

### 项目说明

从 git 根目录到当前目录，每一层取第一个存在的 `ROAST.md`、`AGENTS.md` 或 `CLAUDE.md`，再加上用户级的 `~/.roast/ROAST.md`，一起放进 system prompt，总共最多 4 万字符。`/init` 可以让 agent 分析仓库后写好这份说明，见[生成项目说明](#生成项目说明)。

### Skills

技能放在 `.roast/skills/<名称>/SKILL.md` 或 `~/.roast/skills/<名称>/SKILL.md`，也兼容 `.claude/skills/`。同名时项目级优先，但未受信任的项目不能覆盖用户级技能。

```markdown
---
name: release-notes
description: 根据 git 提交整理版本说明
allowed-tools: bash, read
---
读取上一个 tag 以来的提交……
```

system prompt 里只列出技能的名称和描述，模型需要时用 `skill` 工具读取正文。你也可以用 `/技能名 参数` 直接调用，或在 `/skills` 中选择。

### MCP

```sh
roast mcp add github -e GITHUB_TOKEN='${GITHUB_TOKEN}' -- npx -y @modelcontextprotocol/server-github
roast mcp add docs --url https://example.com/mcp
roast mcp add old-server --url https://example.com/sse --transport sse
roast mcp list
roast mcp remove github
```

默认写入用户配置，加 `--project` 写入项目配置（需要信任）。有 `--url` 时默认使用 streamable HTTP，否则为 stdio。`-H KEY=VALUE` 添加请求头。对应的配置：

```json
{
  "mcp": {
    "servers": {
      "github": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
      }
    }
  }
}
```

`env`、`headers` 和 `args` 中的 `${VAR}` 会在启动时替换为环境变量的值。

- 工具名为 `mcp__<服务器>__<工具>`，在会话启动时一次性注册，之后不变。MCP 工具默认按执行类处理，调用前询问，可以用 `mcp__github__*` 这样的规则放行。在服务器配置中设置 `trustAnnotations: true` 后，服务器标记为只读（`readOnlyHint`）的工具按读取处理。
- resources 通过 `mcp__<服务器>__list_resources` 和 `mcp__<服务器>__read_resource` 读取。
- prompt 作为斜杠命令调用，比如 `/mcp__docs__prompt_review topic="cache engine" tone=brief`，支持位置参数、`name=value` 和带引号的文本。
- 工具返回的图片会传给模型，单次累计最多 5 MiB。
- `/mcp` 查看各服务器的连接状态。

### Hooks

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "bash", "command": "node scripts/check-command.js", "timeoutMs": 30000 }],
    "PostToolUse": [{ "matcher": "edit|write|multi_edit", "command": "pnpm prettier --write ." }]
  }
}
```

`matcher` 是匹配工具名的正则，省略或写 `*` 表示所有工具。钩子从 stdin 收到 JSON，包含 `hook_event_name`、`session_id`、`cwd`，工具类事件还有 `tool_name`、`tool_input`、`agent_id`，PostToolUse 另有 `tool_response: {is_error, text}`。语义和 Claude Code 的 hooks 接近，但字段不完全相同。退出码 0 表示通过，2 表示阻止或反馈（stderr 作为内容），其他退出码视为钩子出错但不阻止。

| 事件 | 时机和作用 |
|---|---|
| `PreToolUse` | 工具执行前、权限检查之前。退出码 2 阻止这次调用 |
| `PostToolUse` | 工具执行后。退出码 2 时 stderr 作为反馈附加到工具结果，退出码 0 的输出会被忽略 |
| `UserPromptSubmit` | 用户发送消息时。可以拦截，stdout 会作为附加上下文；Hive 的 prompt 为原始 goal，另带 hive 元数据，追加内容进入 brief |
| `Stop` | agent 准备结束 turn 时。退出码 2 让它继续，每个 turn 最多 3 次 |
| `SessionStart` | 会话开始时，stdout 加入 system prompt |

各配置层的 hooks 会叠加。仓库配置中的 hooks 需要信任。`Stop` 和 `UserPromptSubmit` 只作用于主会话，其他钩子对子 agent 同样生效。

### 长期记忆

模型用 `memory` 工具保存和检索跨会话的事实，按项目隔离。默认存在本地 `~/.roast/memory/` 下，最近的 20 条会在下次会话开始时加入 system prompt。`/memory` 查看和搜索。注意 `#` 写入的是 `ROAST.md`，和这里的记忆是两回事。

也可以使用 [Mem0](https://mem0.ai)：

```json
{ "memory": { "driver": "mem0", "baseURL": "https://api.mem0.ai", "mode": "platform", "apiVersion": "v3", "apiKeyEnv": "MEM0_API_KEY" } }
```

自托管时设置 `mode: "self-hosted"` 并填写实例地址。密钥可以用 `apiKeyEnv` 指定环境变量，或用 `apiKeyRef` 引用 `credentials.json` 中的一项，都不设置时读取 `MEM0_API_KEY`。

### 代码检索

`search_code` 默认用 BM25 检索，支持自然语言、完整标识符以及 camelCase、snake_case 拆出的子词。第一次检索时建立索引，之后按文件修改时间增量更新。

可以加上向量检索，和 BM25 的结果合并排序：

```json
{ "rag": { "embeddings": { "provider": "openai", "model": "text-embedding-3-small", "batchSize": 32, "maxChunks": 2000 } } }
```

`provider` 引用一个已配置的 OpenAI 兼容供应商，沿用它的地址、密钥和 headers。向量按内容 hash 缓存在 `~/.roast/indexes/`。`maxChunks` 限制向量化的代码块数量，BM25 仍然覆盖全部代码。向量服务出错时退回 BM25 并给出提示。

### Prompt 覆盖

`.roast/prompts/<名称>.md` 或 `~/.roast/prompts/<名称>.md` 会替换同名的 system prompt 分段，项目级优先。可以替换的分段有 `identity`（身份和总体准则）、`environment`（工作目录、平台、日期）、`swarm`（蜂群说明）、`agent-models`（可用模型），以及存在时的 `agents`（自定义角色列表）、`instructions`（项目说明）、`skills` 和 `memory`。其他名字会作为新的分段追加到末尾。文件中可以使用 `{{cwd}}`、`{{date}}`、`{{platform}}`。

## 配置参考

### 配置文件

按优先级从低到高合并：

1. `.roast/config.json`（项目）
2. `roastcli.config.json`（项目，旧位置）
3. `~/.roast/config.json`（用户）
4. `ROASTCLI_CONFIG` 指定的文件

对象逐键合并，数组和其他值整体覆盖。也就是说，用户配置优先，项目配置只补充用户配置中没有的项。如果用户配置定义了某个供应商的 `driver`，它的连接字段完全以用户配置为准，不会继承项目里的地址或密钥引用。

完整示例见仓库中的 [roastcli.config.example.json](https://github.com/Roast-2007/RoastCli/blob/main/roastcli.config.example.json)。

| 字段 | 说明 |
|---|---|
| `providers.<id>.driver` | `openai-compat` 或 `anthropic` |
| `providers.<id>.baseURL` | 接口地址 |
| `providers.<id>.auth` | 设为 `"none"` 表示不需要密钥 |
| `providers.<id>.apiKeyRef` | `credentials.json` 中的密钥引用，由向导生成 |
| `providers.<id>.headers` | 额外的请求头 |
| `providers.<id>.promptCaching` | 见[缓存](#缓存) |
| `providers.<id>.maxConcurrency` | 并发上限，1–64 |
| `providers.<id>.streamIdleTimeoutMs` | 流式响应的空闲超时 |
| `providers.<id>.models.<模型>` | `contextWindow`、`maxTokens`、`pricing`、`reasoning`、`reasoningEffort`、`reasoningEfforts`、`reasoningReplay`；Anthropic 另有 `thinkingBudget`，OpenAI 兼容另有 `maxTokensField` |
| `default` | 默认模型，格式为 `provider:model` |
| `maxSteps` | 主会话每个 turn 最多的 step 数，默认 100 |
| `diagnostics` | `enabled`（默认 `true`）、`maxItems`（默认 10）、`timeoutMs`（默认 8000），见[修改后自动诊断](#修改后自动诊断) |
| `temperature` | 0–2 |
| `logsDir` | 运行日志目录，默认 `logs`，**相对于当前目录**。记得加进项目的 `.gitignore`，或改成绝对路径 |
| `debugLog` | 记录完整的请求体，也可以用环境变量 `ROAST_DEBUG_LOG=1` 开启 |
| `context` | `compactAt`（默认 0.8）、`elideAt`（0.7）、`minSavings`（4000）、`keepTurns`（3）、`agingTurns`（8）、`agingMinTokens`（2000）、`previewLines`（20）、`cacheTtlMs`（300000）、`summaryModel`、`summaryMaxTokens`（2048） |
| `swarm` | `models`、`efforts`、`maxAgents`、`maxDepth`、`maxMinutes`、`maxSteps`、`worktrees`、`strategy`、`n` |
| `swarm.maxSteps` | 子 agent 每 turn 的步骤上限，正整数，默认 150 |
| `swarm.strategy` | 默认策略，默认 `"auto"` |
| `swarm.n` | 默认并行数，默认 3，范围 2–8 |
| `ui` | `theme`、`motion`、`ascii`、`shellTimeoutMs`、`markdown`、`home`、`notify`、`title`、`gutter`、`mouse`、`hints` |
| `ui.home` | `"hive"`（默认）或 `"chat"` |
| `ui.notify` | `"auto"`（默认）、`"bell"` 或 `"off"`，仅用户配置生效 |
| `ui.title` | 是否设置窗口标题，默认 `true`，仅用户配置生效 |
| `ui.gutter` | 右侧留白 0–4 列，默认 2；`ROAST_GUTTER` 优先，窄屏自动归零 |
| `ui.mouse` | 鼠标报告默认 `true`，`/mouse` 可在会话中切换 |
| `ui.hints` | `"full"`（默认）、`"compact"` 或 `"off"` |
| `webSearch` | `driver`、`baseURL`、`apiKeyRef`、`timeoutMs` |
| `memory` | 见[长期记忆](#长期记忆) |
| `rag.embeddings` | 见[代码检索](#代码检索) |
| `permissions` | `allow`、`ask`、`deny`、`defaultMode` |
| `hooks` | 见 [Hooks](#hooks) |
| `mcp.servers` | 见 [MCP](#mcp) |

### 环境变量

| 变量 | 作用 |
|---|---|
| `ROAST_HOME` | 用户目录，默认 `~/.roast` |
| `ROASTCLI_CONFIG` | 优先级最高的配置文件。指向项目目录内的文件时按项目配置处理，需要信任 |
| `ROAST_THEME` | 主题，优先于配置 |
| `NO_COLOR`、`FORCE_COLOR=0` | 使用无色主题 |
| `TERM=dumb` | 无色主题、ASCII 字符、关闭动画 |
| `ROAST_ASCII=1` | 只用 ASCII 字符 |
| `ROAST_REDUCED_MOTION=1` | 关闭动画 |
| `ROAST_RG_PATH` | 指定 ripgrep 路径。默认依次查找 PATH、安装包自带的 ripgrep，都没有时使用较慢的内置搜索 |
| `ROAST_DEBUG_LOG=1` | 记录完整请求体 |
| `ROAST_DIAGNOSTICS=0` | 关闭修改后自动诊断 |
| `MEM0_API_KEY` | Mem0 密钥的默认来源 |

### 文件位置

用户目录（`~/.roast`，Windows 为 `%USERPROFILE%\.roast`）：

| 路径 | 内容 |
|---|---|
| `config.json` | 用户配置 |
| `pricing.json` | 自定义用户价目，优先于内置 / 下载价目 |
| `pricing-catalog.json` | `roast pricing update` 下载的官方价目 |
| `credentials.json` | API Key（明文） |
| `trusted.json` | 已信任的文件夹 |
| `ROAST.md` | 用户级项目说明 |
| `projects/<hash>/` | 每个项目的输入历史和"本项目始终允许"的授权 |
| `memory/` | 长期记忆 |
| `indexes/` | 代码向量缓存 |
| `worktrees/` | 蜂群 worktree |
| `skills/`、`prompts/`、`strategies/`、`templates/` | 用户级技能、prompt 覆盖和 Hive 策略（兼容模板） |
| `agents/` | 用户级自定义角色 |

项目目录：

| 路径 | 内容 |
|---|---|
| `.roast/config.json` | 项目配置 |
| `.roast/shadow.git`、`.roast/snapshots/` | 检查点 |
| `.roast/skills/`、`.roast/prompts/`、`.roast/strategies/`、`.roast/templates/` | 项目级技能、prompt 覆盖和 Hive 策略（兼容模板） |
| `.roast/agents/`、`.claude/agents/` | 项目级自定义角色，项目受信任后才加载 |
| `roast-export-<runId>.md` | `/export` 的默认导出文件 |
| `ROAST.md` | 项目说明，`#` 写入的记忆也在这里 |
| `logs/` | 运行日志（默认位置） |
| `logs/<日期>/<runId>/log.jsonl`、`agents/<成员>.jsonl` | Queen 和子 agent 的主日志、子日志 |
| `logs/<日期>/<runId>/hive.jsonl` | 黑板、消息、中断文本、回退与分叉快照，主进程单写者追加 |

`.roast/` 和 `logs/` 都不应该提交到仓库。

## 常见问题

**PowerShell 提示无法加载 npm.ps1 或 roast.ps1**

这是 PowerShell 的执行策略导致的，改用 `npm.cmd` 和 `roast.cmd` 即可。

**安装后找不到 roast 命令**

重新打开终端。如果还是不行，运行 `npm prefix -g` 查看 npm 的全局目录：Windows 上把这个目录加入 PATH，macOS 和 Linux 上把它下面的 `bin` 目录加入 PATH。

**macOS / Linux 安装时报 EACCES**

把 npm 的全局目录改到用户目录下：

```sh
npm install -g --prefer-online --prefix "$HOME/.local" https://github.com/Roast-2007/RoastCli/releases/latest/download/roastcli.tgz
export PATH="$HOME/.local/bin:$PATH"
```

把 `export` 这一行加到 shell 的配置文件里，以后打开终端都会生效。

**需要安装 git 吗**

不是必须的，但建议安装。没有 git 时检查点改用文件快照，蜂群不能使用 worktree。Windows 上建议安装 [Git for Windows](https://git-scm.com/download/win)，bash 工具会使用其中的 Git Bash。ripgrep 已经包含在安装包里，不用单独安装。

**Shift+Enter 没有换行**

部分终端不会把 `Shift+Enter` 和 `Enter` 区分开，改用 `Ctrl+J` 或在行尾输入 `\`。

**缓存命中率很低**

先看会话是否只有很少几次请求，单次请求没有可以复用的前缀。其次检查供应商是否支持前缀缓存、缓存有效期多长、OpenAI 兼容端点是否设置了 `promptCaching: true`。

**网页搜索失败**

DuckDuckGo 有时会要求验证码或限流，换成 Brave、Tavily 或 SearXNG，见[网页搜索](#网页搜索)。

## 已知限制

- 没有在 Windows Terminal 和 conhost 中手工验证过中文输入法候选框的位置，以及 `Shift+Enter` 的行为。
- 内置的语义工具只支持 TS/JS。
- 不支持 SGR 鼠标的终端需要使用键盘操作。
- 旧会话缺少 `hive.jsonl` 时无法恢复黑板、计划板、消息和中断文本；历史成员只读，未合并 worktree 需单独查看。
- 0.5.0 可以恢复 0.4 日志；含 hive/mission 的新日志需用 0.5.0 或更新版本读取。
