/**
 * adapter 测试：stub globalThis.fetch，覆盖
 * - openai-compat 2xx 流式路径（含请求头/请求体断言）
 * - 401 → finish error AUTH
 * - 缺少已保存的 API Key → finish error MISSING_CREDENTIAL
 * - anthropic 2xx 流式路径
 * - buildProviderRegistry 的 driver 路由
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { roastHome, type ProviderProfile, type RoastConfig } from '../../src/core/config.js';
import { saveCredential } from '../../src/core/credentials.js';
import { RoastError } from '../../src/core/errors.js';
import { VERSION } from '../../src/core/version.js';
import { userMessage, type StreamChunk } from '../../src/core/types.js';
import { OpenAICompatAdapter } from '../../src/providers/openai-compat/adapter.js';
import { AnthropicAdapter } from '../../src/providers/anthropic/adapter.js';
import { buildProviderRegistry } from '../../src/providers/registry.js';

const ENV_KEY = 'ROASTCLI_TEST_API_KEY';

function sseResponse(events: string[], status = 200): Response {
  const text = events.map((e) => `${e}\n\n`).join('');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

async function collectAll(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

const openaiProfile: ProviderProfile = {
  driver: 'openai-compat',
  baseURL: 'https://example.test/v1',
  apiKeyRef: undefined,
};

const anthropicProfile: ProviderProfile = {
  driver: 'anthropic',
  baseURL: 'https://anthropic.test',
  apiKeyRef: undefined,
};

function setKey(key: string) {
  openaiProfile.apiKeyRef = anthropicProfile.apiKeyRef = saveCredential(roastHome(), key);
}
beforeEach(() => setKey('sk-test'));

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env[ENV_KEY];
});

describe('OpenAICompatAdapter.stream', () => {
  it('honors per-agent effort overrides and auto, supports no-key servers and strips error bodies', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => sseResponse(['data: [DONE]']));
    vi.stubGlobal('fetch', fetchMock);
    for (const adapter of [
      new OpenAICompatAdapter({ driver: 'openai-compat', auth: 'none', baseURL: 'http://localhost:1234/v1/', models: { m: { reasoningEffort: 'high' } } }, 'local'),
      new AnthropicAdapter({ driver: 'anthropic', auth: 'none', baseURL: 'http://localhost:1234/v1/', models: { m: { reasoningEffort: 'high' } } }, 'local'),
    ]) {
      for (const effort of ['low', null] as const) {
        await collectAll(adapter.stream({ model: 'm', messages: [userMessage('hi')], reasoningEffort: effort }));
        const [url, init] = fetchMock.mock.calls.at(-1)!;
        expect(url).not.toContain('//v1'); expect(url).not.toContain('/v1/v1');
        expect(init.headers).not.toHaveProperty('authorization'); expect(init.headers).not.toHaveProperty('x-api-key');
        const request = JSON.parse(String(init.body));
        expect(request.reasoning_effort ?? request.output_config?.effort).toBe(effort ?? undefined);
        expect(init.redirect).toBe('error');
      }
      fetchMock.mockImplementationOnce(async () => new Response('secret-key-reflected-by-server', { status: 401 }));
      const chunks = await collectAll(adapter.stream({ model: 'm', messages: [userMessage('hi')] }));
      const finish = chunks.at(-1)!;
      expect(finish.type === 'finish' && finish.error?.message).toBe('provider "local" 返回 HTTP 401');
    }
  });
  it('both drivers authenticate using a user-local reference, with no env variable', async () => {
    const ref = saveCredential(roastHome(), 'sk-file-auth');
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => sseResponse(['data: [DONE]']));
    vi.stubGlobal('fetch', fetchMock);
    for (const [adapter, header] of [
      [new OpenAICompatAdapter({ driver: 'openai-compat', apiKeyRef: ref }, 'local-openai'), 'authorization'],
      [new AnthropicAdapter({ driver: 'anthropic', apiKeyRef: ref }, 'local-claude'), 'x-api-key'],
    ] as const) {
      await collectAll(adapter.stream({ model: 'm', messages: [userMessage('hi')] }));
      expect((fetchMock.mock.calls.at(-1)![1].headers as Record<string, string>)[header]).toBe(header === 'authorization' ? 'Bearer sk-file-auth' : 'sk-file-auth');
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('uses configured effort in actual requests for both protocols and Kimi Code tool continuations', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => sseResponse(['data: [DONE]']));
    vi.stubGlobal('fetch', fetchMock);
    const kimi = new OpenAICompatAdapter({ ...openaiProfile, baseURL: 'https://api.kimi.com/coding/v1', models: { 'kimi-for-coding': { reasoningEffort: 'max', reasoningReplay: 'field' } } }, 'kimi-code');
    await collectAll(kimi.stream({ model: 'kimi-for-coding', messages: [
      userMessage('hi'),
      { role: 'assistant', content: [{ type: 'reasoning', text: 'current thinking' }, { type: 'tool-call', id: 'read-1', name: 'read', args: {} }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'read-1', name: 'read', content: [{ type: 'text', text: 'file' }] }] },
    ] }));
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.kimi.com/coding/v1/chat/completions');
    const kimiRequest = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(kimiRequest.reasoning_effort).toBe('max');
    expect(kimiRequest.messages[1].reasoning_content).toBe('current thinking');
    expect(fetchMock.mock.calls[0]![1].headers).toHaveProperty('user-agent', `RoastCli/${VERSION}`);
    const claude = new AnthropicAdapter({ ...anthropicProfile, models: { m: { reasoningEffort: 'low' } } }, 'claude');
    await collectAll(claude.stream({ model: 'm', messages: [userMessage('hi')] }));
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body)).output_config).toEqual({ effort: 'low' });
  });
  it('2xx 流式路径：文本 + finish stop，且恰好一个 finish', async () => {
    setKey('sk-test');
    const fetchMock = vi.fn(async () =>
      sseResponse([
        `data: {"choices":[{"delta":{"content":"你好"}}]}`,
        `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_cache_hit_tokens":4,"prompt_cache_miss_tokens":6}}`,
        'data: [DONE]',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OpenAICompatAdapter(openaiProfile, 'test');
    const chunks = await collectAll(
      adapter.stream({ model: 'm', system: 'sys', messages: [userMessage('hi')], maxTokens: 100, temperature: 0.5 }),
    );

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, block: 'text' },
      { type: 'text-delta', index: 0, text: '你好' },
      { type: 'block-end', index: 0 },
      { type: 'usage', usage: { input: 6, output: 2, cacheRead: 4, cacheWrite: 6 } },
      { type: 'finish', reason: 'stop' },
    ]);

    // 请求断言
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.test/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk-test');
    const body = JSON.parse(String(init.body));
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.max_tokens).toBe(100);
    expect(body.temperature).toBe(0.5);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('401 → finish error AUTH，不抛出', async () => {
    setKey('sk-bad');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('invalid api key', { status: 401 })));

    const adapter = new OpenAICompatAdapter(openaiProfile, 'test');
    const chunks = await collectAll(adapter.stream({ model: 'm', messages: [userMessage('hi')] }));

    expect(chunks).toHaveLength(1);
    const finish = chunks[0]!;
    expect(finish.type).toBe('finish');
    if (finish.type === 'finish') {
      expect(finish.reason).toBe('error');
      expect(finish.error?.code).toBe('AUTH');
      expect(finish.error?.status).toBe(401);
      expect(finish.error?.retryable).toBe(false);
    }
  });

  it('旧环境变量密钥不参与认证 → MISSING_CREDENTIAL，且不发起 fetch', async () => {
    process.env[ENV_KEY] = 'deprecated-key';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OpenAICompatAdapter({ ...openaiProfile, apiKeyRef: undefined, apiKeyEnv: ENV_KEY }, 'test');
    const chunks = await collectAll(adapter.stream({ model: 'm', messages: [userMessage('hi')] }));

    expect(fetchMock).not.toHaveBeenCalled();
    const finish = chunks.at(-1)!;
    expect(finish.type).toBe('finish');
    if (finish.type === 'finish') {
      expect(finish.reason).toBe('error');
      expect(finish.error?.code).toBe('MISSING_CREDENTIAL');
    }
  });

  it('网络错误（fetch reject TypeError）→ finish error NETWORK', async () => {
    setKey('sk-test');
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));

    const adapter = new OpenAICompatAdapter(openaiProfile, 'test');
    const chunks = await collectAll(adapter.stream({ model: 'm', messages: [userMessage('hi')] }));

    const finish = chunks.at(-1)!;
    if (finish.type === 'finish') {
      expect(finish.reason).toBe('error');
      expect(finish.error?.code).toBe('NETWORK');
      expect(finish.error?.retryable).toBe(true);
    } else {
      expect.unreachable();
    }
  });
});

describe('AnthropicAdapter.stream', () => {
  it('2xx 流式路径：text block + finish stop', async () => {
    setKey('sk-ant');
    const fetchMock = vi.fn(async () =>
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
        'event: message_stop\ndata: {"type":"message_stop"}',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new AnthropicAdapter(anthropicProfile, 'claude');
    const chunks = await collectAll(adapter.stream({ model: 'claude-x', system: 'sys', messages: [userMessage('hi')] }));

    expect(chunks).toEqual([
      { type: 'usage', usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 } },
      { type: 'block-start', index: 0, block: 'text' },
      { type: 'text-delta', index: 0, text: 'Hi' },
      { type: 'block-end', index: 0 },
      { type: 'usage', usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } },
      { type: 'finish', reason: 'stop' },
    ]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://anthropic.test/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(String(init.body));
    expect(body.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]); // 默认开启 prompt caching
    expect(body.max_tokens).toBe(8192); // 默认
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }]);
  });

  it('401 → finish error AUTH', async () => {
    setKey('sk-bad');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"type":"authentication_error"}}', { status: 401 })));

    const adapter = new AnthropicAdapter(anthropicProfile, 'claude');
    const chunks = await collectAll(adapter.stream({ model: 'claude-x', messages: [userMessage('hi')] }));

    const finish = chunks.at(-1)!;
    if (finish.type === 'finish') {
      expect(finish.reason).toBe('error');
      expect(finish.error?.code).toBe('AUTH');
    } else {
      expect.unreachable();
    }
  });
});

describe('buildProviderRegistry', () => {
  const base: RoastConfig = {
    providers: {
      ds: { driver: 'openai-compat', apiKeyEnv: 'A' },
      claude: { driver: 'anthropic', apiKeyEnv: 'B' },
    },
    default: 'ds:x',
    maxSteps: 50,
    logsDir: 'logs',
    debugLog: false,
    context: {},
    swarm: { maxAgents: 12, maxDepth: 3, maxMinutes: 60 },
  };

  it('按 driver 实例化并注册', () => {
    const registry = buildProviderRegistry(base);
    expect(registry.names().sort()).toEqual(['claude', 'ds']);
    expect(registry.get({ provider: 'ds', model: 'x' }).driver).toBe('openai-compat');
    expect(registry.get({ provider: 'claude', model: 'x' }).driver).toBe('anthropic');
  });

  it('未识别 driver → RoastError CONFIG', () => {
    const bad = {
      ...base,
      providers: { x: { driver: 'not-a-driver', apiKeyEnv: 'A' } },
    } as unknown as RoastConfig;
    expect(() => buildProviderRegistry(bad)).toThrowError(RoastError);
    try {
      buildProviderRegistry(bad);
    } catch (e) {
      expect((e as RoastError).code).toBe('CONFIG');
    }
  });
});
