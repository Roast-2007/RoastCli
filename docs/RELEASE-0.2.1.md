# RoastCli v0.2.1

配置一次，所有项目复用；启动时直接确认文件夹信任。

- 用户目录 `.roast/config.json` 优先于项目配置，供应商、默认模型、主题和 Hive 模型设置全局复用。
- `roast config`、`/provider`、`/theme` 和 `/hive models` 默认保存全局设置；显式设置 `ROASTCLI_CONFIG` 时使用指定文件。
- 全局供应商不会继承项目中的连接地址、headers、认证方式或密钥引用；项目独有的供应商仍要求信任。
- 首次交互式启动弹出文件夹信任面板，可查看完整路径及项目配置、确认继续或取消退出；记录保存在用户目录，相关配置变化后再次确认。
- 非交互模式不弹窗或自动授予信任，保留 `roast trust` 供脚本使用。Hive 项目模板在确认信任后加载。
- 同一配置文件只加载一次，避免显式指定全局文件时钩子重复执行；从项目配置新建全局供应商时保证全局默认模型可独立使用。

安装 / 更新：

```sh
npm install -g --prefer-online https://github.com/Roast-2007/RoastCli/releases/latest/download/roastcli.tgz
```

Windows 全局目录默认为 `%USERPROFILE%\.roast`，macOS / Linux 为 `~/.roast`；`ROAST_HOME` 可指定其他目录。已有项目配置继续作为补充，显式配置文件继续保持最高优先级。具体选项见 [使用指南](USAGE.md)。
