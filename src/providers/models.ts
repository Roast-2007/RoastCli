import { resolveApiKey, ReasoningEffortSchema, type ModelMeta, type ProviderProfile, type RoastConfig } from '../core/config.js';
import { RoastError } from '../core/errors.js';
import { remoteJson, object } from '../ext/http-json.js';
import { ANTHROPIC_VERSION } from './anthropic/config.js';
import { providerEndpoint } from './endpoints.js';
import { VERSION } from '../core/version.js';
import type { ModelPricing } from '../core/config.js';

export interface CatalogModel {
  id: string;
  provider: string;
  ref: string;
  meta: ModelMeta;
  source: 'configured' | 'remote';
}
export interface ModelCatalog {
  models: CatalogModel[];
  warnings: string[];
}

const validId = (id: unknown): id is string =>
  typeof id === 'string' &&
  id.length > 0 &&
  id.length <= 256 &&
  !/[\s\x00-\x1f\x7f]/.test(id) &&
  !['__proto__', 'constructor', 'prototype'].includes(id);
const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;

/** 只识别 OpenRouter 明确的美元 / token 格式，不猜其他接口单位。 */
export function discoveredPricing(value: unknown): ModelPricing | undefined {
  const raw = object(value);
  const price = (v: unknown) => {
    if ((typeof v !== 'string' && typeof v !== 'number') || (typeof v === 'string' && !v.trim())) return undefined;
    // Per-token decimals ("0.000003") pick up float noise when scaled; keep 6 decimals per million.
    const n = Math.round(Number(v) * 1_000_000 * 1e6) / 1e6;
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const input = price(raw['prompt']),
    output = price(raw['completion']);
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = price(raw['input_cache_read']),
    cacheWrite = price(raw['input_cache_write']);
  return { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}) };
}

export function configuredModels(config: RoastConfig): CatalogModel[] {
  const models = new Map<string, CatalogModel>();
  for (const [provider, profile] of Object.entries(config.providers)) {
    for (const [id, meta] of Object.entries(profile.models ?? {}))
      models.set(`${provider}:${id}`, { id, provider, ref: `${provider}:${id}`, meta, source: 'configured' });
  }
  for (const ref of [config.default, ...Object.values(config.swarm.models ?? {})]) {
    const index = ref.indexOf(':');
    if (index < 1) continue;
    const provider = ref.slice(0, index),
      id = ref.slice(index + 1);
    if (config.providers[provider] && !models.has(ref)) models.set(ref, { id, provider, ref, meta: {}, source: 'configured' });
  }
  return [...models.values()];
}

/** GET only, bounded transport, no redirects, safe diagnostics, and abortable pagination. */
export async function discoverModels(
  profile: ProviderProfile,
  name: string,
  opts: { apiKey?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CatalogModel[]> {
  const apiKey = opts.apiKey ?? resolveApiKey(profile, name);
  const endpoint = providerEndpoint(profile, 'models');
  const headers = {
    'user-agent': `RoastCli/${VERSION}`,
    ...(profile.driver === 'anthropic'
      ? { 'anthropic-version': ANTHROPIC_VERSION, ...(apiKey ? { 'x-api-key': apiKey } : {}) }
      : apiKey
        ? { authorization: `Bearer ${apiKey}` }
        : {}),
    ...profile.headers,
  };
  const found = new Map<string, CatalogModel>();
  const cursors = new Set<string>();
  const signal = AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? 10_000), ...(opts.signal ? [opts.signal] : [])]);
  let query = profile.driver === 'anthropic' ? '?limit=100' : '';
  for (let page = 0; page < 20; page++) {
    const payload = await remoteJson(endpoint + query, '', { label: `${name} 模型列表`, method: 'GET', headers, signal });
    const raw = object(payload);
    const data = Array.isArray(payload) ? payload : raw['data'];
    if (!Array.isArray(data)) throw new RoastError('INVALID_REQUEST', `${name} 模型列表格式无效；可手动添加模型`);
    for (const entry of data) {
      const item = object(entry);
      if (!validId(item['id'])) continue;
      const id = item['id'];
      const contextWindow = positive(item['context_window'] ?? item['context_length'] ?? object(item['top_provider'])['context_length']);
      const maxTokens = positive(item['max_output_tokens'] ?? object(item['top_provider'])['max_completion_tokens']);
      const efforts = Array.isArray(item['reasoning_efforts'])
        ? item['reasoning_efforts'].filter(
            (e): e is import('../core/config.js').ReasoningEffort => ReasoningEffortSchema.safeParse(e).success,
          )
        : undefined;
      const pricing = discoveredPricing(item['pricing']);
      const meta: ModelMeta = {
        ...(typeof (item['display_name'] ?? item['name']) === 'string' ? { name: String(item['display_name'] ?? item['name']) } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxTokens ? { maxTokens } : {}),
        ...(typeof item['reasoning'] === 'boolean' ? { reasoning: item['reasoning'] } : {}),
        ...(efforts ? { reasoningEfforts: efforts } : {}),
        ...(pricing ? { pricing } : {}),
        ...profile.models?.[id],
      };
      found.set(id, { id, provider: name, ref: `${name}:${id}`, meta: { ...found.get(id)?.meta, ...meta }, source: 'remote' });
    }
    if (!raw['has_more']) return [...found.values()];
    const last = raw['last_id'];
    if (profile.driver !== 'anthropic' || !validId(last) || cursors.has(last))
      throw new RoastError('INVALID_REQUEST', `${name} 模型列表分页无效`);
    cursors.add(last);
    query = `?limit=100&after_id=${encodeURIComponent(last)}`;
  }
  throw new RoastError('INVALID_REQUEST', `${name} 模型列表超过分页上限；可手动添加模型`);
}

export class ModelDiscovery {
  private cache = new Map<string, { at: number; models: CatalogModel[] }>();
  private configured: Record<string, Record<string, ModelMeta>>;
  constructor(
    private config: RoastConfig,
    private trusted: (provider: string) => void,
  ) {
    this.configured = Object.fromEntries(Object.entries(config.providers).map(([name, profile]) => [name, { ...profile.models }]));
  }
  async list(opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<ModelCatalog> {
    const models = new Map(configuredModels(this.config).map((model) => [model.ref, model]));
    const warnings: string[] = [];
    await Promise.all(
      Object.entries(this.config.providers).map(async ([name, profile]) => {
        try {
          this.trusted(name);
          const cached = this.cache.get(name);
          const entries =
            !opts.refresh && cached && Date.now() - cached.at < 300_000
              ? cached.models
              : await discoverModels({ ...profile, models: this.configured[name] }, name, { signal: opts.signal });
          this.cache.set(name, { at: Date.now(), models: entries });
          for (const model of entries) {
            profile.models ??= {};
            profile.models[model.id] = { ...model.meta, ...this.configured[name]?.[model.id] };
            models.set(model.ref, { ...model, meta: profile.models[model.id]! });
          }
        } catch (err) {
          if (opts.signal?.aborted) return;
          warnings.push(err instanceof Error ? err.message : `${name} 模型发现失败`);
          for (const model of this.cache.get(name)?.models ?? []) if (!models.has(model.ref)) models.set(model.ref, model);
        }
      }),
    );
    return { models: [...models.values()].sort((a, b) => a.ref.localeCompare(b.ref)), warnings: warnings.sort() };
  }
}
