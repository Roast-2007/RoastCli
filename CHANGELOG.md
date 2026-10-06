# 更新日志

安装包和校验文件见 [GitHub Releases](https://github.com/Roast-2007/RoastCli/releases)。

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
