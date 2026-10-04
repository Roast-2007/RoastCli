import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findInstructionFiles, renderInstructions } from '../../src/ext/instructions.js';
import { tempWorkspace } from '../fixtures/workspace.js';

describe('项目指令文件', () => {
  it('用户级 + 自仓库根向下到 cwd 的每层取第一个匹配（ROAST.md > AGENTS.md > CLAUDE.md）', () => {
    const home = tempWorkspace('roast-ih-').dir;
    const repo = tempWorkspace('roast-ir-');
    mkdirSync(path.join(repo.dir, '.git'));
    repo.file('AGENTS.md', '根目录约定');
    repo.file('CLAUDE.md', '不应被读取（同层已有 AGENTS.md）');
    repo.file('pkg/app/ROAST.md', '子包约定');
    writeFileSync(path.join(home, 'ROAST.md'), '用户偏好', 'utf8');
    const cwd = path.join(repo.dir, 'pkg', 'app');

    const files = findInstructionFiles(cwd, { home });
    expect(files.map((f) => [f.scope, path.basename(f.path), f.text])).toEqual([
      ['user', 'ROAST.md', '用户偏好'],
      ['project', 'AGENTS.md', '根目录约定'],
      ['project', 'ROAST.md', '子包约定'],
    ]);
  });

  it('不越过仓库根向上查找', () => {
    const outer = tempWorkspace('roast-io-');
    outer.file('AGENTS.md', '仓库外的文件');
    mkdirSync(path.join(outer.dir, 'repo', '.git'), { recursive: true });
    const files = findInstructionFiles(path.join(outer.dir, 'repo'), { home: tempWorkspace('roast-ih2-').dir });
    expect(files).toEqual([]);
  });

  it('渲染：标注来源，超长截断', () => {
    const text = renderInstructions(
      [
        { scope: 'project', path: '/p/AGENTS.md', text: 'a'.repeat(50) },
        { scope: 'project', path: '/p/sub/ROAST.md', text: 'b'.repeat(50) },
      ],
      60,
    );
    expect(text).toContain('/p/AGENTS.md');
    expect(text).toContain('已截断');
    expect(text.length).toBeLessThan(400);
  });

  it('没有文件时渲染为空串', () => {
    expect(renderInstructions([], 1000)).toBe('');
  });
});
