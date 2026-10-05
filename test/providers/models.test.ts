import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ConfigSchema, type ProviderProfile } from '../../src/core/config.js';
import { discoverModels, ModelDiscovery } from '../../src/providers/models.js';
import { providerEndpoint } from '../../src/providers/endpoints.js';

afterEach(() => vi.unstubAllGlobals());
async function server(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const http = createServer(handler); await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, close: () => new Promise<void>((resolve) => http.close(() => resolve())) };
}

describe('automatic model catalog', () => {
  it('uses the actual compatible endpoint, merges metadata, deduplicates and sanitizes IDs', async () => {
    const http = await server((req, res) => {
      expect(req.url).toBe('/gateway/v1/models'); expect(req.headers.authorization).toBe('Bearer secret'); expect(req.headers['x-gateway']).toBe('tenant');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'new', context_length: 32000, reasoning_efforts: ['low', 'high', 'made-up'] }, { id: 'old', context_window: 1000 }, { id: 'new' }, { id: 'bad\x1b[2J' }, { id: '__proto__' }] }));
    });
    try {
      const models = await discoverModels({ driver: 'openai-compat', baseURL: `${http.url}/gateway/v1/`, headers: { 'x-gateway': 'tenant' }, models: { old: { contextWindow: 64000, pricing: { input: 1, output: 2 } } } }, 'custom', { apiKey: 'secret' });
      expect(models.map((model) => model.id)).toEqual(['new', 'old']);
      expect(models[0]!.meta).toMatchObject({ contextWindow: 32000, reasoningEfforts: ['low', 'high'] });
      expect(models.find((model) => model.id === 'old')!.meta).toMatchObject({ contextWindow: 64000, pricing: { input: 1, output: 2 } });
    } finally { await http.close(); }
  });
  it('paginates Anthropic without duplicating /v1 and preserves credentials and protocol headers', async () => {
    const paths: string[] = [];
    const http = await server((req, res) => {
      paths.push(req.url!); expect(req.headers['x-api-key']).toBe('secret'); expect(req.headers['anthropic-version']).toBe('2023-06-01');
      res.end(JSON.stringify(paths.length === 1 ? { data: [{ id: 'claude-a', display_name: 'Claude A' }], has_more: true, last_id: 'claude-a' } : { data: [{ id: 'claude-b' }], has_more: false }));
    });
    try {
      const models = await discoverModels({ driver: 'anthropic', baseURL: `${http.url}/proxy/v1` }, 'claude', { apiKey: 'secret' });
      expect(models.map((model) => model.id)).toEqual(['claude-a', 'claude-b']);
      expect(paths).toEqual(['/proxy/v1/models?limit=100', '/proxy/v1/models?limit=100&after_id=claude-a']);
      expect(providerEndpoint({ driver: 'anthropic', baseURL: http.url + '/proxy/' }, 'messages')).toBe(http.url + '/proxy/v1/messages');
    } finally { await http.close(); }
  });
  it('caches discoveries, falls back to manual/configured and stale models, and checks trust before network access', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'remote', context_window: 64000 }] })));
    vi.stubGlobal('fetch', fetch);
    const config = ConfigSchema.parse({ providers: { p: { driver: 'openai-compat', auth: 'none', models: { manual: {} } }, blocked: { driver: 'anthropic', auth: 'none' } }, default: 'p:default' });
    const catalog = new ModelDiscovery(config, (name) => { if (name === 'blocked') throw new Error('连接尚未信任'); });
    const first = await catalog.list();
    expect(first.models.map((model) => model.ref)).toEqual(['p:default', 'p:manual', 'p:remote']);
    expect(config.providers.p!.models!.remote!.contextWindow).toBe(64000);
    expect(first.warnings).toEqual(['连接尚未信任']);
    await catalog.list(); expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockImplementation(async () => new Response('contains-secret', { status: 403 }));
    const fallback = await catalog.list({ refresh: true });
    expect(fallback.models.map((model) => model.ref)).toEqual(first.models.map((model) => model.ref));
    expect(fallback.warnings.join(' ')).toContain('HTTP 403'); expect(fallback.warnings.join(' ')).not.toContain('contains-secret');
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: 'remote', context_window: 128000 }] })));
    await catalog.list({ refresh: true });
    expect(config.providers.p!.models!.remote!.contextWindow).toBe(128000);
  });
  it('does not follow redirects and bounds malformed, cyclic, oversized and aborted discovery', async () => {
    const fetch = vi.fn(async (_url: unknown, _init: RequestInit) => new Response(JSON.stringify({ data: [{ id: 'a' }], has_more: true, last_id: 'a' })));
    vi.stubGlobal('fetch', fetch);
    const profile: ProviderProfile = { driver: 'anthropic', auth: 'none' };
    await expect(discoverModels(profile, 'p')).rejects.toThrow('分页无效'); expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]![1].redirect).toBe('error');
    fetch.mockImplementation(async () => new Response(JSON.stringify({ nonsense: [] })));
    await expect(discoverModels(profile, 'p')).rejects.toThrow('格式无效');
    fetch.mockImplementation(async () => new Response('x', { headers: { 'content-length': String(20 * 1024 * 1024) } }));
    await expect(discoverModels(profile, 'p')).rejects.toThrow('响应过大');
    const abort = new AbortController(); abort.abort();
    vi.unstubAllGlobals();
    await expect(discoverModels(profile, 'p', { signal: abort.signal })).rejects.toThrow('被中断');
  });
});
