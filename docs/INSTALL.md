# 安装 RoastCli

需要 **Node.js 22 或更新版本**（包含 npm）。安装 Node.js 后重新打开终端；Windows 建议使用 Windows Terminal，并安装 Git for Windows，以便使用 Git Bash 和 worktree。Git 与 ripgrep 可选，缺少时部分功能会降级。

## 一条命令安装

Windows、macOS 和 Linux 通用，不需要克隆代码或安装 pnpm：

```sh
npm install -g --prefer-online https://github.com/Roast-2007/RoastCli/releases/latest/download/roastcli.tgz
```

安装包来自本项目的 GitHub Release。当前尚未发布到 npm registry，因此请使用完整链接，而非 `npm install -g roastcli`。也可锁定版本：

```sh
npm install -g https://github.com/Roast-2007/RoastCli/releases/download/v0.1.2/roastcli.tgz
```

## 安装脚本

脚本会检查 Node.js 版本并安装同一个 Release 包，不需要管理员权限启动终端。

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/Roast-2007/RoastCli/main/install.ps1 | iex
```

macOS / Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/Roast-2007/RoastCli/main/install.sh | sh
```

## 第一次使用

在需要工作的项目目录运行：

```sh
roast config
roast doctor
roast
```

在向导里选择供应商，填写模型、API Key 和 reasoning effort，按 Enter 确认，再 Enter 保存。支持 Kimi Code：端点 `https://api.kimi.com/coding/v1`，默认模型 `kimi-for-coding`。供应商密钥直接保存，不需要设置密钥环境变量。

密钥存放在用户目录 `~/.roast/credentials.json`（本地明文），配置只记录引用。项目配置修改后，按提示运行 `roast trust`；请先确认项目配置来源。Node.js 安装时配置的 npm 全局目录需要位于 PATH 中。

## 更新和卸载

更新：退出正在运行的 RoastCli，重新执行上面的安装命令或安装脚本，再用 `roast --version` 核对版本。`--prefer-online` 会检查远端包，避免一直使用旧的缓存。安装会保留配置、API Key 和会话记录。

```sh
npm uninstall -g roastcli
```

卸载程序会保留用户配置和会话记录；如需彻底删除，再手动处理 `~/.roast` 及项目内 `.roast` 目录。

## 常见问题

- **PowerShell 阻止 npm.ps1 / roast.ps1**：用 `npm.cmd` / `roast.cmd` 执行对应命令。
- **找不到 roast**：重新打开终端，运行 `npm prefix -g` 检查安装位置。Windows 将该目录加入 PATH；macOS / Linux 将其 `bin` 子目录加入 PATH。
- **macOS / Linux 的 EACCES**：将 npm 的安装位置设为用户目录后重试：

```sh
npm install -g --prefer-online --prefix "$HOME/.local" https://github.com/Roast-2007/RoastCli/releases/latest/download/roastcli.tgz
export PATH="$HOME/.local/bin:$PATH"
```

将 PATH 设置加入你的 shell 配置文件即可长期生效。

## 从源码开发

```sh
git clone https://github.com/Roast-2007/RoastCli.git
cd RoastCli
npm install -g pnpm@11.21.0
pnpm install --frozen-lockfile
pnpm dev config
pnpm dev
```

验证：`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm check:package`。
