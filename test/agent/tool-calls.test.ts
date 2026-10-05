import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { executeToolCalls, toolResultsMessage } from '../../src/agent/tool-calls.js';
import { ToolRegistry, defineTool, textResult } from '../../src/tools/index.js';
import type { ToolCallBlock } from '../../src/core/types.js';
import { makeCtx } from '../tools/helpers.js';

describe('tool call scheduling', () => {
  const call = (name: string): ToolCallBlock => ({ type: 'tool-call', id: name, name, args: {} });
  it('runs readers concurrently, isolates writes and returns results in model order', async () => {
    const registry = new ToolRegistry(),
      completed: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const name of ['slow', 'fast', 'write', 'tail'])
      registry.register(
        defineTool({
          name,
          description: '',
          parameters: z.object({}),
          isReadOnly: name !== 'write',
          isConcurrencySafe: name !== 'write',
          execute: async () => {
            if (name === 'slow') await gate;
            if (name === 'fast') {
              completed.push(name);
              release();
              return textResult(name);
            }
            if (name === 'write') expect(completed).toEqual(['fast', 'slow']);
            if (name === 'tail') expect(completed).toContain('write');
            completed.push(name);
            return textResult(name);
          },
        }),
      );
    const outcomes = await executeToolCalls(['slow', 'fast', 'write', 'tail'].map(call), registry, makeCtx('.'));
    expect(completed).toEqual(['fast', 'slow', 'write', 'tail']);
    expect(toolResultsMessage(outcomes).content.map((b) => b.toolCallId)).toEqual(['slow', 'fast', 'write', 'tail']);
  });
  it('pairs both interrupted and not-started calls with error results', async () => {
    const registry = new ToolRegistry(),
      abort = new AbortController();
    let tailRan = false;
    registry.register(
      defineTool({
        name: 'active',
        description: '',
        parameters: z.object({}),
        isReadOnly: false,
        isConcurrencySafe: false,
        execute: async () => {
          abort.abort();
          await Promise.resolve();
          abort.signal.throwIfAborted();
          return textResult('unreachable');
        },
      }),
    );
    registry.register(
      defineTool({
        name: 'tail',
        description: '',
        parameters: z.object({}),
        isReadOnly: false,
        isConcurrencySafe: false,
        execute: async () => {
          tailRan = true;
          return textResult('tail');
        },
      }),
    );
    const outcomes = await executeToolCalls(['active', 'tail'].map(call), registry, { ...makeCtx('.'), signal: abort.signal });
    expect(tailRan).toBe(false);
    expect(outcomes[0]!.result.metadata).toMatchObject({ aborted: true, inFlight: true });
    expect(outcomes[1]!.result.metadata).toMatchObject({ aborted: true, inFlight: false });
    expect(toolResultsMessage(outcomes).content.every((b) => b.isError)).toBe(true);
  });
});
