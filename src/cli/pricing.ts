import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, roastHome } from '../core/config.js';
import { RoastError } from '../core/errors.js';
import { terminalText } from '../core/terminal-text.js';
import { remoteJson } from '../ext/http-json.js';
import { configuredModels } from '../providers/models.js';
import {
  clearPricingCache,
  effectiveCatalog,
  pricingData,
  pricingPaths,
  pricingSourceLabel,
  resolvePricing,
} from '../providers/pricing/index.js';
import { parsePricingCatalog } from '../providers/pricing/schema.js';

const CATALOG_URL = 'https://raw.githubusercontent.com/Roast-2007/RoastCli/main/src/providers/pricing/catalog.json';

export async function updatePricing(opts: { home?: string; url?: string } = {}): Promise<string> {
  const home = opts.home ?? roastHome();
  const raw = await remoteJson(opts.url ?? CATALOG_URL, '', { label: '价目更新', method: 'GET', timeoutMs: 10_000, maxBytes: 1024 * 1024 });
  const parsed = parsePricingCatalog(raw);
  if (!parsed.catalog) throw new RoastError('INVALID_REQUEST', `价目格式无效：${parsed.error}`);
  const file = pricingPaths(home).downloaded,
    temp = `${file}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(temp, JSON.stringify(parsed.catalog, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temp, file);
    clearPricingCache(home);
  } finally {
    await rm(temp, { force: true });
  }
  return `价目已更新：${parsed.catalog.entries.length} 条 · ${parsed.catalog.updatedAt}`;
}

export async function runPricing(action = 'list', opts: { all?: boolean; cwd?: string } = {}): Promise<string> {
  if (action === 'update') return updatePricing();
  const data = pricingData();
  if (action === 'path') {
    const paths = pricingPaths();
    return `用户价目：${paths.user}\n下载价目：${paths.downloaded}\n内置价目日期：${data.builtin.catalog?.updatedAt ?? '无效'}`;
  }
  if (action !== 'list') throw new RoastError('INVALID_REQUEST', '用法：roast pricing [list|update|path] [--all]');
  if (opts.all) return JSON.stringify(effectiveCatalog(data) ?? { entries: [] }, null, 2);
  const config = loadConfig(opts.cwd);
  if (!config) return '未配置模型；roast pricing --all 查看价目。';
  return configuredModels(config)
    .map((model) => {
      const resolved = resolvePricing(config, { provider: model.provider, model: model.id }, data);
      return `${terminalText(model.ref)} · ${resolved ? `$${resolved.pricing.input}/$${resolved.pricing.output} / 1M tokens · ${pricingSourceLabel(resolved)}` : '定价未知'}`;
    })
    .join('\n');
}
