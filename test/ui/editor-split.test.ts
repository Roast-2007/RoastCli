import { describe, expect, it } from 'vitest';
import { createEditor, editorReducer, expand, textOf, type EditorAction, type EditorState } from '../../src/ui/input/editor.js';
import { splitStreaming } from '../../src/ui/markdown/split.js';

const run = (s: EditorState, ...actions: EditorAction[]) => actions.reduce(editorReducer, s);

describe('splitStreaming', () => {
  it('完成的段落进入 complete，最后一个块留在 rest', () => {
    const r = splitStreaming('# 标题\n\n第一段。\n\n第二段还在写');
    expect(r.complete).toEqual(['# 标题', '第一段。']);
    expect(r.rest).toBe('第二段还在写');
  });

  it('未闭合的代码块整体留在 rest', () => {
    const r = splitStreaming('说明\n\n```ts\nconst a = 1;\n');
    expect(r.complete).toEqual(['说明']);
    expect(r.rest.startsWith('```ts')).toBe(true);
  });

  it('只有一个块时什么都不提交', () => {
    expect(splitStreaming('半句话')).toEqual({ complete: [], rest: '半句话' });
  });
});

describe('editorReducer', () => {
  it('插入、换行、退格跨行合并', () => {
    let s = run(createEditor(), { type: 'insert', text: 'ab' }, { type: 'newline' }, { type: 'insert', text: 'cd' });
    expect(s.lines).toEqual(['ab', 'cd']);
    s = run(s, { type: 'home' }, { type: 'backspace' });
    expect(s.lines).toEqual(['abcd']);
    expect(s.col).toBe(2);
  });

  it('按词删除（含中文）与删到行首', () => {
    const s = run(createEditor(), { type: 'insert', text: 'git commit 中文词' }, { type: 'deleteWordLeft' });
    expect(textOf(s)).toBe('git commit ');
    expect(textOf(run(s, { type: 'killToStart' }))).toBe('');
  });

  it('历史浏览：↑ 取上一条并保留草稿，↓ 回到草稿', () => {
    let s = run(createEditor(['first', 'second']), { type: 'insert', text: 'draft' });
    s = run(s, { type: 'up' });
    expect(textOf(s)).toBe('second');
    s = run(s, { type: 'up' });
    expect(textOf(s)).toBe('first');
    s = run(s, { type: 'down' }, { type: 'down' });
    expect(textOf(s)).toBe('draft');
  });

  it('多行粘贴折叠为占位，提交时展开；commit 记入历史并清空', () => {
    const pasted = Array.from({ length: 8 }, (_, i) => `line ${i}`).join('\n');
    let s = run(createEditor(), { type: 'insert', text: '看看：' }, { type: 'paste', text: pasted });
    expect(textOf(s)).toBe('看看：[粘贴 8 行 #1]');
    expect(expand(s)).toBe(`看看：${pasted}`);
    s = run(s, { type: 'commit' });
    expect(textOf(s)).toBe('');
    expect(s.history).toEqual([`看看：${pasted}`]);
  });

  it('短粘贴直接插入', () => {
    expect(textOf(run(createEditor(), { type: 'paste', text: 'a\nb' }))).toBe('a\nb');
  });
});
