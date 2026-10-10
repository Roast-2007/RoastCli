/**
 * 「帮我审批」（auto 模式）的离线风险判断，完全基于规则，不调用模型：
 * - autoRiskReason：高风险返回原因（需要用户在倒计时内确认），低风险返回 null（自动放行）
 * - denialKey：用户拒绝后记住的操作身份。命令按规范化后的完整文本精确匹配，
 *   文件操作按同一路径（edit / write / multi_edit 视为同一操作），其他工具按目标或参数
 * 引擎先处理 deny 规则、plan 模式与强制高危命令，这里只补充 auto 模式的扩展清单。
 */
import path from 'node:path';
import { bashRisk } from './auto-bash.js';
import { isCredentialPath, isInside, riskEnv, writeRisk, type RiskEnv } from './auto-paths.js';
import { commandText } from './bash-parse.js';
import type { PermissionRequest } from './rules.js';

export function autoRiskReason(req: PermissionRequest, env: RiskEnv = riskEnv(req.cwd)): string | null {
  if (req.tool === 'bash') return req.target === undefined ? null : bashRisk(req.target, env);
  if (req.destructive) return 'MCP 工具声明可能造成破坏性修改';
  if (req.target === undefined || req.targetKind === 'label') return null;
  if (req.kind === 'edit') return writeRisk(path.resolve(req.cwd, req.target), env);
  if (req.kind === 'read') return readRisk(req, env);
  return null;
}

/** 读取凭据文件；grep 会读取文件内容（含隐藏文件），按 glob 指向凭据或搜索整个用户目录也算 */
function readRisk(req: PermissionRequest, env: RiskEnv): string | null {
  if (isCredentialPath(req.target!)) return '读取凭据文件';
  if (req.tool !== 'grep') return null;
  const glob = (req.args as { glob?: unknown } | undefined)?.glob;
  if (typeof glob === 'string' && isCredentialPath(glob)) return '读取凭据文件';
  return isInside(path.resolve(req.cwd, req.target!), env.home) ? '搜索整个用户目录（可能读到凭据）' : null;
}

function stableJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, v: unknown) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : v,
    ) ?? ''
  );
}

export function denialKey(req: PermissionRequest): string {
  if (req.tool === 'bash' && req.target !== undefined) return `bash:${commandText(req.target)}`;
  if (req.target === undefined) return `${req.tool}:${stableJson(req.args)}`;
  if (req.targetKind === 'label' || (req.kind !== 'edit' && req.kind !== 'read')) return `${req.tool}:${req.target}`;
  const abs = path.resolve(req.cwd, req.target);
  return `${req.kind}:${process.platform === 'win32' ? abs.toLowerCase() : abs}`;
}
