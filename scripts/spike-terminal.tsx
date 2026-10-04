/**
 * M0 手工技术验证（真实终端）：pnpm tsx scripts/spike-terminal.tsx
 * 验证项：
 *  - Ctrl+G：inline ⇄ 全屏（alternate screen）切换，返回后 scrollback 无重复
 *  - Shift+Enter 是否可识别（kitty 键盘协议 auto）；Ctrl+J / Alt+Enter 作为回退
 *  - 中文输入法候选框是否跟随光标（useCursor）
 *  - 粘贴多行文本是否整体到达（usePaste）
 * Ctrl+C 退出。
 */
import { useState } from 'react';
import { Box, render, Static, Text, useCursor, useInput, usePaste, useWindowSize, type Instance } from 'ink';

interface Shared {
  history: string[];
  watermark: number;
}

const shared: Shared = { history: [], watermark: 0 };
let current: Instance | null = null;

function log(line: string): void {
  shared.history = [...shared.history, line];
}

function InlineApp({ onToggle }: { onToggle: () => void }) {
  const [buffer, setBuffer] = useState('');
  const [items, setItems] = useState(() => shared.history.slice(shared.watermark));
  const { setCursorPosition } = useCursor();
  const push = (line: string) => {
    log(line);
    setItems((prev) => [...prev, line]);
  };
  useInput((input, key) => {
    if (key.ctrl && input === 'c') process.exit(0);
    if (key.ctrl && input === 'g') return onToggle();
    if (key.return && (key.shift || key.meta)) return push(`[换行键] shift=${key.shift} meta=${key.meta}`);
    if (key.ctrl && input === 'j') return push('[换行键] ctrl+j');
    if (key.return) {
      push(`› ${buffer}`);
      setBuffer('');
      return;
    }
    if (key.backspace || key.delete) return setBuffer((b) => b.slice(0, -1));
    if (input && !key.ctrl) setBuffer((b) => b + input);
  });
  usePaste((text) => push(`[粘贴] ${text.split('\n').length} 行, ${text.length} 字符`));
  // 光标放在输入行末尾（"› " 两列 + 缓冲区显示宽度的近似）
  const width = [...buffer].reduce((w, ch) => w + (/[　-鿿＀-￯]/.test(ch) ? 2 : 1), 0);
  setCursorPosition({ x: 2 + width, y: 1 });
  return (
    <>
      <Static items={items}>{(item, i) => <Text key={`${shared.watermark}-${i}`}>{item}</Text>}</Static>
      <Text dimColor>Ctrl+G 全屏 · Shift+Enter/Ctrl+J 测换行 · 粘贴测试 · 中文输入法测试 · Ctrl+C 退出</Text>
      <Text color="cyan">› {buffer}</Text>
    </>
  );
}

function FullscreenApp({ onToggle }: { onToggle: () => void }) {
  const { rows, columns } = useWindowSize();
  const [tick, setTick] = useState(0);
  useInput((input, key) => {
    if (key.ctrl && input === 'c') process.exit(0);
    if ((key.ctrl && input === 'g') || input === 'q' || key.escape) return onToggle();
    setTick((t) => t + 1);
  });
  return (
    <Box height={rows - 1} width={columns} flexDirection="column" borderStyle="round" borderColor="yellow" overflow="hidden">
      <Text color="yellow">MISSION CONTROL 原型 — {columns}×{rows} — 按键次数 {tick}</Text>
      <Text>按 q / Esc / Ctrl+G 返回 inline；返回后检查 scrollback 是否有重复历史</Text>
    </Box>
  );
}

async function mount(fullscreen: boolean): Promise<void> {
  if (current) {
    current.unmount();
    await current.waitUntilExit().catch(() => {});
  }
  if (!fullscreen) shared.watermark = shared.history.length;
  const toggle = () => void mount(!fullscreen);
  const opts = { exitOnCtrlC: false, alternateScreen: fullscreen, kittyKeyboard: { mode: 'auto' as const } };
  if (fullscreen) {
    current = render(<FullscreenApp onToggle={toggle} />, opts);
  } else {
    // 回到 inline：Static 只渲染水位线之后的新条目（此处为空），历史留在终端 scrollback
    current = render(<InlineApp onToggle={toggle} />, opts);
  }
}

void mount(false);
