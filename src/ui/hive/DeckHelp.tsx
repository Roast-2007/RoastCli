import { useInput } from 'ink';
import type { UiStore } from '../store/store.js';
import { useViewport } from '../viewport.js';
import { useTerminal } from '../terminal.js';
import { MessagePanel } from '../components/MessagePanel.js';
export function deckHelpText(columns: number, ascii: boolean) {
  const tabs =
    columns >= 70 && columns < 112
      ? '1 计划 · 2 输出 · 3 改动 · 4 信号 · 5 消息 · 6 黑板 · 7 用量'
      : '1 计划 · 2 输出 · 3 改动 · 4 消息 · 5 黑板 · 6 用量';
  const diagram =
    columns < 70
      ? '蜂群 | 任务区 | 信号'
      : ascii
        ? ' + 蜂群 + 任务区 + 信号 +\n +------+--------+------+ '
        : ' ┌ 蜂群 ┬ 任务区 ┬ 信号 ┐\n └──────┴────────┴──────┘';
  return `${diagram}
点击面板，或 F6 / Shift+F6 切换焦点 · Esc 回到输入框

输入框   Enter 发起任务 / 运行中插话 · @成员 文本 指挥成员 · / 命令 · Tab 补全
面板     Tab / Shift+Tab 切换面板 · ↑↓ j/k 选择或滚动 · PgUp/PgDn · g/G
成员     Enter 看输出 · Space 菜单 · m 指示 · p 暂停 · x×2 取消 · d 改动
任务区   ${tabs}
输出页   Markdown 与工具摘要 · 双击窗格 / Enter 全屏阅读
全屏输出 ↑↓ j/k · PgUp/PgDn b/f · g/G Home/End · 滚轮 · Esc / 双击正文返回
工具详情 双击工具查看该调用 · Ctrl+O 最近工具 · ←→ [ ] 切换 · Esc/Ctrl+O 关闭
鼠标     单击选择/聚焦 · 双击打开 · 右键菜单 · 滚轮滚动指针下的面板
         /mouse off 关闭鼠标以便拖选文字；开启时按住 Shift 拖动也能选择
全局     Ctrl+G 切换 Hive/对话 · Shift+Tab 权限模式（输入框中）· Ctrl+O 工具输出
         Esc 中断 · Esc×2 回退菜单 · Ctrl+C 清空草稿 / 两次退出
命令     /hive  /strategy  /agents  /board  /model  /mode  /status  /mouse  /help`;
}
export function DeckHelp({ store, height }: { store: UiStore; height: number }) {
  const { columns } = useViewport(),
    { ascii } = useTerminal();
  const close = () => store.setMeta({ overlay: null });
  useInput((input) => {
    if (input === '?') close();
  });
  return <MessagePanel title="帮助 · HIVE Deck" text={deckHelpText(columns, ascii)} height={height} onClose={close} />;
}
