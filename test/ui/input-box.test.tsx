import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { InputBox } from '../../src/ui/input/InputBox.js';
import { createEditor, editorReducer, expand, type EditorState } from '../../src/ui/input/editor.js';

const tick = () => new Promise((r) => setTimeout(r, 30));
const deps = { commands: [{ name: 'context', description: '上下文占用' }], files: () => [] };

describe('InputBox', () => {
  it('selects a completion with arrows, and reverse search keeps the draft until accepted', async () => {
    const submit = vi.fn();
    const screen = render(<InputBox active placeholder="" initialHistory={['old auth question', 'recent auth question']} initialText="draft" deps={{ ...deps, commands: [{ name: 'context', description: 'ctx' }, { name: 'cost', description: 'usage' }] }} onSubmit={submit} />);
    await tick();
    screen.stdin.write('\u0012'); await tick();
    screen.stdin.write('auth'); await tick();
    expect(screen.lastFrame()).toContain('recent auth question');
    screen.stdin.write('\u0012'); await tick();
    expect(screen.lastFrame()).toContain('old auth question');
    screen.stdin.write('\u001b'); await tick();
    expect(screen.lastFrame()).toContain('draft');
    screen.stdin.write('\u0015'); await tick();
    screen.stdin.write('/co'); await tick();
    screen.stdin.write('\u001b[B'); await tick();
    screen.stdin.write('\t'); await tick();
    screen.stdin.write('\r'); await tick();
    expect(submit).toHaveBeenCalledWith('/cost', '/cost ');
    screen.unmount();
  });
  it('restores the editor caret and collapsed paste across a screen remount', async () => {
    const original = 'a\nb\nc\nd\ne\nf';
    let saved: EditorState = editorReducer(createEditor(), { type: 'paste', text: original });
    const capture = (state: EditorState) => { saved = state; };
    const first = render(<InputBox active placeholder="" initialHistory={[]} initialState={saved} onStateChange={capture} deps={deps} onSubmit={vi.fn()} />);
    await tick();
    first.stdin.write('\u001B[D');
    await tick();
    const caret = saved.col;
    first.unmount();
    const submit = vi.fn();
    const second = render(<InputBox active placeholder="" initialHistory={[]} initialState={saved} onStateChange={capture} deps={deps} onSubmit={submit} />);
    await tick();
    expect(saved.col).toBe(caret);
    expect(expand(saved)).toBe(original);
    second.stdin.write('\u001B[F');
    await tick();
    second.stdin.write('\r');
    await tick();
    expect(submit).toHaveBeenCalledWith(original, original);
    second.unmount();
  });
  it('输入后回车提交，并清空', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<InputBox active placeholder="输入消息" initialHistory={[]} deps={deps} onSubmit={onSubmit} />);
    await tick();
    stdin.write('你好');
    await tick();
    expect(lastFrame()).toContain('你好');
    stdin.write('\r');
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('你好', '你好');
    expect(lastFrame()).toContain('输入消息');
  });

  it('斜杠命令提示，Tab 补全', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<InputBox active placeholder="" initialHistory={[]} deps={deps} onSubmit={onSubmit} />);
    await tick();
    stdin.write('/co');
    await tick();
    expect(lastFrame()).toContain('/context');
    expect(lastFrame()).toContain('上下文占用');
    stdin.write('\t');
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('/context', '/context ');
  });

  it('行尾反斜杠 + 回车 = 换行而不提交', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<InputBox active placeholder="" initialHistory={[]} deps={deps} onSubmit={onSubmit} />);
    await tick();
    stdin.write('第一行\\');
    await tick();
    stdin.write('\r');
    await tick();
    stdin.write('第二行');
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('第二行');
  });

  it('↑ 取历史', async () => {
    const { stdin, lastFrame } = render(<InputBox active placeholder="" initialHistory={['上一次的问题']} deps={deps} onSubmit={vi.fn()} />);
    await tick();
    stdin.write('\u001B[A');
    await tick();
    expect(lastFrame()).toContain('上一次的问题');
  });
});
