# RoastCli 当前状态

> 更新于 2026-10-05，v0.4.0。版本说明见 [RELEASE-0.4.0.md](RELEASE-0.4.0.md)，路线图见 [ROADMAP.md](ROADMAP.md)，架构见 [DESIGN.md](DESIGN.md)。

## 当前交付

开源分发：MIT 许可、简短 README、独立安装 / 使用指南、跨平台安装脚本、npm 包文件白名单，以及 GitHub CI / Release 工作流。通过 GitHub Release 的 roastcli.tgz 支持一条 npm 命令安装；当前未登录 npm registry，暂不提供 registry 包名安装。个人配置、凭据、运行状态与临时测试目录不进入公开仓库或安装包。原开发历史仅在本机备份，公开历史从干净的初始提交开始；作者使用 GitHub noreply 邮箱。Gitleaks 历史与公开源码扫描无密钥命中，安装包白名单和独立目录安装验证通过。

M0–M8 的功能实现与自动化验收已完成，包含可选 Mem0、embeddings、无 Git 文件检查点及蜂群自适应并发。TUI 已补齐小屏布局、长输入、帮助与会话菜单、实时模型切换、暂停和终端降级。

- 本轮 Windows 验证：117 个测试文件、714 个测试全部通过；typecheck / lint / build / 安装包白名单 / 离线 frozen-lockfile 校验通过。
- 2026-10-05 最终 Vitest V8 覆盖率：行与语句 93.66%、分支 82.34%、函数 90.84%。CI 保存 JSON summary 和 LCOV；性能测试保持约 30 次 store 通知 / 秒。
- 本地安装包为 release/roastcli-0.4.0.tgz；构建 CLI 的版本、蜂群角色模型帮助、非 TTY 提前报错与空 PATH 下的打包 ripgrep 已验证。跨平台 CI 与用户在线供应商尚未在本机验证。
- 真实 Ink 输出覆盖 40×10、60×16、80×24、120×40，运行中缩到 25×8，2000 行流式输出不触发整屏清空。
- 尚未验证：Windows Terminal / conhost 的真实 IME 候选框、Shift+Enter，以及用户在线供应商。供应商、Mem0 和 embeddings 使用受控 HTTP 测试，未调用用户在线账户。

## 里程碑

| 里程碑 | 实现状态 | 主要内容 |
|---|---|---|
| M0 稳定化 | 完成 | 工具中断收尾、UTF-8 / GBK 输出、进程树退出、路径身份、Ink 7 |
| M1 事件运行时 | 完成 | Committer、可重放日志、队列插话、边界钩子、重试、稳健恢复 |
| M2 工具与权限 | 完成 | 文件 / 搜索 / shell / 网络 / 提问、四模式、审批、检查点、文件与对话回退 |
| M3 上下文引擎 | 完成 | 去重、老化、无损折叠、安全压缩、recall、用量校准、缓存规划、thinking |
| M4 inline TUI | 完成 | Static + 流式尾部、输入编辑、历史搜索、补全、工具聚合、量规、toast、菜单 |
| M5 Hive | 完成 | 拓扑、消息、黑板、等待、看门狗、取消、租约 / worktree、AIMD、模板 |
| M6 Mission Control | 完成 | 响应式全屏、消息正文 / 黑板 / 上下文、指示、暂停、取消、集中审批、屏幕交接 |
| M7 扩展 | 完成 | skills、MCP、hooks、memory、RAG、guard、prompts、plan |
| M8 打磨 | 实现完成 | doctor / init / 配置向导、四主题、终端降级、Mem0 / embeddings、性能与回归验证 |

## 本轮打磨

### v0.4.0 上下文、工具与蜂群

- 修正 DeepSeek miss tokens 同时作为普通输入和 cacheWrite 累计的问题；历史 reasoning 在 field 模式下保持稳定，要求丢弃旧 reasoning 的服务可用 current。缓存 key 绑定模型/system/tools，Anthropic 的旧边界按实际内容校验，压缩、回退与模型切换不会沿用失效边界。
- 延后批量折叠，默认廉价模型摘要，失败回退抽取式实现；按 token 加权统计命中率与重试次数。主模型、子代理和摘要请求均按原模型定价并可恢复。
- 本机近期日志的多步 Kimi 请求已有约 75–95% 命中，单请求会话为 0%；未复现持续低命中，旧 DeepSeek 样本还受计费映射影响。需要分别检查供应商、会话长度和前缀变化；未调用线上推理接口验证升级后的收益，原始私人日志不进入仓库。
- 滚轮滚动 chat 并保留草稿，回到底部跟随输出；初始蜂群目标跳过 splash。Queen 按已配置模型信息选择未指定角色，用户模型（包括 inherit）受到保护。
- 图片、MCP resources/templates/prompts、网页搜索及 TS/JS 语义工具落地；跨文件重命名逐文件授权、内容校验和回滚。搜索端点加入项目 trust hash，MCP 图片有累计大小限制。
- yolo 每条 bash 前快照，turn 首次基线保留；shell 超时提示与输出详情、非 TTY 提前报错、搜索列表、有限历史、管道参数摘要。
- 直接回归覆盖会话装配、step 重试、工具并发/中断配对、SSE 分帧与取消、注入警示、真实 Ink 滚轮、语义跨文件修改、MCP prompt、摘要与子代理成本恢复。TS 和平台 ripgrep 为运行依赖，Biome/覆盖率接入 CI，install 不再自动构建。

### v0.2.1 全局配置与启动信任

- 用户目录 `.roast/config.json` 优先于项目配置，默认模型、供应商、界面及 Hive 设置跨项目复用；显式 `ROASTCLI_CONFIG` 仍优先。配置向导和偏好修改默认写全局文件。
- 全局完整供应商独立拥有连接字段，避免继承项目 URL、headers、认证或密钥引用；项目独有的供应商仍受信任限制。配置层去重避免重复加载同一文件的钩子。
- 首次交互启动用键盘面板信任文件夹，可查看完整路径和项目配置、确认或退出；记录保存于用户目录，相关项目配置变化后重问，非交互模式不自动授权。
- Hive 启动在确认信任后构造策略提示，允许首次确认后使用可信的项目模板。

### v0.2.0 模型、Hive 和命令交互

- 自动获取 OpenAI 兼容 / Anthropic 模型列表；支持分页、超时、取消、会话缓存、搜索、刷新和手动回退。显式模型元数据优先，刷新会更新远端元数据；模型发现前检查项目连接信任。
- `/model` 面板分两步选择模型与 effort，主会话和子代理空闲时切换；每次切换写日志并可恢复。effort 通过独立请求选项传递，自动用 null 清除配置默认值，不会改动其他代理的设置。
- 向导支持逗号输入多个模型、留空自动拉取、Ctrl+L 列表多选，以及无密钥本地服务。同类供应商自动分配独立 ID，保存保留覆盖层和模型元数据。
- `/hive models` 保存各角色模型 / effort，后续派生生效；spawn_agent 和 task 可单次指定其他已配置供应商。继承主会话时也继承它的 effort，无效供应商在分配 agent 前拒绝。
- 选择与查看命令使用滚动、可搜索面板；主题选择持久化，技能 / 蜂群策略可输入参数 / 目标，成员可查看详情、发送指示、暂停或确认取消。命令补全可直接 Enter 打开，帮助页可 Enter 执行选中的命令。
- Markdown 响应式左右留白与段落 / 列表间距，引用递归渲染，表格使用内容区宽度。尺寸从主界面传入，2000 行输出不增加每块 resize 监听器。
- 修复 Anthropic 自定义 /v1 路径重复拼接、覆盖层丢模型元数据及供应商错误正文泄漏；模型与生成请求拒绝重定向。Release 工作流要求同一 main 提交已通过三平台 CI。
- 新回归覆盖 HTTP 模型发现与分页、失败 / 取消 / 缓存刷新、完整向导多选、真实按键面板、跨供应商 Hive、effort 恢复、Markdown 留白和长输出监听器数量。供应商可用模型 / effort 仍以实际服务为准，未调用用户付费推理接口。

### 蜂群 research 权限与进展修复

- 修复只读角色在权限审批前直接拒绝 shell 的问题。常见 Git 列表、排序与只读管道正确分类；无法确认的命令转交共享审批队列，用户可批准本次执行。只读角色的直接文件写入仍禁止，配置 deny 规则、plan 模式和 worktree 边界仍生效。
- 不再按 usage 事件和写入次数判断子 agent 停滞。新读取、搜索、验证结果都计入进展；只有连续完成步骤重复相同结果或失败才提醒，重试、等待授权和未完成的工具不累计步数。
- 待审批 agent 在蜂群树及 agents_status 显示“等待用户授权 / 回答”；审批完成、拒绝或取消时立即同步队列，取消子 agent 不留下失效卡片。暂停 / 恢复保留等待状态。
- 回归覆盖并发审批、真实 Ink 按键批准 / 拒绝、取消待审批 agent、长只读调研、worktree 内批准 shell、重复操作和模型重试。原问题日志复查：16 次角色拒绝中 13 次识别为只读，3 次进入审批，三个 scout 均无停滞误报。日志只在本机分析，不进入公开仓库。

### 供应商修复与推理强度（后续修复）

- 供应商认证只使用直接输入并保存在用户 credentials.json 的 API Key；旧 apiKeyEnv 可读取用于迁移，但不再读取环境变量密钥。向导、init、doctor 与配置示例同步更新；Mem0 / MCP 的独立认证配置仍按各自协议处理。
- 向导直接聚焦密钥输入，Enter 确认后再 Enter 保存；同步维护输入与光标，连续快速按键不丢字符。缺少或失效的已保存密钥需重新输入，错误页保持遮罩。
- 保存默认写用户级全局配置，显式 ROASTCLI_CONFIG 则写指定文件，页首与确认页显示实际路径。支持部分项目补充层，保留其他供应商、模型元数据和扩展；默认模型以用户配置为准，项目连接变更在交互启动时确认信任。
- 新增 Kimi Code：OpenAI 兼容端点 https://api.kimi.com/coding/v1，默认模型 kimi-for-coding；保留当前工具循环的 reasoning_content，客户端如实标识 RoastCli。
- Reasoning effort 按模型保存、编辑和清除；自动不发送参数。OpenAI 兼容请求使用 reasoning_effort，Anthropic 使用 output_config.effort 并保留原 thinkingBudget 行为。Kimi Code 按官方文档提供 none / low / high / max。
- init 支持 --api-key-stdin 与 --reasoning-effort，无需供应商环境变量。回归验证覆盖保存后重载、旧认证迁移、真实 CLI stdin、快速输入、40×10 小屏及两种协议的实际请求体。

### 显示与输入

- layout.ts 统一按物理行预算分配活动区，输入和审批优先；状态栏固定一行，按宽度省略次要信息。大终端恢复彩色上下文量规。
- 编辑器按 grapheme 移动和删除，支持 CJK、组合音标、emoji 家庭 / 旗帜；软换行视窗跟随光标。长粘贴折叠，提交和历史保存展开原文。
- Ctrl+R 搜索历史，再次 Ctrl+R 切换匹配，Enter 载入、Esc 返回草稿；↑↓ 选择补全，Tab 应用。
- 空输入 ?、F1、/help 打开滚动帮助；Esc Esc / /rewind 打开可选择并确认的回退菜单；/context 可钉住 / 取消钉住 / 折叠。
- 帮助、审批和屏幕切换保留草稿、粘贴映射及光标。权限 / 提问卡片可选菜单、详情翻页，自由回答复用编辑器。
- Ctrl+O 工具详情支持 PgUp/PgDn、Home/End。工具、diff、历史与 Markdown 清理终端控制序列；表格按屏宽分配列宽。
- 同一尚未发布帧内至少三次连续成功的同名读取 / 搜索工具聚合显示，保留各个记录；失败、diff 与已打印条目不聚合。
- 四主题 ember / aurora / daylight / mono，/theme 打开选择并保存的面板，/theme <name> 可直接即时切换。NO_COLOR 优先，ROAST_THEME 高于配置。
- ui.ascii / ROAST_ASCII=1 使用 ASCII 边框和主要装饰；ui.motion: reduced / ROAST_REDUCED_MOTION=1 停止旋转动画。TERM=dumb 自动启用两项。
- 所有旋转动画共用一个 80ms 计时器，订阅归零后停止；render 限制 30fps 并启用 incrementalRendering。模式与回答反馈用短暂 toast，卸载清理计时器。

### 交互与会话

- !shell 提供实时输出，Esc / Ctrl+C 可中断，退出等待收尾。执行期间发送的模型消息保留在输入框。
- /model 自动获取列表并选择模型与 effort；/model [provider:model] [effort|auto] 可直接切换。主会话与子 agent 须空闲，模型引用、上下文窗口、蜂群 root 信息同步，历史与工具列表不变。
- model/change 落日志，恢复选择最后使用的模型；费用按原模型逐次累计，回退不退还已用 tokens，缺少任何已用模型的定价时不虚报完整费用。
- /clear 重新挂载 inline，保留上下文和编辑草稿，防止 Static 重印历史。
- /resume 按同项目最近活动列出会话，/resume <runId> 直接恢复。加载期间可以退出，失败回到旧会话；候选会话、日志与渲染器均正常关闭。
- 恢复界面只重放已提交的用户 / 助手 / 工具 / 用量，不重复 raw chunks，不显示内部 attachment；rewind 日志恢复保留实际费用与用量。
- # 的空输入及写入错误有提示；/provider（别名 /config）、/agents、/board [key] 可在 inline 中管理配置、查看蜂群及完整黑板值。

### Mission Control 与蜂群

- ≥112 列三栏，70–111 列两栏，更窄单栏；agent 树跟随选择滚动。
- Tab / 1–4 切换输出、消息正文、黑板值、上下文；输出软换行，PgUp/PgDn 或 b/f 翻页，G 到底部。
- m 向主会话或选中子 agent 发指示，p 暂停 / 恢复，x 二次确认取消子树。暂停在请求步骤边界生效，执行中的工具完整收尾；中断解除暂停。
- 按 agent 分组合并每帧连续 delta；20-agent / 20k 事件归约在定向测量中约 73ms（原约 2.3s），通知约 30Hz。
- 每个真实 provider profile 共享 AIMD 并发限制，最多从 4 个并发开始；429 减半，遵守 retry-after，连续十次成功加一，受 maxConcurrency 限制。等待可中断，工具与父级等待不持有请求名额。
- 子 agent 初始化失败也会关闭日志、报告失败、结束等待并释放租约，不留下活跃状态或未处理 rejection。

### 扩展与检查点

- Mem0：平台 v3（可选 v2）与自托管端点，正确的 Token / X-API-Key 认证，canonical cwd 哈希隔离项目，原文保存，删除前验证归属，未返回 id 不虚报成功。
- 共享 JSON HTTP 传输限制大小、超时与中断，不追随重定向，不回显远端错误正文。Mem0 启动失败给出警告，主会话可继续；工具失败明确呈现。
- OpenAI 兼容 embeddings 支持供应商 headers / 凭据，验证数量、顺序、维度和有效向量；按内容哈希持久化缓存、分批生成，默认最多 2000 chunks。
- 查询时先获得向量维度，变化自动淘汰旧缓存；BM25 与 cosine 用 reciprocal rank fusion 合并。先过滤路径，远端失败提示回退 BM25，中断不伪装成回退。
- 项目级 memory / rag 配置需 trust，纳入敏感配置 hash 与信任清单；没有扩展配置的旧 hash 保持兼容。
- Git 不可用时使用 .roast/snapshots/，按字节保存并恢复二进制、CRLF、删改和新增文件，回退前保存备份。跳过 Roast / Git 状态、依赖和日志，不跟随 symlink / junction，单次上限 128 MiB。

## 保留的保障与设计决定

- JSONL v1 + seq / agentId、request digest、固定工具 schema、共享 history reducer；工具调用和结果配对始终合法。恢复含断尾修复、悬空调用补结果、活进程写锁分叉、v0 导入、fs-state 与权限重建。
- 模型摘要在会话装配中默认启用；确定性的抽取式实现作为失败兜底，也可通过 context.summaryModel=extractive 单独使用，原文召回与安全切点约束保留。
- 等待只允许父级等待后代，问题等待有超时；结构约束和看门狗代替额外全局 quiescence 调度器。超过 agent 数量上限明确拒绝。
- 蜂群拓扑由 Queen 在运行中产生，因此展示实时树，不制造启动前的静态拓扑预览。
- worktree 文件编辑限制在副本内，依赖使用独立副本；外部执行每次需审批。字节保持、CRLF、非 UTF-8、diff 设置、hooks、UNC / 8.3 路径、配置 trust hash 的回归保障保留。
- roast worktrees list/prune 只处理登记且未被活进程使用的副本，未合并改动保留，退出列出保留路径。

## 验证边界

自动化覆盖主要尺寸、缩放、Unicode、ASCII、减少动画、长输入、长输出、并发、暂停 / 中断、恢复失败 / 退出、网络失败、缓存变化、文件回退。终端缩小时，Ink 因上一帧较高可能清屏一次；随后稳定帧不应继续清屏。

无法通过伪 TTY 断言原生 IME 候选窗口、不同字体 emoji 宽度或 conhost 的全部行为。人工脚本为 pnpm tsx scripts/spike-terminal.tsx；旧终端换行可使用 Ctrl+J / Alt+Enter / 行尾反斜杠。

## 开发与运行

先读本文件及路线图，定向测试新功能，再运行 typecheck / 全量测试 / build；里程碑更新状态并使用 conventional commit。含反斜杠的代码只用文件编辑工具写入。PowerShell 可用 pnpm.cmd 避免执行策略拦截。

```bash
pnpm install --frozen-lockfile
pnpm dev config
pnpm dev doctor
pnpm dev trust                   # 信任本项目的配置
pnpm dev                         # TUI
pnpm dev -c / pnpm dev -r <id>   # 恢复
pnpm typecheck
pnpm test
pnpm build
pnpm test:coverage
```
