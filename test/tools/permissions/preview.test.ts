import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InteractionBroker } from '../../../src/core/interaction.js';
import { PermissionEngine } from '../../../src/tools/permissions/engine.js';
import { permissionHook } from '../../../src/tools/permissions/hook.js';
import { approvalPreview } from '../../../src/tools/permissions/preview.js';
import { executeTool } from '../../../src/tools/executor.js';
import { readTool } from '../../../src/tools/read/index.js';
import { writeTool } from '../../../src/tools/write/index.js';
import { editTool } from '../../../src/tools/edit/index.js';
import { multiEditTool } from '../../../src/tools/multi-edit/index.js';
import { tempWorkspace } from '../../fixtures/workspace.js';
import { makeCtx } from '../helpers.js';
describe('permission previews', () => {
  it('previews edit, sequential multi_edit and write before approval without modifying bytes', async () => {
    const ws = tempWorkspace(), ctx = makeCtx(ws.dir), engine = new PermissionEngine({ mode: 'default', allow: [], deny: [], ask: [] }), broker = new InteractionBroker();
    ws.file('a.txt', 'before\r\nsecond\r\n'); await executeTool(readTool, { path: 'a.txt' }, ctx);
    let seen = 0;
    broker.onRequest((request) => {
      expect(request.kind).toBe('permission'); if (request.kind !== 'permission') return;
      expect(readFileSync(`${ws.dir}/a.txt`, 'utf8')).toBe('before\r\nsecond\r\n');
      expect(request.preview).toContain('-before'); expect(request.preview?.some((line) => line.startsWith('+after'))).toBe(true);
      expect(request.fullDetail).toContain('+'); seen++; broker.respond(request.id, { kind: 'permission', decision: 'deny' });
    });
    const hooks = { preExecute: [permissionHook({ engine, broker })], postExecute: [] };
    await executeTool(editTool, { path: 'a.txt', old_string: 'before', new_string: 'after' }, ctx, hooks);
    await executeTool(multiEditTool, { path: 'a.txt', edits: [{ old_string: 'before', new_string: 'middle' }, { old_string: 'middle', new_string: 'after' }] }, ctx, hooks);
    await executeTool(writeTool, { path: 'a.txt', content: 'after\n' }, ctx, hooks);
    expect(seen).toBe(3);
    expect(await approvalPreview('edit', { path: '\\\\untrusted-host\\secret', old_string: '', new_string: '' }, ctx, engine)).toBeUndefined();
    expect(await approvalPreview('edit', { path: '../outside', old_string: '', new_string: '' }, ctx, engine)).toBeUndefined();
    expect(await approvalPreview('bash', { command: 'run' }, ctx, engine)).toBeUndefined();
  });
  it('previews a new file, skips invalid edits and honors read deny rules', async () => {
    const ws = tempWorkspace(), ctx = makeCtx(ws.dir), engine = new PermissionEngine({ mode: 'default', allow: [], deny: [], ask: [] });
    expect(await approvalPreview('write', { path: 'new.txt', content: 'new\n' }, ctx, engine)).toMatchObject({ preview: expect.arrayContaining(['+new']) });
    expect(await approvalPreview('edit', { path: 'missing', old_string: 'x', new_string: 'y' }, ctx, engine)).toBeUndefined();
    const denied = new PermissionEngine({ mode: 'default', allow: [], ask: [], deny: ['read'] });
    expect(await approvalPreview('write', { path: 'new.txt', content: 'new' }, ctx, denied)).toBeUndefined();
  });
});
