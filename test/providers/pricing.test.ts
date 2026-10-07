import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema, type RoastConfig, type ModelRef } from '../../src/core/config.js';
import { UsageCost, formatUsageBreakdown } from '../../src/core/usage-cost.js';
import { summaryModel } from '../../src/context/model-summary.js';
import { effectiveCatalog, pricingData, pricingDiagnostics, resolvePricing, type PricingData } from '../../src/providers/pricing/index.js';
import { parsePricingCatalog, type PricingCatalog } from '../../src/providers/pricing/schema.js';
import { discoveredPricing, discoverModels } from '../../src/providers/models.js';
import { runPricing, updatePricing } from '../../src/cli/pricing.js';
import { tempWorkspace } from '../fixtures/workspace.js';

const entry = (models = ['model', 'future-*'], input = 2) => ({
  provider: 'official',
  hosts: ['api.example.com'],
  models,
  pricing: { input, output: 4 },
  source: 'https://example.com/prices',
});
const catalog = (input = 2, updatedAt = '2026-10-08'): PricingCatalog => ({
  version: 1,
  updatedAt,
  currency: 'USD',
  unit: '1M tokens',
  entries: [entry(undefined, input)],
});
const data = (): PricingData => ({ builtin: { catalog: catalog() }, user: {}, downloaded: {} });
const config = () =>
  ConfigSchema.parse({
    providers: { proxy: { driver: 'openai-compat', baseURL: 'https://api.example.com/v1', models: { model: {}, cheap: {} } } },
    default: 'proxy:model',
  });
const ref = { provider: 'proxy', model: 'model' };
afterEach(() => vi.unstubAllGlobals());

describe('内置价目数据', () => {
  const bundled = parsePricingCatalog(JSON.parse(readFileSync(path.resolve('src/providers/pricing/catalog.json'), 'utf8')));
  const builtin = (): PricingData => ({ builtin: bundled, user: {}, downloaded: {} });
  const providers = (baseURL: string, model: string) =>
    ConfigSchema.parse({ providers: { p: { driver: 'openai-compat', baseURL, models: { [model]: {} } } }, default: `p:${model}` });
  it('通过校验，每条都有来源，且精确模型名不会被同一 host 的前一条遮住', () => {
    expect(bundled.error).toBeUndefined();
    const entries = bundled.catalog!.entries;
    expect(entries.length).toBeGreaterThan(40);
    for (const [index, e] of entries.entries()) {
      expect(e.source, e.models.join(',')).toMatch(/^https:\/\//);
      for (const id of e.models.filter((m) => !m.includes('*'))) {
        const host = e.hosts![0]!;
        const first = entries.findIndex((other) => other.hosts?.includes(host) && other.models.some((m) => new RegExp(`^${m.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i').test(id)));
        expect(first, `${host} ${id}`).toBe(index);
      }
    }
  });
  it('官方 host 取官方价，代理同名模型标为参考价，订阅制端点保持未知', () => {
    const at = (baseURL: string, model: string) => resolvePricing(providers(baseURL, model), { provider: 'p', model }, builtin());
    expect(at('https://api.anthropic.com', 'claude-opus-5-5')).toMatchObject({ source: 'catalog', pricing: { input: 4, output: 20, cacheRead: 0.2 } });
    expect(at('https://api.anthropic.com', 'claude-fable-5-1')?.pricing.cacheRead).toBe(0.25);
    expect(at('https://api.anthropic.com', 'claude-fable-5')?.pricing.cacheRead).toBe(1);
    expect(at('https://api.anthropic.com', 'claude-haiku-4-5-20251001')?.pricing.input).toBe(1);
    expect(at('https://api.openai.com/v1', 'gpt-5-2025-08-07')?.pricing.input).toBe(1.25);
    expect(at('https://proxy.example.com/v1', 'gpt-6.1-sol')).toMatchObject({ source: 'reference', pricing: { input: 2, output: 10 } });
    expect(at('https://openrouter.ai/api/v1', 'anthropic/claude-sonnet-5-5')).toMatchObject({ source: 'reference', pricing: { input: 2 } });
    expect(at('https://api.kimi.com/coding/v1', 'k3')).toBeUndefined();
  });
});

describe('价目解析', () => {
  it('config > user > official catalog > exact reference > unknown', () => {
    const cfg = config(),
      prices = data();
    expect(resolvePricing(cfg, ref, prices)).toMatchObject({ source: 'catalog', pricing: { input: 2 } });
    cfg.providers.proxy!.baseURL = 'https://proxy.example/v1';
    expect(resolvePricing(cfg, ref, prices)?.source).toBe('reference');
    expect(resolvePricing(cfg, { ...ref, model: 'unknown' }, prices)).toBeUndefined();
    prices.user.catalog = { ...catalog(3), entries: [{ ...entry(undefined, 3), hosts: undefined }] };
    expect(resolvePricing(cfg, ref, prices)).toMatchObject({ source: 'user', pricing: { input: 3 } });
    cfg.providers.proxy!.models!.model!.pricing = { input: 9, output: 10 };
    expect(resolvePricing(cfg, ref, prices)).toMatchObject({ source: 'config', pricing: { input: 9 } });
  });
  it('通配不区分大小写；无 baseURL 只走精确参考；vendor 前缀可去掉', () => {
    const cfg = config(),
      prices = data();
    expect(resolvePricing(cfg, { ...ref, model: 'FUTURE-V4' }, prices)?.source).toBe('catalog');
    delete cfg.providers.proxy!.baseURL;
    expect(resolvePricing(cfg, { ...ref, model: 'FUTURE-V4' }, prices)).toBeUndefined();
    expect(resolvePricing(cfg, { ...ref, model: 'Vendor/MODEL' }, prices)?.source).toBe('reference');
    prices.user.catalog = catalog(7);
    expect(resolvePricing(cfg, ref, prices)?.source).toBe('reference');
  });
  it('下载价目只有较新时替代内置；无效文件忽略并诊断，缓存不反复读取', () => {
    const home = tempWorkspace().dir;
    writeFileSync(path.join(home, 'pricing.json'), '{broken');
    writeFileSync(path.join(home, 'pricing-catalog.json'), JSON.stringify(catalog(8, '2026-10-09')));
    const prices = pricingData(home);
    expect(prices.user.catalog).toBeUndefined();
    expect(pricingDiagnostics(prices)).toMatchObject({ warning: true });
    expect(effectiveCatalog(prices)?.updatedAt).toBe('2026-10-09');
    writeFileSync(path.join(home, 'pricing.json'), JSON.stringify(catalog()));
    expect(pricingData(home)).toBe(prices);
    const older = data();
    older.downloaded.catalog = catalog(8, '2026-10-07');
    expect(effectiveCatalog(older)?.entries[0]?.pricing.input).toBe(2);
    const invalidBuiltin = { ...older, builtin: parsePricingCatalog({}) };
    expect(pricingDiagnostics(invalidBuiltin).detail).toContain('内置价目无效');
    expect(effectiveCatalog({ ...data(), builtin: parsePricingCatalog({}) })).toBeUndefined();
  });
  it('账本使用注入价目，缓存 tokens 不重复计入，缺价总价未知；摘要选最便宜模型', () => {
    const cfg = config(),
      prices = data();
    prices.builtin.catalog!.entries.push({ ...entry(['cheap'], 0.1), pricing: { input: 0.1, output: 0.2 } });
    const lookup = (c: RoastConfig, r: ModelRef) => resolvePricing(c, r, prices);
    const ledger = new UsageCost(ref, cfg, lookup);
    ledger.observe({
      type: 'usage',
      seq: 1,
      agentId: 'main',
      turn: 1,
      step: 1,
      usage: { input: 100, output: 10, cacheRead: 20, cacheWrite: 30 },
    });
    expect(ledger.value()).toBeCloseTo(0.00034);
    expect(formatUsageBreakdown(ledger.breakdown())).toContain('内置价目 2026-10-08');
    expect(summaryModel(cfg, ref, lookup)).toEqual({ provider: 'proxy', model: 'cheap' });
    ledger.observe(
      { type: 'usage', seq: 2, agentId: 'w1', turn: 1, step: 1, usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { ...ref, model: 'missing' },
    );
    expect(ledger.value()).toBeNull();
  });
});

describe('OpenRouter 取价', () => {
  it('只接受有限非负数，必填无效丢整组，可选无效仅丢本项', () => {
    const result = discoveredPricing({ prompt: '0.000002', completion: 0.000004, input_cache_read: '0.0000001', input_cache_write: '-1' });
    expect(result).toMatchObject({ input: 2, output: 4 });
    expect(result?.cacheRead).toBeCloseTo(0.1);
    expect(result?.cacheWrite).toBeUndefined();
    // 0.000003 * 1e6 is 3.0000000000000004 in floating point; prices shown to users stay exact.
    expect(discoveredPricing({ prompt: '0.000003', completion: '0.000015' })).toEqual({ input: 3, output: 15 });
    for (const value of ['-1', 'Infinity', '', null, true]) expect(discoveredPricing({ prompt: value, completion: '0.1' })).toBeUndefined();
    expect(discoveredPricing({ input: 2, output: 4 })).toBeUndefined();
  });
  it('远端价格进入 metadata，配置定价优先', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'model', pricing: { prompt: '0.000002', completion: '0.000004' } }] }))),
    );
    const profile = config().providers.proxy!;
    expect((await discoverModels({ ...profile, auth: 'none' }, 'proxy'))[0]?.meta.pricing).toEqual({ input: 2, output: 4 });
    profile.models!.model!.pricing = { input: 7, output: 8 };
    expect((await discoverModels({ ...profile, auth: 'none' }, 'proxy'))[0]?.meta.pricing).toEqual({ input: 7, output: 8 });
  });
});

describe('主动价目更新', () => {
  it('真实 mock HTTP 拒绝重定向且保留旧文件；GET 成功后可 list / all / path', async () => {
    const home = tempWorkspace().dir,
      file = path.join(home, 'pricing-catalog.json');
    let requests = 0;
    const server = createServer((req, res) => {
      requests++;
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/catalog' });
        res.end('remote-secret');
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(catalog(2, '2026-10-09')));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock server address');
    const url = `http://127.0.0.1:${address.port}`;
    const savedHome = process.env['ROAST_HOME'],
      savedConfig = process.env['ROASTCLI_CONFIG'];
    try {
      writeFileSync(file, 'old');
      await expect(updatePricing({ home, url: `${url}/redirect` })).rejects.not.toThrow('remote-secret');
      expect(requests).toBe(1);
      expect(readFileSync(file, 'utf8')).toBe('old');
      await updatePricing({ home, url: `${url}/catalog` });
      writeFileSync(path.join(home, 'config.json'), JSON.stringify(config()));
      process.env['ROAST_HOME'] = home;
      delete process.env['ROASTCLI_CONFIG'];
      const list = await runPricing('list', { cwd: home });
      expect(list).toContain('proxy:model · $2/$4');
      expect(list).toContain('内置价目 2026-10-09');
      expect(await runPricing('list', { all: true })).toContain('api.example.com');
      expect(await runPricing('path')).toContain(path.join(home, 'pricing.json'));
    } finally {
      if (savedHome === undefined) delete process.env['ROAST_HOME'];
      else process.env['ROAST_HOME'] = savedHome;
      if (savedConfig === undefined) delete process.env['ROASTCLI_CONFIG'];
      else process.env['ROASTCLI_CONFIG'] = savedConfig;
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
  it('校验成功后原子替换', async () => {
    const home = tempWorkspace().dir;
    const fetch = vi.fn(async (_url: unknown, _init: RequestInit) => new Response(JSON.stringify(catalog())));
    vi.stubGlobal('fetch', fetch);
    expect(await updatePricing({ home })).toContain('1 条 · 2026-10-08');
    expect(JSON.parse(readFileSync(path.join(home, 'pricing-catalog.json'), 'utf8'))).toEqual(catalog());
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'error' });
  });
  it.each(['large', 'stream', 'schema', 'redirect', 'error'])('%s 失败保留已有文件，不回显远端正文', async (kind) => {
    const home = tempWorkspace().dir,
      file = path.join(home, 'pricing-catalog.json');
    writeFileSync(file, 'old');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (kind === 'redirect') throw new TypeError('remote-secret');
        if (kind === 'error') return new Response('remote-secret', { status: 503 });
        if (kind === 'large') return new Response('remote-secret', { headers: { 'content-length': '1048577' } });
        if (kind === 'stream') return new Response('x'.repeat(1048577));
        return new Response(JSON.stringify({ ...catalog(), version: 2 }));
      }),
    );
    await expect(updatePricing({ home })).rejects.not.toThrow('remote-secret');
    expect(readFileSync(file, 'utf8')).toBe('old');
  });
});
