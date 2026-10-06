import { parseModelRef, type RoastConfig } from '../core/config.js';
import type { AgentRole } from './types.js';

const ROLES = new Set<AgentRole>(['queen', 'lead', 'worker', 'scout', 'critic', 'judge']);
export function parseRoleModels(values: string[]): Partial<Record<AgentRole, string>> {
  const out: Partial<Record<AgentRole, string>> = {};
  for (const value of values) {
    const index = value.indexOf('='),
      role = value.slice(0, index) as AgentRole,
      model = value.slice(index + 1);
    if (index <= 0 || !ROLES.has(role)) throw new Error('角色模型格式：queen|lead|worker|scout|critic|judge=provider:model');
    if (model !== 'inherit') parseModelRef(model);
    out[role] = model;
  }
  return out;
}

export function modelCatalogSection(config: RoastConfig): string {
  const models = Object.entries(config.providers).flatMap(([provider, profile]) =>
    Object.entries(profile.models ?? {}).map(
      ([model, meta]) =>
        `- ${provider}:${model}${meta.name ? ` (${meta.name})` : ''}${meta.contextWindow ? ` · window ${meta.contextWindow}` : ''}${meta.reasoning ? ' · reasoning' : ''}${meta.pricing ? ` · input $${meta.pricing.input}/M · output $${meta.pricing.output}/M` : ''}`,
    ),
  );
  if (!models.some((line) => line.startsWith(`- ${config.default}`))) models.push(`- ${config.default} (default)`);
  const routes = Object.entries(config.swarm.models ?? {})
    .map(([role, model]) => `${role}=${model}`)
    .join(', ');
  return `## Available agent models\n${models.join('\n')}\nUser role routes: ${routes || 'none; Queen chooses'}\nRespect user role routes; otherwise choose per task by difficulty and price; when metadata is insufficient, inherit the main model.`;
}
