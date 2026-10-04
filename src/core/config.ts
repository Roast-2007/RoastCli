/**
 * 配置加载：分层合并（~/.roast/config.json → .roast/config.json → roastcli.config.json → ROASTCLI_CONFIG）。
 * 原则（借鉴 deepseek-harness）：
 * - 显式 resolve 一步完成校验与默认值落地，运行时不再散落 `?? default`
 * - apiKeyRef 存用户凭据引用，密钥本身不进普通配置文件、不进日志
 * - 凭据在每次请求时才解析（resolveApiKey），缺失报 MISSING_CREDENTIAL 而非启动崩溃
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { RoastError } from './errors.js';
import { canonicalPath, isPathInside, isUncPath } from './paths.js';
import { readCredential } from './credentials.js';

export const ReasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
export function reasoningEfforts(driver: 'openai-compat' | 'anthropic', baseURL?: string): ReasoningEffort[] {
  if (baseURL) {
    try {
      const url = new URL(baseURL.trim());
      if (['api.kimi.com', 'api.kimi.ai'].includes(url.hostname) && url.pathname.startsWith('/coding')) return driver === 'anthropic' ? ['low', 'high', 'max'] : ['none', 'low', 'high', 'max'];
    } catch { /* The connection form separately validates the URL. */ }
  }
  return driver === 'anthropic' ? ['low', 'medium', 'high', 'xhigh', 'max'] : [...ReasoningEffortSchema.options];
}

const ModelMetaSchema = z.object({
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  reasoning: z.boolean().optional(),
  /** 显式推理强度；null 在覆盖层中清除旧设置，由供应商决定。 */
  reasoningEffort: ReasoningEffortSchema.nullish().transform((effort) => effort ?? undefined),
  /** anthropic：开启 extended thinking 的预算（tokens，≥1024）；max_tokens 会自动保证大于预算 */
  thinkingBudget: z.number().int().min(1024).optional(),
  /**
   * openai-compat：assistant 历史中的 reasoning 如何回传
   * - drop（默认）：不回传
   * - field：仅当前 turn 以 reasoning_content 字段回传（DeepSeek 思考模式工具调用需要）
   * - inline：拼进 content（旧行为，不推荐）
   */
  reasoningReplay: z.enum(['drop', 'field', 'inline']).optional(),
  /** openai-compat：输出上限字段名（默认按模型名推断：o 系列 / gpt-5 → max_completion_tokens） */
  maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
  /** 定价（美元 / 百万 tokens），用于状态栏与 /cost 估算费用 */
  pricing: z
    .object({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      cacheRead: z.number().nonnegative().optional(),
      cacheWrite: z.number().nonnegative().optional(),
    })
    .optional(),
});

export type ModelPricing = NonNullable<z.infer<typeof ModelMetaSchema>['pricing']>;

export const ProviderProfileSchema = z.object({
  driver: z.enum(['openai-compat', 'anthropic']),
  baseURL: z.string().url().optional(),
  /** @deprecated 只读取旧配置用于迁移；请求不再读取此环境变量。 */
  apiKeyEnv: z.string().min(1).optional(),
  apiKeyRef: z.string().min(1).optional(),
  models: z.record(z.string(), ModelMetaSchema).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /** anthropic：是否打 prompt cache 断点（默认开启） */
  promptCaching: z.boolean().optional(),
  /** 覆盖默认的流空闲超时（毫秒） */
  streamIdleTimeoutMs: z.number().int().positive().optional(),
  /** 主会话与蜂群共享的供应商并发上限；429 自动减半，连续成功后逐步恢复。 */
  maxConcurrency: z.number().int().min(1).max(64).optional(),
});

export const ConfigSchema = z.object({
  providers: z.record(z.string(), ProviderProfileSchema).refine((p) => Object.keys(p).length > 0, {
    message: '至少配置一个 provider',
  }),
  /** "provider:model"，例如 "deepseek:deepseek-chat" */
  default: z.string().min(3),
  maxSteps: z.number().int().positive().default(50),
  logsDir: z.string().default('logs'),
  temperature: z.number().min(0).max(2).optional(),
  /** 上下文引擎参数（见 docs/DESIGN.md §3） */
  context: z
    .object({
      compactAt: z.number().min(0.3).max(0.98),
      elideAt: z.number().min(0.1).max(0.95),
      minSavings: z.number().int().nonnegative(),
      keepTurns: z.number().int().min(1),
      agingTurns: z.number().int().min(1),
      agingMinTokens: z.number().int().nonnegative(),
      previewLines: z.number().int().min(0),
      cacheTtlMs: z.number().int().nonnegative(),
    })
    .partial()
    .default({}),
  /** Hive 蜂群：按角色路由模型（"provider:model"）与规模上限 */
  swarm: z
    .object({
      models: z.record(z.enum(['queen', 'lead', 'worker', 'scout', 'critic', 'judge']), z.string()).optional(),
      maxAgents: z.number().int().min(1).max(64).default(12),
      maxDepth: z.number().int().min(1).max(5).default(3),
      /** 单个子 agent 的运行时长上限（分钟） */
      maxMinutes: z.number().int().min(1).max(24 * 60).default(60),
      /** 写入型子 agent 在 git 仓库中使用独立 worktree（false 则全部共享工作区，靠租约协调） */
      worktrees: z.boolean().optional(),
    })
    .default({}),
  /** 界面偏好 */
  ui: z
    .object({
      /** 主题：ember（默认）/ aurora / daylight（浅色终端）/ mono；环境变量 ROAST_THEME 优先 */
      theme: z.string().optional(),
      motion: z.enum(['full', 'reduced']).optional(),
      ascii: z.boolean().optional(),
    })
    .optional(),
  memory: z.object({
    driver: z.enum(['local', 'mem0']).optional(),
    baseURL: z.string().url().optional(),
    apiKeyEnv: z.string().min(1).optional(),
    apiKeyRef: z.string().min(1).optional(),
    mode: z.enum(['platform', 'self-hosted']).optional(),
    apiVersion: z.enum(['v2', 'v3']).optional(),
    timeoutMs: z.number().int().min(100).max(120_000).optional(),
  }).optional(),
  rag: z.object({ embeddings: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    dimensions: z.number().int().min(1).max(65_536).optional(),
    batchSize: z.number().int().min(1).max(128).optional(),
    maxChunks: z.number().int().min(1).max(20_000).optional(),
    timeoutMs: z.number().int().min(100).max(120_000).optional(),
  }).optional() }).optional(),
  /** 每个 step 落完整请求体（调试用；也可用环境变量 ROAST_DEBUG_LOG=1） */
  debugLog: z.boolean().default(false),
});

export type ModelMeta = z.infer<typeof ModelMetaSchema>;
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;
export type RoastConfig = z.infer<typeof ConfigSchema>;

export interface ModelRef {
  provider: string;
  model: string;
}

/** 解析 "provider:model" 引用；不带冒号时只含 model，由调用方决定默认 provider */
export function parseModelRef(ref: string): ModelRef {
  const idx = ref.indexOf(':');
  if (idx <= 0 || idx === ref.length - 1) {
    throw new RoastError('CONFIG', `非法模型引用 "${ref}"，应为 "provider:model" 格式`);
  }
  return { provider: ref.slice(0, idx), model: ref.slice(idx + 1) };
}

/** 用户级目录：ROAST_HOME 或 ~/.roast（技能、记忆、用户配置都在这里） */
export function roastHome(): string {
  return process.env['ROAST_HOME'] ?? join(homedir(), '.roast');
}

export type ConfigLayer = 'user' | 'project' | 'legacy' | 'env';

export interface ConfigSource {
  layer: ConfigLayer;
  path: string;
  exists: boolean;
}

/**
 * 配置层，按优先级从低到高。
 * - 在用户主目录下运行时，项目层与用户层是同一个文件：只保留用户层，避免重复加载（钩子跑两次）
 * - ROASTCLI_CONFIG 指向项目目录内的文件时视为项目层（仓库可控，需 trust），而不是可信的 env 层
 */
export function configSources(cwd: string = process.cwd()): ConfigSource[] {
  const user = join(roastHome(), 'config.json');
  const project = join(cwd, '.roast', 'config.json');
  const layers: { layer: ConfigLayer; path: string }[] = [
    { layer: 'user', path: user },
    ...(canonicalPath(project) === canonicalPath(user) ? [] : [{ layer: 'project' as const, path: project }]),
    { layer: 'legacy', path: join(cwd, 'roastcli.config.json') },
  ];
  const envPath = process.env['ROASTCLI_CONFIG'];
  if (envPath) {
    const abs = resolve(envPath);
    layers.push({ layer: isPathInside(cwd, abs) ? 'project' : 'env', path: abs });
  }
  return layers.map((l) => ({ ...l, exists: existsSync(l.path) }));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** 深合并：对象逐键合并，数组与标量由后者整体覆盖；不修改入参；忽略原型污染键 */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(base)) if (!FORBIDDEN_KEYS.has(k)) out[k] = v;
  for (const [k, v] of Object.entries(over)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    out[k] = deepMerge(base[k], v);
  }
  return out;
}

/** 决定"密钥发往哪里"的 provider 字段：仓库内配置改动它们需要用户显式信任 */
const CONNECTION_FIELDS = ['driver', 'baseURL', 'headers', 'apiKeyEnv', 'apiKeyRef'] as const;
const REPO_LAYERS: readonly ConfigLayer[] = ['project', 'legacy'];

/**
 * 仓库内配置层（.roast/config.json、roastcli.config.json）修改了连接字段的 provider。
 * 不可信仓库可借此把你的 API key 发往任意地址，使用前需 `roast trust`。
 */
export function untrustedProviderOverrides(cwd: string = process.cwd()): string[] {
  const names = new Set<string>();
  for (const s of configSources(cwd)) {
    if (!s.exists || !REPO_LAYERS.includes(s.layer)) continue;
    const raw = readJson(s.path);
    const providers = isPlainObject(raw) && isPlainObject(raw['providers']) ? raw['providers'] : {};
    for (const [name, p] of Object.entries(providers)) {
      if (isPlainObject(p) && CONNECTION_FIELDS.some((f) => p[f] !== undefined)) names.add(name);
    }
  }
  return [...names];
}

const trustFile = () => join(roastHome(), 'trusted.json');

interface TrustRecord {
  projects: string[];
  /** 信任时仓库配置敏感部分的 hash（旧记录没有 → 视为仍然信任，下次 trust 时补上） */
  hashes: Record<string, string>;
}

function readTrusted(): TrustRecord {
  try {
    const raw = JSON.parse(readFileSync(trustFile(), 'utf8')) as unknown;
    if (!isPlainObject(raw)) return { projects: [], hashes: {} };
    const projects = Array.isArray(raw['projects']) ? raw['projects'].filter((p): p is string => typeof p === 'string') : [];
    const hashes = isPlainObject(raw['hashes'])
      ? Object.fromEntries(Object.entries(raw['hashes']).filter((e): e is [string, string] => typeof e[1] === 'string' && !FORBIDDEN_KEYS.has(e[0])))
      : {};
    return { projects, hashes };
  } catch {
    return { projects: [], hashes: {} };
  }
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (isPlainObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/** 仓库配置层中需要信任才生效的部分：provider 连接信息、钩子、MCP 服务器、allow 规则 */
export function repoConfigHash(cwd: string): string {
  const parts = configSources(cwd)
    .filter((s) => s.exists && REPO_LAYERS.includes(s.layer))
    .map((s) => {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(s.path, 'utf8'));
      } catch {
        return { file: s.layer, invalid: true };
      }
      const cfg = isPlainObject(raw) ? raw : {};
      const providers = isPlainObject(cfg['providers']) ? cfg['providers'] : {};
      const connections = Object.fromEntries(
        Object.entries(providers).map(([name, p]) => [name, isPlainObject(p) ? Object.fromEntries(CONNECTION_FIELDS.filter((f) => f !== 'apiKeyRef' || p[f] !== undefined).map((f) => [f, p[f] ?? null])) : null]),
      );
      const permissions = isPlainObject(cfg['permissions']) ? cfg['permissions'] : {};
      return {
        file: s.layer,
        connections,
        hooks: cfg['hooks'] ?? null,
        mcp: cfg['mcp'] ?? null,
        allow: permissions['allow'] ?? null,
        logsDir: cfg['logsDir'] ?? null,
        debugLog: cfg['debugLog'] ?? null,
        ...(cfg['memory'] === undefined ? {} : { memory: cfg['memory'] }),
        ...(cfg['rag'] === undefined ? {} : { rag: cfg['rag'] }),
      };
    });
  return createHash('sha256').update(stableStringify(parts)).digest('hex').slice(0, 32);
}

export type TrustState = 'trusted' | 'untrusted' | 'changed';

/** changed：信任过，但仓库配置的敏感部分此后被修改（如 git pull 带来新的钩子），需重新确认 */
export function trustState(cwd: string): TrustState {
  const rec = readTrusted();
  const key = canonicalPath(cwd);
  if (!rec.projects.includes(key)) return 'untrusted';
  const recorded = rec.hashes[key];
  // 旧版记录没有 hash：无法确认信任时的内容，按 changed 处理（重新 roast trust 一次即可）
  return recorded !== undefined && recorded === repoConfigHash(cwd) ? 'trusted' : 'changed';
}

export function isProjectTrusted(cwd: string): boolean {
  return trustState(cwd) === 'trusted';
}

export function trustProject(cwd: string): void {
  const rec = readTrusted();
  const key = canonicalPath(cwd);
  const next = { projects: [...new Set([...rec.projects, key])], hashes: { ...rec.hashes, [key]: repoConfigHash(cwd) } };
  mkdirSync(roastHome(), { recursive: true });
  writeFileSync(trustFile(), JSON.stringify(next, null, 2) + '\n', 'utf8');
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new RoastError('CONFIG', `配置文件 ${path} 不是合法 JSON`, { cause: err });
  }
}

/**
 * 加载并合并所有存在的配置层（用户级 → 项目级 → 旧版 roastcli.config.json → ROASTCLI_CONFIG）。
 * 一个配置文件都没有时返回 null（调用方决定是报错还是引导初始化）。
 */
/**
 * 未信任时忽略仓库层中能把数据外送或泄露的字段：
 * - 指向项目目录之外的 logsDir（绝对路径 / UNC / WebDAV / ..，日志含完整会话）；项目内的相对目录无害，照常生效
 * - debugLog（记录完整请求体）
 */
function withoutUntrustedKeys(raw: unknown, cwd: string): unknown {
  if (!isPlainObject(raw)) return raw;
  const { logsDir, debugLog: _debugLog, memory: _memory, rag: _rag, ...rest } = raw;
  // 纯字符串判断，不触碰文件系统（对不可信的 UNC 路径做 realpath 本身就会发起网络连接）
  const rel = typeof logsDir === 'string' ? relative(resolve(cwd), resolve(cwd, logsDir)) : '..';
  const safeLogs = typeof logsDir === 'string' && !isAbsolute(logsDir) && !isUncPath(logsDir) && !rel.startsWith('..') && !isAbsolute(rel);
  return safeLogs ? { ...rest, logsDir } : rest;
}

export function loadConfig(cwd: string = process.cwd()): RoastConfig | null {
  const present = configSources(cwd).filter((s) => s.exists);
  if (present.length === 0) return null;
  const trusted = present.some((s) => REPO_LAYERS.includes(s.layer)) ? isProjectTrusted(cwd) : true;
  const merged = present.reduce<unknown>((acc, s) => deepMerge(acc, trusted || !REPO_LAYERS.includes(s.layer) ? readJson(s.path) : withoutUntrustedKeys(readJson(s.path), cwd)), {});
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const where = present.map((s) => s.path).join(' + ');
    throw new RoastError('CONFIG', `配置校验失败（来源: ${where}）: ${result.error.message}`);
  }
  return result.data;
}

/** Credentials come exclusively from API keys saved by the configuration wizard. */
export function resolveApiKey(profile: ProviderProfile, providerName: string): string {
  const key = profile.apiKeyRef ? readCredential(roastHome(), profile.apiKeyRef) : undefined;
  if (!key) {
    throw new RoastError(
      'MISSING_CREDENTIAL',
      `provider "${providerName}" 未保存 API Key${profile.apiKeyEnv ? '（旧环境变量认证已弃用）' : ''}，运行 roast config 输入密钥`,
    );
  }
  return key;
}

/** 各 driver 的默认 baseURL */
export function defaultBaseURL(driver: ProviderProfile['driver']): string {
  switch (driver) {
    case 'openai-compat':
      return 'https://api.openai.com/v1';
    case 'anthropic':
      return 'https://api.anthropic.com';
  }
}
