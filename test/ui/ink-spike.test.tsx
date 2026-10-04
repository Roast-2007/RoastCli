/**
 * M0 技术验证（自动化部分）：Ink 7 在伪 TTY 上的行为。
 * 1. inline ⇄ alternate-screen 交接：卸载 inline → 全屏渲染 → 卸载 → 重新 inline，
 *    Static 只输出水位线之后的新条目，不重复打印历史
 * 2. 活动区高度 < rows 时不触发 clearTerminal；≥ rows 时触发（设计约束的依据）
 * 3. 全屏根容器高度 rows-1 时多次重绘不触发 clearTerminal（Windows 控制台在 = rows 时每帧清屏）
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Box, render, Static, Text } from 'ink';
import { releaseScreen } from '../../src/ui/screens.js';

const CLEAR = '\u001B[2J';
const ALT_ENTER = '\u001B[?1049h';
const ALT_EXIT = '\u001B[?1049l';

class FakeTty extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 24;
  writable = true;
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  take(): string {
    const all = this.chunks.join('');
    this.chunks = [];
    return all;
  }
}

function ttyOptions(stdout: FakeTty, alternateScreen = false) {
  return {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: process.stdin,
    interactive: true,
    patchConsole: false,
    exitOnCtrlC: false,
    alternateScreen,
  };
}

function Inline({ items, live }: { items: string[]; live: number }) {
  return (
    <>
      <Static items={items}>{(item) => <Text key={item}>{item}</Text>}</Static>
      <Box flexDirection="column">
        {Array.from({ length: live }, (_, i) => (
          <Text key={i}>live {i}</Text>
        ))}
      </Box>
    </>
  );
}

function Fullscreen({ rows, tick }: { rows: number; tick: number }) {
  return (
    <Box height={rows - 1} flexDirection="column" overflow="hidden">
      <Text>MISSION CONTROL {tick}</Text>
    </Box>
  );
}

describe('Ink 7 spike', () => {
  it('inline → 全屏 → inline：进出 alt screen，历史不重复打印', async () => {
    const tty = new FakeTty();
    const a = render(<Inline items={['HIST-A', 'HIST-B']} live={2} />, ttyOptions(tty));
    await a.waitUntilRenderFlush();
    const first = tty.take();
    expect(first).toContain('HIST-A');
    await releaseScreen(a, true);
    const handoff = tty.take();
    expect(handoff).toContain('\u001B[2K');
    expect(handoff).not.toContain('live 0'); // Clear must not be undone by Ink's final frame.
    expect(handoff).not.toContain('HIST-A');

    const mc = render(<Fullscreen rows={tty.rows} tick={0} />, ttyOptions(tty, true));
    await mc.waitUntilRenderFlush();
    await releaseScreen(mc, false);
    const fullscreen = tty.take();
    expect(fullscreen).toContain(ALT_ENTER);
    expect(fullscreen).toContain('MISSION CONTROL');
    expect(fullscreen).toContain(ALT_EXIT);

    // 重新挂载 inline：只给水位线之后的新条目
    const b = render(<Inline items={['NEW-C']} live={2} />, ttyOptions(tty));
    await b.waitUntilRenderFlush();
    b.unmount();
    await b.waitUntilExit();
    const second = tty.take();
    expect(second).toContain('NEW-C');
    expect(second).not.toContain('HIST-A');
  });

  it('活动区高度 < rows 时重绘不清屏', async () => {
    const tty = new FakeTty();
    const inst = render(<Inline items={[]} live={tty.rows - 2} />, ttyOptions(tty));
    await inst.waitUntilRenderFlush();
    inst.rerender(<Inline items={['S1']} live={tty.rows - 3} />);
    await inst.waitUntilRenderFlush();
    inst.rerender(<Inline items={['S1', 'S2']} live={tty.rows - 2} />);
    await inst.waitUntilRenderFlush();
    const out = tty.take();
    inst.unmount();
    expect(out).not.toContain(CLEAR);
  });

  it('活动区高度 ≥ rows 时会整屏清空并重打 static（需避免）', async () => {
    const tty = new FakeTty();
    const inst = render(<Inline items={['S1']} live={tty.rows + 2} />, ttyOptions(tty));
    await inst.waitUntilRenderFlush();
    inst.rerender(<Inline items={['S1']} live={tty.rows + 3} />);
    await inst.waitUntilRenderFlush();
    const out = tty.take();
    inst.unmount();
    expect(out).toContain(CLEAR);
  });

  it('全屏根容器高度 rows-1：多次重绘不清屏', async () => {
    const tty = new FakeTty();
    const inst = render(<Fullscreen rows={tty.rows} tick={0} />, ttyOptions(tty, true));
    await inst.waitUntilRenderFlush();
    tty.take();
    for (let i = 1; i <= 3; i++) {
      inst.rerender(<Fullscreen rows={tty.rows} tick={i} />);
      await inst.waitUntilRenderFlush();
    }
    const out = tty.take();
    inst.unmount();
    expect(out).toContain('MISSION CONTROL 3');
    expect(out).not.toContain(CLEAR);
  });
});
