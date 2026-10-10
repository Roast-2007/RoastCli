# RoastCli 设计

面向贡献者，说明各模块如何分工、关键机制怎么实现，以及改代码时需要守住的约束。用法见[使用指南](USAGE.md)，开发流程见 [AGENTS.md](../AGENTS.md)。

## 目标

1. **上下文不丢失**：旧内容折叠成占位符而不是删除，模型可以用 `recall` 取回原文；上下文变换尽量少地改动发给供应商的前缀，以保持缓存命中。
2. **Hive 优先**：任务和策略是独立入口，默认 Deck 指挥 Queen、Lead、Worker 和只读专家通过消息、黑板与 worktree 协作。等待子任务时不发请求、不消耗 token，Chat 保留单 agent 工作面。
3. **可重放**：模型看到的一切都先写入日志。恢复会话时重放日志，得到与当时完全相同的请求。
4. **终端体验**：在小窗口、中文输入、慢速终端和 Windows 控制台中都能正常使用。

## 模块

| 目录 | 内容 |
|---|---|
| `src/entrypoints` | CLI 入口，命令行参数解析 |
| `src/cli` | 子命令：doctor、init、logs、mcp、trust、worktrees、管道模式 |
| `src/core` | 消息和流的类型、错误分类、分层配置与信任、凭据、路径工具、EventHub、InteractionBroker |
| `src/agent` | 会话装配（`session.ts`、`session-assembly.ts`、`*-setup.ts`）、运行时、step、工具调度、system prompt |
| `src/session` | 事件类型、日志写入、history reducer、恢复 |
| `src/context` | 上下文状态、视图投影、策略、调度、摘要、recall |
| `src/providers` | 供应商无关的流协议，OpenAI 兼容与 Anthropic 两种驱动，模型发现，并发调度 |
| `src/tools` | 工具抽象与执行管线、内置工具、权限引擎 |
| `src/swarm` | 蜂群：supervisor、消息、黑板、租约、worktree、策略、任务简报、模型路由 |
| `src/ext` | 项目说明、skills、MCP、hooks、记忆、代码检索、prompt 覆盖、注入检查、检查点 |
| `src/ui` | Ink 界面：store、Chat、`hive/` 指挥台、输入框、Markdown、配置向导 |

## 基本约束

1. **日志是唯一的事实来源。** 所有状态变更都通过 `Committer.commit(ev)`（`agent/committer.ts`）：先写日志并分配 `seq` 和 `agentId`，再交给 reducer。实时运行和恢复使用同一个 reducer。
2. **只记录决策，回放时不重新计算。** 折叠、压缩、授权、模式切换、模型切换都作为事件写入日志，恢复时直接回放，不重新执行策略。
3. **请求可重放。** 每次请求都写入 `request/digest`，其中 `viewHash` 是发给模型的视图（`buildView(state)`）的 hash。测试辅助函数 `replayMismatches` 重放日志，逐一比对。新增 reducer 或视图变换都必须保持这一点。
4. **工具调用和结果成对出现。** 中断、出错、崩溃、恢复、折叠都不能破坏配对。测试用 `pairingErrors` 检查。
5. **工具列表在会话启动时确定。** 内置工具加上 MCP 工具在启动时注册，之后不再变化，子 agent 也共用这一份。plan 模式、只读角色等限制由权限引擎拒绝并说明原因，而不是移除工具，这样 system 和工具 schema 组成的前缀不会变。
6. **等待关系只能是父等子。** 只有父 agent 能阻塞等待自己的后代，所以等待关系总是一棵树，不会出现死锁。同级 agent 之间只能异步通信。

## 运行时与日志

### Turn 循环

`AgentRuntime`（`agent/runtime.ts`）的 `run(input)` 接受普通文本或 `MissionInput`，把输入放入队列并驱动循环。每个 turn 由若干 step 组成，主会话最多 `maxSteps` 个（默认 100），子 agent 使用独立的 `swarm.maxSteps`（默认 150）。每个 step：

1. **边界处理。** 从第二个 step 起投递排队的用户消息；`beforeRequest` 钩子执行上下文维护（折叠、压缩），并注入附件，比如蜂群的收件箱。
2. 最后一条消息来自 assistant 时说明没有新内容，turn 结束。
3. **构建请求。** system 或工具 schema 变化时写入快照事件，然后写入 `step/start` 和 `request/digest`；开启调试日志时还会写入完整请求体 `request/body`。
4. **请求模型。** `runStep`（`agent/step.ts`）流式消费供应商返回的 chunk，由 `assembler.ts` 聚合成一条 assistant 消息。可重试的错误（限流、服务端错误、网络错误）按指数退避重试，最多 4 次，间隔 1–30 秒加 ±20% 抖动，服务端的 `retry-after` 最多遵守 120 秒；每次重试写入 `step/retry`。如果重试前已经输出了部分内容，界面会收到 `stream-reset` 清掉这部分。
5. **提交结果。** 写入 `assistant/message`。有工具调用时进入工具阶段（`tool-phase.ts`、`tool-calls.ts`），否则进入 `decideEndOfTurn`，在蜂群中可能转为等待。

收到 `CONTEXT_WINDOW_EXCEEDED` 时，运行时调用 `onOverflow` 强制压缩，并用同一个 step 编号重试一次。

预算提醒在 boundary 经 `attachment/injected`（source 为 budget）进入历史：上限至少 20 时剩五步提醒，否则剩两步提醒，最后一步再要求结束或 report。剩余预算包含当前步骤，每种提醒每 turn 一次，history reducer 记录 turn / step 标记，溢出重试、恢复和回退按日志重建。内部附件不进入 UI 或 logs show 的显示投影。子 agent 的英文角色卡包含预算；提醒不改 system 或工具 schema 前缀。

### 工具执行

`tools/executor.ts` 的管线是：preExecute 钩子 → zod 参数校验 → `validateInput` → `execute` → postExecute 钩子。主会话的 preExecute 钩子依次是：用户的 PreToolUse 钩子 → 权限检查 → 文件租约 → 检查点（`agent/session-assembly.ts`）。子 agent 在权限检查之前还有 worktree 守卫和角色守卫（`agent/swarm-setup.ts`），守卫检查的是 PreToolUse 钩子改写之后的实际参数。

`read`、`edit` 共享文件状态（`tools/fs-state.ts`）：edit 要求文件在本会话中先被 read 过，并且之后没有被外部修改（按内容 sha1 判断）。写类工具的公共逻辑在 `tools/file-ops.ts`，写回时保持原来的换行风格。

### 日志

- 路径为 `<logsDir>/<YYYYMMDD>/<runId>/log.jsonl`，写锁文件是 `log.jsonl.lock`。`logsDir` 默认为 `logs`，相对于会话的工作目录。
- 首行是 `{type: 'session', version: 1}` 头，之后每行一个事件，都带 `seq` 和 `agentId`。事件类型定义在 `session/events.ts`。
- 同一个 tick 内的事件用 `setImmediate` 合并成一次 `appendFileSync`。进程退出时，exit hook 写入剩余事件并释放锁。
- 子 agent 的日志在同一目录下的 `agents/<agentId>.jsonl`。
- Hive 界面与协作状态在同目录的 `hive.jsonl`，主日志事件类型不变，0.5.0 可继续读取 0.5.1 主日志。

### History reducer

`session/history.ts` 把事件流折叠成模型可见的 `Message[]`：

- 连续的用户内容合并成一条 user 消息；
- `hive/mission` 与 `user/message` 共用追加分支，模型内容取日志中的 brief，合并规则完全相同；
- 同一个 `turn:step` 的工具结果合并成一条；
- attachment 追加到最后一条 user 消息，如果最后一条不是 user 消息就新建一条；
- 每个 `turn/start` 记下该 turn 开始前的消息列表（不可变引用，开销很小），`rewind` 时恢复到目标 turn 的那一份。

上下文状态（折叠、压缩、钉住）也由这个 reducer 维护，见[上下文引擎](#上下文引擎)。

### Hive 任务事件

`hive/mission` 取代任务的那条 `user/message`，记录 `turn`、`at`、`missionId`、`goal`、`strategy`、`n`、`brief`，以及可选的 `readOnly` 和 `images`。history reducer 把 brief 文本和图片拼成同一条 user 消息，显示投影用 goal 加图片；没有 `images` 的旧日志行为不变。任务编号 m1、m2……由运行时在会话内递增，恢复后继续计数。brief 渲染一次后写入日志，恢复时不重新读取策略或渲染简报。

模型读取完整 brief，UI reducer、transcript 和 `logs show` 投影原始 goal；stream-json 保留任务事件。简报是 user 内容，不加入 system。Deck / Chat 切换只改变 UI，不改 system、工具 schema 或历史前缀。`listTurns` 与抽取式摘要提取 brief 中的 `<goal>`，避免把策略指令当成用户目标。

`UserPromptSubmit` 收到原始 goal 和 hive 元数据，可以拦截；hook 输出和检索上下文附加到 brief 后提交，goal 保持不变。`attachment/injected` 收件箱和内部检索附件不作为对话内容显示，未提交的 raw chunk 不参与恢复后的 UI 重放。

### 恢复

`session/resume.ts`：

- 日志末尾写了一半的行在打开时截掉，读取时也能容忍。
- 没有结果的工具调用补上合成结果，保持配对。
- 写锁被仍在运行的进程持有时，分叉出一个新的 run，不和原进程抢写同一个文件。
- 旧版（v0）日志通过 `history/import` 事件导入。
- 同时重建文件读取状态和权限授权。
- 0.5.0 接受已有 0.4 日志；含新 `hive/mission` 事件的日志不能由旧版程序读取。

`Session.displayEvents()` 合并恢复源日志与本进程 committer 已提交的事件，跳过用于导入模型历史的 `history/import`，避免覆盖原始显示。分叉的 import 可选字段 `fromSeq` 固定来源水位，`turn` / `turnStarts` / `missionSeq` 保存轮次快照与任务编号（`turnStarts` 按引用去重为消息池加下标，体积随消息数线性增长），支持新日志的重放和原轮次回退；旧程序可忽略这些字段。

界面不重放 raw chunk 或内部 attachment。流式文本只有提交成功才进入模型历史；中断的文本单独写 Hive partial，UI 在该 turn 的结束小结之前显示 Markdown 和弱化标记“（已中断，未发送给模型）”，Queen 与子 agent 相同。子成员 partial 可带 `agentTurn`，主 turn 用于全体回退，子 turn 用于成员界面定位。projection 和请求摘要比对不读取 partial。

### Hive 日志与成员恢复

`swarm/hive-journal.ts` 对 `<runDir>/hive.jsonl` 单写者同步追加，写失败仅降级；每行 `v: 1`，读取跳过坏行、未知版本和 type。记录为：

| type | 字段与用途 |
|---|---|
| `board` | `turn, entry`，成功的黑板写入，包含计划与 `/reports/<id>` |
| `message` | `turn, envelope, recipients`，与 UI 同源，按 envelope.id 去重 |
| `partial` | `turn, agentId, text, at`，未提交的中断文本；子成员可带 agentTurn |
| `rewind` | `toTurn, at`，丢弃 turn ≥ toTurn 的协作状态 |
| `snapshot` | `turn, board, messages, partials`，分叉恢复后的初始状态 |

`turn` 为 supervisor 观察 `turn/start` 后的 Queen 当前轮次。按顺序折叠记录，snapshot 替换当前积累状态，rewind 删除目标轮次及之后的记录；board 取每个 key 最新 entry，保留 version / author / at；messages 返回最近 50 条。snapshot 的 board 和 messages 保留带原 turn 的历史记录，才能在新 run 再次回退到旧版本。`Blackboard.restore` 整体替换而不触发 watch 或写监听，Queen 工具与计划页读取同一份重建结果。

`session/hive-restore.ts` 从来源 run 的主日志及 `agents/*.jsonl` 配对 spawn_agent 调用与成功结果，得到 parentId、role、brief、taskId 和 spawnTurn，孙辈继承父的 Queen spawnTurn。header 给出模型与开始时间，最后成功 report 或 turn/end 推导 done / failed / cancelled；自动报告从 Hive 黑板 `/reports/<id>` 恢复，partial 对应 done 成员状态，缺 Hive 记录时 max-steps 仍推导为 partial；无结束记录视为 cancelled。缺少 spawn 时按 id 前缀推角色并归属 Queen，损坏子日志跳过。父链计算 depth 和 children，不恢复 worktree。分叉链沿原目录读取，不能改读新目录的空 agents。

恢复成员只进入 UI 合并树与历史 view，live 同名数据优先，不放入 supervisor recs，不占 maxAgents，也不可路由、暂停、取消或合并。id 序号同时读取来源日志与恢复成员，回退不降低水位。费用仍按原模型与事件计价，来源主日志和子日志只观察一次，回退不退款。

## 权限与检查点

### 组件

| 文件 | 作用 |
|---|---|
| `tools/permissions/bash-parse.ts` | 启发式解析 shell 命令：引号（双引号内的反斜杠按 bash 规则保留）、`;` `&&` `\|\|` `\|` `&`、换行、`$()` 和反引号、写文件的重定向（不含 `2>&1` 和 `/dev/null`），并标记从管道读取输入的段。维护只读命令白名单和高危命令模式 |
| `tools/permissions/rules.ts` | 规则 `Tool` 或 `Tool(pattern)`。bash 支持整词前缀 `prefix:*`、精确匹配和 `*`；路径用 picomatch，相对路径相对 cwd；网络用 `domain:`，包含子域名；工具名可以含 `*` |
| `tools/permissions/engine.ts` | 决策逻辑，见下文 |
| `tools/permissions/auto-risk.ts` | 帮我审批的离线风险判断入口与拒绝身份 `denialKey`。`auto-bash.ts` 分析 bash（跟踪 cd，展开 `$()`、`bash -c`、`powershell -Command`、`cmd /c`、`find -exec`、`xargs` 和 npx / pnpm exec 等包运行器，去掉 env / nohup / timeout / cross-env 等包装；交给 cmd 和 PowerShell 的内层文本先加倍反斜杠再分词），`auto-commands.ts` 按命令名匹配规则表，`auto-writes.ts` 找出删除、移动、复制、解压和下载的写入目标，`auto-paths.ts` 解析路径并判断工作区外、敏感文件与凭据。除了首次读取一次临时目录的长路径，全部是纯计算，不调用模型 |
| `tools/permissions/hook.ts` | 接入 preExecute：允许、拒绝或经 broker 询问用户，可以记住授权。帮我审批的询问带倒计时，超时与明确拒绝分别反馈给模型。没有界面时直接拒绝并说明原因 |
| `tools/permissions/settings.ts` | 规则来源：用户配置、`~/.roast/projects/<hash>/settings.json`（hash 为规范化 cwd 的 sha1 前 16 位）、仓库配置（allow 需要信任，deny 和 ask 始终生效）。从日志恢复授权与帮我审批的拒绝记录 |
| `core/interaction.ts` | InteractionBroker：处理权限和提问两类请求，维护待处理队列，支持取消。没有订阅者时返回 `unavailable`。带 `countdownMs` 的请求在界面调用 `shown` 后开始计时，到时以 `timedOut` 拒绝，`hold` 暂停 |
| `ui/components/InteractionCard.tsx` | 审批和提问卡片；挂载时通知 `shown`，卡片上的按键和点击通知 `hold` |

### 决策顺序

deny → plan 模式（只放行只读和交互类工具）→ 高危强制询问 → 只读角色强制询问 → yolo → allow → ask → 默认策略。auto 模式用离线风险规则代替默认策略：命中规则询问，其余放行。

以下请求属于强制询问，yolo 模式和 allow 规则都不能跳过：

- 匹配高危模式的 bash 命令，以及目标在 `.git/` 或 `.roast/shadow.git` 内的编辑类请求（bash 命令不做这项路径检查）；
- 只读角色发起的执行请求，除非是能确认只读或验证的 bash 命令。

复合命令的每一段都必须匹配 allow 规则或是只读命令，并且不能包含子 shell；deny / ask 对完整命令及各段匹配。引号感知分词保留原文和值，匹配与只读判断去掉连续的环境变量赋值，危险检查使用完整原文。单独 cd 只改变目录，后续每段独立判断。建议规则跳过已放行段，取命令与合法的未加引号子命令去重；permissionHook 逐条 grant、落日志与持久化，InteractionCard / KeyBar 显示同一组规则。强制询问的卡片只提供"允许一次"和"拒绝"。worktree 普通 ask 显示执行根目录且可保存授权；readRoots 包含主 cwd 和本 run 的 worktree 根，只影响读取请求。

默认策略：交互类工具放行；工作区内读取放行，工作区外询问；修改文件询问（acceptEdits 模式下工作区内放行）；只读命令放行，其他命令询问。

### 帮我审批（auto）

- 风险规则只补充默认策略之后的判断，deny、plan、强制询问和 allow / ask 规则的位置不变，所以 allow 规则能豁免扩展清单，但豁免不了强制询问。
- auto 模式下引擎给所有 ask 结果附上 `denialKey`。bash 用 `commandText` 规范化后的完整命令；edit 和 read 类请求用规范化路径（edit、write、multi_edit 共用同一个身份）；其他请求用工具名加目标，没有目标时用键排序后的参数 JSON。
- 用户明确拒绝后，hook 调用 `engine.rememberDenial` 并写入 `{type: 'permission/deny', key}`。之后 auto 模式下身份相同的 ask 直接变成 deny，其他模式不受影响。恢复会话时从日志折叠出拒绝记录；rewind 不撤销拒绝记录，与授权的处理一致。
- 倒计时由 broker 维护，界面不计时，只负责显示。界面显示卡片后才开始计时，所以排队中的请求不会提前超时。卡片在作答前卸载（切换工作面，或 Deck 把另一条审批提到最前）会调用 `hold` 暂停，所以看不见的审批不会被超时拒绝。controller 刷新审批列表时保留界面上的顺序。超时以 `timedOut` 拒绝，不写拒绝记录。
- 风险规则看不到脚本文件的内容，也看不到 `node -e` / `python -c` 内联代码的含义。auto 模式和 yolo 一样在每条 bash 前打检查点，工作区内的改动可以用 rewind 恢复。

### 检查点与回退

代码在 `ext/audit/`。

- `checkpoints.ts` 作为 preExecute 钩子，在每个 turn 第一次执行会修改文件的工具前打快照，写入 `{type: 'checkpoint', turn, hash}`。yolo 和 auto 模式下每条 bash 命令前都会打快照，因为无法可靠判断命令是否会改文件。
- `shadow-git.ts` 使用影子仓库：`git --git-dir <cwd>/.roast/shadow.git --work-tree <cwd>`。初始化时设置 `core.autocrlf=false`、`core.longpaths=true`、`core.quotepath=false`、`commit.gpgsign=false` 和用户信息，`info/exclude` 写入 `.roast/`、`node_modules/`、`.git/`、`logs/`、`*.log`，项目的 `.gitignore` 同样生效。快照是 `add -A` 加 `commit -q --allow-empty --no-verify`。
- 恢复时先给当前状态打一个回退前快照，删除目标快照之后新增的文件，再执行 `checkout <hash> -- .`（目标树为空时跳过）。
- `file-snapshots.ts` 在 git 不可用或初始化失败时使用。快照按字节保存为 `.roast/snapshots/<uuid>.json`，保留二进制内容和 CRLF；跳过符号链接和 junction、依赖、日志和 Roast 自身状态；累计超过 128 MiB 时报错。恢复时同样删除快照中没有的文件。
- `rewind` 事件为 `{type: 'rewind', toTurn, checkpoint?, backup?, deleted?}`。对话按 history reducer 记下的 turn 起点恢复；文件使用 turn 编号不小于目标的最早检查点恢复。turn 编号之后继续递增，不复用。
- 回退后，文件读取状态以文件内容的 sha1 为准，不一致时 edit 会要求重新 read。

没有 worktree 且 cwd 与主工作区相同的成员，在写类工具执行前复用主 CheckpointManager，以 Queen 当前 turn 串行创建首个基线；多个成员并发只快照一次，checkpoint 写主日志。worktree 的检查点仍独立，合并经过主检查点。主模型和所有子成员空闲才允许 rewind。成功后追加 Hive rewind、重建黑板和消息、移除该轮次起派生的终态成员及 UI diff 缓存，并用 displayEvents 重放 Queen。store.restore 从当前 nextId 继续分配显示 id，保证 `/clear` 的 Static 水位不会隐藏重放内容；未合并 worktree 留给退出清理，id 不复用。

## 上下文引擎

代码在 `src/context/`。

### 状态与视图

上下文状态（`state.ts`）随 history reducer 一起维护：

```ts
interface ContextState {
  elided: Record<string, { reason: string; preview?: string; tokens?: number }>; // key 为工具调用的 callId
  compaction: { upTo: number; summary: string; seq: number } | null;               // 最近一次压缩
  pinned?: Record<string, true>;                                                   // 钉住的工具结果不会被自动折叠
}
```

变换都以事件写入日志：`context/transform` 的操作有 `elide`、`unelide`、`pin`、`unpin`；`context/compact` 记录 `upTo`、`summary`，以及可选的 `focus`、`auxUsage`、`auxModel`。只有工具结果可以被折叠。

`buildView(state)`（`view.ts`）生成发给模型的消息：

- 被折叠的工具结果只替换内容，block 本身保留，所以配对不变。存根格式：

  ```
  ⟦ctx:<callId>⟧ <工具名> 的结果已折叠（约 N tokens，<原因>）。需要原文时调用 recall({"handle":"<callId>"})。
  ```

  aging 折叠的结果在后面附头尾预览。
- 压缩后，`messages[0, upTo)` 被摘要替代。摘要包在 `<summary>` 中，放在切点处 user 消息的开头。切点总在 user 文本消息之前，所以不会切断工具调用。

### Token 估算

`estimator.ts`：CJK 字符每个算 1 token，其余文本每 4 个字符算 1 token，每个 block 和每条消息各加 4，图片按 1500 计。有了真实用量之后，以最近一次请求的 `input + cacheRead + cacheWrite` 为锚点，再加上之后新增内容的估算值。估算偏差用校准系数修正（EMA，α = 0.3），只保存在当前会话的内存中。

### 策略与调度

策略（`policies.ts`）是纯函数，只给出候选：

- **dedup**：同一文件之后又被成功读取或修改时，折叠更早的 `read` 结果。出错和钉住的结果不动。
- **aging**：`agingTurns`（8）个 turn 之前、不少于 `agingMinTokens`（2000）tokens 的工具结果，折叠并保留头尾各 `previewLines`（20）行。
- **chooseCut**：选择压缩切点，保留最近 `keepTurns`（3）个 turn。切点必须在带用户文本的 turn 开头，并且在上一次压缩的位置之后。

`ContextController`（`controller.ts`）通过 boundary 钩子接入运行时，在每个 step 前决定是否应用：

- **折叠**：节省量不少于 `minSavings`（4000 tokens，每个存根按 60 tokens 扣除），并且满足以下之一：占用超过 `elideAt`（窗口的 70%）；或距离上次请求超过 `cacheTtlMs`（5 分钟，此时缓存已冷，改写前缀没有代价）且占用超过 `elideAt` 的 80%。不满足时先攒着，避免频繁改写前缀。
- **压缩**：占用超过 `compactAt`（80%）时执行。
- **溢出**：强制折叠，并以 `keepTurns: 1` 压缩，然后由运行时重试一次。

所有参数都可以在配置的 `context` 中覆盖。

### 摘要

`model-summary.ts` 默认从已配置且有定价的模型中选 input + output 单价最低的一个（同价按名称排序），没有定价信息时用当前主模型；供应商未受信任时直接用抽取式摘要。`context.summaryModel` 可以是 `provider:model`、`auto` 或 `extractive`。模型调用失败时退回 `compactor.ts` 的抽取式摘要，内容包括用户请求、涉及的文件、命令、错误和最近 3 条结论。`auxModel` 在回退时也会记录，摘要的费用单独计入账本。

### recall

`recall-tool.ts`：

- 按句柄（`callId` 或 `msg:<序号>`）取回原文，作为新的工具结果追加。原来的存根不动，以免改写前缀。
- 按关键词检索当前会话的完整历史，包括已折叠和已压缩的部分。按命中词数和出现次数排序，返回 160 字符的片段和句柄，默认 5 条，最多 20 条。
- 单次输出最多 5 万字符。

### 前缀缓存

- 运行时为每次请求计算 `cacheKey = hash(cwd, provider, model, systemHash, toolsHash)`，并与上一次请求逐条比较消息的 hash，得到仍然相同的前缀长度 `cacheBoundary`。
- Anthropic（`providers/anthropic/request.ts`）默认开启缓存，`promptCaching: false` 关闭。断点打在 system、最后一个工具、`cacheBoundary` 处的消息和最后一条消息上，跳过 thinking block。
- OpenAI 兼容（`providers/openai-compat/adapter.ts`）：`api.openai.com` 自动发送 `prompt_cache_key`，其他端点需要 `promptCaching: true`。
- `/context` 显示按 token 加权的命中率、请求次数（含重试）和前缀变化次数（transform、compact、rewind 事件的数量）。

### 推理内容回传

- Anthropic 回放所有带签名的 thinking 和 redacted thinking，丢弃没有签名的。
- OpenAI 兼容按模型的 `reasoningReplay`：`drop`（默认，不回传）、`field`（用 `reasoning_content` 字段回传全部历史，前缀稳定）、`current`（只回传当前 turn）、`inline`（拼进正文，旧行为，不推荐）。
- DeepSeek 的 `prompt_cache_miss_tokens` 算作普通输入，不算缓存写入。

## 供应商

代码在 `src/providers/`。

- `adapter.ts` 定义供应商无关的接口：输入消息和工具，输出统一的 `StreamChunk` 流。`openai-compat/` 和 `anthropic/` 各自包含 adapter、config、request、sse、translate。
- `registry.ts` 按配置创建 adapter，并用 `scheduler.ts` 包装。
- 推理强度：OpenAI 兼容发送 `reasoning_effort`，Anthropic 发送 `output_config.effort`；`null` 表示清除配置中的默认值，不发送参数。
- 请求设置 `redirect: 'error'`，不跟随重定向；接口返回的错误正文不写入界面和日志。`idle.ts` 在流长时间没有数据时终止请求。
- `models.ts` 负责模型发现，`endpoints.ts` 拼接地址（Anthropic 地址不以 `/v1` 结尾时自动补上）。超时 10 秒，内存缓存 5 分钟，最多 20 页。
- `presets.ts` 是配置向导的预设列表。

### 模型价目

`providers/pricing/` 用 zod 校验 version 1、USD / 1M tokens 格式的 catalog，JSON import 将内置数据打入 bundle。`resolvePricing` 优先模型配置、用户 pricing.json、较新的下载 / 内置 catalog 的 host 与模型匹配，最后是精确模型参考价（可剥离 vendor/ 前缀）。模型通配不区分大小写，未配置 baseURL 不匹配 host；用户无 hosts 条目可覆盖任意端点。缺价返回 undefined，费用账本保持未知总价。

用户文件仅从 roastHome 读取，按进程缓存；无效文件忽略并供 doctor 诊断，测试可注入 PricingData / PricingLookup。发现模型仅解析 OpenRouter 明确的 per-token pricing，转换到 per-million，配置 spread 优先级保护已有价格。UsageCost、摘要选择、Queen 路由和模型面板共用解析器，账本按原 provider / model / agent / turn 分别记录来源，/cost 与 Deck 用量页标注配置、用户、catalog 日期或参考价。

`roast pricing` 提供 list / --all / path；update 是用户主动触发的 GET，10 秒、redirect error、1 MiB 上限，校验成功后 wx 临时文件加 rename 原子替换下载价目，失败不覆盖旧文件、不输出远端错误正文。启动不自动联网取价，包 files 白名单不扩大。

### 并发调度

`scheduler.ts` 按供应商共享并发名额，主会话和所有子 agent 都从这里排队（FIFO）。上限是 `maxConcurrency`，默认为 16 和 `maxAgents + 1` 中较小的一个。实际并发采用 AIMD：最多从 4 开始；遇到 429 减半，并按 `retry-after`（没有时 1 秒）冷却，整个供应商共享冷却；连续成功 10 次后加 1。等待名额的过程可以中断，执行工具和等待子 agent 时不占用名额。

## 界面

代码在 `src/ui/`。

### 渲染

- `screens.ts` 的 `runInteractive` 只创建一个 Ink 实例（alternate screen、`maxFps` 30、`incrementalRendering`、kitty 键盘协议自动检测），通过 `rerender` 在 Hive Deck、Chat（`FullScreen.tsx`）和会话内的配置向导之间切换。首页取 `ui.home`，默认 hive，CLI 可以覆盖。store、controller 和两个工作面的独立编辑器草稿在切换时保留。首次配置向导和信任确认在此之前用单独的 `render()` 显示，旧 Mission Control 已删除。
- 对话界面的标题、输入框和状态栏固定，中间是按行滚动的视口。`output-rows.ts` 共享 `OutputRow {spans: Span[]; callId?: string}`，Markdown 由 `markdown/rows.ts` 通过 marked 解析，代码块高亮映射主题。工具摘要、diff、错误和 live 行带各自 callId，其他行不带；WeakMap 按不可变消息对象缓存，签名含 width / ascii / spacing / compact。compact 段落间距为 0，只保留工具摘要、两行 live 尾部和一行错误；非 compact 保持 Chat 的 diff 预览。`transcript.ts` 保留兼容导出，`OutputLine` 共用 spans 绘制，所有外部文字经过 terminalText。
- `viewport.ts` 统一读取窗口尺寸，所有布局接收 `columns = max(1, rawColumns - gutter)`、`rows = max(1, rawRows - 1)`；底部一行避免 Windows 控制台滚屏。`ui.gutter` 为 0–4，默认 2，`ROAST_GUTTER` 优先，rawColumns <30 时归零。根容器和浮层使用扣留白后的尺寸，输入与审批优先。
- `resize.ts` 为各 Ink 实例监听任一维度的 resize，防抖 60ms；等待绘制完成后丢弃输出缓存、写清屏序列并 rerender 原树。Ink 7.1.1 的公开 `clear()` 会把旧输出重新同步进缓存，不能强制重绘，因此版本相关的私有实例映射与缓存适配集中在此处，并移除 Ink 同步绘制旧尺寸树的 resize 监听。尺寸 hook 继续更新，根不 remount；偏移在渲染时夹紧，草稿、焦点、页签、浮层与动画时钟保留。
- `App.tsx` 中还保留了旧的 inline 模式（`<Static>` 加水位线），只在 `fullScreen` 为假时使用，目前生产代码不走这条路径，主要用于测试和嵌入。

### Hive Deck

新 UI 按功能放在 `src/ui/hive/`：

| 文件 | 作用 |
|---|---|
| `Deck.tsx`、`layout.ts` | 编排、键盘路由，三栏 / 两栏 / 单栏和矮屏高度分配 |
| `ColonyPane.tsx`、`MissionPane.tsx`、`SignalsPane.tsx`、`Pane.tsx` | 蜂群树、任务页、信号和按显示宽度滚动的通用面板 |
| `plan.ts`、`phase.ts` | 纯函数解析计划、关联 taskId、推导任务状态与结果 |
| `plan-view.ts`、`PlanZoom.tsx`、`ZoomPane.tsx` | 计划 / 待办预换行、独立详情导航、共享整宽渲染 |
| `focus.ts` | 四焦点循环和成员指示解析 |
| `diffs.ts`、`usage.ts`、`lines.ts` | 改动缓存、任务费用聚合和输出行投影 |
| `Ignition.tsx`、`honeycomb.ts`、`wordmark.ts`、`ignition-frame.ts`、`ignition-paint.ts` | 900ms 全窗口蜂巢、几何缓存、精确字标、逐格帧与直写差分绘制 |
| `hitmap.ts`、`deck-mouse.ts`、`AgentMenu.tsx`、`tabs.ts` | 共享布局命中、指针路由、成员菜单和页签几何 |
| `Guides.tsx`、`DeckHelp.tsx`、`components/KeyBar.tsx` | 空状态、专属帮助和 Deck / Chat 共用的可点击键位提示 |
| `status.ts`、`interrupt.ts`、`QueueLine.tsx` | 统一状态栏、Ctrl+C 状态机与排队条 |
| `terminal-effects.ts` | TTY 通知和标题的单一生命周期 |

焦点默认 input，输入框中的 Tab 只补全，无候选时保持焦点；Shift+Tab 只在输入框切权限模式。F6 / Shift+F6 正向 / 反向循环 input → colony → mission → signals，缺少信号栏时跳过；Ink Key 不保留功能键名称，因此 `function-keys.ts` 监听原始序列。面板内 Tab / Shift+Tab 切焦点，非面板快捷键的可打印字符回到输入框并插入草稿。聚焦边框用 accent，标题加方向标记。两个草稿独立保存完整 editor state，带 screen 的 inputSeed 只更新对应工作面，排队消息中断后恢复到输入框。

`hitmap.ts` 的 deckRegions 与绘制共用 deckLayout、paneMetrics 和页签显示宽度，反向查找让具体目标优先；蜂群按单行截断，计划用内宽预换行后的同一份 Line 计算绘制、滚动上限与命中。每个任务的头行和标题共享 plan-row target，滚动后的坐标只覆盖可见行，留白没有命中。点击成员、计划、页签、信号、策略与权限胶囊经既有 controller 操作；滚轮按指针下的面板路由，不改变成员或草稿。SelectPanel、InteractionCard 与 Chat 的可点击组件用真实 DOM 的绝对位置和可见高度，双击限定同一目标 400ms。

`ui.hints` 控制 full 引导、compact KeyBar 或 off。KeyBar 只取能完整放入的一组优先级前缀，高度不足 14 行时隐藏；Deck 命中图和 Chat DOM 坐标都对应实际显示项。点击提交复用 InputBox 的 Enter 处理，保留命令补全、历史搜索、换行和折叠粘贴展开；点击审批复用 InteractionCard 的选项及单次响应守卫，强制审批不提供持久授权。Chat 阅读位置和排队数量留在输入区，不随 hints 关闭而丢失。Deck 专属帮助经 Overlay 的 deck 标记分流。

Queen 用 `board_write` 写 `/mission/plan` JSON，`plan.ts` 接受 tasks 或顶层数组，只要求 id 与标题（数字 id 转字符串，标题别名回退）；可选字段补空，坏任务或重复 id 单独跳过，全无效才回退到成员行；`spawn_agent` / `task` 的 `task_id` 映射到 `AgentInfo.taskId`。状态来自成员 state / report，计划从 Hive 日志恢复。标题正文完整换行，小窗格最多三行并提示展开；计划下方追加 Queen 与选中成员的 todos，todo_write 结果 metadata 经 UI reducer 重放恢复，有待办即不显示空引导。

计划页 Enter 或双击任务 / 待办行进入整宽详情，纯函数生成完整标题、验收、依赖、成员和报告前三行以及所有待办。PlanZoom 保存页签 / narrow / 成员 / offset 与独立滚动位置，双击入口按 taskId 定位头行；详情中的 plan-member 双击切输出，其他行双击或 Esc 恢复原导航。共享 ZoomPane 保留输入、队列、审批和状态栏，键盘、滚轮、草稿转焦点与输出 zoom 一致，矮屏不进入。

Deck 输出页使用 paneMetrics 内宽生成 compact OutputRow，绘制、滚动上限与 hitmap 共用同一份 rows；Pane 对 rows 不二次换行。输出窗格双击或任务区 Enter 打开本地 zoom，替换 body 为整宽非 compact 输出，使用 Chat 留白和间距。zoom 的 start 与底部跟随独立于原窗格 offset，关闭详情或缩放窗口不丢阅读状态，退出保留页签 / 成员 / offset。compact 矮屏没有全屏入口。

`tool-nav.ts` 按显示顺序去重 callId 并使用最新状态；latestTool 保持运行中优先。Chat 按正文和左右留白计算鼠标行号，双击 tool:callId 打开对应工具，阅读时 Ctrl+O 选择视口最后一个工具。Deck 小窗格双击进入 zoom，zoom 中工具双击打开精确详情，其他行双击返回。详情在 `components/ToolDetail.tsx` 独立滚动，完整显示参数、diff 与结果，可切换工具，入口 callId 固定而同 callId 状态持续更新。Shift 点击和 mouse off 不处理；KeyBar / 状态栏点击仍用原组件路径。

通知存 UI meta.signals，不属于 main 显示条目；更新信号固定在信号栏顶部用 accent，启动警告与通知去重。界面回退重放不清除这些信号，重启时由启动检测重新填入。

`phase.ts` 依据当前任务所属 turn 推导计划中、执行中、整合中，以及 completed / aborted / error / max-steps 的结束标签。成员关联限制在该任务 turn 内，活跃派发阶段也识别新启动成员，避免后续 Chat turn 污染任务用量。任务用量按 turn、agent、provider / model 汇总既有账本；缺少定价时显示未知，不输出部分总价。

`swarm/diff.ts` 只读运行禁用 pager、外部 diff 和 textconv 的 git 命令；子成员用真实基线比较已提交、未提交和新文件，Queen 用工作区 git diff。不触碰索引、HEAD、检查点或文件。`diffs.ts` 在打开改动页后异步读取，支持 AbortSignal，缓存到成员状态变化；计划行使用已有缓存中的增删统计。输出有超时和大小上限，避免渲染线程同步调用 git。

审批预览在权限引擎得到 ask 后生成，不授予读写权限。`tools/permissions/preview.ts` 复用文件工具的状态检查和 diff 生成，只预览 cwd 内、读权限允许且状态有效的路径；直接子成员的合并显示 diffstat。审批卡最多展示 12 行，Ctrl+O 切换完整详情，bash 保留完整命令及强制询问原因。读失败、越界、UNC 或过大内容跳过预览，执行时仍走原权限和检查点管线。

通知和标题仅向 TTY 写出，`ui.notify` / `ui.title` 在配置合并时只接受用户层。auto 检测 Windows Terminal、iTerm、WezTerm、Kitty 的环境变量后用 OSC 9，bell 用 BEL；首次出现审批或运行至少 20 秒后结束时通知。OSC 2 标题每秒最多更新一次，renderer 退出时清理订阅、定时器并重置为 roast；切工作面不重复创建生命周期。

### Store

`store/store.ts` 把运行时的 UiEvent 缓冲 33 毫秒（约 30Hz）再批量提交：按 agent 分组，同一批中连续的文本和推理增量合并；turn 开始和结束、用户消息和提示会立即提交。组件用 `useSyncExternalStore` 订阅。

`store/reducer.ts` 维护每个 agent 的视图：用 `splitStreaming` 把已经完整的 Markdown 块提前定稿，让流式尾部保持短小；同一批中连续 3 个以上成功的 read、grep、glob、ls、search_code 会被分组。

### 输入

- `input/editor.ts` 是纯 reducer，按 grapheme 移动和删除（宽度计算在 `core/text-width.ts`，使用 `Intl.Segmenter`），支持 CJK、组合字符和 emoji 序列。`layout.ts` 的 `editorViewport` 负责软换行，视窗跟随光标。
- `input/cursor.ts` 把终端光标放到插入点，让输入法候选框跟随。
- `input/files.ts` 为 `@` 补全提供文件列表（tinyglobby，最多 2 万个文件），用自己实现的子序列打分做模糊匹配。
- `input/history.ts` 把输入历史存到 `~/.roast/projects/<hash>/history.jsonl`，保留 500 条。
- `mouse.ts` 仅开启 1000/1006，不开启移动或拖动报告。parseMouse 支持连续包、缺 ESC 的包、按下 / 释放、右键、修饰键与滚轮，每格滚动 3 行；释放与 Shift 按下不触发点击。`ui.mouse` 默认 true，`/mouse` 在共享 meta 中覆盖本会话设置，切换工作面仍有效；关闭和卸载时恢复报告模式。
- 外部文本（工具输出、Markdown、diff）显示前用 `core/terminal-text.ts` 清除终端控制序列。

### 主题与动画

- `theme.tsx` 定义语义色（accent、muted、success、warn、danger、diffAdd、diffDel 等）和四套主题。默认主题是 aurora，主色为 `#22d3ee → #3ddbd9 → #a78bfa` 渐变；ember 为 `#ff4e1a → #ff7a18 → #ffb347`。真彩色不可用时降级到 256 色或 16 色；`NO_COLOR`、`FORCE_COLOR=0` 或 `TERM=dumb` 时使用 mono。
- `components/useSpinner.ts` 让所有旋转动画共用一个 80 毫秒的计时器，没有订阅者时停止。`motion.ts` 处理面板的颜色过渡。`hive/Ignition.tsx` 取代 Startup，ASCII 蜂巢铺满视口，从中央王台向外点火，字标逐列显示，持续 900 毫秒后直接进入工作面；可跳过并传递可打印字符。reduced motion、TERM=dumb 或有初始任务时跳过，尺寸不足时降级为单行或 ROAST。
- 启动动画不经过 React / Ink 绘制：组件渲染 null，Ink 在动画期间不写任何输出；layout effect 按 16ms 节拍（Windows 计时器一个 tick，约 60fps）计算整帧，`ignition-paint.ts` 只把变化的格子写成光标定位 + SGR，每帧一次写入并包在同步输出（DEC 2026）中，stdout 有积压时跳过该帧。颜色按 `getColorDepth` 降级到 256 / 16 色，与 chalk 的换算一致；NO_COLOR 等只保留粗体与暗色。逐 span 生成 React 元素再经 Ink 布局，大窗口单帧就会超过帧预算，所以动画改为直写。
- 交接：动画卸载时 layout effect 的清理先于 Ink 渲染下一棵树执行，此时写入 `同步开始 + 清屏 + 光标归位`，Ink 随后的首帧是从光标处整屏写出，并以自己的同步结束收尾，所以清屏与工作面首帧在同一次同步更新内完成，最后一帧的任何格子都不会残留（Ink 只做行级差分，Windows 控制台已知会留下旧帧）。120ms 后补一个同步结束兜底；Ctrl+C 退出时不清屏。尺寸变化后 300ms 内整帧重绘，覆盖 resize 重绘写出的清屏。
- `honeycomb.ts` 是纯平顶六边形生成器：蜂房宽 L+2s、高 2s+1，原点为 x=c(L+s)+dx、y=2sq+(奇数列?s:0)+dy，共享边字符一致；四周多生成一圈再裁剪。按 XL / L / M / S 档生成，王台剔除交叠蜂房，选取正上方最近的完整蜂王格。几何按 columns、rows、tier 缓存，限制 8 项。
- `wordmark.ts` 的 Big 字标由 R/O/A/S/T 五块逐行拼接，每块间一空格，六行各 48 列。`ignition-frame.ts` 按归一化距离计算点火时间：光环从王台外沿立即出发，440ms 内扫过全窗，每格内部用 @/#/*/+/:/. 燃烧 180ms，轮廓随后经暗 accent 冷却回静止边框，约 18% 固定 hash 余烬只在冷却前半段出现；约 780ms 后全部稳定，最后一帧只有字标、副标题、信息行和蜂王格（最后绘制，共享边也点亮）带颜色。帧以逐格字符和样式表示，宽字符后一格为空串。标题版本取自 package.json。缩放只换几何，不重置 900ms 时钟；mono 仅用粗体与暗色。
- `terminal.tsx` 提供 ASCII、减少动画、gutter、mouse 和 hints 偏好；TERM=dumb 自动启用 ASCII 和减少动画。

### 命令

`commands.ts` 注册内置斜杠命令（`SlashCommand`：name、aliases、description、args、run）。`controller.ts` 分发输入时依次尝试：内置命令 → MCP prompt → skill。skill 命令会发一条用户消息，让模型调用 `skill` 工具加载它。

## 蜂群

代码在 `src/swarm/`。

| 文件 | 作用 |
|---|---|
| `supervisor.ts` | agent 树：派生、等待、取消、合并，以及子 agent 的 boundary 钩子 |
| `tools.ts` | 蜂群工具和角色守卫 `roleGuardHook` |
| `bus.ts`、`mailbox.ts` | 消息路由、限流、去重；收件箱和唤醒 |
| `board.ts` | 黑板 |
| `lease.ts` | 文件租约 |
| `isolation.ts`、`worktree.ts`、`dependencies.ts` | 隔离模式、git worktree、`node_modules` 复制 |
| `roles.ts`、`prompts.ts`、`strategies.ts`、`templates.ts`、`model-routing.ts` | 角色卡、共享提示词、任务策略、旧模板适配和模型路由 |
| `diff.ts` | 只读 worktree / 工作区改动审阅 |
| `watchdog.ts` | 无进展检测 |
| `types.ts` | 公共类型，如 `AgentInfo`、消息信封 |

`agent/swarm-setup.ts` 为会话创建 Supervisor，并定义子 agent 的运行时工厂。

### Agent

每个子 agent 有自己的 `AgentRuntime`、日志（`agents/<id>.jsonl`）和工具服务（文件状态、后台任务、待办）。所有 agent 共用同一份 system prompt 核心和工具列表，蜂群工具对所有 agent 可见，按角色限制使用；角色说明放在子 agent 的第一条用户消息中。这样不同 agent 的请求前缀相同，可以共享缓存。

子 agent 的 boundary 钩子：

- `beforeRequest`：把收件箱中的消息取出，渲染成 `<inbox>` 附件注入（事件为 `attachment/injected`，来源 `inbox`）。
- `onWouldEndTurn`：收件箱不为空时继续；还有在运行且没有 report 的子 agent 时等待；有未回答的问题时最多等 10 分钟。

状态有 running、waiting、paused、done、failed、cancelled。

### 消息与黑板

- 信封：`{id, from, to, kind, subject, body, refs, replyTo?, hop, at}`。`to` 可以是 agentId、`parent`、`children`、`siblings` 或 `role:<角色>`，广播只有 Queen 能用。
- `body` 最多 4000 字符，大块内容放在黑板或文件中，用 `refs` 引用。
- 只有 question、answer、steer、alert 和 report 会唤醒等待中的 agent，其他消息在下一个 step 边界送达。
- 每个发送者每分钟最多 30 条，hop 最多 4，按 `sha1(from|kind|subject|body)` 在最近 200 条中去重。
- 黑板是版本化键值存储，键形如 `/mission/auth/api-contract`。`board_write` 带 `expect_version` 时做 CAS，版本不匹配返回 `{ok: false, current: <版本号>}`。订阅者只收到"某个键已更新"的通知，正文需要用 `board_read` 拉取，这样通信内容不会自动塞进每个 agent 的上下文。成功写入追加 Hive 日志，恢复时整体重建，恢复动作不通知订阅者。

### 工具

| 工具 | 行为 |
|---|---|
| `spawn_agent({role, task, task_id?, refs?, model?, reasoning_effort?, isolation?})` | 派生子 agent，返回 agentId，task_id 用于计划关联 |
| `send_message({to, kind, subject, body, refs?, reply_to?})` | 发送消息；超限、路由不通或重复时返回原因 |
| `await_agents({ids?, mode, timeout_s})` | 阻塞等待子 agent（默认等全部，超时 1800 秒），等待期间不发请求。返回 `{reason, reports, pending}` |
| `report({status, summary, refs?})` | 向父 agent 报告，同时写入黑板 `/reports/<id>`。每个 agent 只能 report 一次，工具结果会要求模型结束本轮，但不强制。status 为 done、failed、partial 或 changes_requested |
| `merge_worktree({agentId, discard?})` | 由直接上级在子 agent report 之后调用，合并或丢弃它的 worktree |
| `board_write`、`board_read`、`board_list`、`board_watch` | 黑板操作 |
| `agents_status` | 查看 agent 树和状态 |
| `configure_swarm({models})` | 只有 Queen 可用，为未锁定的角色设置默认模型 |
| `task({prompt, role, task_id?, model?, reasoning_effort?})` | 派生一个一次性的 worker 或 scout，同步等待报告，支持计划关联 |

### 防失控

- **等待**：只有父 agent 能等待后代，问题等待有超时。
- **无进展检测**：连续 12 个已完成的 step 没有进展时提醒父 agent。进展指得到一个新的成功结果（按工具名、参数和内容的 hash 判断），或调用了产出类工具；出错的结果不算。模型重试、未完成的工具和等待用户授权不计入步数。
- **只读角色**：scout、critic、judge 的直接文件修改由 `roleGuardHook` 拒绝；它们的执行请求带上 `readOnlyRole`，除了能确认只读的 bash 命令，都由权限引擎强制询问。
- **只读任务**：supervisor 观察 turn/start、hive/mission 和 turn/end，在 readOnly 任务运行期间拒绝 worker / lead，返回“本任务为只读调研”；Queen 的写操作照常由权限引擎判断，turn 结束时清除任务标记。
- **上限**：`maxAgents` 是一次会话派生的 agent 总数（包括已结束的），`maxDepth` 是层级，`swarm.maxSteps` 是子 agent 每 turn 的步骤上限（150），`maxMinutes` 是单个子 agent 的有效运行时长，超时后取消它的子树。不限制 token。
- **用户等待**：broker.onChange 把任意未处理交互通知 supervisor。ActiveClock 用可注入 now 记录暂停区间，elapsed(since) 扣除交叠的用户等待时间；成员时限与 await_agents 都在暂停时撤销定时器、恢复时按剩余预算重设。
- **报告与进展**：未调用 report 的 max-steps / error / 正常结束分别生成 partial / failed / done，取消为 cancelled；保留最后一段非空 assistant 文本，不因工具开始清除，并附未完成待办、最多 30 个改动路径与续做建议。报告写黑板与父 inbox，partial 成员状态保持 done。事件观察点维护 steps / lastActivityAt / lastTool，await 超时说明成员仍在运行并返回 pending 进展，agents_status 同样展示。
- **取消**：父 agent 的 AbortController 上挂监听，递归调用 `cancelSubtree`。取消时为未完成的工具调用补上合成结果，释放租约，保留 worktree 供检查，并向父 agent 发送状态为 cancelled 的报告。

### 隔离

- **租约**（`lease.ts`）：会修改文件、且有明确目标路径的工具在 preExecute 时申请租约，冲突时返回持有者，提示 agent 发消息协商。主 agent 不受限制。租约在 agent 结束时释放。
- **隔离模式**：`spawn_agent` 的 `isolation` 可以是 `auto`（默认，worker 和 lead 在 git 仓库中使用 worktree，只读角色和非 git 项目共享工作区）、`worktree` 或 `shared`。`swarm.worktrees: false` 全局关闭 worktree。
- **基线**：父 agent 工作区的当前状态，包括未提交和未跟踪的改动，遵守 `.gitignore`，排除 `node_modules` 和 `.roast`。用临时索引执行 `read-tree HEAD` → `add -A` → `write-tree` → `commit-tree -p HEAD`，不触碰用户的索引、分支和 HEAD。所有文件按原始字节处理。
- **位置**：`<ROAST_HOME>/worktrees/<runId>/<agentId>`，detached HEAD，不建分支，不运行用户的 git 钩子。基线、runId、agentId 和占用进程的 PID 记录在 `<runId>/.metadata/<agentId>.json`。顶层 `node_modules` 复制一份（支持时用写时复制），pnpm 内部链接映射到副本，不共享可写的硬链接。副本 .modules.yaml 若为 JSON 且 virtualStoreDir 是源 node_modules 内的绝对路径，改写为对应副本绝对路径，保持字段、缩进与换行；非 JSON 或外部路径不动，源文件不改。
- **工作目录**：父 agent 的 cwd 在仓库中的相对位置，映射到 worktree 中的对应目录。守卫钩子拒绝编辑 worktree 之外的路径（包括通过符号链接逃逸），在原仓库路径被拒绝时提示对应的副本路径。
- **执行边界**：worktree 隔离的是 git 改动，不是操作系统沙箱，shell 和外部工具可能访问其他目录。executionRoot 继续由宿主传递以显示执行位置，命令与普通请求走同一权限链，yolo / allow / 会话与项目授权均生效，高危、只读角色、deny 和 plan 边界不变。
- **合并**：先给子 worktree 打一次树快照，用 `git diff-tree <基线> <子树>` 生成二进制补丁（固定路径前缀、禁用 textconv，不受用户 diff 设置影响），在父工作区执行 `git apply --check`，通过后才真正应用。有冲突时返回冲突文件列表，不会部分应用。合并按 edit 类工具处理，会打检查点，可以 rewind。
- **嵌套**：Lead 在自己的 worktree 中派生的 Worker，以 Lead 的 worktree 为基线，也合并回 Lead 的 worktree。
- 内部 git 调用都带 `core.autocrlf=false` 和 `commit.gpgsign=false`。
- **清理**：会话结束时删除没有改动的 worktree，有未合并改动或检查失败的保留并返回路径。`roast worktrees prune` 只删除当前仓库中已登记、不在使用、相对基线没有改动的 worktree。

### 策略与模型路由

策略（`strategies.ts`）是 Queen 简报中的 playbook，不是写死的编排流程，所有协作走同一套工具。内置 auto（默认）、fanout、best-of-n、critique（最多 3 轮）、research。`renderBrief` 按 missionId、goal、strategy、n、readOnly 和 playbook 拼接 `prompts.ts` 中的固定结构；英文共享提示词和角色卡要求用用户的语言回复，报告固定为 RESULT / CHANGES / VERIFY / RISKS / BOARD。

YAML 兼容 `~/.roast/templates/` 和 `.roast/templates/`，新增同级 `strategies/`，同一层内同名策略优先。字段为 name、description、playbook（兼容 prompt）、可选 n / readOnly，支持 `{{goal}}` 和 `{{n}}`；不合法文件跳过。未受信任的项目不能覆盖已有同名策略。`templates.ts` 只保留旧接口适配，生产任务入口用 MissionInput。`swarm.strategy` 默认 auto，`swarm.n` 默认 3。

strategyUsesN 根据 playbook 中允许空格的 n 占位符或 YAML n 判断，两步策略面板仅对使用 n 的策略显示 2–8 的并行数。当前策略保留会话 n，其他优先 YAML n，确认一次更新 strategy / n。文本命令支持名称加 n 或纯数字 n，非法输入不改变 meta。任务面板使用当前会话 n，Deck 标记与 `/status` 仅在 usesN 时显示 n，显式 n 对所有策略仍是 writer 并发上限。

模型路由（`model-routing.ts`）：用户指定的角色模型（配置的 `swarm.models`、`--role-model`，包括 `inherit`）优先且锁定。其余角色由 Queen 通过 `configure_swarm` 或在 `spawn_agent` 时指定，可选范围是已配置、受信任的模型，Queen 能看到它们的价格和上下文长度。都没有指定时跟随主会话。

### 自定义角色

`swarm/profiles.ts` 依次读取 `~/.roast/agents`、`<cwd>/.claude/agents`、`<cwd>/.roast/agents`，同名后者覆盖。项目未信任时跳过两个项目目录并报告数量，因为 profile 可以选择付费模型。`.claude` 来源按宽松模式解析：Claude Code 的工具名映射为 RoastCli 工具名，模型别名和未知工具静默忽略。

profile 清单在会话装配时渲染为 system 分段 `agents`（order 302），会话内不变；工具 schema 不随 profile 变化，全员相同，前缀缓存不受影响。profile 正文追加在角色卡的 duty 后，角色卡是成员的首条 user 消息。

- `spawn_agent` 的 `agent` 参数选择 profile，role 可省略，与 profile 冲突时返回工具错误。
- profile 的 model / effort 视为用户指定：优先于 `swarm.models[基础角色]`，Queen 传入不同值时报错；`inherit` 表示主模型。最终仍经 `modelFor` 校验 provider 已配置且受信任。
- 工具白名单由 `profileGuard` 在角色守卫之后、权限检查之前拦截，只能收窄基础角色的范围；协作协议工具始终放行。
- `AgentInfo.profile` 与 spawn_agent 结果 metadata 记录 profile，恢复时从 metadata 和调用参数重建；旧日志没有这些字段，按 id 前缀推断角色。

## 扩展

装配代码在 `agent/extensions-setup.ts`（skills、记忆、prompt 覆盖、注入检查、代码索引）、`agent/hooks-setup.ts` 和 `agent/mcp-setup.ts`。子 agent 共用工具（包括 MCP）、system prompt、扩展服务、PreToolUse/PostToolUse 钩子和注入检查；Stop 和 UserPromptSubmit 钩子只作用于主会话。

为了保持前缀缓存，启动时生成的内容（技能摘要、最近的记忆、SessionStart 输出、MCP 工具表）在整个会话中不变；会话中产生的新内容只通过工具结果或日志中的注入事件进入上下文。

system prompt 由 `agent/system-prompt.ts` 按 order 拼接：identity（0）、instructions（150）、environment（200）、swarm（300）、agent-models（301）、skills（320）、memory（330）、session-start（340）。

| 扩展 | 实现 |
|---|---|
| 项目说明 | `ext/instructions.ts`：用户级 `~/.roast/ROAST.md`，加上从 git 根目录到 cwd 每一层的第一个 `ROAST.md` / `AGENTS.md` / `CLAUDE.md`，总共最多 4 万字符 |
| skills | `ext/skills/`：解析 `SKILL.md` 的 frontmatter（name、description、allowed-tools）。来源优先级 `~/.roast/skills` < `.claude/skills` < `.roast/skills`，未受信任的项目不能覆盖用户级技能。摘要放进 system prompt，`skill` 工具返回正文 |
| MCP | `ext/mcp/`：基于 `@modelcontextprotocol/sdk`，按需动态加载，支持 stdio、streamable HTTP 和 SSE。工具的 JSON Schema 原样交给模型，参数由服务器校验。工具名 `mcp__<server>__<tool>` 只保留 `[A-Za-z0-9_-]`，超过 64 字符时截断并加 hash 后缀，重名的跳过，启动时按名称排序一次性注册。只有配置了 `trustAnnotations: true` 时才信任 `readOnlyHint`，否则按执行类工具处理。也支持 resources、URI 模板和 prompts |
| hooks | `ext/hooks/`：各配置层的钩子叠加，仓库层需要信任。JSON 从 stdin 传入（`integration.ts` 定义各事件的字段）。PreToolUse 在权限检查之前运行；PostToolUse 退出码为 2 时把 stderr 追加到工具结果；UserPromptSubmit 可以拦截，或把 stdout 附加到用户消息（附加后的文本写入 `user/message`，回放一致）；Stop 每个 turn 最多让 agent 继续 3 次；SessionStart 的 stdout 作为 system prompt 分段 |
| 记忆 | `ext/memory/`：本地驱动存储在 `~/.roast/memory/<hash>/facts.jsonl`（追加写入 add 和 forget 记录），按关键词重叠打分，中文按双字切分。Mem0 驱动支持平台版（默认 v3，可选 v2，`Authorization: Token`）和自托管（`X-API-Key`），用项目 ID 作为 user_id 隔离项目，保存时 `infer: false` 保留原文，删除前检查归属 |
| 代码检索 | `ext/rag/`：BM25 以 40 行为窗口、30 行为步长切块；分词保留完整标识符，同时拆出 camelCase、snake_case 子词，中文按双字切分，路径中的词也计入。文件列表在 git 仓库中用 `git ls-files`，否则遍历目录，跳过构建产物、锁文件和二进制文件。首次检索时建索引，之后按 mtime 和大小增量刷新。可选的向量检索按内容 hash 缓存，用 reciprocal rank fusion（k = 60）与 BM25 合并 |
| prompt 覆盖 | `ext/prompts/`：`~/.roast/prompts/<name>.md` < `.roast/prompts/<name>.md`。同名覆盖内置分段并沿用原来的 order，新名字放在 order 400。支持 `{{cwd}}`、`{{date}}`、`{{platform}}` |
| 注入检查 | `ext/guard/injection.ts`：对 read、grep、bash、bash_output、web_fetch、web_search、search_code 和所有 MCP 工具的成功结果匹配中英文注入特征，命中时追加警告，不拦截 |

`ext/http-json.ts` 是 Mem0 和向量服务共用的 HTTP 传输，限制响应大小，支持超时和中断，不跟随重定向，不回显远端的错误正文。

### 自动诊断

修改后诊断分三层：

- `tools/lsp/diagnostics-core.ts`：纯逻辑。按 tsconfig / jsconfig 路径缓存 LanguageService（LRU 2 个，淘汰时 dispose）。tsconfig 只在首次或配置文件变化时解析；被检查的文件用内存文本和递增版本号，其他文件用 mtime + size 作为版本，外部修改能被感知。
- `tools/lsp/diagnostics-worker.ts`：worker_threads 入口，处理带 id 的 check / warm 请求。
- `tools/lsp/diagnostics.ts`：主线程。`DiagnosticsWorkerClient` 是会话内唯一的 worker，主会话和所有成员共用，请求串行排队；超时时 terminate worker 并跳过本次，下次请求重建，连续 3 次超时后会话内停用。`DiagnosticsHost` 只是某个工作区（主会话 cwd 或成员 worktree）的视图，决定文件是否在范围内，成员的 host 由主会话的 `forWorkspace` 派生，不拥有 worker。会话 shutdown 时关闭 worker。

`commitWrite` 在写入前用旧文本查基线，写入后再查一次，按 `(code, message)` 多重集求差得到新增错误，位置不参与比较；基线失败时报告写入后的全部错误并注明“含已有错误”。等待基线期间重新比对文件字节，被外部改动就放弃写入。结果作为文本和 metadata 写进 tool/result，日志、恢复和 `Ctrl+O` 看到的内容一致。

tsdown 单独产出 `dist/diagnostics-worker.js`，host 按 `import.meta.url` 寻址；源码和测试环境找不到 `.js` 时用同目录的 `.ts` 加 tsx 启动。`typescript` 是运行时依赖，`check:package` 和 CI 的全局安装冒烟会实际启动安装后的 worker。

## 测试

夹具在 `test/fixtures/`：

| 文件 | 用途 |
|---|---|
| `scripted-provider.ts` | `ScriptedProvider`：按脚本返回确定的 chunk 流，脚本可以是函数（根据请求决定输出），记录所有请求，响应中断 |
| `routed-provider.ts` | 按 agent 或角色路由脚本，用于蜂群测试 |
| `chunks.ts` | 构造文本、工具调用、推理、错误等 chunk 序列 |
| `workspace.ts` | `tempWorkspace`：路径已规范化的临时工作区 |
| `history.ts` | `pairingErrors`：检查工具调用和结果是否配对 |
| `replay.ts` | `replayMismatches`：重放日志并比对 `viewHash` |
| `fake-clock.ts` | 可控时钟 |
| `mcp-servers.ts`、`mcp-stdio-server.ts` | 进程内和 stdio 的 MCP 测试服务器 |

分层：纯函数用单元测试；运行时和会话用 ScriptedProvider 做集成测试；界面用 ink-testing-library 或伪 TTY。供应商测试使用 mock HTTP，不访问真实服务。需要人工确认的场景：

- `pnpm tsx scripts/smoke.ts provider:model "hi"`：用真实密钥测试供应商层。
- `pnpm tsx scripts/spike-terminal.tsx`：在真实终端中检查渲染和输入。

伪 TTY 无法覆盖原生输入法候选框、不同字体下的 emoji 宽度和 conhost 的全部行为，这些需要人工验证。

## Windows

- 路径身份（Map 的键、租约、worktree 归属判断）统一用 `core/paths.ts` 的 `canonicalPath`，它解析 8.3 短路径和符号链接并转为小写；实际读写仍然使用原路径。`resolveUserPath` 兼容 Git Bash 的 `/d/x` 写法。
- shell 优先 Git Bash（`bash -c`），不存在时用 `cmd.exe /c`。spawn 一律传参数数组，不用 `shell: true`。终止进程树用 `taskkill /T /F`，进程退出时用 `spawnSync`。
- 命令输出按字节收集，每个流各自判断一次编码（UTF-8，或 Windows 下的 GBK），再用流式解码器按到达顺序拼接，避免多字节字符被拆坏。输出超过 256 KiB 时只保留头尾各 64 KiB。子进程的环境变量会设置 UTF-8 相关的 `LANG`、`PYTHONIOENCODING`、`PYTHONUTF8` 和 `LESSCHARSET`。
- ripgrep 查找顺序：`ROAST_RG_PATH` → PATH → 安装包自带的 `@vscode/ripgrep` → JS 实现。
- 全屏界面高度为 `rows - 1`，否则 Windows 控制台会在画面占满时滚动或清屏。
