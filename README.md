# RoastCli

终端里的开源编程助手，支持 Windows、macOS 和 Linux。

- 多供应商与自定义端点，包括 Kimi Code；直接配置 API Key、模型和推理强度。
- 文件读写、搜索、shell、权限审批、检查点回退与会话恢复。
- 上下文折叠和原文召回，支持 skills、MCP、记忆与代码检索。
- 多智能体蜂群与全屏 Mission Control；界面适配小屏、中文和 emoji。

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
roast config   # 选择供应商，输入模型、API Key 和 reasoning effort
roast doctor   # 检查配置和运行环境
roast          # 开始对话
```

`Enter` 发送，`Shift+Enter` / `Ctrl+J` 换行，`Esc` 中断，`Ctrl+G` 打开蜂群面板，`F1` 显示帮助。用 `roast -c` 继续上次会话。

[安装、更新与常见问题](docs/INSTALL.md) · [完整使用指南](docs/USAGE.md) · [开发状态](docs/STATUS.md)

安装包通过 [GitHub Releases](https://github.com/Roast-2007/RoastCli/releases) 分发；当前尚未发布到 npm registry。许可：[MIT](LICENSE)。
