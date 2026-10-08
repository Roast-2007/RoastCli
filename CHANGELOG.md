# 更新日志

安装包和校验文件见 [GitHub Releases](https://github.com/Roast-2007/RoastCli/releases)。

## 0.6.0 - 2026-10-09

新增

- 图片附件：Chat 和 Deck 中按 `Alt+V`（macOS 用 `Ctrl+V`）附加剪贴板图片，或把图片文件拖进终端；输入框显示 `[图片 #N]` 占位符，删掉即取消。Deck 空闲时图片随新任务发给 Queen。
- 管道输入：`git diff | roast -p "评审"` 把管道内容附在任务后面，`git diff | roast -p` 直接把它当作任务；`roast hive --print` 同样支持。
- 管道模式新增 `--output-format json`，结束时输出一行结果，含回答、用量、费用和 runId；`--max-budget-usd` 设置费用上限，达到后中断全部成员。
- `--max-steps` 临时调整主会话步数上限；`--allowed-tools` / `--disallowed-tools` 为本次运行追加工具规则，不带括号的禁止项同时对模型隐藏该工具。
- 自定义角色：在 `~/.roast/agents/` 或项目的 `.roast/agents/` 中用 Markdown 定义成员的职责、基础角色、模型和可用工具，Queen 用 `spawn_agent` 的 `agent` 参数派生。兼容项目中 Claude Code 的 `.claude/agents/`。`roast hive --list-agents` 查看。
- 修改后自动诊断：改完 TS/JS 文件后，用 TypeScript 检查该文件，把新引入的错误附在工具结果后面。检查在后台线程进行，可用 `diagnostics` 配置或 `ROAST_DIAGNOSTICS=0` 关闭。
- `/export [路径]` 和 `roast logs export` 把对话导出为 Markdown；`/copy [N]` 复制回答，SSH 下使用 OSC 52。

变更

- `/init` 改为让 agent 分析仓库后生成或更新项目说明，已有的 `ROAST.md` / `AGENTS.md` / `CLAUDE.md` 在原内容上改进；`/init template` 保留原来的空模板。

兼容性

- `hive/mission` 事件新增可选的 `images` 字段。0.5.x 可以读取 0.6 的日志，但会丢失任务中的图片。
- `-p` 的值改为可选。`roast -p "任务"` 的用法不变；stdin 不是终端时会尝试读取管道输入，有任务时最多等 3 秒第一个字节。
- 项目未受信任时不加载项目级自定义角色，启动时提示忽略的数量。

## 0.5.2 - 2026-10-08

新增

- Deck 计划页完整换行显示任务标题；Enter 或双击打开计划详情，查看标题、验收标准、依赖、成员与报告摘要。
- Queen 与选中成员的待办直接显示在计划页，不再需要 `/todo`。
- 内置模型价目（`src/providers/pricing/catalog.json`，含来源链接），`roast pricing` 查看价格来源，`roast pricing update` 随时下载最新价目；`~/.roast/pricing.json` 可自定义。获取模型列表时自动读取 OpenRouter 格式的价格。`/cost` 标注价格来源，代理端点的同名模型标为参考价。
- 新增 `swarm.maxSteps`（默认 150），子 agent 步数与主会话独立；接近上限时提醒收尾并 report。

修复

- worktree 中的成员执行命令遵循权限模式与授权规则，YOLO 下不再逐条询问；只读命令和 `cd` 不询问，worker 读取主工作区不询问。
- “始终允许”按命令段生成规则，识别引号和环境变量前缀，复合命令授权后不再反复询问。
- 子 agent 达到步数上限时报告为 partial，附最后说明、未完成待办和 worktree 改动文件，不再显示“failed（没有输出）”。
- 等待用户审批或回答期间暂停 `maxMinutes` 与 `await_agents` 计时；超时结果显示每个成员的步数、最近活动和等待原因。
- worktree 复制的 `node_modules` 修正 pnpm 布局路径，pnpm 不再要求重装依赖。
- 启动动画直接按差分绘制，大窗口也能保持流畅；结束时在同一次同步刷新中清屏并进入工作面，不再残留最后一帧的色块。

变更

- 主会话每个 turn 的默认步数上限从 50 提高到 100。

## 0.5.1 - 2026-10-08

新增

- Deck 输出页渲染 Markdown；双击输出窗格或按 Enter 进入全屏，保留成员、页签、草稿与阅读位置。
- Chat 和 Deck 全屏输出可双击任意工具查看参数、完整 diff 和结果；详情支持左右切换工具和独立滚动。
- `/strategy` 两步选择策略与并行数，支持单独修改 n，自定义 YAML 的 n 与占位符同样生效。
- Hive 日志保存黑板、计划、消息与中断文本；恢复成员树及 Queen / 成员输出，历史成员只读。

修复

- `/rewind` 同步重放 Chat / Deck，回滚成员、黑板、消息和中断文本；清屏后重放仍可见。
- 共享工作区的 worker 写入复用 Queen 当前轮次的首个检查点，支持 git 与非 git 目录；活跃成员结束前拒绝回退。
- 分叉恢复读取来源目录，保留成员 id 水位、原轮次回退信息和累计费用。
- 更新提醒固定在信号栏顶部，界面重放不会清除；启动警告去重。
- 流式输出重试时丢弃已提交的半截段落，不再重复显示；`-p` 只有在确实丢弃已输出的文本时才提示重试。

兼容性

- 主日志不增加事件类型，0.5.0 仍可读取；`history/import` 的可选字段保留分叉来源水位与轮次快照。
- 0.5.0 日志可恢复成员和输出；缺少 `hive.jsonl` 时无法恢复黑板、消息和中断文本。未合并 worktree 继续保留在磁盘。
- 中断文本仅供界面回看，并标记“已中断，未发送给模型”，不进入模型历史或 projection。
- `--output-format stream-json` 新增 `stream-commit` 和 `partial` 事件，解析方请忽略未知事件类型。

## 0.5.0 - 2026-10-07

新增

- Hive 任务事件、独立的目标与模型简报、递增任务编号；auto 默认策略，以及 fanout、best-of-n、critique、research 和自定义 YAML 策略。
- 默认首页 Hive Deck：蜂群树、任务计划、成员流式输出、改动、消息、黑板和用量；`@成员` 直接发送指示，计划通过 `task_id` 关联成员。
- 按需读取和缓存 worktree diff；文件审批卡片预览 diff，合并审批显示 diffstat，`Ctrl+O` 查看完整详情。
- `roast hive`、`--strategy`、`--list-strategies`、`/strategy`、`/chat` 和 `/status`；`ui.home`、`ui.notify`、`ui.title`、`swarm.strategy` 和 `swarm.n` 配置。
- 终端审批与长任务结束通知、节流窗口标题；通知和标题配置仅在用户配置中生效。
- Deck 鼠标选择、双击输出、右键成员菜单、页签和信号点击、指针所在面板的滚轮；浮层与审批支持点击，`ui.mouse` 和 `/mouse [on|off]` 控制鼠标报告。
- Deck / Chat 共用可点击 KeyBar，焦点标记、反色页签、空状态引导和 Deck 专属帮助；`ui.hints` 支持 full、compact、off。
- 全屏右侧留白 `ui.gutter`（默认 2，范围 0–4）及 `ROAST_GUTTER` 覆盖；窗口两维变化完整重绘并保留草稿、焦点、成员、页签、滚动和浮层。

变更

- `roast` 默认进入 Deck，`Ctrl+G` 切换 Deck / Chat，两边各保留草稿；旧 Mission Control 被 Deck 取代。
- 900 毫秒全窗口 ASCII 蜂巢 Ignition，按尺寸选择蜂房和字标，中央王台点火、固定余烬；单行头部与统一状态栏，启动警告和更新提醒移至信号或 toast。
- 输入框 Tab 仅用于补全，F6 / Shift+F6 切换面板；面板 Tab / Shift+Tab 切焦点，输入框 Shift+Tab 保留权限模式切换。
- `Ctrl+C` 优先中断运行、其次清空草稿，空闲无草稿时在两秒内再按一次才退出；排队消息显示在输入框上方。
- 重写共享提示词、Queen 任务简报、角色卡与报告格式；只读任务拒绝派生 worker / lead。
- 默认主题改为 `aurora`（极光青紫）。想继续用余烬橙，设置 `ui.theme: "ember"` 或 `ROAST_THEME=ember`。

兼容性

- `ui.home: "chat"` 或 `--chat`（`--solo`）保留单 agent 首页，`-p` 仍是单 agent 管道模式。
- `roast swarm`、`/swarm`、`-t/--template`、`--list-templates` 和原 `templates/*.yaml` 继续可用；同一配置层的 `strategies/` 同名策略优先。
- 0.5.0 可以读取 0.4 日志；旧程序不能读取含新任务事件的日志，请用 0.5.0 恢复。黑板与计划板仍不随会话保存。

## 0.4.1 - 2026-10-06

- 每次启动交互终端时，在后台检查官方 GitHub Releases 的最新正式版本，发现更新后提醒并显示更新指令；不强制更新，网络失败不影响使用。
- 新增 `roast update`，一条命令更新全局安装；`roast update --check` 只检测。更新失败时提供手动安装指令。

## 0.4.0 - 2026-10-05

新增

- `read_image` 读取本地图片；MCP 工具返回的图片也会作为图片传给模型。需要模型支持视觉输入。
- `web_search` 网页搜索，支持 DuckDuckGo（默认，无需密钥）、Brave、Tavily 和 SearXNG。
- `find_references` 和 `rename_symbol`：基于 TypeScript 语言服务查找引用和跨文件重命名。重命名默认只预览，应用前逐个文件申请权限，任一文件失败则全部回滚。
- MCP 支持 resources、URI 模板和 prompts，prompt 可以当作斜杠命令调用。
- `--role-model 角色=provider:model` 为蜂群角色指定模型，`/swarm` 里也能用。没有指定的角色由 Queen 根据已配置模型的价格和上下文长度选择。
- `/cost` 按 turn、agent、供应商和模型列出费用，包括压缩摘要的开销。恢复会话后累计费用不丢失。
- 鼠标滚轮滚动对话，输入框里的草稿不受影响；滚回底部后继续跟随新输出。
- 会话、回退和成员列表支持输入搜索。

改进

- 上下文压缩默认用已配置模型中最便宜的一个生成摘要。可以用 `context.summaryModel` 指定模型，或设为 `extractive` 完全不调用模型。摘要失败时退回抽取式摘要。
- 工具输出的折叠阈值提高到上下文窗口的 70%，减少不必要的前缀改写。
- OpenAI 官方端点发送稳定的 `prompt_cache_key`；Anthropic 在上一次请求中仍然相同的位置设置缓存断点。压缩、回退和切换模型后会重新检查缓存边界。
- yolo 模式下每条 bash 命令执行前都会创建快照，rewind 恢复到该 turn 的第一个快照。
- `!命令` 的超时可以配置，默认 600 秒；输出在 `Ctrl+O` 中查看。
- 输入历史最多保存 500 条。
- 安装包自带对应平台的 ripgrep，不需要单独安装。

修复

- DeepSeek 未命中缓存的输入同时被算作普通输入和缓存写入，导致费用偏高。
- 跨 turn 回传 reasoning 时改写了历史前缀，导致缓存失效。新增 `reasoningReplay: "current"`，用于只接受当前回合推理的服务。
- 非 TTY 环境下缺少任务参数时，现在会在创建会话之前报错。

开发

- 引入 Biome（`pnpm lint`、`pnpm format`），CI 运行覆盖率测试并上传报告。
- 构建从 `prepare` 移到 `prepack`，安装依赖时不再自动构建。

## 0.3.0 - 2026-10-05

- 对话默认全屏，输入框和状态栏固定在底部。对话、蜂群面板和配置向导共用一个渲染器，切换时历史、草稿和进行中的任务都不受影响。
- 启动时播放 ROAST 字符动画，按任意键跳过，按下的字符会进入输入框。
- 长回答可以逐行滚动阅读：`Shift+↑↓` 或 `PgUp` 进入阅读，`↑↓` 或 `j`/`k` 滚动，`Home` 到顶部，`End`、`Enter`、`Esc` 回到输入框。阅读时新输出不会把视图拉回底部。
- `/help` 改为可滚动的说明页。`/context` 默认显示统计，按 `m` 管理工具结果。
- 工具详情、黑板、费用、记忆和日志都可以逐行滚动。
- 改进小窗口布局、Unicode 换行、窗口缩放和快速连续输入。
- 动画遵循 `ui.motion: "reduced"`、`ROAST_REDUCED_MOTION=1` 和 `TERM=dumb`。

## 0.2.1 - 2026-10-05

- 配置默认保存在用户目录的 `~/.roast/config.json`，所有项目共用。项目配置只补充全局没有设置的项。设置了 `ROASTCLI_CONFIG` 时读写指定的文件。
- 全局配置里的供应商不会继承项目配置中的地址、headers、认证方式或密钥引用。
- 第一次在某个目录交互启动时会询问是否信任该文件夹，项目中相关配置变化后会再次询问。非交互模式不弹窗，也不会自动信任，可以用 `roast trust`。
- 修复显式指定全局配置文件时钩子执行两次的问题。

## 0.2.0 - 2026-10-05

- 自动获取供应商的模型列表（OpenAI 兼容和 Anthropic 协议），支持搜索和刷新，获取失败时可以手动输入。
- `/model` 选择模型和推理强度，立即生效，恢复会话时沿用。
- 配置向导可以一次添加多个模型，支持自定义端点和无需密钥的本地服务。
- `/hive models` 为每个蜂群角色设置模型和推理强度；`spawn_agent` 和 `task` 可以为单个子 agent 指定模型。
- `/theme` 选择并保存主题。权限模式、蜂群策略、技能、成员、黑板、费用、待办和记忆等命令改为交互面板。
- Markdown 输出增加左右留白和段落间距，可以通过 `ui.markdown` 调整。
- 修复：自定义 Anthropic 地址以 `/v1` 结尾时路径重复；配置覆盖层丢失模型信息；新建同类供应商时复用了已有 ID。
- 供应商请求不再跟随重定向，接口返回的错误正文不会写入界面和日志。

## 0.1.2 - 2026-10-04

- 修复 `/swarm research` 中只读角色的 shell 命令在审批前就被拒绝。无法确认是否只读的命令改为请求用户批准。
- 修复长时间的只读调研被误判为停滞：新的读取、搜索和验证结果都算作进展。
- 蜂群树和 `agents_status` 显示正在等待授权的 agent；取消 agent 时移除它的审批卡片。

## 0.1.1 - 2026-10-04

- 提供 PowerShell 和 shell 安装脚本。
- 在配置向导中直接输入并保存 API Key；新增 Kimi Code 预设；支持自定义模型和推理强度。
- 修复跨平台发布检查；`roast --version` 显示安装包的版本。

## 0.1.0 - 2026-10-04

首个开源版本。
