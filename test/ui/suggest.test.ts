import { describe, expect, it } from 'vitest';
import { createEditor, editorReducer, textOf } from '../../src/ui/input/editor.js';
import { fuzzyScore, rankFiles } from '../../src/ui/input/files.js';
import { suggestions } from '../../src/ui/input/suggest.js';

const commands = [
  { name: 'compact', description: '压缩上下文', args: '[焦点]' },
  { name: 'context', description: '上下文占用' },
  { name: 'exit', description: '退出' },
];
const files = ['src/ui/App.tsx', 'src/agent/runtime.ts', 'README.md'];
const deps = { commands, files: (q: string) => rankFiles(q, files) };

describe('suggestions', () => {
  it('斜杠命令前缀匹配，应用后补全并加空格', () => {
    const s = editorReducer(createEditor(), { type: 'insert', text: '/co' });
    const list = suggestions(s, deps);
    expect(list.map((x) => x.label)).toEqual(['/compact [焦点]', '/context']);
    expect(textOf(list[0]!.apply(s))).toBe('/compact ');
  });

  it('输入空格后不再提示命令', () => {
    expect(suggestions(editorReducer(createEditor(), { type: 'insert', text: '/compact x' }), deps)).toEqual([]);
  });

  it('@ 文件模糊匹配，替换光标前的 @ 词', () => {
    const s = editorReducer(createEditor(), { type: 'insert', text: '看下 @rtm' });
    const list = suggestions(s, deps);
    expect(list[0]!.label).toBe('@src/agent/runtime.ts');
    const applied = list[0]!.apply(s);
    expect(textOf(applied)).toBe('看下 @src/agent/runtime.ts ');
    expect(applied.col).toBe(textOf(applied).length);
  });
});

describe('fuzzyScore', () => {
  it('子序列匹配，文件名命中优先，不匹配返回 null', () => {
    expect(fuzzyScore('app', 'src/ui/App.tsx')).not.toBeNull();
    expect(fuzzyScore('zzz', 'src/ui/App.tsx')).toBeNull();
    expect(rankFiles('app', ['src/app/zzz.ts', 'src/ui/App.tsx'])[0]).toBe('src/ui/App.tsx');
  });
});
