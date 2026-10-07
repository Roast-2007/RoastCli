import type { AgentInfo } from './types.js';

export function formatProgress(agent: AgentInfo, age: (at: number) => number = (at) => Date.now() - at): string {
  const parts = [agent.id, agent.state];
  if (agent.steps !== undefined) parts.push(`步骤 ${agent.steps}${agent.maxSteps ? `/${agent.maxSteps}` : ''}`);
  if (agent.lastActivityAt !== undefined) {
    const ms = Math.max(0, age(agent.lastActivityAt));
    parts.push(`最近活动 ${ms < 60_000 ? `${Math.floor(ms / 1000)} 秒` : `${Math.floor(ms / 60_000)} 分钟`}前`);
  }
  if (agent.lastTool) parts.push(`最近工具 ${agent.lastTool}`);
  if (agent.waitingFor) parts.push(agent.waitingFor);
  return parts.join(' · ');
}
