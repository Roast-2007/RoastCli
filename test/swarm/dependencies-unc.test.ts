import path from 'node:path';
import { lstat, readlink, realpath } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { copyDependencies } from '../../src/swarm/dependencies.js';

vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>(), lstat: vi.fn(), readlink: vi.fn(), realpath: vi.fn() }));

it('refuses a chain of dependency links to UNC before any realpath or copy', async () => {
  const source = path.resolve('/fixture/node_modules');
  vi.mocked(lstat).mockImplementation(async (file) => ({ isSymbolicLink: () => ['node_modules', 'redirect'].includes(path.basename(String(file))) }) as Awaited<ReturnType<typeof lstat>>);
  vi.mocked(readlink).mockImplementation(async (file) => path.basename(String(file)) === 'node_modules' ? path.resolve('/fixture/redirect') : '//blocked.example/share');
  await expect(copyDependencies(source, path.resolve('/private/node_modules'), path.resolve('/fixture'), path.resolve('/private'))).rejects.toThrow('UNC');
  expect(realpath).not.toHaveBeenCalled();
});
