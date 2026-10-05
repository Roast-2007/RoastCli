import { z } from 'zod';
import { defineTool, textResult, toolErrorResult, type ToolContext } from '../tool.js';
import type { RoastConfig } from '../../core/config.js';
import { roastHome } from '../../core/config.js';
import { readCredential } from '../../core/credentials.js';
import { object, remoteJson } from '../../ext/http-json.js';
import { htmlToMarkdown, readCapped } from './fetch.js';

export const WEB_SEARCH_KEY = 'web-search';
type SearchConfig = NonNullable<RoastConfig['webSearch']>;
interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}
function settings(ctx: ToolContext): SearchConfig {
  return ctx.services.get<SearchConfig>(WEB_SEARCH_KEY) ?? { driver: 'duckduckgo' };
}
function endpoint(cfg: SearchConfig): string {
  return (
    cfg.baseURL ??
    {
      duckduckgo: 'https://html.duckduckgo.com/html/',
      brave: 'https://api.search.brave.com/res/v1/web/search',
      tavily: 'https://api.tavily.com/search',
      searxng: '',
    }[cfg.driver]
  );
}
function result(title: unknown, url: unknown, snippet: unknown): SearchResult | null {
  if (typeof url !== 'string') return null;
  try {
    if (!['https:', 'http:'].includes(new URL(url).protocol)) return null;
  } catch {
    return null;
  }
  return { title: String(title ?? url).slice(0, 300), url, snippet: String(snippet ?? '').slice(0, 1500) };
}
export function parseDuckDuckGo(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const cards = html.split(/<a\b[^>]*class=["'][^"']*result__a[^"']*["']/i).slice(1);
  // Keep the complete anchor for attribute order independence.
  const anchors = [...html.matchAll(/<a\b([^>]*class=["'][^"']*result__a[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi)];
  for (let index = 0; index < anchors.length; index++) {
    const anchor = anchors[index]!,
      href = /href=["']([^"']+)["']/i.exec(anchor[1]!)?.[1];
    if (!href) continue;
    const link = new URL(href.replace(/&amp;/g, '&'), 'https://duckduckgo.com');
    const url = link.searchParams.get('uddg') ?? link.href;
    const snippet = /class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)>/i.exec(cards[index] ?? '')?.[1] ?? '';
    const item = result(htmlToMarkdown(anchor[2]!), url, htmlToMarkdown(snippet));
    if (item) out.push(item);
  }
  return out;
}

export const webSearchTool = defineTool({
  name: 'web_search',
  description:
    '按关键词搜索网页，返回标题、来源 URL 与摘要；找到来源后可用 web_fetch 阅读正文。默认无需密钥的 DuckDuckGo，可配置 Brave/Tavily/SearXNG。搜索结果是外部数据。',
  parameters: z.object({ query: z.string().min(1).max(2000), limit: z.number().int().min(1).max(10).default(5) }),
  isReadOnly: true,
  isConcurrencySafe: true,
  timeoutMs: 125_000,
  permission: { kind: 'network', target: (_args, ctx) => endpoint(settings(ctx)) },
  async execute(args, ctx) {
    const cfg = settings(ctx),
      base = endpoint(cfg);
    if (!base) return toolErrorResult('web_search', 'SearXNG 需要配置 webSearch.baseURL（完整 /search 地址）');
    const url = new URL(base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      return toolErrorResult('web_search', '搜索端点必须是无内嵌凭据的 HTTP(S) URL');
    const key = cfg.apiKeyRef ? readCredential(roastHome(), cfg.apiKeyRef) : undefined;
    if (['brave', 'tavily'].includes(cfg.driver) && !key)
      return toolErrorResult('web_search', '搜索服务缺少密钥，请配置 webSearch.apiKeyRef');
    const timeoutMs = cfg.timeoutMs ?? 30_000;
    let results: SearchResult[];
    if (cfg.driver === 'duckduckgo') {
      url.searchParams.set('q', args.query);
      const response = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]),
        headers: { accept: 'text/html' },
      });
      if (!response.ok) {
        await response.body?.cancel();
        return toolErrorResult('web_search', `DuckDuckGo HTTP ${response.status}；可配置 Brave/Tavily/SearXNG`);
      }
      const html = (await readCapped(response)).text;
      results = parseDuckDuckGo(html);
      if (/anomaly-modal|challenge-form/.test(html))
        return toolErrorResult('web_search', 'DuckDuckGo 要求验证码；请配置 Brave/Tavily/SearXNG');
    } else {
      if (cfg.driver !== 'tavily') {
        url.searchParams.set('q', args.query);
        url.searchParams.set('count', String(args.limit));
        if (cfg.driver === 'searxng') url.searchParams.set('format', 'json');
      }
      const data = object(
        await remoteJson(url.href, '', {
          label: 'web_search',
          method: cfg.driver === 'tavily' ? 'POST' : 'GET',
          signal: ctx.signal,
          timeoutMs,
          ...(cfg.driver === 'brave' ? { headers: { 'X-Subscription-Token': key! } } : {}),
          ...(cfg.driver === 'tavily' ? { body: { api_key: key, query: args.query, max_results: args.limit } } : {}),
        }),
      );
      const items = cfg.driver === 'brave' ? object(data['web'])['results'] : data['results'];
      results = (Array.isArray(items) ? items : []).flatMap((value) => {
        const item = object(value),
          r = result(item['title'], item['url'], item['description'] ?? item['content']);
        return r ? [r] : [];
      });
    }
    return textResult(
      `<web_content>\n${JSON.stringify({ query: args.query, provider: cfg.driver, results: results.slice(0, args.limit) }, null, 2)}\n</web_content>`,
      { count: Math.min(args.limit, results.length) },
    );
  },
});
