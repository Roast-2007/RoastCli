import { createDoubleClick, type MouseEvent } from '../mouse.js';
import { hitTest, type Region, type Target } from './hitmap.js';
import type { DeckFocus } from './focus.js';
export interface MouseActions {
  focus(pane: DeckFocus): void; select(id: string): void; tab(index: number): void;
  menu(id: string): void; scroll(pane: DeckFocus, delta: number): void;
  signal(target: Extract<Target, { kind: 'signal' }>): void;
  hint(action: string): void; mode(): void; strategy(): void;
}
export function createDeckMouse() {
  const doubleClick = createDoubleClick();
  return (events: MouseEvent[], regions: Region[], actions: MouseActions, approval = false) => {
    for (const event of events) {
      const region = hitTest(regions, event.x, event.y);
      if (!region) continue;
      const target = region.target;
      if (approval && !(target.kind === 'signal' && target.type === 'approval' || target.kind === 'hint' && (target.action.startsWith('approve:') || target.action === 'approval-next'))) continue;
      if (event.kind === 'wheel') {
        const pane = hitTest(regions, event.x, event.y, true)?.target;
        if (pane?.kind === 'pane') actions.scroll(pane.pane === 'input' ? 'mission' : pane.pane, event.delta ?? 0);
        continue;
      }
      if (event.kind !== 'press' || event.shift) continue;
      const pane = hitTest(regions, event.x, event.y, true)?.target;
      if (pane?.kind === 'pane') actions.focus(pane.pane);
      if (target.kind === 'agent' || target.kind === 'plan-row') {
        const id = target.kind === 'agent' ? target.id : target.agentId;
        if (!id) continue;
        actions.select(id);
        if (event.button === 'right') actions.menu(id);
        else if (event.button === 'left' && doubleClick(`${target.kind}:${id}`)) { actions.tab(1); actions.focus('mission'); }
      } else if (event.button === 'left') {
        if (target.kind === 'tab') actions.tab(target.index);
        if (target.kind === 'signal') actions.signal(target);
        if (target.kind === 'hint') actions.hint(target.action);
        if (target.kind === 'status-mode') actions.mode();
        if (target.kind === 'strategy-chip') actions.strategy();
      }
    }
  };
}
