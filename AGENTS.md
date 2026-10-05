# RoastCli 开发与发布规范

本文件适用于整个仓库。先阅读 `docs/STATUS.md`、`docs/DESIGN.md`、`docs/USAGE.md` 和 `docs/ROADMAP.md`，再按任务范围检查实现与测试。用户在当前任务中的明确指令优先于本文件。

## 项目结构与开发

- 使用 Node.js 22+、pnpm 11.21.0、TypeScript ESM；Windows 可用 `pnpm.cmd` 避免 PowerShell 执行策略拦截。
- `src/agent` 负责会话装配和运行，`src/context` 负责上下文与压缩，`src/providers` 负责供应商协议，`src/tools` 负责工具与权限，`src/swarm` 负责蜂群，`src/session` 负责日志与恢复，`src/ext` 负责扩展，`src/ui` 负责 Ink 界面。
- 测试位于 `test`，构建与包校验配置位于根目录和 `scripts`，CI 与发布位于 `.github/workflows`。
- 先检查 Git 状态，保留已有工作；针对实际问题修改，避免无关重构。使用 conventional commit。未获授权时不 force push、不重置用户改动、不移动已发布 tag。
- 依赖变动同步 `package.json` 与 `pnpm-lock.yaml`；安装使用 `pnpm install --frozen-lockfile`。构建由 `prepack` 触发，不能重新引入 install 时自动构建。
- Biome 格式化只针对本次修改的文件，避免全库格式噪声。shell 中含反斜杠或多行文本的修改使用文件编辑工具，避免转义改变源文件。

## 必须保留的不变量

- 日志、history reducer、恢复与界面重放一致；工具调用与结果始终配对，包括并发、错误、中断及多模态结果。不要把内部 attachment 或未提交 raw chunk 当作最终对话重放。
- 供应商请求的 system、工具 schema 与历史前缀保持稳定；压缩、回退、模型切换后验证缓存边界。缓存命中率按 token 加权，费用以供应商实际用量计算，避免普通输入、cache read、cache write 重复累计。
- 主模型、子代理及摘要分别记录 provider/model/agent/turn；恢复不能丢失费用，rewind 不退还实际已消耗费用。无定价时明确报告缺失，不能虚报完整总价。
- 用户显式指定的角色模型优先于 Queen 自动路由，包括 `inherit`。仅使用已配置且可信的供应商。
- 项目配置中的供应商、网络端点、MCP、hooks、memory、RAG 等执行或外发能力需纳入 trust 与权限边界；不要绕过 deny、plan、只读角色或 worktree 边界。
- 修改文件保持字节、编码与 CRLF；跨文件修改逐文件授权并检查并发冲突。危险 shell 的快照使用 turn 的首次基线，回退前保留恢复备份。
- TUI 修改检查小屏、缩放、长输入、Unicode、草稿保留、流式输出及退出清理。滚轮用于阅读 chat，不调用历史命令；回到底部恢复跟随新输出。
- 凭据、私人运行日志、用户配置、`.roast`、临时文件、覆盖率和构建产物不能提交。npm 包继续使用文件白名单，不扩大到整个仓库。

## 验证与文档

先运行有意义的定向回归，覆盖真实协议边界、权限、恢复、失败或用户行为。避免只复述实现的测试。供应商测试默认使用受控 HTTP/mock，不为测试自动消耗用户付费账户；实测在线收益需要相应任务授权与真实证据。

提交功能或发布前执行：

```sh
pnpm typecheck
pnpm lint
pnpm test:coverage
pnpm build
pnpm check:package
git diff --check
```

核对 CLI 版本、相关帮助与安装 smoke。只改文档时可用相关校验代替重复本地全量测试，但发布仍必须通过远端完整 CI。CI 在 Linux、Windows、macOS 上检查类型、lint、覆盖率、构建、包白名单及全局安装。

版本和功能变更同步 `package.json`、README、`docs/STATUS.md`、`docs/USAGE.md`、配置示例，以及 `docs/RELEASE-X.Y.Z.md`；涉及架构或路线图时同步对应文件。覆盖率与测试数量必须来自本次实际报告，区分本地、远端 CI、真实终端与在线供应商验证。

## 正式版本发布

用户明确要求发布时，应完成以下流程，不以本地测试通过或生成 tarball 作为发布完成，也不重复请求已经给出的发布权限。仅有开发请求时，不推断为公开发布授权。

1. 检查改动、版本号与 `docs/RELEASE-X.Y.Z.md`，确认目标 tag 尚不存在，执行本地验证。确认安装文档使用正确的 GitHub Release 地址。
2. 提交改动并推送到 `main`，记录精确 commit SHA；若远端已前进，先整合并验证，不能强推。
3. 等待该 SHA 的 main push CI 在三个平台全部成功。失败时读取失败日志、修复并提交新的 commit，重新等待同一 SHA 的完整 CI；不能用其他提交或本地结果代替。
4. 对通过 CI 的精确 SHA 创建 annotated tag `vX.Y.Z` 并推送。公开 tag 不得移动或删除；发现已发布问题使用新补丁版本。
5. 等待 Release 工作流成功。工作流再次检查精确 SHA 的 CI 与 tag/version 一致性，使用版本说明发布 `roastcli.tgz` 和 `SHA256SUMS`；先准备 draft 和附件，再公开发布。已公开版本的附件不覆盖。
6. 读取 GitHub Release，确认 tag、目标 SHA、版本说明、公开状态与附件；下载已发布附件，核对 SHA-256，并在隔离目录安装测试 `roast --version` 和帮助。不得用本地 tarball 替代已发布附件验证。
7. 最终报告真实 Release 链接、CI 链接、版本与验证结果。若认证、网络或自动审批阻断发布，说明具体未完成步骤和真实原因，不能声称发布成功。

本项目通过 GitHub Releases 分发，除非用户另外要求，不发布到 npm registry。发布后的 CI/Release 证据放在交付说明；不要为了补写“CI 已通过”产生未经 CI 验证的新发布提交。
