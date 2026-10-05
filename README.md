# RoastCli

终端里的开源编程助手，支持 Windows、macOS 和 Linux。

- 多供应商与自定义端点；自动获取模型列表，用 `/model` 面板选择模型和推理强度。
- 文件与图片读取、网页搜索、TS/JS 语义引用和重命名、shell、检查点回退与会话恢复。
- 稳定缓存前缀、模型摘要和原文召回；支持 skills、MCP tools/resources/prompts、记忆与代码检索。
- 多智能体蜂群与全屏 Mission Control；用户可指定角色模型，Queen 为未指定的角色选择模型，费用按 agent/turn/provider 分解。
- 全屏对话、字符启动动画与平滑面板过渡；长计划连续滚动，输入框和状态栏固定在底部。
- 可搜索的命令面板、持久化主题、带留白和段落间距的 Markdown；适配小屏、中文和 emoji。

## 安装

需要 [Node.js 22+](https://nodejs.org/)（包含 npm），一条命令安装：

```sh
npm install -g --prefer-online https://github.com/Roast-2007/RoastCli/releases/latest/download/roastcli.tgz
```

Windows PowerShell 也可使用：

```powershell
irm https://raw.githubusercontent.com/Roast-2007/RoastCli/main/install.ps1 | iex
```

macOS / Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/Roast-2007/RoastCli/main/install.sh | sh
```

## 开始使用

在你的项目目录运行：

```sh
roast config   # 配置一次，全局复用；Ctrl+L 获取模型列表
roast doctor   # 检查配置和运行环境
roast          # 开始对话
```

供应商、默认模型、主题及 Hive 设置默认保存到用户目录 `~/.roast/config.json`（Windows 为 `%USERPROFILE%\.roast\config.json`），所有项目共享，项目同名设置不会覆盖全局配置。首次交互启动会弹出文件夹信任面板，↑↓ / Enter 确认，Esc 退出；信任记录保存在用户目录，相关项目配置变化后会重新提示。

`Enter` 发送，`Shift+Enter` / `Ctrl+J` 换行，`Esc` 中断，`Ctrl+G` 打开蜂群面板，`F1` 显示帮助。鼠标滚轮滚动对话并保留草稿；也可用 `Shift+↑↓` 或 `PgUp` 进入阅读，`End` / `Enter` / `Esc` 返回输入。用 `roast -c` 继续上次会话。

`/model` 选择模型和 effort，`/theme` 选择并保存主题，`/hive models` 配置各角色的模型。面板用 ↑↓ / Enter 操作，模型列表支持输入搜索和 Ctrl+R 刷新。

```sh
roast swarm "修复测试并评审" --role-model worker=deepseek:deepseek-chat --role-model critic=claude:claude-sonnet-4-5
```

**0.4.0** 的变更与验证见 [版本说明](docs/RELEASE-0.4.0.md)，开发与发布规范见 [AGENTS.md](AGENTS.md)。

[安装、更新与常见问题](docs/INSTALL.md) · [完整使用指南](docs/USAGE.md) · [开发状态](docs/STATUS.md)

安装包通过 [GitHub Releases](https://github.com/Roast-2007/RoastCli/releases) 分发；当前尚未发布到 npm registry。许可：[MIT](LICENSE)。
