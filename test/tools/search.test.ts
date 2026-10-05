import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeTool } from '../../src/tools/executor.js';
import { globTool } from '../../src/tools/search/glob.js';
import { grepTool } from '../../src/tools/search/grep.js';
import { lsTool } from '../../src/tools/search/ls.js';
import { locateRipgrep, resetRipgrepCache } from '../../src/tools/search/rg.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { makeCtx, textOf } from './helpers.js';

function workspace() {
  const ws = tempWorkspace('roast-search-');
  ws.file('src/a.ts', 'export const alpha = 1;\n// TODO: refine\n');
  ws.file('src/b.tsx', 'const Beta = () => null;\n');
  ws.file('docs/readme.md', '# Alpha docs\n');
  ws.file('node_modules/x/index.js', 'alpha in deps\n');
  return ws;
}

const modes: [string, () => void][] = [
  ['ripgrep', () => {}],
  [
    '打包的 ripgrep（空 PATH）',
    () => {
      process.env['ROAST_RG_PATH'] = '';
      process.env['PATH_BACKUP'] = process.env['PATH'];
      process.env['PATH'] = '';
    },
  ],
];

afterEach(() => {
  if (process.env['PATH_BACKUP'] !== undefined) {
    process.env['PATH'] = process.env['PATH_BACKUP'];
    delete process.env['PATH_BACKUP'];
  }
  delete process.env['ROAST_RG_PATH'];
  resetRipgrepCache();
});

describe.each(modes)('搜索工具（%s）', (name, prepare) => {
  const hasRg = locateRipgrep().path !== null;

  it('supports type, context and multiline without a system rg', async () => {
    prepare(); resetRipgrepCache();
    if (name !== 'ripgrep') expect(locateRipgrep().source).toContain('bundled');
    const ws = workspace();
    const r = await executeTool(grepTool, { pattern: 'alpha.*TODO', type: 'ts', multiline: true, context: 1, output_mode: 'content' }, makeCtx(ws.dir));
    expect(textOf(r)).toContain('alpha = 1'); expect(textOf(r)).toContain('TODO: refine');
    expect(textOf(r)).not.toContain('Alpha docs');
  });

  it.skipIf(name === 'ripgrep' && !hasRg)('glob：按模式找文件，忽略 node_modules', async () => {
    prepare();
    resetRipgrepCache();
    const ws = workspace();
    const r = await executeTool(globTool, { pattern: '**/*.ts*' }, makeCtx(ws.dir));
    const text = textOf(r);
    expect(text).toContain('src/a.ts');
    expect(text).toContain('src/b.tsx');
    expect(text).not.toContain('node_modules');
  });

  it.skipIf(name === 'ripgrep' && !hasRg)('grep：files / content / count 三种模式', async () => {
    prepare();
    resetRipgrepCache();
    const ws = workspace();
    const ctx = makeCtx(ws.dir);
    const files = textOf(await executeTool(grepTool, { pattern: 'alpha', case_insensitive: true }, ctx));
    expect(files).toContain('a.ts');
    expect(files).toContain('readme.md');
    expect(files).not.toContain('node_modules');

    const content = textOf(await executeTool(grepTool, { pattern: 'TODO', output_mode: 'content' }, ctx));
    expect(content).toMatch(/a\.ts:2:\/\/ TODO: refine/);

    const count = textOf(await executeTool(grepTool, { pattern: 'const', output_mode: 'count', glob: '*.ts*' }, ctx));
    expect(count).toMatch(/a\.ts:1/);

    const none = await executeTool(grepTool, { pattern: 'zzz_nope' }, ctx);
    expect(textOf(none)).toContain('没有找到');
  });
});

describe('ls 工具', () => {
  it('目录在前，跳过 node_modules，支持 ignore', async () => {
    const ws = workspace();
    ws.file('build.log', 'x');
    const text = textOf(await executeTool(lsTool, { ignore: ['*.log'] }, makeCtx(ws.dir)));
    const lines = text.split('\n').slice(1);
    expect(lines[0]).toBe('docs/');
    expect(lines[1]).toBe('src/');
    expect(text).not.toContain('node_modules');
    expect(text).not.toContain('build.log');
  });

  it('不存在的目录返回错误', async () => {
    const r = await executeTool(lsTool, { path: path.join('no', 'such') }, makeCtx(tempWorkspace().dir));
    expect(r.isError).toBe(true);
  });
});
