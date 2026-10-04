# RoastCli 使用指南

安装步骤见 [INSTALL.md](INSTALL.md)，项目介绍见 [README](../README.md)。

一个终端里的 coding agent。主打三件事：

- **无损上下文**：旧内容不删，折叠成带句柄的存根 `⟦ctx:id⟧`，模型随时可以用 `recall` 取回原文。压缩只在安全切点进行，并且会考虑前缀缓存。
- **Hive 蜂群**：Queen → Lead → Worker 多层智能体，配合 scout、critic 等专家角色。agent 之间通过消息总线和版本化黑板协作，等待子任务时不耗 token。在 git 仓库中，写代码的子 agent 各自在独立的 worktree 中并行修改，上级审阅后用 `merge_worktree` 合并，冲突会被检出而不会写坏文件。按 Ctrl+G 进入全屏 Mission Control 实时指挥。
- **可证明一致**：所有模型可见的内容都先写进 JSONL 日志。实时运行和 `-c` 恢复走同一套 reducer，每次请求都会校验视图 hash。

此外还提供：权限引擎与检查点回退、skills、MCP、用户钩子、本地 / Mem0 长期记忆、BM25 / embeddings 混合代码检索，以及支持中文和 emoji 编辑的 Ink TUI。

## 快速开始

```bash
pnpm install && pnpm build        # 或开发时用 pnpm dev 代替下文的 roast
roast config                      # 终端向导：选择供应商、填写密钥和模型、确认保存
roast doctor                      # 自检：配置、凭据、shell、git、ripgrep、扩展
roast                             # 交互式 TUI
```

Windows 上 bash 工具优先使用 Git Bash（`C:\Program Files\Git\bin\bash.exe`），找不到时退回 cmd。

## 命令

| 命令 | 说明 |
|---|---|
| `roast` | 交互式 TUI |
| `roast -p "<任务>"` | 管道模式：直接输出结果。可加 `--output-format stream-json` 输出全部事件（包括子 agent） |
| `roast -c` / `roast -r [runId]` | 继续本目录最近一次会话 / 恢复指定会话 |
| `roast -m provider:model` | 临时换模型 |
| `roast --permission-mode <mode>` | `default` / `acceptEdits` / `plan` / `yolo` |
| `roast swarm "<目标>" [-t 模板] [-n 数量] [-p]` | 以蜂群方式完成目标。模板：`fanout`（默认，拆分并行）、`best-of-n`（N 个独立方案，由 Judge 择优合并）、`critique`（实现、评审、修正循环）、`research`（多角度只读调研）；`--list-templates` 列出全部，可在 `.roast/templates/*.yaml` 自定义 |
| `roast init` / `roast doctor` | 生成配置 / 环境自检 |
| `roast config` | 供应商配置向导：添加、编辑、选择默认模型与推理强度，保存到当前生效配置 |
| `roast trust` | 信任当前项目（允许项目配置设置 provider 连接信息、钩子、MCP 服务器） |
| `roast mcp add <名称> -- <命令> [参数…]` | 添加 stdio MCP 服务器。也可用 `--url <地址>` 添加 http / sse 服务器；`-e K=V`、`-H K=V`；`--project` 写入项目级配置 |
| `roast mcp list` / `roast mcp remove <名称>` | 列出 / 移除 MCP 服务器 |
| `roast logs list` / `roast logs show <runId> [--raw]` | 浏览运行日志，从日志重建会话 |
| `roast worktrees list` / `roast worktrees prune` | 查看当前仓库保留的蜂群工作区 / 清理已结束且相对基线无改动的工作区；有未合并改动、仍在运行或缺少基线记录的工作区会保留 |

## TUI

**按键**

| 按键 | 作用 |
|---|---|
| Enter / Shift+Enter、Ctrl+J、行尾 `\` | 发送 / 换行 |
| Esc / Ctrl+C | 中断当前回合（空闲时连按两次 Esc 打开回退列表，Ctrl+C 退出） |
| Ctrl+O | 查看最近工具的完整输出；PgUp/PgDn 翻页，Home/End 到首尾 |
| Shift+Tab | 切换权限模式 default → acceptEdits → plan → yolo |
| Ctrl+G | 进入 / 退出全屏 Mission Control |
| Tab / ↑↓ | 补全命令或 `@文件` / 选择补全项 |
| ↑ / ↓、Ctrl+R | 浏览输入历史 / 反向搜索；再次 Ctrl+R 切换匹配，Enter 载入，Esc 返回草稿 |
| 空输入时 `?` / F1 | 打开可滚动帮助，Esc 关闭并保留草稿 |

**输入前缀**：`/` 命令，`@路径` 引用文件，`!命令` 直接执行 shell（结果不发给模型），`#内容` 记到 ROAST.md。agent 运行时输入的内容会排队，在下一步送达，不需要先中断。

**斜杠命令**：`/help /provider`（别名 `/config`）、`/clear /resume [runId] /context [pin|unpin|drop <id>] /compact [关注点] /rewind [N] /mode /model [provider:model] /cost /todo /init /swarm [模板] <目标> /agents /board [key] /theme [名称] /skills /memory [关键词] /mcp /logs /exit`。另外，每个 skill 都可以用 `/技能名 参数` 直接调用。

`/model` 在主会话和子 agent 空闲时即时切换；历史与工具列表保持，费用按各次实际使用的模型累计。`/clear` 清空显示并保留上下文与草稿，`/resume` 打开最近活动优先的会话菜单。回退菜单用 ↑↓ 选择、两次 Enter 确认。

**Mission Control**（Ctrl+G）：宽终端展示 agent 树、输出、消息和黑板；窄终端自动改为两栏或单栏。`j/k` 选择 agent，`Tab` / `1–4` 查看输出、消息正文、黑板内容、上下文，`b/f` 或 PgUp/PgDn 翻页、`G` 回到底部，`m` 给主会话或子 agent 发指示，`p` 暂停 / 恢复，`x` 两次确认取消子树，`q` / `Esc` 返回。暂停在步骤边界生效，执行中的工具会正常收尾。

界面按终端行数分配输入、工具与审批面板，长输入软换行且光标始终可见。动画共用一个计时器，事件约 30Hz 合批；`NO_COLOR` 使用 mono 主题，`TERM=dumb` 自动使用 ASCII 装饰并停止动画。也可设置 `ROAST_ASCII=1`、`ROAST_REDUCED_MOTION=1`，或配置 `ui.ascii: true`、`ui.motion: "reduced"`。`/theme ember|aurora|daylight|mono` 即时切换；`ROAST_THEME` 优先。

## 配置

运行 `roast config`（会话内使用 `/provider`）打开终端向导。支持 DeepSeek、通义千问、智谱、Kimi / Moonshot、Kimi Code、豆包、腾讯混元、硅基流动、OpenAI、Claude、Gemini、OpenRouter，以及自定义 OpenAI 兼容 / Anthropic 端点。地址和模型均可编辑，豆包需填写控制台实际模型或 Endpoint ID，Gemini 使用 OpenAI 兼容接口。预设模型是建议，请按账号实际可用模型调整。

向导按“供应商 → 连接与模型 → API Key 与推理强度 → 确认保存”引导配置。密钥页直接聚焦 API Key，输入后 Enter 确认，下一页 Enter 保存。Tab / Shift+Tab 或 ↑↓ 切换字段，推理强度和默认模型用 ←→ 选择，Esc 返回或取消；小屏只显示当前字段，长确认页用 PgUp/PgDn 翻页。保存位置显示在页首及确认页：有项目或显式配置时更新当前最高优先级文件，否则写用户配置，保留其他供应商与扩展设置，避免保存后又被旧项目默认模型覆盖。项目连接信息变更后按提示运行 `roast trust`。修改在下一次启动生效。缺少配置时，交互式启动会自动打开向导。

密钥直接输入并保存在 `~/.roast/credentials.json`（**用户目录中的本地明文文件**），配置只记录 `apiKeyRef`。供应商环境变量认证已弃用，旧配置仍可打开修改，但 `apiKeyEnv` 不再用于认证；请重新输入并保存 API Key，已有本地密钥仍可使用。`ROAST_HOME` 可覆盖用户目录。POSIX 下凭据文件权限为 `0600`，Windows 继承用户目录权限；密钥输入不进入聊天历史和日志。更换密钥使用新引用，当前会话仍使用原来的引用。

`Reasoning effort` 按模型保存为 `models.<模型>.reasoningEffort`，“自动”保存为 `null` 并清除覆盖层继承的设置，请求不发送额外参数。OpenAI 兼容协议发送 `reasoning_effort`，Anthropic 发送 `output_config.effort`。选项需实际模型支持；Kimi Code 提供自动 / none / low / high / max，默认端点为 `https://api.kimi.com/coding/v1`，模型为 `kimi-for-coding`，工具循环保留当前回合的 reasoning 内容。参数依据：[OpenAI 官方文档](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Anthropic effort](https://platform.claude.com/docs/en/build-with-claude/effort)、[Kimi Code 模型配置](https://www.kimi.com/code/docs/kimi-code/models.html)。

脚本或非交互终端可用 `roast init --provider kimi-code --reasoning-effort high` 生成配置，然后运行 `roast config` 输入密钥；也可加 `--api-key-stdin` 从标准输入读取并保存密钥，无需设置供应商环境变量。

配置分层合并，后者覆盖前者：

```
~/.roast/config.json → .roast/config.json → roastcli.config.json（旧版）→ $ROASTCLI_CONFIG
```

```jsonc
{
  "providers": {
    // pricing 为示例数值（美元 / 百万 tokens），请按服务商当前官方定价填写
    "deepseek": { "driver": "openai-compat", "baseURL": "https://api.deepseek.com", "apiKeyRef": "<向导生成的密钥引用>",
                  "models": { "deepseek-chat": { "contextWindow": 131072, "pricing": { "input": 0.27, "output": 1.1, "cacheRead": 0.07 } } } },
    "claude":   { "driver": "anthropic", "apiKeyRef": "<向导生成的密钥引用>" }
  },
  "default": "deepseek:deepseek-chat",
  "ui": { "theme": "ember", "motion": "full", "ascii": false },
  "swarm": { "models": { "worker": "deepseek:deepseek-chat" }, "maxAgents": 12, "maxDepth": 3, "maxMinutes": 60 },
  "hooks": { "PostToolUse": [{ "matcher": "edit|write|multi_edit", "command": "pnpm prettier --write ." }] },
  "mcp": { "servers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
                                    "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } } } }
}
```

**安全**

- 供应商密钥通过 `apiKeyRef` 用户凭据引用提供，不放入普通配置文件。MCP 的 env / headers 用 `${VAR}` 引用。
- 仓库内的配置文件如果设置了 provider 连接信息、钩子、MCP、Mem0 或 embeddings，需要先运行 `roast trust` 才会生效，防止克隆来的仓库把你的密钥发往别处或执行任意命令。信任与这些配置的内容绑定：之后的改动（例如 `git pull` 带来新的钩子）需要重新确认。
- 权限规则写在配置的 `permissions: { allow, ask, deny }` 中，格式如 `bash(git status:*)`、`edit(src/**)`、`mcp__github__create_issue`。仓库层的 allow 规则需要先 trust；在卡片上选"始终允许"会写入 `~/.roast/projects/<hash>/settings.json`，不进仓库。复合命令会拆开逐段判断，高危命令即使在 yolo 模式下也会询问。
- worktree 的文件编辑限制在它自己的目录内。`node_modules` 使用独立副本，内部 pnpm 链接也映射到副本；复制依赖会增加启动时间和磁盘用量，支持时采用 copy-on-write。worktree 提供 Git 改动隔离；shell 和外部执行工具仍能访问其他目录，因此每次执行都需明确批准，`yolo` 和 allow 规则不能跳过。管道模式没有审批界面时会拒绝，验证可由主会话在合并后执行。
- 会话退出时会在 stderr 列出仍保留的 worktree 路径，纯文本回答和 stream-json 输出格式不受影响。可以进入工作区检查改动；`worktrees prune` 只处理当前仓库，不会删除未合并代码。

## 扩展

| 扩展 | 用法 |
|---|---|
| 项目说明 | `ROAST.md` / `AGENTS.md` / `CLAUDE.md`（项目级 + `~/.roast` 用户级），放进稳定的 system 前缀 |
| Skills | `.roast/skills/<名称>/SKILL.md`、`~/.roast/skills/…`，兼容 `.claude/skills/…`。frontmatter 写 name / description / allowed-tools。system prompt 只列摘要，模型用 `skill` 工具按需读取正文 |
| 长期记忆 | `memory` 工具；默认本地 JSONL，也可使用 Mem0 平台 / 自托管服务。按项目隔离，最近事实在下次会话开始时进入稳定 system prompt |
| 代码检索 | `search_code`：默认 BM25，支持自然语言、标识符、camelCase 子词及增量索引；可选 embeddings 混合排序，失败明确回退 BM25 |
| 用户钩子 | `PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop` / `SessionStart`，JSON 经 stdin 传入。退出码 2 表示阻止（stderr 作为理由）。PreToolUse 在权限检查之前运行 |
| MCP | stdio / streamable-http / sse。工具名为 `mcp__<服务器>__<工具>`，在会话启动时注册；`/mcp` 查看连接状态 |
| Prompt 覆盖 | `.roast/prompts/<section>.md` 覆盖同名的内置 system section，支持 `{{cwd}} {{date}} {{platform}}` |
| 注入防护 | 读取网页、文件或命令输出时，如果发现疑似提示注入，会在结果后追加警示 |

Mem0 与 embeddings 均为可选能力，未配置时保持本地记忆与 BM25。下面的设置合并进已有配置；`rag.embeddings.provider` 引用已配置的 OpenAI 兼容供应商（支持其 `baseURL`、凭据与自定义 headers），并使用该供应商实际支持的 embedding 模型：

```json
{
  "memory": {
    "driver": "mem0", "baseURL": "https://api.mem0.ai",
    "apiKeyEnv": "MEM0_API_KEY", "mode": "platform", "apiVersion": "v3"
  },
  "rag": {
    "embeddings": {
      "provider": "openai", "model": "text-embedding-3-small",
      "batchSize": 32, "maxChunks": 2000
    }
  }
}
```

Mem0 平台用 `Authorization: Token`；自托管设置 `mode: "self-hosted"` 和实例地址，凭据通过 `X-API-Key`。保存保留原文，删除前检查项目归属；请求可以中断并有超时。代码向量按内容哈希缓存于 `~/.roast/indexes/`，首次检索才分批生成；`maxChunks` 限制语义索引成本，BM25 仍覆盖全部索引。向量维度变化自动重建缓存。

供应商的 `maxConcurrency` 控制主会话与蜂群共享的并发上限；默认从最多 4 个并发开始，429 时减半，遵守 `retry-after`，连续 10 次成功后加 1。等待请求可中断，执行工具或等待子任务期间不占请求名额。

检查点优先使用影子 Git；没有 Git 时使用 `.roast/snapshots/` 文件快照，保持二进制和 CRLF，回退前另存备份。文件快照不跟随符号链接，默认跳过依赖、日志及 Roast 自身状态，单次上限 128 MiB。

## 架构

```
src/
  core/       类型、错误分类、分层配置与 trust、EventHub、InteractionBroker
  providers/  provider 中立的流协议；openai-compat、anthropic（thinking 签名、cache_control）
  agent/      AgentRuntime（turn/step 状态机、边界钩子、重试）、Committer（先写日志再 reduce）、会话装配
  session/    v1 事件日志（批量写、锁、断尾修复）、history reducer、resume
  context/    无损上下文：折叠 / 去重 / 老化 / 安全切点压缩 / recall / 缓存规划
  tools/      执行管线（pre 钩子 → zod 校验 → 执行 → post 钩子）、内置工具、权限引擎
  swarm/      Supervisor、mailbox、消息总线、黑板、租约锁、角色、蜂群工具
  ext/        instructions、audit（影子 git 检查点）、skills、memory、prompts、guard、hooks、rag、mcp
  ui/         store（按 agent 分片、30Hz 合批）、控制器、markdown、输入框、Mission Control
  cli/        管道模式、logs、mcp、doctor、init
```

设计文档：[docs/DESIGN.md](docs/DESIGN.md)；当前进度与交接说明：[docs/STATUS.md](docs/STATUS.md)；路线图：[docs/ROADMAP.md](docs/ROADMAP.md)。

## 开发

```bash
pnpm dev                 # 从源码运行（tsx）
pnpm test                # vitest（脚本化 provider + ink-testing-library，不依赖网络）
pnpm test:coverage       # 95 个文件 / 594 个测试；行与分支覆盖率见 STATUS.md
pnpm typecheck && pnpm build
pnpm tsx scripts/smoke.ts deepseek:deepseek-chat "hi"   # 只冒烟 provider 层（需要真实密钥）
```

自动化终端验收覆盖 40×10、60×16、80×24、120×40，运行中缩到 25×8，以及 2000 行流式输出和 20-agent 负载。Windows Terminal / conhost 的真实 IME 候选框和 Shift+Enter 仍需人工验收；供应商认证、端点和请求参数使用受控测试，未对用户的在线账户发起请求。Mem0 / embeddings 使用受控 HTTP 测试。
