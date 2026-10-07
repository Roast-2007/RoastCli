import { useTerminal } from '../terminal.js';
import type { Session } from '../../agent/session.js';
import type { UiStoreState } from '../store/store.js';
import { Pane } from './Pane.js';
import { messageLine, type Line } from './lines.js';
export function pinnedSignals(ui: UiStoreState): Line[] {
  return (ui.meta.signals ?? []).filter((signal) => signal.tone === 'info').map((signal) => ({ text: signal.text, tone: 'accent' }));
}
export function signalLines(session: Session, ui: UiStoreState): Line[] {
  return [
    ...pinnedSignals(ui),
    ...[
      ...new Set([
        ...session.startupWarnings,
        ...(ui.meta.signals ?? []).filter((signal) => signal.tone !== 'info').map((signal) => signal.text),
      ]),
    ].map((text): Line => ({ text, tone: 'warn' })),
    ...ui.agents
      .main!.items.filter((item) => item.kind === 'notice')
      .map((item): Line => ({ text: item.kind === 'notice' ? item.text : '', tone: 'warn' })),
    ...ui.meta.interactions.map(
      (request): Line => ({
        target: { kind: 'signal', type: 'approval', id: request.id },
        text: `${request.agentId ?? 'queen'} 等待${request.kind === 'permission' ? '授权' : '回答'}`,
        tone: 'warn',
      }),
    ),
    ...ui.meta.messages.map(
      (message): Line => ({ ...messageLine(message), target: { kind: 'signal', type: 'message', id: message.from } }),
    ),
    ...session.swarm.board
      .list('/')
      .map(
        (entry): Line => ({
          target: { kind: 'signal', type: 'board', id: entry.key },
          text: `${entry.key} v${entry.version}`,
          tone: 'muted',
        }),
      ),
  ];
}
export function SignalsPane({
  session,
  ui,
  height,
  width,
  focused,
  offset,
}: {
  session: Session;
  ui: UiStoreState;
  height: number;
  width: number;
  focused: boolean;
  offset: number;
}) {
  const { hints } = useTerminal(),
    lines = signalLines(session, ui);
  const pinned = pinnedSignals(ui);
  return (
    <Pane
      title="信号"
      pinned={pinned}
      lines={
        lines.length || hints !== 'full'
          ? lines.slice(pinned.length)
          : [{ text: '审批请求、成员消息和黑板更新会显示在这里', tone: 'muted' }]
      }
      height={height}
      width={width}
      focused={focused}
      offset={offset}
    />
  );
}
