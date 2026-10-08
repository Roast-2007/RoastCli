import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticsCore, newDiagnostics } from '../../src/tools/lsp/diagnostics-core.js';
import { DIAGNOSTICS_KEY, DiagnosticsHost, diagnosticsConfig, type DiagnosticWorker } from '../../src/tools/lsp/diagnostics.js';
import { readTool } from '../../src/tools/read/index.js';
import { editTool } from '../../src/tools/edit/index.js';
import { writeTool } from '../../src/tools/write/index.js';
import { multiEditTool } from '../../src/tools/multi-edit/index.js';
import { commitWrite } from '../../src/tools/file-ops.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { makeCtx, textOf } from './helpers.js';

function project() {
  const ws = tempWorkspace();
  ws.file('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true, noLib: true, types: [] } }));
  return ws;
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe('TypeScript diagnostic core', () => {
  it('reports syntax and semantic errors while excluding preexisting errors after line shifts', () => {
    const ws = project(),
      file = ws.file('a.ts', 'const old = missing;\n'),
      core = new DiagnosticsCore();
    try {
      const before = core.check(file, 'const old = missing;\n');
      const after = core.check(file, '\n\nconst old = missing;\nconst x: number = "wrong";\n');
      expect(newDiagnostics(before, after)).toEqual([expect.objectContaining({ line: 4, code: 2322 })]);
      expect(newDiagnostics(before, core.check(file, '\nconst old = missing;\n'))).toEqual([]);
      expect(core.check(file, 'const = ;')).toEqual(expect.arrayContaining([expect.objectContaining({ code: 1134 })]));
      expect(newDiagnostics([], core.check(path.join(ws.dir, 'new.ts'), 'export const x = mysteryQuuxSymbol;'))).toEqual([
        expect.objectContaining({ code: 2304 }),
      ]);
    } finally {
      core.dispose();
    }
  });
  it('uses a multiset rather than deleting all repeated errors, and detects external dependency changes', () => {
    const d = { line: 1, column: 1, code: 2304, message: 'missing' };
    expect(newDiagnostics([d], [d, { ...d, line: 2 }])).toEqual([{ ...d, line: 2 }]);
    const ws = project(),
      core = new DiagnosticsCore();
    ws.file('b.ts', 'export const value = 1;');
    const file = ws.file('a.ts', 'import { value } from "./b"; const n: number = value;');
    try {
      expect(core.check(file)).toEqual([]);
      ws.file('b.ts', 'export const value = "now a string";');
      expect(core.check(file)).toEqual([expect.objectContaining({ code: 2322 })]);
      for (let i = 0; i < 3; i++) {
        const next = project();
        expect(core.check(next.file('a.ts', 'const n = missing;'))).toHaveLength(1);
      }
      expect(core.check(file)).toHaveLength(1);
    } finally {
      core.dispose();
    }
  });
  it('skips unconfigured projects and configurations outside the agent workspace', () => {
    const ws = tempWorkspace(),
      file = ws.file('a.ts', 'missing');
    expect(diagnosticsConfig(file, ws.dir)).toBeUndefined();
    ws.file('tsconfig.json', '{}');
    expect(diagnosticsConfig(file, ws.dir)).toBe(path.join(ws.dir, 'tsconfig.json'));
    const nested = ws.file('sub/a.ts', 'missing');
    expect(diagnosticsConfig(nested, path.dirname(nested))).toBeUndefined();
    expect(diagnosticsConfig(file, tempWorkspace().dir)).toBeUndefined();
  });
});
describe('diagnostic worker host', () => {
  it('shares one worker across member workspaces and only the owning host shuts it down', async () => {
    const main = project(),
      member = project(),
      mainFile = main.file('a.ts', ''),
      memberFile = member.file('a.ts', '');
    let started = 0,
      terminated = 0;
    const factory = () => {
      started++;
      const worker = Object.assign(new EventEmitter(), {
        unref() {},
        terminate: async () => {
          terminated++;
          return 0;
        },
        postMessage(message: { id: number }) {
          queueMicrotask(() => worker.emit('message', { id: message.id, diagnostics: [] }));
        },
      });
      return worker as unknown as DiagnosticWorker;
    };
    const host = new DiagnosticsHost(main.dir, {}, factory),
      memberHost = host.forWorkspace(member.dir);
    expect(memberHost.eligible(memberFile)).toBe(true);
    expect(memberHost.eligible(mainFile)).toBe(false);
    await host.check(mainFile, '');
    await memberHost.check(memberFile, '');
    expect(started).toBe(1);
    await memberHost.shutdown();
    expect(terminated).toBe(0);
    await host.shutdown();
    expect(terminated).toBe(1);
  });
  it('keeps captured file existence and aborts before writing when interrupted during the baseline', async () => {
    const ws = project(),
      file = ws.file('a.ts', ''),
      controller = new AbortController(),
      ctx = { ...makeCtx(ws.dir), signal: controller.signal };
    rmSync(file);
    await expect(commitWrite(file, '', 'content', false, ctx.services, { expectedExists: true })).rejects.toThrow('外部创建或删除');
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, '');
    await expect(commitWrite(file, '', 'content', false, ctx.services, { expectedExists: false })).rejects.toThrow('外部创建或删除');
    await readTool.execute({ path: file }, ctx);
    const factory = () => {
      const worker = Object.assign(new EventEmitter(), {
        unref() {},
        terminate: async () => 0,
        postMessage(message: { id: number }) {
          controller.abort();
          queueMicrotask(() => worker.emit('message', { id: message.id, diagnostics: [] }));
        },
      });
      return worker as unknown as DiagnosticWorker;
    };
    const host = new DiagnosticsHost(ws.dir, {}, factory);
    ctx.services.set(DIAGNOSTICS_KEY, host);
    try {
      await expect(writeTool.execute({ path: file, content: 'modified;' }, ctx)).rejects.toMatchObject({ name: 'AbortError' });
      expect(readFileSync(file, 'utf8')).toBe('');
    } finally {
      await host.shutdown();
    }
  });
  it('reports all after-errors when baseline fails, and skips disabled diagnostics', async () => {
    const ws = project(),
      file = ws.file('a.ts', 'const old = missing;'),
      ctx = makeCtx(ws.dir);
    await readTool.execute({ path: file }, ctx);
    let calls = 0;
    const factory = () => {
      const worker = Object.assign(new EventEmitter(), {
        unref() {},
        terminate: async () => 0,
        postMessage(message: { id: number }) {
          calls++;
          queueMicrotask(() =>
            worker.emit(
              'message',
              calls === 1
                ? { id: message.id, error: 'baseline unavailable' }
                : { id: message.id, diagnostics: [{ line: 1, column: 13, code: 2304, message: "Cannot find name 'missing'." }] },
            ),
          );
        },
      });
      return worker as unknown as DiagnosticWorker;
    };
    const host = new DiagnosticsHost(ws.dir, {}, factory);
    ctx.services.set(DIAGNOSTICS_KEY, host);
    try {
      const result = await editTool.execute({ path: file, old_string: 'const old', new_string: 'const renamed', replace_all: false }, ctx);
      expect(textOf(result)).toContain('含已有错误');
      expect(result.metadata?.['diagnostics']).toMatchObject({ includesExisting: true });
      vi.stubEnv('ROAST_DIAGNOSTICS', '0');
      const disabled = await writeTool.execute({ path: 'disabled.ts', content: 'unknownName;' }, ctx);
      expect(disabled.metadata?.['diagnostics']).toBeUndefined();
      expect(calls).toBe(2);
      expect(new DiagnosticsHost(ws.dir, { enabled: false }, factory).eligible(file)).toBe(false);
    } finally {
      await host.shutdown();
    }
  });
  it('refuses to overwrite a concurrent external edit made during the diagnostic baseline', async () => {
    const ws = project(),
      file = ws.file('a.ts', 'const value = 1;'),
      ctx = makeCtx(ws.dir);
    await readTool.execute({ path: file }, ctx);
    const factory = () => {
      const worker = Object.assign(new EventEmitter(), {
        unref() {},
        terminate: async () => 0,
        postMessage(message: { id: number }) {
          writeFileSync(file, 'external bytes\r\n');
          queueMicrotask(() => worker.emit('message', { id: message.id, diagnostics: [] }));
        },
      });
      return worker as unknown as DiagnosticWorker;
    };
    const host = new DiagnosticsHost(ws.dir, {}, factory);
    ctx.services.set(DIAGNOSTICS_KEY, host);
    try {
      await expect(editTool.execute({ path: file, old_string: '1', new_string: '2', replace_all: false }, ctx)).rejects.toThrow(
        '诊断期间被外部修改',
      );
      expect(readFileSync(file, 'utf8')).toBe('external bytes\r\n');
    } finally {
      await host.shutdown();
    }
  });
  it('delivers a warm-up timeout disable notice in the next writing tool only once', async () => {
    const ws = project(),
      file = ws.file('a.ts', 'const value = 1;'),
      ctx = makeCtx(ws.dir);
    vi.useFakeTimers();
    const factory = () =>
      Object.assign(new EventEmitter(), { postMessage() {}, unref() {}, terminate: async () => 0 }) as unknown as DiagnosticWorker;
    const host = new DiagnosticsHost(ws.dir, { timeoutMs: 1000 }, factory);
    ctx.services.set(DIAGNOSTICS_KEY, host);
    try {
      for (let n = 0; n < 3; n++) {
        host.warm(file);
        await vi.advanceTimersByTimeAsync(1001);
      }
      const result = await writeTool.execute({ path: 'next.ts', content: 'const value = 2;' }, ctx);
      expect(textOf(result)).toContain('诊断超时，本会话已停用自动诊断');
      expect(result.metadata?.['diagnostics']).toMatchObject({ notice: '诊断超时，本会话已停用自动诊断' });
      expect(textOf(await writeTool.execute({ path: 'another.ts', content: 'const value = 3;' }, ctx))).not.toContain('诊断');
    } finally {
      await host.shutdown();
    }
  });
  it('makes a real worker round trip and appends new errors with metadata without changing CRLF', async () => {
    const ws = project(),
      file = ws.file('a.ts', 'const old = existingError;\r\nconst value = 1;\r\n');
    const host = new DiagnosticsHost(ws.dir, { timeoutMs: 15000 }),
      ctx = makeCtx(ws.dir);
    ctx.services.set(DIAGNOSTICS_KEY, host);
    try {
      await readTool.execute({ path: file }, ctx);
      const result = await editTool.execute(
        { path: file, old_string: 'const value = 1;', new_string: 'const value = newError;', replace_all: false },
        ctx,
      );
      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toContain('新增 1 个 TypeScript 错误');
      expect(textOf(result)).toContain("Cannot find name 'newError'");
      expect(textOf(result)).not.toContain("Cannot find name 'existingError'");
      expect(result.metadata?.['diagnostics']).toMatchObject({ items: [expect.objectContaining({ line: 2 })], includesExisting: false });
      expect(readFileSync(file, 'utf8')).toBe('const old = existingError;\r\nconst value = newError;\r\n');
      const noNew = await multiEditTool.execute(
        { path: file, edits: [{ old_string: 'const value', new_string: '\nconst value', replace_all: false }] },
        ctx,
      );
      expect(textOf(noNew)).not.toContain('诊断：');
      const created = await writeTool.execute({ path: 'new.ts', content: 'export const value = anotherError;' }, ctx);
      expect(textOf(created)).toContain('新增 1 个');
    } finally {
      await host.shutdown();
    }
  }, 30000);
  it('terminates timed-out workers, restarts, and disables after three consecutive timeouts', async () => {
    const ws = project(),
      file = ws.file('a.ts', 'const x = missing;');
    vi.useFakeTimers();
    const workers: { terminate: ReturnType<typeof vi.fn> }[] = [];
    const factory = () => {
      const worker = Object.assign(new EventEmitter(), { postMessage() {}, unref() {}, terminate: vi.fn(async () => 0) });
      workers.push(worker);
      return worker as unknown as DiagnosticWorker;
    };
    const host = new DiagnosticsHost(ws.dir, { timeoutMs: 1000 }, factory);
    for (let n = 1; n <= 3; n++) {
      const pending = host.check(file);
      await vi.advanceTimersByTimeAsync(1001);
      expect(await pending).toMatchObject(n === 3 ? { notice: '诊断超时，本会话已停用自动诊断' } : { error: '诊断超时' });
    }
    expect(workers).toHaveLength(3);
    expect(workers.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
    expect(await host.check(file)).toEqual({});
    await host.shutdown();
  });
});
