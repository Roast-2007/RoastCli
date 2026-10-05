# RoastCli v0.3.0

全屏工作区、字符启动动画和连续阅读。

- 主对话默认进入全屏，输入框与状态栏固定在底部。对话、Hive 和供应商向导共用一个终端渲染器，切换视图保留历史、草稿和进行中的任务。
- 启动时展示 ROAST 字符动画，可用任意键跳过；用于跳过的文字会进入输入框。面板打开、菜单选择、Hive 视图和审批卡片使用短时颜色过渡，不延迟按键处理。
- 长回答和计划使用按行滚动的连续视口。Shift+↑↓ / PgUp 进入阅读，↑↓ / j/k 逐行滚动，Home 到顶部，End / Enter / Esc 返回输入。阅读时新输出不会把视口拉到底部。
- /help 直接阅读完整快捷键与命令说明，取消无效的条目选择和 Enter 执行命令。/context 默认阅读统计，按 m 进入真正可操作的工具结果管理菜单。
- 工具详情、黑板、费用、记忆和日志正文支持逐行滚动；Hive 的 ↑↓ 滚动正文，j/k 仅在输出视图切换成员。
- 改善小窗口的布局分配、Unicode 自动换行、窗口缩放、快速连续输入与重复确认；小尺寸提问优先显示问题和回答输入框。
- 动画尊重 ui.motion=reduced、ROAST_REDUCED_MOTION=1 和 TERM=dumb；保留 ASCII 与无色主题支持。启动横幅使用实际安装版本号。

安装 / 更新：

```sh
npm install -g --prefer-online https://github.com/Roast-2007/RoastCli/releases/latest/download/roastcli.tgz
```

验证覆盖全量测试、真实 Ink 终端渲染、全部 19 类命令面板、20×5 至 120×40 的窗口、2,000 行回答、实际审批写入、草稿保留、缩放与动画清理。发布前执行 Windows / macOS / Linux CI 和全局安装检查。
