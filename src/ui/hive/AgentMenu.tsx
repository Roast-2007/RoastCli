import { useState } from 'react';
import type { AgentInfo } from '../../swarm/types.js';
import type { UiController } from '../controller.js';
import { SelectPanel } from '../components/SelectPanel.js';
export function AgentMenu({ agent, height, controller, onAction, onClose }: { agent: AgentInfo; height: number; controller: UiController; onAction(action: 'output' | 'diff' | 'steer' | 'pause'): void; onClose(): void }) {
  const [confirm, setConfirm] = useState(false);
  if (confirm) return <SelectPanel key="confirm" title={`确认取消 ${agent.id} 及其子树？`} height={height} entries={[{ id: 'back', label: '返回' }, { id: 'cancel', label: '确认取消' }]} onClose={() => setConfirm(false)} onSelect={entry => { if (entry.id === 'cancel') { controller.cancelAgent(agent.id); onClose(); } else setConfirm(false); }} />;
  return <SelectPanel title={`${agent.id === 'main' ? 'queen' : agent.id} · ${agent.role}`} height={height} entries={[{ id: 'output', label: '查看输出' }, { id: 'diff', label: '查看改动' }, { id: 'steer', label: '发送指示' }, { id: 'pause', label: '暂停或继续' }, { id: 'cancel', label: '取消（需要再确认一次）' }]} onClose={onClose} onSelect={entry => { if (entry.id === 'cancel') setConfirm(true); else onAction(entry.id as 'output' | 'diff' | 'steer' | 'pause'); }} />;
}
