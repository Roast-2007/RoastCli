/**
 * 用户钩子配置：各配置层的 "hooks" 字段（与 Claude Code 的 hooks 语义接近，便于复用现成脚本）。
 *
 *   "hooks": {
 *     "PreToolUse":  [{ "matcher": "bash|write", "command": "node scripts/check.js", "timeoutMs": 30000 }],
 *     "PostToolUse": [{ "matcher": "edit|write|multi_edit", "command": "pnpm prettier --write ." }],
 *     "UserPromptSubmit": [{ "command": "..." }], "Stop": [...], "SessionStart": [...]
 *   }
 *
 * 安全：钩子是任意 shell 命令。仓库内配置层（.roast/config.json、roastcli.config.json）的钩子
 * 只有在项目被 `roast trust` 后才生效；用户级（~/.roast/config.json）与 ROASTCLI_CONFIG 始终生效。
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { configSources, type ConfigLayer } from '../../core/config.js';

export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

const HookSpecSchema = z.object({
  /** 工具名正则（整名匹配，如 "edit|write"）；省略或 "*" 匹配全部。只对 PreToolUse / PostToolUse 有意义 */
  matcher: z.string().optional(),
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
});

export type HookSpec = z.infer<typeof HookSpecSchema>;
export type HooksConfig = Record<HookEvent, HookSpec[]>;

const HooksSchema = z.object(Object.fromEntries(HOOK_EVENTS.map((e) => [e, z.array(HookSpecSchema).optional()])) as Record<HookEvent, z.ZodOptional<z.ZodArray<typeof HookSpecSchema>>>);

const REPO_LAYERS: readonly ConfigLayer[] = ['project', 'legacy'];

export function emptyHooksConfig(): HooksConfig {
  return { PreToolUse: [], PostToolUse: [], UserPromptSubmit: [], Stop: [], SessionStart: [] };
}

export interface LoadedHooks {
  hooks: HooksConfig;
  /** 因项目未被信任而忽略的仓库钩子数量 */
  ignored: number;
  /** 格式错误的配置层（跳过，不阻止启动） */
  invalid: string[];
}

function readHooksField(file: string): unknown {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>)['hooks'] : undefined;
  } catch {
    return undefined;
  }
}

/** 按层收集钩子（各层追加，不覆盖） */
export function loadHooks(cwd: string, trusted: boolean): LoadedHooks {
  const hooks = emptyHooksConfig();
  let ignored = 0;
  const invalid: string[] = [];
  for (const source of configSources(cwd)) {
    if (!source.exists) continue;
    const field = readHooksField(source.path);
    if (field === undefined) continue;
    const parsed = HooksSchema.safeParse(field);
    if (!parsed.success) {
      invalid.push(source.path);
      continue;
    }
    const repo = REPO_LAYERS.includes(source.layer);
    for (const event of HOOK_EVENTS) {
      const specs = parsed.data[event] ?? [];
      if (repo && !trusted) ignored += specs.length;
      else hooks[event] = [...hooks[event], ...specs];
    }
  }
  return { hooks, ignored, invalid };
}

/** matcher 是否命中工具名：省略 / "*" 全部命中；否则整名正则匹配，非法正则按字面量比较 */
export function matchesTool(matcher: string | undefined, toolName: string): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName);
  } catch {
    return matcher === toolName;
  }
}
