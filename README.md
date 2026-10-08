# RoastCli

以 Hive 蜂群为主打的终端编程 agent，支持 Windows、macOS 和 Linux。打开就是指挥台：发起任务、查看计划和成员输出、审阅改动，用 `@成员` 直接发指示；`Ctrl+G` 随时切换到单 agent 的 Chat。

[使用指南](docs/USAGE.md) · [更新日志](CHANGELOG.md) · [设计文档](docs/DESIGN.md)

- 支持 DeepSeek、Kimi、通义千问、智谱、OpenAI、Claude、Gemini 等供应商，也能接入任意 OpenAI 兼容或 Anthropic 协议的端点。模型列表自动获取，用 `/model` 随时切换模型和推理强度。
- 旧的工具输出会折叠成占位符而不是直接删除，模型需要时可以用 `recall` 取回原文。上下文压缩尽量不破坏供应商的前缀缓存，`/cost` 可以按 turn、agent 和模型查看费用。
- Hive：Queen 按 auto、fanout、best-of-n、critique 或 research 策略组织任务，把工作分给 Lead、Worker 和只读专家。在 git 仓库里，写代码的 agent 各用独立的 worktree，报告后由上级审阅合并。
- 每个 turn 第一次改文件前自动打快照，`/rewind` 可以同时回退文件和对话。`roast -c` 继续上次的会话。
- 四种权限模式，可以按规则放行或拒绝命令。高危命令即使在 yolo 模式下也要你确认。
- 支持 skills、MCP、hooks、长期记忆、代码检索、网页搜索和读取图片，内置 TS/JS 的引用查找和跨文件重命名。
- 可以把截图直接贴进输入框发给模型；`git diff | roast -p "评审"` 这样从管道传入材料，`--output-format json` 和费用上限方便在脚本和 CI 中使用。
- 在 `.roast/agents/` 中用 Markdown 定义自己的成员角色，指定职责、模型和可用工具，也能读取项目里 Claude Code 的 `.claude/agents/`。
- 改完 TS/JS 文件后自动检查新引入的类型错误，并反馈给模型。

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
- 安装指定版本：把链接中的 `latest/download` 换成 `download/v<版本号>`。
- 卸载：`npm uninstall -g roastcli`。配置和密钥在 `~/.roast` 目录，运行日志默认在项目下的 `logs/` 目录，不再需要时手动删除。

安装遇到问题见[常见问题](docs/USAGE.md#常见问题)。

## 快速开始

在项目目录中运行：

```sh
roast config   # 选择供应商，填写 API Key 和模型
roast doctor   # 检查配置和运行环境
roast          # 打开 Hive Deck，在输入框中发送目标
roast --chat   # 直接进入单 agent 的 Chat
```

配置保存在 `~/.roast/config.json`（Windows 为 `%USERPROFILE%\.roast\config.json`），所有项目共用。第一次在某个目录启动时，RoastCli 会询问是否信任这个文件夹。

| 按键 | 作用 |
|---|---|
| `Enter` | 空闲 Deck 发起任务；运行中给 Queen 插话 |
| `Shift+Enter` 或 `Ctrl+J` | 换行 |
| `Alt+V` / `Ctrl+V` | 附加剪贴板中的图片（Windows 用 `Alt+V`，macOS 用 `Ctrl+V`） |
| `Esc` | 输入框聚焦时中断；面板聚焦时返回输入框 |
| `Ctrl+C` | 运行中中断；空闲清草稿，再按一次退出 |
| `Tab` | 输入框中仅补全；面板中切到下一栏 |
| `Shift+Tab` | 输入框中切换权限模式；面板中切到上一栏 |
| `F6` / `Shift+F6` | 在输入框、蜂群、任务区、信号之间正向 / 反向切焦点 |
| `Ctrl+G` | 在 Hive Deck 和 Chat 之间切换，各自保留草稿 |
| `@成员 文本` | 向成员发指示；`@queen` 给 Queen 插话 |
| `Space`（蜂群栏）或右键成员 | 成员操作菜单 |
| 双击输出窗格 / `Enter`（输出页聚焦） | 全屏阅读成员输出，`Esc` 返回 |
| 双击工具行 / `Ctrl+O` | 查看工具参数、完整 diff 与结果，`←→` 切换工具 |
| `F1`、空输入时 `?` 或点击帮助 | 当前工作面的帮助 |

可以直接点击成员、页签和提示栏；滚轮滚动指针下的面板。`/mouse off` 关闭鼠标报告后可拖选文字，`/mouse on` 恢复；开启时也可按住 `Shift` 拖选。默认有操作引导，`ui.hints` 可设为 `compact` 或 `off`，详见[使用指南](docs/USAGE.md#deck-鼠标与引导)。

用蜂群完成一个任务：

```sh
roast hive --strategy critique "修复失败的测试并评审改动"
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
