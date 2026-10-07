# 使用指南

安装和入门见 [README](../README.md)。本文按功能说明 RoastCli 的全部用法。

## Hive

`roast` 默认打开 Hive Deck，输入目标即可发起任务。Queen 负责理解、规划、派发、整合与验证，子 agent 通过消息和黑板协作；等待子 agent 时不发模型请求，不消耗 token。简单或耦合紧密的工作可以由 Queen 自己完成。

`Ctrl+G` 在 Deck 和 [Chat](#chat) 之间切换，两边分别保留输入草稿。`ui.home: "chat"` 把 Chat 设为首页；`--chat`（别名 `--solo`）或 `--hive` 只覆盖本次启动。首次配置和文件夹信任流程不变。Ignition 铺满窗口的 ASCII 蜂巢动画最多 900 毫秒，任意键跳过，可打印字符会进入输入框；reduced motion 或 `TERM=dumb` 直接进入首页。带目标启动 Hive 时跳过动画。

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
| `1` 计划 | Queen 在黑板 `/mission/plan` 写的任务计划；没有有效计划时按子 agent 生成行 |
| `2` 输出 | 选中成员的 Markdown 与流式输出，默认 Queen；工具显示摘要和增删统计 |
| `3` 改动 | 成员 worktree 相对基线的 diffstat / diff；Queen 显示当前工作区的 git diff |
| `4` 消息 | 消息时间线 |
| `5` 黑板 | 键、版本、作者和值 |
| `6` 用量 | 本任务按 agent / 模型聚合的 token 和费用；缺少定价时总价显示“未知” |

中屏插入信号页后，消息、黑板、用量依次为 `5`、`6`、`7`。改动页打开时才读取 git，切页可中断，结果缓存到成员下一次状态变化，不修改索引、HEAD 或文件。大型 diff 会截断。

计划格式为 `{"tasks":[{"id":"t1","title":"实现限流","role":"worker","acceptance":"测试通过","dependsOn":[]}]}`。Queen 派发时传 `task_id`，Deck 按成员的 `taskId` 关联任务并推导状态，不需要 Queen 反复改写计划。每行显示任务、成员、状态；读取过该成员的改动后还显示缓存中的 `+增 −删`。黑板和计划板随 Hive 日志保存。

输出页保留 Markdown 的标题、强调、列表和代码着色。小窗格省略 diff 正文，运行中的工具最多显示两行尾部。双击输出窗格任意位置，或在任务区输出页按 Enter，进入整宽全屏输出，显示与 Chat 相同的段落间距、留白和 diff 预览。全屏保留输入框、排队行、审批与状态栏；窄屏同样可用，高度 <8 行时不能进入。

全屏中 `↑↓` / `j k` 逐行，`PgUp/PgDn` / `b f` 翻页，`g/G` / `Home/End` 到顶 / 到底，也可用滚轮。上翻后新输出不会拉回视图，到底后恢复跟随。面板聚焦时按 Esc 或双击非工具行返回，保留原页签、成员和小窗格滚动位置；双击工具行查看该工具详情，关闭后回到原全屏位置。可打印字符回到输入框插入草稿。

### Deck 按键

默认聚焦输入框，`Tab` 只补全命令、文件和成员，没有候选时保持焦点。点击面板，或用 `F6` 按输入框 → 蜂群 → 任务区 → 信号循环；`Shift+F6` 反向循环，布局没有独立信号栏时跳过。在面板中，`Tab` / `Shift+Tab` 正向 / 反向切换焦点。聚焦面板的边框高亮，标题前显示 `▸`（ASCII 为 `>`）。单字母快捷键只在面板聚焦时生效；其他可打印字符会把焦点移回输入框并插入草稿。

| 按键 | 作用 |
|---|---|
| `Enter` | 输入框发送；蜂群栏选中成员并打开输出；任务区输出页进入全屏 |
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
| `←→`、`[` / `]`（工具详情） | 切换上一个 / 下一个工具 |
| `↑↓` / `j k`、`PgUp/PgDn` / `b f`、`g/G` / `Home/End`（全屏） | 逐行、翻页、到顶 / 到底；Esc 返回 |
| `Ctrl+G` | 切到 Chat |
| 鼠标滚轮 | 滚动指针下的面板；指针在输入区时滚动任务区，不切成员或输入历史 |
| `?`、`F1` | 打开 Deck 专属帮助；输入框中的 `?` 仅在草稿为空时打开 |
| `Esc`（输入框） | 运行中中断 Queen；空闲时 600 毫秒内按两次打开回退菜单 |
| `Ctrl+C` | 运行中中断；空闲有草稿时清空；无草稿时提示，两秒内再按一次退出 |

`Ctrl+C` 清草稿后也会提示“已清空 · 再按 Ctrl+C 退出”。暂停在 step 之间生效，正在执行的工具会正常完成。换行、编辑、输入历史、斜杠命令与 Chat 共用，见下文。

### Deck 鼠标与引导

单击面板聚焦；单击成员或计划行选中对应成员，双击打开输出。右键成员或计划行打开“查看输出 / 查看改动 / 发送指示 / 暂停或继续 / 取消”菜单，取消需要再次确认。点击页签切换任务页，输出和改动页右侧显示当前成员；点击信号打开对应审批、消息发送者或黑板键。点击策略标记打开策略选择，点击状态栏权限胶囊切换权限模式。

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

### worktree

在 git 仓库中，worker 和 lead 默认各自在独立的 worktree 里改代码，完成后由上级审阅合并。合并前会先检查冲突，有冲突时一个文件也不会写入。只读角色和非 git 项目共用工作目录，通过文件租约避免两个 agent 同时改同一个文件。设置 `swarm.worktrees: false` 可以关闭 worktree。

- worktree 位于 `~/.roast/worktrees/<runId>/<agentId>`，基于父 agent 工作区的当前状态创建，包括未提交的改动。整个过程不会动你的分支、索引和 HEAD。
- 顶层的 `node_modules` 会复制一份到 worktree（文件系统支持时使用写时复制），这会增加启动时间和磁盘占用。
- worktree 只隔离文件修改，不是沙箱，shell 等外部命令仍然能访问其他目录。所以在 worktree 中执行命令每次都需要你批准，yolo 模式和 allow 规则也不例外。非交互模式下这类命令会被拒绝，可以等合并后由主会话验证。
- 会话结束时，没有改动的 worktree 会被删除，有未合并改动的会保留，并在 stderr 列出路径。`roast worktrees list` 查看保留的 worktree，`roast worktrees prune` 删除已结束且没有改动的。正在使用、有未合并改动或缺少基线记录的不会被删除。

### 只读角色

scout、critic 和 judge 不能直接修改文件。它们执行的命令中，能确认是只读的（如 `git log`、`rg`、`cat`）按普通规则处理；无法确认的每次都要你批准，不能设为始终允许。MCP 等其他执行类工具也一样。等待批准时，agent 在蜂群树中显示为"等待用户授权"。deny 规则和 plan 模式仍然有效。

一个 agent 连续 12 个 step 没有新进展（重复同样的调用，或者一直失败）时，会提醒它的上级检查。读取、搜索和验证得到新结果都算作进展，所以长时间的调研不会被误判。

### 限制

- `swarm.maxAgents`：一次会话最多派生的 agent 数（包括已结束的），默认 12。
- `swarm.maxDepth`：最大层级，默认 3。
- `swarm.maxMinutes`：单个子 agent 的最长运行时间，默认 60 分钟，超时后取消它和它的子 agent。
- 不限制 token 用量。

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
| `roast -p "<任务>"` | 非交互执行，输出结果后退出。加 `--output-format stream-json` 以 JSON 行输出所有事件，包括子 agent |
| `roast -c` | 继续当前目录最近的会话 |
| `roast -r [runId]` | 恢复指定会话；不带 ID 时列出当前目录最近 20 个会话 |
| `roast -m provider:model` | 本次使用指定的模型 |
| `roast --permission-mode <模式>` | 以指定权限模式启动：`default`、`acceptEdits`、`plan`、`yolo` |
| `roast hive [目标]`（`roast swarm`） | 打开 Deck 或立即发起任务，见 [Hive](#hive) |
| `roast hive --strategy <名称> -n <数量> <目标>` | 指定策略和并行数，旧 `-t/--template` 仍可用 |
| `roast hive --list-strategies` | 列出策略，旧 `--list-templates` 仍可用 |
| `roast config` | 配置向导 |
| `roast init` | 不经向导生成配置，见[不用向导](#不用向导) |
| `roast doctor` | 检查 Node.js 版本、配置、密钥、信任状态、shell、git、ripgrep、项目说明、skills、hooks 和 MCP |
| `roast trust` | 信任当前目录 |
| `roast mcp add` / `list` / `remove` | 管理 MCP 服务器，见 [MCP](#mcp) |
| `roast logs list` | 列出最近 20 次运行 |
| `roast logs show <runId> [--raw]` | 从日志还原某次运行的对话，`--raw` 输出原始事件 |
| `roast worktrees list` / `prune` | 查看或清理蜂群保留下来的 worktree |
| `roast update` | 从官方 GitHub Release 更新全局安装；`--check` 只检查、不安装 |
| `roast --version` | 显示版本 |

在 CI、管道等非 TTY 环境中必须用 `-p` 提供任务，蜂群用 `roast swarm --print "<目标>"`，否则直接报错。非交互模式下，需要用户确认的操作一律拒绝。按一次 `Ctrl+C` 中断当前任务，再按一次退出。

退出码：`2` 缺少配置，`3` 项目配置未受信任，`130` 被中断，其他错误为 `1`。

Windows 上 bash 工具和 `!命令` 优先使用 Git Bash（`C:\Program Files\Git\bin\bash.exe`），找不到时使用 cmd。

每次启动交互式 `roast`、`roast hive` 或 `roast swarm`，都会在后台从官方 GitHub Releases 检查最新正式版本，超时 3 秒，不缓存到下次启动。有更新时在 Deck 信号栏或 Chat toast / notice 显示当前版本、新版本和更新指令，不打断输入或任务。断网、超时、限流时静默跳过；管道模式、`--help`、`--version` 不自动联网检查。

更新完全自愿：退出会话后运行 `roast update`，它会调用 npm 安装对应版本的官方发布附件。`roast update --check` 只检查。npm 不可用或安装失败时会给出手动安装指令，不自动提权。Windows 执行策略拦截命令时用 `roast.cmd update`、`npm.cmd`。

## Chat

Chat 是单 agent 对话工作面，用 `--chat`、`/chat` 或 `Ctrl+G` 进入。标题只占一行，输入框和状态栏固定在底部，空白页只显示暗色字标。完整环境与配置状态用 `/status` 查看。

### 按键

| 按键 | 作用 |
|---|---|
| `Enter` | 发送 |
| `Shift+Enter`、`Alt+Enter`、`Ctrl+J`，或在行尾输入 `\` | 换行 |
| `Esc` | 运行中：中断。空闲时在 600 毫秒内按两次：打开回退菜单 |
| `Ctrl+C` | 运行中中断；空闲清草稿；无草稿时提示，两秒内再按一次退出 |
| `Shift+Tab` | 切换权限模式：default → acceptEdits → plan → yolo |
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

agent 运行时输入的消息会排队，在下一个 step 送达，不用先中断。中断时，排队的内容会放回输入框。

输入历史按项目保存，最多 500 条。

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
| `/init` | 在当前目录创建 `ROAST.md` 模板 |
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
| `plan` | 只允许只读操作。模型用 `exit_plan_mode` 提交计划，你批准后才能修改 |
| `yolo` | 除了高危命令，全部自动允许 |

文件 edit / multi_edit / write 审批卡片会在读权限允许且文件状态有效时预览 diff，最多 12 行，超出部分用 `Ctrl+O` 查看完整详情。新文件可以直接预览；越界、UNC、未读取或过大的现有文件不自动预览。merge_worktree 审批显示 diffstat；bash 显示完整命令和高危、worktree 或只读角色触发强制询问的原因。预览和 `Ctrl+O` 不会批准操作。

审批时，`1` 或 `y` 允许一次，`2` 本会话内始终允许，`3` 本项目始终允许，`4`、`n` 或 `Esc` 拒绝；也可以用 `↑↓` 选择后按 `Enter`。高危操作只能选允许一次或拒绝。本会话的授权写在会话日志里，恢复会话后仍然有效。本项目的授权保存在 `~/.roast/projects/<hash>/settings.json`，不会进入仓库。

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
- 包含 `&&`、`|`、`;` 的复合命令会拆开判断，每一段都必须被允许，并且不能含子 shell。
- 判断顺序是 deny → plan 模式 → 强制询问 → yolo → allow → ask → 默认。高危命令和直接修改 `.git/` 内文件的编辑属于强制询问，在 yolo 模式下或匹配了 allow 规则也会询问。
- 仓库配置中的 allow 规则需要信任后才生效。`permissions.defaultMode` 只在用户配置中生效。

### 检查点与回退

每个 turn 第一次修改文件之前，RoastCli 会给工作目录打一个快照：

- 有 git 时使用影子仓库 `.roast/shadow.git`，不影响项目自己的仓库、索引和分支。
- 没有 git 时把文件按字节保存到 `.roast/snapshots/`，二进制内容和 CRLF 都原样保留。跳过符号链接、依赖目录和日志，单次最多 128 MiB。
- yolo 模式下每条 bash 命令执行前都会打快照，因为无法可靠判断一条命令会不会改文件。

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

在模型配置中填写定价（美元 / 百万 tokens），状态栏和 `/cost` 就会显示费用：

```json
"models": {
  "deepseek-chat": { "pricing": { "input": 0.27, "output": 1.1, "cacheRead": 0.07 } }
}
```

上面是示例数值，请按供应商当前的价格填写。`/cost` 按 turn、agent、供应商和模型列出主会话、子 agent 和摘要的费用，每次请求按当时使用的模型计价。恢复会话后累计费用不变，回退不会扣减。只要有一个用过的模型缺少定价，总价就显示为未知，不会给出一个偏低的数字。

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

### 提示注入检查

`read`、`grep`、`bash`、`bash_output`、`web_fetch`、`web_search`、`search_code` 和所有 MCP 工具的结果中，如果出现疑似提示注入的内容，会在结果后面附加警告。只提示，不拦截。

## 扩展

### 项目说明

从 git 根目录到当前目录，每一层取第一个存在的 `ROAST.md`、`AGENTS.md` 或 `CLAUDE.md`，再加上用户级的 `~/.roast/ROAST.md`，一起放进 system prompt，总共最多 4 万字符。`/init` 可以生成一个 `ROAST.md` 模板。

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

`.roast/prompts/<名称>.md` 或 `~/.roast/prompts/<名称>.md` 会替换同名的 system prompt 分段，项目级优先。可以替换的分段有 `identity`（身份和总体准则）、`environment`（工作目录、平台、日期）、`swarm`（蜂群说明）、`agent-models`（可用模型），以及存在时的 `instructions`（项目说明）、`skills` 和 `memory`。其他名字会作为新的分段追加到末尾。文件中可以使用 `{{cwd}}`、`{{date}}`、`{{platform}}`。

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
| `maxSteps` | 每个 turn 最多的 step 数，默认 50 |
| `temperature` | 0–2 |
| `logsDir` | 运行日志目录，默认 `logs`，**相对于当前目录**。记得加进项目的 `.gitignore`，或改成绝对路径 |
| `debugLog` | 记录完整的请求体，也可以用环境变量 `ROAST_DEBUG_LOG=1` 开启 |
| `context` | `compactAt`（默认 0.8）、`elideAt`（0.7）、`minSavings`（4000）、`keepTurns`（3）、`agingTurns`（8）、`agingMinTokens`（2000）、`previewLines`（20）、`cacheTtlMs`（300000）、`summaryModel`、`summaryMaxTokens`（2048） |
| `swarm` | `models`、`efforts`、`maxAgents`、`maxDepth`、`maxMinutes`、`worktrees`、`strategy`、`n` |
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
| `MEM0_API_KEY` | Mem0 密钥的默认来源 |

### 文件位置

用户目录（`~/.roast`，Windows 为 `%USERPROFILE%\.roast`）：

| 路径 | 内容 |
|---|---|
| `config.json` | 用户配置 |
| `credentials.json` | API Key（明文） |
| `trusted.json` | 已信任的文件夹 |
| `ROAST.md` | 用户级项目说明 |
| `projects/<hash>/` | 每个项目的输入历史和"本项目始终允许"的授权 |
| `memory/` | 长期记忆 |
| `indexes/` | 代码向量缓存 |
| `worktrees/` | 蜂群 worktree |
| `skills/`、`prompts/`、`strategies/`、`templates/` | 用户级技能、prompt 覆盖和 Hive 策略（兼容模板） |

项目目录：

| 路径 | 内容 |
|---|---|
| `.roast/config.json` | 项目配置 |
| `.roast/shadow.git`、`.roast/snapshots/` | 检查点 |
| `.roast/skills/`、`.roast/prompts/`、`.roast/strategies/`、`.roast/templates/` | 项目级技能、prompt 覆盖和 Hive 策略（兼容模板） |
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
