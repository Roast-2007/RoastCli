/**
 * roast init：生成最小可用配置（默认写 ~/.roast/config.json，--project 写 .roast/config.json）。
 * API Key 保存到用户凭据文件，配置只写引用；已存在时需 --force 才覆盖。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { roastHome, reasoningEfforts, type ReasoningEffort } from '../core/config.js';
import { PROVIDER_PRESETS } from '../providers/presets.js';
import { atomicWriteJson, saveCredential } from '../core/credentials.js';

export const INIT_PROVIDERS = PROVIDER_PRESETS;

export interface InitOptions {
  provider?: string;
  model?: string;
  project?: boolean;
  force?: boolean;
  apiKey?: string;
  apiKeyStdin?: boolean;
  reasoningEffort?: ReasoningEffort;
}

export function initConfig(cwd: string, opts: InitOptions = {}): { file: string; text: string } {
  const key = opts.provider ?? 'deepseek';
  const t = Object.hasOwn(INIT_PROVIDERS, key) ? INIT_PROVIDERS[key] : undefined;
  if (!t) throw new Error(`未知 provider：${key}（可选：${Object.keys(INIT_PROVIDERS).join(' / ')}）`);
  const file = opts.project ? path.join(cwd, '.roast', 'config.json') : path.join(roastHome(), 'config.json');
  if (existsSync(file) && !opts.force) throw new Error(`${file} 已存在（加 --force 覆盖）`);
  const model = opts.model ?? t.model;
  if (!model || !t.baseURL) throw new Error('此供应商需要填写连接信息，请运行 roast config');
  if (opts.apiKey !== undefined && !opts.apiKey.trim()) throw new Error('API Key 不能为空');
  if (opts.reasoningEffort && !reasoningEfforts(t.driver, t.baseURL).includes(opts.reasoningEffort)) throw new Error('此供应商不支持所选 reasoning effort');
  const config = {
    providers: { [t.name]: { driver: t.driver, baseURL: t.baseURL, ...(opts.apiKey ? { apiKeyRef: saveCredential(roastHome(), opts.apiKey) } : {}), models: { [model]: { ...(t.contextWindow ? { contextWindow: t.contextWindow } : {}), ...t.modelMeta, ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}) } } } },
    default: `${t.name}:${model}`,
  };
  atomicWriteJson(file, config);
  const keyStep = opts.apiKey ? 'API Key 已保存在用户凭据文件' : '运行 roast config 输入并保存 API Key（脚本可通过 roast init --api-key-stdin 从标准输入读取）';
  const trustStep = opts.project ? '\n  3. 项目级配置设置了 provider 连接信息，首次使用前运行 roast trust' : '';
  return { file, text: `已写入 ${file}（默认模型 ${config.default}）\n下一步：\n  1. ${keyStep}\n  2. 运行 roast doctor 自检，然后 roast 开始使用${trustStep}` };
}
