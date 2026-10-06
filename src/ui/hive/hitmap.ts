import { displayWidth } from '../../core/text-width.js';
import type { DeckFocus } from './focus.js';
import type { deckLayout } from './layout.js';
import type { Line } from './lines.js';
import { paneLines, paneMetrics } from './Pane.js';
import { missionTabs, tabMemberSuffix } from './tabs.js';
export type Target =
  | { kind: 'pane'; pane: DeckFocus }
  | { kind: 'agent'; id: string }
  | { kind: 'tab'; index: number }
  | { kind: 'plan-row'; taskId: string; agentId?: string }
  | { kind: 'signal'; type: 'approval' | 'message' | 'board'; id: string }
  | { kind: 'hint'; action: string }
  | { kind: 'status-mode' } | { kind: 'strategy-chip' }
  | { kind: 'approval-option'; index: number };
export interface Region { x: number; y: number; w: number; h: number; target: Target }
export interface HitModel {
  focus: DeckFocus; narrow: number; tab: number; agents: string[]; colonyOffset: number;
  offset: number; signalOffset: number; missionLines: Line[]; signalLines: Line[];
  memberLabel?: string; modeWidth: number; strategyWidth: number; interaction?: boolean;
  hints?: { x: number; width: number; action: string }[];
}
export function hitTest(regions: Region[], x: number, y: number, panesOnly = false): Region | undefined {
  return regions.slice().reverse().find(region => (!panesOnly || region.target.kind === 'pane') && x >= region.x && x < region.x + region.w && y >= region.y && y < region.y + region.h);
}
export function deckRegions(layout: ReturnType<typeof deckLayout>, model: HitModel): Region[] {
  const regions: Region[] = [], columns = layout.colony + layout.mission + layout.signals;
  const add = (x: number, y: number, w: number, h: number, target: Target) => { if (w > 0 && h > 0) regions.push({ x, y, w, h, target }); };
  const pane = (x: number, width: number, which: DeckFocus) => add(x, layout.header, width, layout.body, { kind: 'pane', pane: which });
  const colonyVisible = layout.colony > 0 || layout.narrow && (model.narrow === 0 || model.focus === 'colony');
  const colonyWidth = layout.colony || columns;
  if (layout.compact) pane(0, columns, 'mission');
  else {
    if (colonyVisible) pane(0, colonyWidth, 'colony');
    if (!layout.narrow || !colonyVisible) pane(layout.colony, layout.mission, 'mission');
    if (layout.signals) pane(columns - layout.signals, layout.signals, 'signals');
  }
  add(0, layout.header + layout.body, columns, layout.input, { kind: 'pane', pane: 'input' });
  if (layout.status) {
    add(0, layout.height - 1, Math.min(columns, model.modeWidth), 1, { kind: 'status-mode' });
    if (columns - model.modeWidth >= 7) add(columns - 6, layout.height - 1, 6, 1, { kind: 'hint', action: 'help' });
  }
  if (!model.interaction && layout.input >= 2) add(Math.max(0, columns - model.strategyWidth), layout.header + layout.body, Math.min(columns, model.strategyWidth), 1, { kind: 'strategy-chip' });
  const content = (x: number, width: number, lines: Line[], offset: number, fromTop: boolean, singleLine: boolean) => {
    const metrics = paneMetrics(width, layout.body), wrapped = paneLines(lines, width, layout.body, singleLine);
    const max = Math.max(0, wrapped.length - metrics.count), start = fromTop ? Math.min(offset, max) : Math.max(0, max - Math.min(offset, max));
    return { metrics, shown: wrapped.slice(start, start + metrics.count), x: x + metrics.inset, y: layout.header + metrics.titleRow + 1 };
  };
  if (!layout.compact && colonyVisible) {
    const visible = content(0, colonyWidth, model.agents.map(id => ({ text: id, tone: 'text' })), model.colonyOffset, true, true);
    visible.shown.forEach((line, index) => add(visible.x, visible.y + index, visible.metrics.width, 1, { kind: 'agent', id: line.text }));
  }
  if (!layout.compact && (!layout.narrow || !colonyVisible)) {
    const visible = content(layout.colony, layout.mission, model.missionLines, model.offset, false, model.tab === 0);
    missionTabs(Math.max(0, visible.metrics.width - 2 - displayWidth(tabMemberSuffix(visible.metrics.width - 2, model.tab, model.memberLabel))), model.tab, !layout.signals && !layout.narrow).forEach(item => add(visible.x + 2 + item.x, layout.header + visible.metrics.titleRow, item.width, 1, { kind: 'tab', index: item.tab }));
    visible.shown.forEach((line, index) => { if (line.target) add(visible.x, visible.y + index, visible.metrics.width, 1, line.target); });
  }
  if (!layout.compact && layout.signals) {
    const visible = content(columns - layout.signals, layout.signals, model.signalLines, model.signalOffset, false, false);
    visible.shown.forEach((line, index) => { if (line.target) add(visible.x, visible.y + index, visible.metrics.width, 1, line.target); });
  }
  if (layout.keybar) model.hints?.forEach(hint => add(hint.x, layout.height - layout.status - 1, hint.width, 1, { kind: 'hint', action: hint.action }));
  return regions;
}
