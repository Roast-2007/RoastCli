import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { copyDependencies } from '../../src/swarm/dependencies.js';
import { tempWorkspace } from '../fixtures/workspace.js';

describe('pnpm 布局副本', () => {
  it.each(['internal', 'external', 'yaml'])('%s：只改内部 JSON store，源文件不变', async (kind) => {
    const { dir } = tempWorkspace();
    const source = path.join(dir, 'repo', 'node_modules'),
      target = path.join(dir, 'wt', 'node_modules');
    mkdirSync(source, { recursive: true });
    const raw =
      kind === 'yaml'
        ? 'virtualStoreDir: .pnpm\r\n'
        : JSON.stringify({ virtualStoreDir: path.join(kind === 'internal' ? source : dir, '.pnpm'), other: { x: 1 } }, null, 2).replace(
            /\n/g,
            '\r\n',
          ) + '\r\n';
    writeFileSync(path.join(source, '.modules.yaml'), raw);
    await copyDependencies(source, target, path.dirname(source), path.dirname(target));
    expect(readFileSync(path.join(source, '.modules.yaml'), 'utf8')).toBe(raw);
    const result = readFileSync(path.join(target, '.modules.yaml'), 'utf8');
    if (kind === 'internal') {
      expect(JSON.parse(result)).toEqual({ virtualStoreDir: path.join(target, '.pnpm'), other: { x: 1 } });
      expect(result.replace(/\r\n/g, '')).not.toContain('\n');
    } else expect(result).toBe(raw);
  });
});
