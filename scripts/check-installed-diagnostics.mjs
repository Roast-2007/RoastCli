import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const packageRoot = process.argv[2];
assert.ok(packageRoot, 'Usage: node scripts/check-installed-diagnostics.mjs <installed-package-root>');
const project = await mkdtemp(path.join(os.tmpdir(), 'roast-installed-diagnostics-'));
let worker;
try {
  await writeFile(
    path.join(project, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, types: [], skipLibCheck: true } }),
  );
  const file = path.join(project, 'a.ts');
  await writeFile(file, 'export const value = 1;');
  worker = new Worker(pathToFileURL(path.join(packageRoot, 'dist', 'diagnostics-worker.js')));
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Installed diagnostics worker timed out')), 15000);
    const finish = (callback, value) => {
      clearTimeout(timer);
      callback(value);
    };
    worker.once('message', (message) => finish(resolve, message));
    worker.once('error', (error) => finish(reject, error));
    worker.once('exit', (code) => finish(reject, new Error(`Worker exited before replying: ${code}`)));
    worker.postMessage({ id: 1, kind: 'check', file, text: 'export const value: number = "wrong";' });
  });
  assert.equal(reply.id, 1);
  assert.equal(reply.error, undefined);
  assert.ok(
    reply.diagnostics.some((item) => item.code === 2322),
    'Installed worker did not return the TypeScript error',
  );
  console.log('Installed diagnostics worker passed: TypeScript semantic error returned.');
} finally {
  await worker?.terminate();
  await rm(project, { recursive: true, force: true });
}
