/**
 * 扩展装配：skills / 长期记忆 / prompt 覆盖 / 注入防护 / 代码检索索引。
 * 摘要类内容（技能列表、最近记忆）只在会话启动时生成一次，作为稳定 system 段，保证前缀缓存不被打破；
 * 会话中新增的记忆通过 memory 工具检索，下次会话才进入 system 段。
 */
import type { PostExecuteHook, ToolServices } from '../tools/index.js';
import { FileSkillRegistry, renderSkillsSection } from '../ext/skills/registry.js';
import { SKILLS_KEY } from '../ext/skills/tool.js';
import { LocalMemoryProvider, MEMORY_KEY, memoryFile, renderMemorySection } from '../ext/memory/local.js';
import { FilePromptStore } from '../ext/prompts/store.js';
import { injectionGuardHook } from '../ext/guard/injection.js';
import { CodeIndex } from '../ext/rag/code-index.js';
import { CODE_INDEX_KEY } from '../ext/rag/tool.js';
import type { SkillRegistry } from '../ext/skills.js';
import type { MemoryProvider } from '../ext/memory.js';
import type { PromptStore } from '../ext/prompts.js';
import type { SystemPromptAssembler } from './system-prompt.js';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { canonicalPath } from '../core/paths.js';
import { defaultBaseURL, resolveApiKey, type RoastConfig } from '../core/config.js';
import { readCredential } from '../core/credentials.js';
import { Mem0Provider } from '../ext/memory/mem0.js';
import { OpenAiEmbeddings, VectorIndex } from '../ext/rag/embeddings.js';

/** 启动时注入 system prompt 的最近记忆条数 */
const MEMORY_SECTION_LIMIT = 20;

export interface ExtensionsSetup {
  skills: SkillRegistry;
  memory: MemoryProvider;
  prompts: PromptStore;
  /** 代码检索索引（search_code，首次调用时构建） */
  codeIndex: CodeIndex;
  postExecute: PostExecuteHook[];
  /** 启动提示（未生效的项目级 prompt 覆盖等） */
  warnings: string[];
  /** 把扩展服务装进 services（主会话与子 agent 共用同一份） */
  provide(services: ToolServices): void;
}

export interface ExtensionsSetupInput {
  cwd: string;
  home: string;
  systemPrompt: SystemPromptAssembler;
  date: string;
  /** 项目是否已被信任（决定项目级 prompt 能否覆盖内置 section） */
  trusted: boolean;
  config?: RoastConfig;
}

export async function setupExtensions(input: ExtensionsSetupInput): Promise<ExtensionsSetup> {
  const skills = new FileSkillRegistry(input.cwd, input.home, { trusted: input.trusted });
  await skills.load();
  const skillsText = renderSkillsSection(skills.list());
  if (skillsText) input.systemPrompt.register({ name: 'skills', order: 320, text: skillsText });

  const warnings: string[] = [];
  const cfg = input.config?.memory;
  const projectId = `roast-${createHash('sha256').update(canonicalPath(input.cwd)).digest('hex').slice(0, 24)}`;
  const memory: MemoryProvider = cfg?.driver === 'mem0' ? new Mem0Provider({
    baseURL: cfg.baseURL ?? 'https://api.mem0.ai', projectId, mode: cfg.mode, apiVersion: cfg.apiVersion, timeoutMs: cfg.timeoutMs,
    apiKey: () => (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined) || (cfg.apiKeyRef ? readCredential(input.home, cfg.apiKeyRef) : undefined) || (!cfg.apiKeyEnv && !cfg.apiKeyRef ? process.env['MEM0_API_KEY'] : undefined),
  }) : new LocalMemoryProvider(memoryFile(input.home, input.cwd));
  let memoryText = '';
  try { memoryText = renderMemorySection(await memory.list?.({ limit: MEMORY_SECTION_LIMIT }) ?? []); }
  catch (err) { warnings.push(`长期记忆暂不可用：${err instanceof Error ? err.message : '读取失败'}；本次会话仍可继续`); }
  if (memoryText) input.systemPrompt.register({ name: 'memory', order: 330, text: memoryText });

  // 最后加载：外部文件覆盖同名内置 section
  const prompts = new FilePromptStore(input.cwd, input.home, { cwd: input.cwd, date: input.date, platform: process.platform }, { trusted: input.trusted });
  await prompts.loadInto(input.systemPrompt);
  const skipped = prompts.skipped();

  const embedding = input.config?.rag?.embeddings;
  let vectors: VectorIndex | undefined;
  if (embedding) {
    const profile = input.config?.providers[embedding.provider];
    if (!profile || profile.driver !== 'openai-compat') warnings.push('代码 embeddings 需要已配置的 openai-compat provider；本次使用 BM25');
    else {
      const baseURL = profile.baseURL ?? defaultBaseURL(profile.driver);
      const identity = createHash('sha256').update(JSON.stringify([baseURL, embedding.model, embedding.dimensions])).digest('hex').slice(0, 16);
      vectors = new VectorIndex(new OpenAiEmbeddings({ baseURL, model: embedding.model, apiKey: () => resolveApiKey(profile, embedding.provider), headers: profile.headers, dimensions: embedding.dimensions, timeoutMs: embedding.timeoutMs }), { cacheFile: path.join(input.home, 'indexes', projectId, `${identity}.json`), batchSize: embedding.batchSize, maxChunks: embedding.maxChunks });
    }
  }
  const codeIndex = new CodeIndex(input.cwd, vectors);

  return {
    skills,
    memory,
    prompts,
    codeIndex,
    postExecute: [injectionGuardHook()],
    warnings: [...warnings, ...(skipped.length ? [`项目级 prompt 覆盖未生效（未信任项目，可运行 roast trust）：${skipped.join(', ')}`] : [])],
    provide(services) {
      services.set(SKILLS_KEY, skills);
      services.set(MEMORY_KEY, memory);
      services.set(CODE_INDEX_KEY, codeIndex);
    },
  };
}
