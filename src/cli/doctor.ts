/**
 * roast doctor：环境自检。每项给出 ok / warn / fail 与说明，从不打印凭据值。
 * 检查已保存的 API Key，只报告来源和状态；耗时项（git、shell）用同步子进程并设超时。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  configSources,
  isProjectTrusted,
  trustState,
  loadConfig,
  parseModelRef,
  roastHome,
  untrustedProviderOverrides,
  resolveApiKey,
  type RoastConfig,
} from '../core/config.js';
import { findInstructionFiles } from '../ext/instructions.js';
import { loadHooks, HOOK_EVENTS } from '../ext/hooks/config.js';
import { loadMcpServers } from '../ext/mcp/config.js';
import { FileSkillRegistry } from '../ext/skills/registry.js';
import { locateRipgrep } from '../tools/search/rg.js';
import { resolveShell } from '../tools/bash/shell.js';
import { displayWidth, padDisplay } from '../core/text-width.js';
import { pricingDiagnostics } from '../providers/pricing/index.js';

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  level: CheckLevel;
  detail: string;
}

const MIN_NODE_MAJOR = 22;
const PROBE_TIMEOUT_MS = 5_000;

function check(name: string, level: CheckLevel, detail: string): Check {
  return { name, level, detail };
}

function nodeCheck(): Check {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= MIN_NODE_MAJOR
    ? check('Node.js', 'ok', `v${process.versions.node}`)
    : check('Node.js', 'fail', `v${process.versions.node}，需要 ≥ ${MIN_NODE_MAJOR}`);
}

function configChecks(cwd: string): { checks: Check[]; config: RoastConfig | null } {
  const present = configSources(cwd).filter((s) => s.exists);
  if (present.length === 0) {
    return {
      checks: [
        check('配置', 'fail', '未找到配置文件。创建 ~/.roast/config.json 或 .roast/config.json（参考 roastcli.config.example.json）'),
      ],
      config: null,
    };
  }
  const where = present.map((s) => `${s.layer}: ${s.path}`).join('；');
  try {
    const config = loadConfig(cwd);
    return { checks: [check('配置', 'ok', where)], config };
  } catch (err) {
    return { checks: [check('配置', 'fail', err instanceof Error ? err.message : String(err))], config: null };
  }
}

function providerChecks(cwd: string, config: RoastConfig): Check[] {
  const out: Check[] = [];
  let ref: { provider: string; model: string } | null = null;
  try {
    ref = parseModelRef(config.default);
  } catch (err) {
    out.push(check('默认模型', 'fail', err instanceof Error ? err.message : String(err)));
  }
  if (ref) {
    const known = config.providers[ref.provider] !== undefined;
    out.push(check('默认模型', known ? 'ok' : 'fail', known ? config.default : `provider "${ref.provider}" 未在 providers 中配置`));
  }
  for (const [name, p] of Object.entries(config.providers)) {
    try {
      resolveApiKey(p, name);
      out.push(check(`凭据 ${name}`, 'ok', p.auth === 'none' ? '已配置为无密钥接口' : '用户凭据文件 已设置'));
    } catch {
      out.push(
        check(
          `凭据 ${name}`,
          'warn',
          p.apiKeyRef
            ? '用户凭据无法读取或不存在（运行 roast config 重新配置）'
            : `未保存 API Key${p.apiKeyEnv ? '，旧环境变量认证已弃用' : ''}（运行 roast config 输入密钥）`,
        ),
      );
    }
  }
  const overrides = untrustedProviderOverrides(cwd);
  const state = trustState(cwd);
  if (state === 'changed')
    out.push(
      check('项目信任', 'warn', '信任后仓库配置的敏感部分（钩子 / MCP / provider 连接 / allow 规则）已被修改，需重新运行 roast trust'),
    );
  else if (overrides.length > 0) {
    const trusted = state === 'trusted';
    out.push(
      check(
        '项目信任',
        trusted ? 'ok' : 'warn',
        trusted ? '已信任' : `项目配置修改了 ${overrides.join(', ')} 的连接信息，需运行 roast trust`,
      ),
    );
  }
  return out;
}

function probe(cmd: string, args: string[], cwd: string): string | null {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

function toolchainChecks(cwd: string): Check[] {
  const shell = resolveShell();
  const shellCheck =
    shell.kind === 'bash'
      ? check('Shell', 'ok', shell.file)
      : check('Shell', 'warn', `未找到 Git Bash，回退到 ${shell.file}（bash 语法的命令可能失败；建议安装 Git for Windows）`);
  const git = probe('git', ['--version'], cwd);
  const inRepo = git ? probe('git', ['rev-parse', '--is-inside-work-tree'], cwd) === 'true' : false;
  const rg = locateRipgrep();
  return [
    shellCheck,
    git
      ? check('git', 'ok', `${git}${inRepo ? '（当前目录是 git 仓库）' : '（当前目录不是 git 仓库）'}`)
      : check('git', 'warn', '未找到 git：检查点与 rewind 不可用'),
    rg.path ? check('ripgrep', 'ok', rg.source) : check('ripgrep', 'warn', '未找到 rg，grep 使用较慢的 JS 回退实现'),
  ];
}

async function extensionChecks(cwd: string): Promise<Check[]> {
  const home = roastHome();
  const trusted = isProjectTrusted(cwd);
  const instructions = findInstructionFiles(cwd, { home });
  const skills = new FileSkillRegistry(cwd, home);
  await skills.load();
  const hooks = loadHooks(cwd, trusted);
  const hookCount = HOOK_EVENTS.reduce((n, e) => n + hooks.hooks[e].length, 0);
  const mcp = loadMcpServers(cwd, trusted);
  const notes = (ignored: number, invalid: string[]) =>
    [ignored ? `${ignored} 个因项目未信任未启用` : '', invalid.length ? `格式错误：${invalid.join(', ')}` : ''].filter(Boolean).join('；');
  const hookNote = notes(hooks.ignored, hooks.invalid);
  const mcpNote = notes(mcp.ignored.length, mcp.invalid);
  return [
    check(
      '项目说明',
      'ok',
      instructions.length ? instructions.map((f) => path.basename(f.path)).join(', ') : '无（roast 会话中 /init 可创建 ROAST.md）',
    ),
    check(
      'Skills',
      'ok',
      skills.list().length
        ? skills
            .list()
            .map((s) => s.name)
            .join(', ')
        : '无',
    ),
    check('钩子', hookNote ? 'warn' : 'ok', `${hookCount} 个${hookNote ? `；${hookNote}` : ''}`),
    check(
      'MCP',
      mcpNote ? 'warn' : 'ok',
      `${mcp.servers.length ? mcp.servers.map((s) => s.name).join(', ') : '无'}${mcpNote ? `；${mcpNote}` : ''}`,
    ),
  ];
}

export async function collectChecks(cwd: string): Promise<Check[]> {
  const { checks: cfgChecks, config } = configChecks(cwd);
  const pricing = pricingDiagnostics();
  return [
    nodeCheck(),
    ...cfgChecks,
    check('模型价目', pricing.warning ? 'warn' : 'ok', pricing.detail),
    ...(config ? providerChecks(cwd, config) : []),
    ...toolchainChecks(cwd),
    check(
      '用户目录',
      existsSync(roastHome()) ? 'ok' : 'warn',
      existsSync(roastHome()) ? roastHome() : `${roastHome()}（不存在，首次写入时创建）`,
    ),
    ...(await extensionChecks(cwd)),
  ];
}

const ICON: Record<CheckLevel, string> = { ok: '✓', warn: '!', fail: '✗' };

export function renderChecks(checks: readonly Check[]): string {
  const width = Math.max(...checks.map((c) => displayWidth(c.name)));
  const lines = checks.map((c) => `${ICON[c.level]} ${padDisplay(c.name, width)}  ${c.detail}`);
  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  const summary = fails ? `${fails} 项失败，${warns} 项警告` : warns ? `可以使用，${warns} 项警告` : '一切正常';
  return `${lines.join('\n')}\n\n${summary}`;
}
