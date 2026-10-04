import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MapToolServices } from '../../src/tools/tool.js';
import type { ToolContext } from '../../src/tools/tool.js';

export async function makeTmpDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'roastcli-test-'));
}

export function makeCtx(cwd: string): ToolContext & { controller: AbortController } {
  const controller = new AbortController();
  return { cwd, signal: controller.signal, services: new MapToolServices(), controller };
}

export function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}
