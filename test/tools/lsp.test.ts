import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findReferencesTool, renameSymbolTool } from '../../src/tools/lsp/index.js';
import { executeTool } from '../../src/tools/executor.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { makeCtx, textOf } from './helpers.js';
import { permissionHook } from '../../src/tools/permissions/hook.js';
import { PermissionEngine } from '../../src/tools/permissions/engine.js';
import { InteractionBroker } from '../../src/core/interaction.js';

function workspace() {
  const ws = tempWorkspace('roast-lsp-');
  ws.file('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs' }, include: ['*.ts'] }));
  ws.file('a.ts', 'export const shared = 1;\r\nexport function other() { const shared = 2; return shared; }\r\n');
  ws.file('b.ts', 'import { shared } from "./a";\r\nconsole.log(shared); // shared in a comment\r\n');
  return ws;
}
const at = { path: 'a.ts', line: 1, column: 14 };
// Real TypeScript projects load standard libraries; preview + apply builds two services.
// Coverage and four concurrent workers can exceed the default 5s on hosted runners.
describe('semantic tools', { timeout: 20_000 }, () => {
  it('finds cross-file references while excluding an unrelated local symbol', async () => {
    const ws = workspace();
    const found = await executeTool(findReferencesTool, at, makeCtx(ws.dir));
    expect(found.isError).toBeUndefined();
    const refs = JSON.parse(textOf(found)).references as Array<{ path: string; line: number }>;
    expect(refs).toHaveLength(3);
    expect(refs.filter((ref) => ref.path === 'a.ts')).toEqual([expect.objectContaining({ line: 1 })]);
    expect(refs.filter((ref) => ref.path === 'b.ts')).toHaveLength(2);
  });
  it('previews without writes, then applies a cross-file rename preserving CRLF and import aliases', async () => {
    const ws = workspace(),
      ctx = makeCtx(ws.dir);
    const before = readFileSync(path.join(ws.dir, 'a.ts'), 'utf8');
    const plan = await executeTool(renameSymbolTool, { ...at, new_name: 'renamed' }, ctx);
    expect(plan.isError).toBeUndefined();
    expect(JSON.parse(textOf(plan)).applied).toBe(false);
    expect(readFileSync(path.join(ws.dir, 'a.ts'), 'utf8')).toBe(before);
    const renamed = await executeTool(renameSymbolTool, { ...at, new_name: 'renamed', apply: true }, ctx);
    expect(renamed.isError).toBeUndefined();
    expect(readFileSync(path.join(ws.dir, 'a.ts'), 'utf8')).toContain('export const renamed = 1;\r\n');
    expect(readFileSync(path.join(ws.dir, 'a.ts'), 'utf8')).toContain('const shared = 2; return shared');
    expect(readFileSync(path.join(ws.dir, 'b.ts'), 'utf8')).toContain('// shared in a comment\r\n');
    expect(renamed.metadata?.['fileStates']).toBeDefined();
  });
  it('rejects a denied secondary file before modifying any file', async () => {
    const ws = workspace(),
      ctx = makeCtx(ws.dir);
    const engine = new PermissionEngine({ mode: 'acceptEdits', allow: [], ask: [], deny: ['rename_symbol(*b.ts)'] });
    const hooks = { preExecute: [permissionHook({ engine, broker: new InteractionBroker() })], postExecute: [] };
    const denied = await executeTool(renameSymbolTool, { ...at, new_name: 'newValue', apply: true }, ctx, hooks);
    expect(denied.isError).toBe(true);
    expect(readFileSync(path.join(ws.dir, 'a.ts'), 'utf8')).toContain('export const shared');
    expect(readFileSync(path.join(ws.dir, 'b.ts'), 'utf8')).toContain('import { shared }');
  });
  it('rejects an invalid location, unsupported language, and files outside the workspace', async () => {
    const ws = workspace(),
      ctx = makeCtx(ws.dir);
    ws.file('a.py', 'shared = 1');
    expect((await executeTool(findReferencesTool, { ...at, line: 100 }, ctx)).isError).toBe(true);
    expect((await executeTool(findReferencesTool, { ...at, path: 'a.py' }, ctx)).isError).toBe(true);
    expect((await executeTool(renameSymbolTool, { ...at, path: '../outside.ts', new_name: 'x' }, ctx)).isError).toBe(true);
    expect((await executeTool(renameSymbolTool, { ...at, new_name: 'class', apply: true }, ctx)).isError).toBe(true);
    expect(readFileSync(path.join(ws.dir, 'a.ts'), 'utf8')).toContain('export const shared');
  });
});
