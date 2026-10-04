import { describe, expect, it } from 'vitest';
import { BlockAssembler } from '../../src/agent/assembler.js';
import { reasoningTextScript } from '../fixtures/chunks.js';

describe('BlockAssembler', () => {
  it('reasoning 携带 signature', () => {
    const asm = new BlockAssembler();
    for (const c of reasoningTextScript('想一想', '答案', 'SIG')) asm.push(c);
    expect(asm.message().content).toEqual([
      { type: 'reasoning', text: '想一想', signature: 'SIG' },
      { type: 'text', text: '答案' },
    ]);
  });

  it('redacted reasoning 即使文本为空也保留', () => {
    const asm = new BlockAssembler();
    asm.push({ type: 'block-start', index: 0, block: 'reasoning', redactedData: 'ENC' });
    asm.push({ type: 'block-end', index: 0 });
    asm.push({ type: 'finish', reason: 'stop' });
    expect(asm.message().content).toEqual([{ type: 'reasoning', text: '', redactedData: 'ENC' }]);
  });
});

describe('BlockAssembler：只有签名的 thinking', () => {
  it('文本为空但带 signature 的 reasoning 保留（回放需要）', () => {
    const asm = new BlockAssembler();
    asm.push({ type: 'block-start', index: 0, block: 'reasoning' });
    asm.push({ type: 'reasoning-signature', index: 0, signature: 'SIG' });
    asm.push({ type: 'block-end', index: 0 });
    asm.push({ type: 'finish', reason: 'stop' });
    expect(asm.message().content).toEqual([{ type: 'reasoning', text: '', signature: 'SIG' }]);
  });
});
