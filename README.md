# RoastCli

在终端里运行的编程助手，支持 Windows、macOS 和 Linux。

[使用指南](docs/USAGE.md) · [更新日志](CHANGELOG.md) · [设计文档](docs/DESIGN.md)

- 支持 DeepSeek、Kimi、通义千问、智谱、OpenAI、Claude、Gemini 等供应商，也能接入任意 OpenAI 兼容或 Anthropic 协议的端点。模型列表自动获取，用 `/model` 随时切换模型和推理强度。
- 旧的工具输出会折叠成占位符而不是直接删除，模型需要时可以用 `recall` 取回原文。上下文压缩尽量不破坏供应商的前缀缓存，`/cost` 可以按 turn、agent 和模型查看费用。
- 蜂群模式：Queen 把任务分给 Lead、Worker 以及 scout、critic 等角色并行处理。在 git 仓库里，写代码的 agent 各用一个独立的 worktree，完成后由上级合并。`Ctrl+G` 打开 Mission Control，查看和指挥所有 agent。
- 每个 turn 第一次改文件前自动打快照，`/rewind` 可以同时回退文件和对话。`roast -c` 继续上次的会话。
- 四种权限模式，可以按规则放行或拒绝命令。高危命令即使在 yolo 模式下也要你确认。
- 支持 skills、MCP、hooks、长期记忆、代码检索、网页搜索和读取图片，内置 TS/JS 的引用查找和跨文件重命名。

## 安装

需要 [Node.js](https://nodejs.org/) 22 或更新版本。

```sh
npm install -g --prefer-online https://github.com/Roast-2007/RoastCli/releases/latest/download/roastcli.tgz
```

RoastCli 通过 GitHub Releases 分发，没有发布到 npm registry，`npm install -g roastcli` 装不上。也可以用安装脚本，脚本会先检查 Node.js 版本：

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/Roast-2007/RoastCli/main/install.ps1 | iex
```

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Roast-2007/RoastCli/main/install.sh | sh
```

- 每次打开对话终端时，会在后台检查官方 GitHub Release，有新版本就提醒；不强制更新，离线或检测失败不影响使用。退出后运行 `roast update` 即可更新，也可以重新运行安装命令，再用 `roast --version` 确认版本。配置、API Key 和会话记录不受影响。
- 安装指定版本：把链接中的 `latest/download` 换成 `download/v0.4.1`。
- 卸载：`npm uninstall -g roastcli`。配置和密钥在 `~/.roast` 目录，运行日志默认在项目下的 `logs/` 目录，不再需要时手动删除。

安装遇到问题见[常见问题](docs/USAGE.md#常见问题)。

## 快速开始

在项目目录中运行：

```sh
roast config   # 选择供应商，填写 API Key 和模型
roast doctor   # 检查配置和运行环境
roast          # 开始对话
```

配置保存在 `~/.roast/config.json`（Windows 为 `%USERPROFILE%\.roast\config.json`），所有项目共用。第一次在某个目录启动时，RoastCli 会询问是否信任这个文件夹。

| 按键 | 作用 |
|---|---|
| `Enter` | 发送 |
| `Shift+Enter` 或 `Ctrl+J` | 换行 |
| `Esc` | 中断当前回答 |
| `Shift+Tab` | 切换权限模式 |
| `Ctrl+G` | 打开 Mission Control |
| `F1` | 帮助 |

用蜂群完成一个任务：

```sh
roast swarm "修复失败的测试并评审改动"
```

命令、配置和扩展的完整说明见[使用指南](docs/USAGE.md)。

## 开发

```sh
git clone https://github.com/Roast-2007/RoastCli.git
cd RoastCli
pnpm install --frozen-lockfile   # 需要 pnpm 11.21.0
pnpm dev                         # 从源码运行，参数与 roast 相同
```

开发约定和发布流程见 [AGENTS.md](AGENTS.md)，架构见[设计文档](docs/DESIGN.md)。

## 许可

[MIT](LICENSE)
