# RoastCli 开发规范

适用于整个仓库。用户在当前任务中的指令优先于本文件。

动手前先读 [README](README.md)、[使用指南](docs/USAGE.md) 和 [设计文档](docs/DESIGN.md)，再看与任务相关的源码和测试。

## 环境

- Node.js 22+，pnpm 11.21.0，TypeScript ESM。
- 安装依赖用 `pnpm install --frozen-lockfile`。改依赖时同时提交 `package.json` 和 `pnpm-lock.yaml`。
- 构建只在 `prepack` 中触发，不要加回安装时自动构建。
- Windows PowerShell 下用 `pnpm.cmd`，可以绕过执行策略的拦截。

## 目录

| 目录 | 内容 |
|---|---|
| `src/agent` | 会话装配、运行时、step 循环 |
| `src/context` | 上下文折叠、压缩、缓存规划、recall |
| `src/providers` | 供应商协议（OpenAI 兼容、Anthropic）、并发调度 |
| `src/tools` | 内置工具、权限引擎 |
| `src/swarm` | 蜂群：supervisor、消息、黑板、worktree |
| `src/session` | 事件日志、history reducer、恢复 |
| `src/ext` | skills、MCP、hooks、记忆、代码检索、检查点 |
| `src/ui` | Ink 界面 |
| `src/cli` | 子命令 |
| `test` | 测试，目录结构与 `src` 对应 |
| `scripts` | 包检查、冒烟和终端调试脚本 |
| `.github/workflows` | CI 和发布 |

## 改代码

- 先看 `git status`，不要覆盖已有的未提交改动。只改和任务相关的部分，不顺手重构。
- 提交信息用 conventional commits（`feat:`、`fix:`、`docs:` 等）。
- 没有用户授权时，不 force push，不重置用户的改动，不移动已发布的 tag。
- Biome 格式化只针对本次改动的文件，不要格式化整个仓库。
- 内容含反斜杠或多行文本时，用文件编辑工具修改，不要用 shell heredoc，避免转义出错。

## 不变量

下面这些约束一旦被破坏，通常不会立刻报错，但会导致恢复失败、缓存失效或费用算错。改动相关代码时要专门验证。

1. **日志一致**：事件日志、history reducer、会话恢复和界面重放必须得到同样的历史。工具调用和结果始终成对出现，并发、出错、中断和多模态结果都不例外。内部 attachment 和未提交的 raw chunk 不能当作对话内容重放。
2. **缓存前缀稳定**：发给供应商的 system、工具 schema 和历史前缀保持不变。压缩、回退、切换模型之后要检查缓存边界。
3. **费用准确**：缓存命中率按 token 加权。费用按供应商返回的用量计算，普通输入、cache read 和 cache write 不能重复计入。主模型、子 agent 和摘要请求分别记录 provider、model、agent 和 turn。恢复会话不丢费用，rewind 不退还已消耗的费用。缺少定价时显示未知，不要给出不完整的总价。
4. **模型路由**：用户为角色指定的模型（包括 `inherit`）优先于 Queen 的自动选择。只使用已配置且受信任的供应商。
5. **信任边界**：项目配置里能执行命令或向外发送数据的部分（供应商连接、网络端点、MCP、hooks、记忆、代码检索、网页搜索）必须经过 trust 和权限检查。不能绕过 deny 规则、plan 模式、只读角色和 worktree 边界。
6. **文件安全**：改文件时保持原有字节、编码和 CRLF。跨文件修改逐个文件授权，并检查并发冲突。危险 shell 命令的快照以该 turn 的第一个基线为准，回退前先备份。
7. **终端界面**：改 TUI 时检查小窗口、缩放、长输入、Unicode、草稿保留、流式输出和退出清理。鼠标滚轮用于滚动对话，不能触发历史命令；回到底部后恢复跟随新输出。
8. **不提交私人数据**：凭据、运行日志、用户配置、`.roast`、临时文件、覆盖率报告和构建产物都不能提交。npm 包用 `files` 白名单，不要扩大到整个仓库。

## 测试

- 优先写能覆盖真实边界的回归测试：协议细节、权限、恢复、失败路径和用户操作。不要写只是把实现复述一遍的测试。
- 供应商相关测试用 mock HTTP 或 ScriptedProvider。没有用户授权时，不调用用户的付费账户。

提交功能前运行：

```sh
pnpm typecheck
pnpm lint
pnpm test:coverage
pnpm build
pnpm check:package
git diff --check
```

只改文档时可以只做相关检查。CI 在 Linux、Windows 和 macOS 上运行同样的检查，并测试全局安装。

## 文档

- 用户能感知的变化要更新 [使用指南](docs/USAGE.md)；影响安装或入门的同时更新 README；新增配置项时更新 `roastcli.config.example.json`。
- 架构变化更新 [设计文档](docs/DESIGN.md)。
- 每个版本在 [CHANGELOG.md](CHANGELOG.md) 顶部加一节 `## X.Y.Z - YYYY-MM-DD`。发布工作流会提取这一节作为 Release 说明，缺少时发布失败。
- 测试数量、覆盖率和验证过程不写进文档，放在提交说明或交付报告里，并注明来源（本地、CI 还是真实终端）。

## 发布

只有用户明确要求发布时才执行，开发任务不等于发布授权。用户已经授权发布的，不要重复确认。本地测试通过或生成了 tarball 都不算发布完成。

项目通过 GitHub Releases 分发，除非用户另有要求，不发布到 npm registry。

1. 检查改动、`package.json` 版本号和 CHANGELOG 中对应的一节，确认 tag `vX.Y.Z` 还不存在，跑完本地检查。
2. 提交并推送到 `main`，记下 commit SHA。远端已有新提交时先合并再验证，不能强推。
3. 等这个 SHA 在 main 上的 CI 三个平台全部通过。失败时看日志、修复、提交新的 commit，再等新 SHA 的 CI 全部通过。不能用别的提交或本地结果代替。
4. 在通过 CI 的 SHA 上创建 annotated tag `vX.Y.Z` 并推送。已发布的 tag 不移动、不删除，发现问题就发补丁版本。
5. 等 Release 工作流完成。工作流会再次检查该 SHA 的 CI 和版本号，发布 `roastcli.tgz` 和 `SHA256SUMS`，已公开的版本不会覆盖附件。
6. 打开 GitHub Release 核对 tag、目标 SHA、说明和附件。下载发布的附件，校验 SHA-256，在临时目录安装后运行 `roast --version` 和 `roast --help`。必须用发布的附件验证，不能用本地 tarball 代替。
7. 报告 Release 链接、CI 链接、版本号和验证结果。如果因为认证、网络或审批卡住，说明停在哪一步、原因是什么，不能说发布成功。

不要为了补写"CI 已通过"之类的内容再提交一次，CI 和发布的证据放在交付报告里。
