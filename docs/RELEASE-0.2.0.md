# RoastCli v0.2.0

模型选择、Hive 路由和终端交互升级。

- 自动获取供应商模型列表：支持 OpenAI 兼容与 Anthropic 协议、分页、取消、缓存、搜索、刷新和手动回退。
- `/model` 用菜单选择模型及 reasoning effort；即时切换并在会话恢复时保留，不同代理的 effort 独立。
- 配置自定义 API 端点及多个模型：逗号输入或自动列表多选，保留原有模型元数据；支持显式无密钥的本地接口。
- `/hive models` 为各角色保存不同模型和 effort，`spawn_agent` / `task` 支持单个子代理覆盖。
- `/theme` 菜单选择并保存主题；权限模式、Hive 策略、技能、成员管理、黑板、费用、待办、记忆等命令使用交互面板。输入 `/`、选择候选并按 Enter 即可打开命令。
- Markdown 增加响应式留白与段落 / 列表间距，表格按可用宽度排版，引用支持样式；可通过 `ui.markdown` 调整。
- 修复自定义 Anthropic `/v1` 地址重复拼接、配置覆盖层丢失模型元数据、添加同类供应商意外重用 ID，以及大量输出的尺寸事件重复订阅。
- 修复菜单快速搜索、连续方向键与供应商向导连续确认的状态同步，页面切换在当前按键事件内完成。
- 供应商请求禁止重定向，错误正文不进入界面或会话日志；Release 发布要求同一提交的三平台 CI 成功。

安装 / 更新：

```sh
npm install -g --prefer-online https://github.com/Roast-2007/RoastCli/releases/latest/download/roastcli.tgz
```

现有配置继续可用。使用 `/model`、`/theme` 和 `/hive models` 体验新版；配置向导用 Ctrl+L 获取模型列表。具体选项与验证边界见 [使用指南](USAGE.md)。
