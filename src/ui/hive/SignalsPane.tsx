import type { Session } from '../../agent/session.js';
import type { UiStoreState } from '../store/store.js';
import { Pane } from './Pane.js';
import { messageLine, type Line } from './lines.js';
export function signalLines(session: Session, ui: UiStoreState): Line[] {
  return [
    ...session.startupWarnings.map((text): Line => ({ text, tone: 'warn' })),
    ...ui.agents.main!.items.filter((item) => item.kind === 'notice').map((item): Line => ({ text: item.kind === 'notice' ? item.text : '', tone: 'warn' })),
    ...ui.meta.interactions.map((request): Line => ({ text: `${request.agentId ?? 'queen'} 等待${request.kind === 'permission' ? '授权' : '回答'}`, tone: 'warn' })),
    ...ui.meta.messages.map((message) => messageLine(message)),
    ...session.swarm.board.list('/').map((entry): Line => ({ text: `${entry.key} v${entry.version}`, tone: 'muted' })),
  ];
}
export function SignalsPane({ session, ui, height, width, focused, offset }: { session: Session; ui: UiStoreState; height: number; width: number; focused: boolean; offset: number }) {
  return <Pane title="信号" lines={signalLines(session, ui)} height={height} width={width} focused={focused} offset={offset} />;
}
