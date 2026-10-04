import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tempWorkspace } from '../fixtures/workspace.js';
import { ShadowGit } from '../../src/ext/audit/shadow-git.js';

describe('checkpoints without git', () => {
  it('restores binary bytes, deleted files and removes additions while preserving excluded state', async () => {
    const ws = tempWorkspace();
    ws.file('a.txt', 'original\r\n');
    ws.file('deleted.txt', 'keep');
    ws.file('.roast/config.json', 'state');
    const bytes = Buffer.from([0, 255, 128, 13, 10]);
    writeFileSync(path.join(ws.dir, 'binary.bin'), bytes);
    const shadow = new ShadowGit(ws.dir, undefined, { gitCommand: 'roast-nonexistent-git' });
    const saved = await shadow.snapshot('before');
    expect(saved).toMatch(/^files:/);
    ws.file('a.txt', 'changed'); ws.file('added.txt', 'new'); ws.file('.roast/config.json', 'new state');
    writeFileSync(path.join(ws.dir, 'binary.bin'), Buffer.from([1]));
    unlinkSync(path.join(ws.dir, 'deleted.txt'));
    const result = await shadow.restore(saved!);
    expect(readFileSync(path.join(ws.dir, 'binary.bin'))).toEqual(bytes);
    expect(readFileSync(path.join(ws.dir, 'a.txt'), 'utf8')).toBe('original\r\n');
    expect(existsSync(path.join(ws.dir, 'deleted.txt'))).toBe(true);
    expect(existsSync(path.join(ws.dir, 'added.txt'))).toBe(false);
    expect(readFileSync(path.join(ws.dir, '.roast/config.json'), 'utf8')).toBe('new state');
    expect(result.deleted).toContain('added.txt');
    await shadow.restore(result.backup);
    expect(readFileSync(path.join(ws.dir, 'a.txt'), 'utf8')).toBe('changed');
    expect(existsSync(path.join(ws.dir, 'added.txt'))).toBe(true);
  });
  it('rejects forged checkpoint identities without modifying the workspace', async () => {
    const ws = tempWorkspace(); ws.file('keep.txt', 'keep');
    const shadow = new ShadowGit(ws.dir, undefined, { gitCommand: 'roast-nonexistent-git' });
    await expect(shadow.restore('files:../../outside')).rejects.toThrow('检查点');
    expect(readFileSync(path.join(ws.dir, 'keep.txt'), 'utf8')).toBe('keep');
  });
});
