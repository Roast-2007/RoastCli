# RoastCli 路线图

> M0–M8 功能实现与自动化验收已完成（2026-10-04）；原生终端与在线服务的验证边界见 [STATUS.md](STATUS.md)。设计见 [DESIGN.md](DESIGN.md)。

## 产品目标
做一个和市面 CLI 有明显差异的编码 agent，四个主轴：
1. **极致易用、美观的 TUI**：inline 对话为主，Ctrl+G 进入全屏 Mission Control。
2. **无损上下文引擎**：旧内容折叠而不删除，模型可以 `recall` 回来；对 provider 前缀缓存友好。
3. **全部扩展缝落地**：skills、MCP、memory、RAG、审计、guard、prompts、hooks、plan。
4. **Hive 蜂群**：Queen → Lead → Worker 三层加专家角色，通过消息总线和黑板互相通信；不设 token 预算，用 token 换质量；通信本身不占上下文。

## 开发约定（2026-10-03 起）
- **减少冒烟测试，全力开发新功能。** 每个功能靠单元测试和集成测试（ScriptedProvider、伪 TTY）保证正确；真实 provider 冒烟只在 M8 做一次，或由用户自行运行。
- TDD：先写测试再实现。每个里程碑结束时 typecheck、测试、build 全绿后提交。
- 不变量必须一直成立：
  1. 日志能重放出与实际发送一致的历史（viewHash）；
  2. tool-call 与 tool-result 始终配对；
  3. 整场会话工具列表不变。
- 含反斜杠的代码一律用文件编辑工具写入，不用 shell heredoc。

## 里程碑

### M2 工具与权限（收尾）
- [x] 会话接线：PermissionEngine、InteractionBroker、permissionHook、授权和模式变化落日志、resume 时恢复
- [x] App：权限卡片（允许 / 本会话始终允许 / 本项目始终允许 / 拒绝）、提问卡片（选项或自由输入）、Shift+Tab 切模式、状态栏显示模式
- [x] CLI：`--permission-mode`；管道模式下需要询问的操作直接拒绝并给出提示
- [x] 检查点：shadow-git（`.roast/shadow.git`），每个 turn 在第一次写操作前打快照；`git` 不可用时降级为按文件快照
- [x] rewind：`rewind {toTurn}` 事件、history reducer 回退、`/rewind [n]` 同时回退文件和对话

**验收**：
- 规则矩阵和复合命令测试通过；
- plan 模式下拒绝写操作，且工具列表不变；
- rewind 后文件与历史都回到目标 turn 开始前的状态，日志可重放；
- resume 后授权与模式恢复。

### M3 上下文引擎
- [x] 上下文条目层（history state + controller）：在 history 上叠加条目层，记录 handle、kind、tokens、state、pinned、来源
- [x] Token 计数：以最近一次真实 usage 为锚点，加上新增部分的估算；冷启动用支持 CJK 的启发式，并按 EMA 校准
- [x] 策略（纯函数）：读取去重、老化折叠、阈值压缩（锚定结构摘要、只在安全切点压缩）、溢出时紧急压缩
- [x] 缓存规划（ContextController）：批量应用折叠，统计缓存击穿次数
- [x] 视图投影：只折叠 tool-result 的内容，配对不变；当前工具循环里的 thinking 逐字节保留
- [x] `recall` 工具：按句柄追加原文，或在归档日志里检索
- [x] 事件：`context/transform`、`context/compact`（摘要原文 + 辅助调用的 usage）
- [x] Anthropic：`cache_control` 断点、thinking 参数
- [x] `/context`（只读的上下文地图）、`/compact [焦点]`

**验收**：
- 长会话集成（30 轮，多工具步骤）的请求，占用始终低于窗口的 85%；
- 每个视图都通过配对校验；
- 缓存击穿次数低于阈值；
- 日志可重放。

### M4 inline TUI 重写
- [x] 外部 store（useSyncExternalStore）、约 30Hz 合批、committedWatermark
- [x] Ember 主题系统，按 chalk level 自动降级
- [x] Markdown 流式渲染：已完成的块进入 Static，只对尾部重新解析；代码高亮
- [x] diff 视图、工具卡片（同类聚合、bash 实时输出、"+N 运行中"折叠）
- [x] 输入框：多行、历史、Ctrl+R、`@` 文件、`/` 命令面板、`!` 执行 shell、`#` 写记忆、粘贴折叠、IME 光标
- [x] 状态栏（模式、模型、上下文量规、缓存命中率、费用、agent 数、分支）、todo 面板、toast、帮助浮层
- [x] 斜杠命令注册表

**验收**：
- ink-testing-library 在 80×24 和 120×40 下的快照通过；
- 活动区高度始终小于终端行数；
- 流式输出 2000 行不触发整屏清空。

### M5 无界面蜂群（Hive）
- [x] Supervisor、AgentHost（每个 agent 一个 AgentRuntime）、拓扑与角色、按层级路由模型
- [x] MessageBus 与 Mailbox（经 boundary 投递、唤醒规则、限流、去重、hop 上限）
- [x] Blackboard（版本化 KV、CAS、只推送变更通知的 watch）
- [x] 工具：spawn_agent、send_message、board_*、await_agents、report、merge_worktree；单 agent 模式下的轻量版 `task`
- [x] 防失控：树形等待与问题超时、无进展看门狗、agent 数与时长上限、按 provider 的 AIMD 并发
- [x] 隔离：文件租约锁 → git worktree
- [x] 策略：fanout、best-of-n、critique、research 四个模板及 YAML 自定义
- [x] `roast swarm -p --output-format stream-json`

**验收**：
- 确定性多 agent 场景测试通过；
- 死锁场景能自行化解；
- 取消子树后每个后代的日志都有配对完整的结果；
- 消息风暴被限流；
- 每个 agent 的日志都能独立重放。

### M6 Mission Control
- [x] alt-screen 全屏，根容器高度为 rows-1；画面包括智能体树、选中 agent 的实时流、消息时间线、黑板、上下文地图、定向输入
- [x] 操作：steer、暂停、终止、集中处理权限队列、运行时拓扑树（Queen 动态生成拓扑，启动前不做静态预览）

**验收**：进出全屏后 scrollback 不重复；20 个 agent 同时运行时渲染不超过 30fps。

### M7 扩展缝（✅ 已完成，2026-10-04）
- [x] skills（SKILL.md、`skill` 工具、作为斜杠命令）
- [x] MCP（stdio / SSE / streamable-http，`mcp__server__tool`，`roast mcp`）
- [x] hooks（PreToolUse / PostToolUse / UserPromptSubmit / Stop / SessionStart）
- [x] memory（本地 jsonl 加关键词检索，没有用 minisearch；`memory` 工具；`#` 仍然写进 ROAST.md）
- [x] RAG 代码索引与 `search_code`（内存 BM25，增量刷新）
- [x] prompts 覆盖、guard 规则（plan 审批卡片在 M2 已经实现）

### M8 打磨
- [x] best-of-N + Judge、YAML 模板、多主题、`/context` 交互、`roast init` / `roast doctor`
- [x] README 重写、20-agent 合批负载测试、覆盖率 ≥80%
- [x] 两轮评审遗留：worktree 字节保持、配置 / 信任 / 路径安全、等待报告、隔离收尾、`worktrees list/prune`、依赖副本与执行审批、四项 LOW（详见 STATUS.md）
- [ ] Windows Terminal / conhost 手工验收：中文输入法候选框、Shift+Enter、Ctrl+G
- [ ] 真实 DeepSeek 冒烟（只做一次；需使用已保存的 API Key，尚未请求用户在线账户）
- [x] Mem0 平台 / 自托管驱动、embeddings 缓存与混合排序、失败回退及配置 trust
- [x] 小屏配置向导、Unicode / emoji 编辑、ASCII / 减少动画、缩放 / 2000 行输出 / 会话生命周期回归

M2–M6 清单已按实现校正。确定性摘要与树形等待代替独立 LLM 摘要器和全局 quiescence 调度器；原生终端及一次在线冒烟在环境具备条件时验证。实际验收记录以 STATUS.md 为准。

## 优先级与顺序
M2 收尾 → M3 → M4 → M5 → M6 → M7 → M8。

M4 的 store 与 M5 共用 EventHub 和 InteractionBroker，所以 M4 必须先把 store 的形状定成"按 agentId 分片"。
