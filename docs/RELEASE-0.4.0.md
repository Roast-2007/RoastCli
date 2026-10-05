# RoastCli v0.4.0

缓存与上下文升级、鼠标阅读、Queen 模型路由，以及新的输入和检索工具。

- 修正 DeepSeek 未命中输入的重复计费，保持跨 turn 的 reasoning 前缀，提供 `current` 兼容模式；OpenAI 稳定 cache key、Anthropic 前次边界断点、压缩/回退后的前缀校验与 token 加权统计。
- 压缩默认使用廉价已配置模型，可指定 `context.summaryModel` 或选择 `extractive`，失败回退抽取摘要，摘要费用记入账本。折叠阈值提高至 70%，减少提前改写上下文。
- 全屏 chat 的滚轮按行滚动，保留草稿，到底后自动跟随新输出；列表与正文也支持滚轮。蜂群初始目标跳过启动动画，会话/回退/成员列表可搜索。
- `--role-model 角色=provider:model` 支持 Queen 和子角色，`/swarm` 同样接受；用户路由优先，Queen 可通过 `configure_swarm` 或单次派生选择未指定角色的模型。
- `read_image` 及 MCP 真实图片支持；MCP resources、URI templates、prompt 斜杠命令；`web_search` 支持 DuckDuckGo、Brave、Tavily、SearXNG。
- `find_references` / `rename_symbol` 使用 TS/JS 语言服务，支持跨文件、导入别名、预览、逐文件权限、内容冲突检查及失败回滚。
- `/cost` 展示 turn/agent/provider/model 与摘要开销，恢复日志保留累计费用；yolo 每条 bash 前快照，rewind 使用 turn 的首次基线。
- `!shell` 超时可配置（默认 600 秒），开始/超时有提示，输出进入工具详情；非 TTY 缺少任务提前报错；历史最多保留 500 条；管道工具行显示参数摘要。
- 打包平台 ripgrep；Biome 配置、lint/format 命令；CI 执行覆盖率并保存报告；构建从 prepare 移到 prepack。

使用与配置例子见 [USAGE.md](https://github.com/Roast-2007/RoastCli/blob/v0.4.0/docs/USAGE.md)，实际测试数量、覆盖率和平台验证边界见 [STATUS.md](https://github.com/Roast-2007/RoastCli/blob/v0.4.0/docs/STATUS.md)。本地验证不调用用户付费供应商，未以模拟测试宣称线上缓存命中率已经提高。内置语义工具支持 TS/JS；其他语言可通过 MCP 接入。

Windows 本地最终验证：117 个测试文件、714 项测试全部通过；行覆盖率 93.66%、分支 82.34%。类型检查、Biome lint、构建、安装包白名单与 frozen-lockfile 校验通过；CLI 空 PATH 能找到随包 ripgrep。

发布工作流要求同一提交通过 Windows/macOS/Linux CI 和全局安装检查，再发布 `roastcli.tgz` 与 `SHA256SUMS`。此版本说明记录本地实测结果，远端验证以对应提交的 GitHub Actions 为准，发布状态以 GitHub Releases 为准。开发与发布流程见 [AGENTS.md](https://github.com/Roast-2007/RoastCli/blob/v0.4.0/AGENTS.md)。
