import { existsSync, readFileSync } from 'node:fs';
import { ConfigSchema, ProviderProfileSchema, configSources, deepMerge, defaultBaseURL, roastHome, reasoningEfforts, type ProviderProfile, type ReasoningEffort } from '../core/config.js';
import { atomicWriteJson, readCredential, saveCredential } from '../core/credentials.js';
import { RoastError } from '../core/errors.js';
import { PROVIDER_PRESETS } from '../providers/presets.js';

function readObject(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error();
    return raw as Record<string, unknown>;
  } catch {
    throw new RoastError('CONFIG', `无法读取配置 ${file}，请检查格式与权限`);
  }
}

export interface ProviderSettings {
  providers: Record<string, ProviderProfile>;
  default?: string;
  userDefault?: string;
  file: string;
}

/** Write the highest active layer, so project/legacy configs cannot hide a saved selection. */
export function providerSettingsSource(cwd: string) {
  const sources = configSources(cwd);
  return sources.filter((source) => source.exists).at(-1) ?? sources[0]!;
}

export function readProviderSettings(cwd: string): ProviderSettings {
  // Show the merged profiles, including providers currently defined only by a project.
  let providers: Record<string, unknown> = {};
  let defaultModel: string | undefined;
  let userDefault: string | undefined;
  for (const source of configSources(cwd).filter((s) => s.exists)) {
    const raw = readObject(source.path);
    if (typeof raw['default'] === 'string') defaultModel = raw['default'];
    if (source.layer === 'user' && typeof raw['default'] === 'string') userDefault = raw['default'];
    if (raw['providers'] && typeof raw['providers'] === 'object' && !Array.isArray(raw['providers'])) {
      for (const [name, value] of Object.entries(raw['providers'])) {
        if (['__proto__', 'constructor', 'prototype'].includes(name)) continue;
        if (value && typeof value === 'object' && !Array.isArray(value)) providers[name] = deepMerge(providers[name] ?? {}, value);
      }
    }
  }
  const valid: Record<string, ProviderProfile> = {};
  for (const [name, profile] of Object.entries(providers)) {
    const result = ProviderProfileSchema.safeParse(profile);
    if (!result.success) throw new RoastError('CONFIG', `供应商 ${name} 配置不完整，请检查连接信息`);
    valid[name] = result.data;
  }
  return { providers: valid, default: defaultModel, userDefault, file: providerSettingsSource(cwd).path };
}

export interface ProviderDraft {
  name: string;
  driver: ProviderProfile['driver'];
  baseURL: string;
  model: string;
  apiKey: string;
  reasoningEffort?: ReasoningEffort;
  existing?: ProviderProfile;
  makeDefault: boolean;
}

export function validateProviderDraft(draft: ProviderDraft, requireKey = true): string | undefined {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(draft.name) || ['constructor', 'prototype'].includes(draft.name)) return '供应商名称只能包含字母、数字、下划线和短横线';
  try {
    const url = new URL(draft.baseURL);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { return '连接地址须为 http(s) URL，不能包含账号、密码、查询参数或锚点'; }
  if (!draft.model.trim() || /[\s\x00-\x1f]/.test(draft.model)) return '请填写有效的模型 ID（豆包可填写 Endpoint ID）';
  if (draft.reasoningEffort && !reasoningEfforts(draft.driver, draft.baseURL).includes(draft.reasoningEffort)) return '该协议不支持所选 reasoning effort';
  if (requireKey && !draft.apiKey.trim()) {
    try { if (!draft.existing?.apiKeyRef || !readCredential(roastHome(), draft.existing.apiKeyRef)) return '请输入 API Key'; }
    catch { return '已保存的 API Key 无法读取，请重新输入'; }
  }
  return undefined;
}

export function providerOverrideWarnings(cwd: string, _name: string, _makeDefault: boolean): string[] {
  const source = providerSettingsSource(cwd);
  return source.layer === 'project' || source.layer === 'legacy'
    ? [`保存将更新当前项目的 ${source.path}；连接信息变更后需运行 roast trust。`]
    : [];
}

export function saveProviderSettings(cwd: string, draft: ProviderDraft): { file: string; warnings: string[] } {
  const error = validateProviderDraft(draft);
  if (error) throw new RoastError('CONFIG', error);
  const home = roastHome();
  const file = providerSettingsSource(cwd).path;
  const raw = readObject(file);
  const settings = readProviderSettings(cwd);
  const providers = raw['providers'];
  if (providers !== undefined && (!providers || typeof providers !== 'object' || Array.isArray(providers))) throw new RoastError('CONFIG', '用户配置的 providers 须为对象');
  const userProfile = (providers as Record<string, unknown> | undefined)?.[draft.name];
  const existing: Partial<ProviderProfile> = {
    ...settings.providers[draft.name],
    ...draft.existing,
    ...(userProfile && typeof userProfile === 'object' ? userProfile : {}),
  };
  const { apiKeyEnv: _env, apiKeyRef: _ref, ...rest } = existing;
  const preset = Object.values(PROVIDER_PRESETS).find((p) => p.baseURL === draft.baseURL.trim().replace(/\/+$/, '') && p.model === draft.model && p.driver === draft.driver);
  const profile = {
    ...rest,
    driver: draft.driver,
    baseURL: draft.baseURL.trim().replace(/\/+$/, ''),
    apiKeyRef: existing.apiKeyRef ?? 'pending',
    models: { ...existing.models, [draft.model]: { ...(preset?.contextWindow ? { contextWindow: preset.contextWindow } : {}), ...preset?.modelMeta, ...existing.models?.[draft.model], reasoningEffort: draft.reasoningEffort ?? null } },
  };
  const next = { ...raw, providers: { ...(providers as object ?? {}), [draft.name]: profile }, default: draft.makeDefault || !settings.default ? `${draft.name}:${draft.model}` : settings.default };
  const merged = configSources(cwd).reduce<unknown>((acc, source) => deepMerge(acc, source.path === file ? next : source.exists ? readObject(source.path) : {}), {});
  // Validate before saving a secret, while preserving extension/unknown config fields on disk.
  if (!ConfigSchema.safeParse(merged).success) throw new RoastError('CONFIG', '合并后的配置无效，请检查现有配置后重试');
  const warnings = providerOverrideWarnings(cwd, draft.name, draft.makeDefault || !settings.default);
  if (draft.apiKey.trim()) profile.apiKeyRef = saveCredential(home, draft.apiKey);
  atomicWriteJson(file, next);
  return { file, warnings };
}

export function draftFromProfile(name: string, profile: ProviderProfile, defaultModel?: string): ProviderDraft {
  const model = defaultModel?.startsWith(`${name}:`) ? defaultModel.slice(name.length + 1) : Object.keys(profile.models ?? {})[0] ?? '';
  return { name, driver: profile.driver, baseURL: profile.baseURL ?? defaultBaseURL(profile.driver), model, reasoningEffort: profile.models?.[model]?.reasoningEffort, apiKey: '', existing: profile, makeDefault: defaultModel === `${name}:${model}` };
}
