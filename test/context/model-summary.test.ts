import { describe, expect, it } from 'vitest';
import { modelSummarizer, summaryModel } from '../../src/context/model-summary.js';
import { ConfigSchema } from '../../src/core/config.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { textScript, errorScript, usageOf } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { userMessage } from '../../src/core/types.js';

const config = () =>
  ConfigSchema.parse({
    providers: {
      p: {
        driver: 'openai-compat',
        models: { big: { pricing: { input: 10, output: 20 } }, cheap: { pricing: { input: 0.1, output: 0.2 } } },
      },
    },
    default: 'p:big',
  });
describe('semantic compaction', () => {
  it('selects the cheapest configured model, honors explicit selection and can disable model summaries', () => {
    const cfg = config(),
      ref = { provider: 'p', model: 'big' };
    expect(summaryModel(cfg, ref)).toEqual({ provider: 'p', model: 'cheap' });
    cfg.context.summaryModel = 'p:big';
    expect(summaryModel(cfg, ref)).toEqual(ref);
    cfg.context.summaryModel = 'extractive';
    expect(modelSummarizer(cfg, ref, new ProviderRegistry(), '.')).toBeUndefined();
  });
  it('preserves focus and usage attribution without replaying images or asking the summarizer to execute tools', async () => {
    const provider = new ScriptedProvider([textScript('决定：保留 CRLF。下一步：修复缓存。', usageOf(100, 20))]);
    const providers = new ProviderRegistry();
    providers.register('p', provider);
    const summarize = modelSummarizer(config(), { provider: 'p', model: 'big' }, providers, tempWorkspace().dir)!;
    const result = await summarize.summarize(
      [userMessage('保留 CRLF'), { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'SECRET_IMAGE' }] }],
      '缓存',
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      summary: '决定：保留 CRLF。下一步：修复缓存。',
      usage: usageOf(100, 20),
      model: { provider: 'p', model: 'cheap' },
    });
    expect(provider.requests[0]).toMatchObject({ model: 'cheap', maxTokens: 2048 });
    expect(JSON.stringify(provider.requests[0])).toContain('缓存');
    expect(JSON.stringify(provider.requests[0])).not.toContain('SECRET_IMAGE');
    expect(provider.requests[0]?.tools).toBeUndefined();
  });
  it('falls back to extractive anchors on failure and propagates cancellation', async () => {
    const provider = new ScriptedProvider([errorScript('NETWORK')]);
    const providers = new ProviderRegistry();
    providers.register('p', provider);
    const summarize = modelSummarizer(config(), { provider: 'p', model: 'big' }, providers, tempWorkspace().dir)!;
    expect((await summarize.summarize([userMessage('必须保留需求')], undefined, new AbortController().signal)).summary).toContain(
      '必须保留需求',
    );
    const abort = new AbortController();
    abort.abort();
    await expect(summarize.summarize([userMessage('x')], undefined, abort.signal)).rejects.toBeDefined();
  });
});
