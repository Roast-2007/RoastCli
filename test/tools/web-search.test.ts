import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDuckDuckGo, webSearchTool, WEB_SEARCH_KEY } from '../../src/tools/web/search.js';
import { executeTool } from '../../src/tools/executor.js';
import { makeCtx, textOf } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());
describe('web_search', () => {
  const html =
    '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">API <b>docs</b></a><a class="result__snippet">Official <b>reference</b></a>';
  it('decodes result links and snippets and sends a bounded, cancellable search request', async () => {
    expect(parseDuckDuckGo(html)).toEqual([{ title: 'API **docs**', url: 'https://example.com/docs', snippet: 'Official **reference**' }]);
    const fetch = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => new Response(html));
    vi.stubGlobal('fetch', fetch);
    const result = await executeTool(webSearchTool, { query: 'error & fix', limit: 1 }, makeCtx('.'));
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('https://example.com/docs');
    expect(String(fetch.mock.calls[0]?.[0])).toContain('q=error+%26+fix');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
  });
  it('reads a configured SearXNG JSON endpoint and filters non-HTTP result links', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              results: [
                { title: 'Docs', url: 'https://example.com', content: 'reference' },
                { title: 'bad', url: 'javascript:alert(1)' },
              ],
            }),
          ),
      ),
    );
    const ctx = makeCtx('.');
    ctx.services.set(WEB_SEARCH_KEY, { driver: 'searxng', baseURL: 'https://search.example/search' });
    const result = await executeTool(webSearchTool, { query: 'q' }, ctx);
    expect(result.metadata?.['count']).toBe(1);
    expect(textOf(result)).not.toContain('javascript:');
  });
  it('reports captcha and missing keys without fabricating results or making unauthenticated paid requests', async () => {
    const fetch = vi.fn(async () => new Response('<form id="challenge-form">captcha</form>'));
    vi.stubGlobal('fetch', fetch);
    expect((await executeTool(webSearchTool, { query: 'q' }, makeCtx('.'))).isError).toBe(true);
    const ctx = makeCtx('.');
    ctx.services.set(WEB_SEARCH_KEY, { driver: 'brave' });
    expect(textOf(await executeTool(webSearchTool, { query: 'q' }, ctx))).toContain('缺少密钥');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
