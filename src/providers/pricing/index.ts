import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { roastHome, type ModelPricing, type ModelRef, type RoastConfig } from '../../core/config.js';
import bundled from './catalog.json' with { type: 'json' };
import { parsePricingCatalog, type PricingCatalog } from './schema.js';

export type PricingSource = 'config' | 'user' | 'catalog' | 'reference';
export interface ResolvedPricing {
  pricing: ModelPricing;
  source: PricingSource;
  updatedAt?: string;
}
export type PricingLookup = (config: RoastConfig, ref: ModelRef) => ResolvedPricing | undefined;
export interface CatalogState {
  catalog?: PricingCatalog;
  error?: string;
}
export interface PricingData {
  builtin: CatalogState;
  user: CatalogState;
  downloaded: CatalogState;
}
const cache = new Map<string, PricingData>();

export function pricingPaths(home = roastHome()): { user: string; downloaded: string } {
  return { user: path.join(home, 'pricing.json'), downloaded: path.join(home, 'pricing-catalog.json') };
}

function loadFile(file: string): CatalogState {
  if (!existsSync(file)) return {};
  try {
    return parsePricingCatalog(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return { error: '无法读取有效 JSON' };
  }
}

/** 只读用户目录，按进程 / home 缓存；测试可直接注入全部数据。 */
export function pricingData(home = roastHome()): PricingData {
  let data = cache.get(home);
  if (!data) {
    const paths = pricingPaths(home);
    data = { builtin: parsePricingCatalog(bundled), user: loadFile(paths.user), downloaded: loadFile(paths.downloaded) };
    cache.set(home, data);
  }
  return data;
}
export function clearPricingCache(home = roastHome()): void {
  cache.delete(home);
}

export function effectiveCatalog(data = pricingData()): PricingCatalog | undefined {
  const a = data.builtin.catalog,
    b = data.downloaded.catalog;
  return b && (!a || b.updatedAt > a.updatedAt) ? b : a;
}

function hostOf(config: RoastConfig, ref: ModelRef): string | undefined {
  const base = config.providers[ref.provider]?.baseURL;
  try {
    return base ? new URL(base).hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
function modelMatches(pattern: string, id: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(id);
}
function matching(catalog: PricingCatalog | undefined, model: string, host: string | undefined, user = false) {
  return catalog?.entries.find(
    (e) => ((user && !e.hosts) || (host && e.hosts?.some((h) => h.toLowerCase() === host))) && e.models.some((m) => modelMatches(m, model)),
  );
}

export function resolvePricing(config: RoastConfig, ref: ModelRef, data = pricingData()): ResolvedPricing | undefined {
  const configured = config.providers[ref.provider]?.models?.[ref.model]?.pricing;
  if (configured) return { pricing: configured, source: 'config' };
  const host = hostOf(config, ref);
  const user = matching(data.user.catalog, ref.model, host, true);
  if (user) return { pricing: user.pricing, source: 'user' };
  const catalog = effectiveCatalog(data);
  const official = matching(catalog, ref.model, host);
  if (official) return { pricing: official.pricing, source: 'catalog', updatedAt: catalog!.updatedAt };
  const ids = [ref.model.toLowerCase(), ref.model.slice(ref.model.indexOf('/') + 1).toLowerCase()];
  const reference = catalog?.entries.find((e) => e.models.some((m) => !m.includes('*') && ids.includes(m.toLowerCase())));
  return reference ? { pricing: reference.pricing, source: 'reference', updatedAt: catalog!.updatedAt } : undefined;
}

export function pricingSourceLabel(result: Pick<ResolvedPricing, 'source' | 'updatedAt'>, short = false): string {
  if (result.source === 'config') return '配置';
  if (result.source === 'user') return '用户价目';
  if (result.source === 'catalog') return `内置价目 ${result.updatedAt ?? ''}`.trim();
  return short ? '参考价' : '参考价（官方标价，非该端点实际价格）';
}

export function pricingDiagnostics(data = pricingData()): { warning: boolean; detail: string } {
  const catalog = effectiveCatalog(data);
  const user = data.user.error ? `无效：${data.user.error}` : data.user.catalog ? `有效 ${data.user.catalog.entries.length} 条` : '不存在';
  const warnings = [
    data.builtin.error && `内置价目无效：${data.builtin.error}`,
    data.downloaded.error && `下载价目无效：${data.downloaded.error}`,
  ].filter(Boolean);
  return {
    warning: !!data.user.error || warnings.length > 0,
    detail: `生效价目 ${catalog?.updatedAt ?? '无'} · ${catalog?.entries.length ?? 0} 条；用户价目 ${user}${warnings.length ? `；${warnings.join('；')}` : ''}`,
  };
}
