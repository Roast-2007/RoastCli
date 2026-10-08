import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { combinePrompt, readPipedStdin } from '../../src/cli/stdin.js';
import { parseBudget, parseMaxSteps, parseToolRules } from '../../src/cli/headless-options.js';

describe('piped stdin', () => {
  const stream = (tty = false) => Object.assign(Readable.from([Buffer.from('\uFEFF你好\n')]), { isTTY: tty });
  const pipe = () => ({ isCharacterDevice: () => false });
  it('reads pipes, including Windows pipes that are neither FIFO nor file, and removes UTF-8 BOM', async () => {
    expect(await readPipedStdin({ stdin: stream(), fstat: pipe })).toBe('你好\n');
  });
  it('never iterates TTY, character devices, or inaccessible stdin', async () => {
    const stdin = {
      isTTY: false,
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        throw new Error('must not read');
      },
    };
    expect(await readPipedStdin({ stdin, fstat: () => ({ isCharacterDevice: () => true }) })).toBeUndefined();
    expect(
      await readPipedStdin({
        stdin,
        fstat: () => {
          throw new Error('closed');
        },
      }),
    ).toBeUndefined();
    expect(
      await readPipedStdin({
        stdin: { ...stdin, isTTY: true },
        fstat: () => {
          throw new Error('must not stat');
        },
      }),
    ).toBeUndefined();
  });
  it('limits bytes rather than characters and ignores blank input', async () => {
    await expect(readPipedStdin({ stdin: stream(), maxBytes: 4, fstat: pipe })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(await readPipedStdin({ stdin: Readable.from([' \n\t']), fstat: pipe })).toBeUndefined();
    expect(combinePrompt('', 'diff')).toBe('diff');
    expect(combinePrompt('review', 'diff')).toBe('review\n\n<stdin>\ndiff\n</stdin>');
    expect(combinePrompt('review')).toBe('review');
  });
  it('gives up on a silent pipe after the first-byte wait, but reads a slow stream once data starts', async () => {
    let released = false;
    const silent = new PassThrough();
    silent.on('close', () => {
      released = true;
    });
    const onSkip = vi.fn();
    expect(await readPipedStdin({ stdin: silent, fstat: pipe, waitMs: 20, onSkip })).toBeUndefined();
    expect(onSkip).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(released).toBe(true));

    const slow = new PassThrough();
    const reading = readPipedStdin({ stdin: slow, fstat: pipe, waitMs: 50 });
    slow.write('first ');
    setTimeout(() => slow.end('second'), 120);
    expect(await reading).toBe('first second');
  });
});
describe('process options', () => {
  it('splits only top-level commas and validates malformed rules', () => {
    expect(parseToolRules(['bash(echo a,b),edit(src/**)', 'mcp__github__*'])).toEqual(['bash(echo a,b)', 'edit(src/**)', 'mcp__github__*']);
    for (const value of ['bash(', 'bash)', 'bash()', ',read', 'read junk', 'read(x)junk']) expect(() => parseToolRules([value])).toThrow();
  });
  it('validates max steps and headless-only budgets', () => {
    expect(parseMaxSteps('1000')).toBe(1000);
    for (const value of ['0', '1001', '1.1', 'NaN']) expect(() => parseMaxSteps(value)).toThrow();
    expect(parseBudget('0.1', true)).toBe(0.1);
    for (const value of ['0', '-1', 'Infinity']) expect(() => parseBudget(value, true)).toThrow();
    expect(() => parseBudget('1', false)).toThrow('仅可用于');
  });
});
