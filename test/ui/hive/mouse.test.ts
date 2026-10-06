import { describe, expect, it, vi } from 'vitest';
import { parseMouse, mouseWheel, isMouseInput, createDoubleClick } from '../../../src/ui/mouse.js';
import { deckRegions, hitTest, type HitModel } from '../../../src/ui/hive/hitmap.js';
import { deckLayout } from '../../../src/ui/hive/layout.js';
import { createDeckMouse } from '../../../src/ui/hive/deck-mouse.js';
const model: HitModel = { focus: 'input', narrow: 1, tab: 0, agents: ['main', 'w1'], colonyOffset: 0, offset: 0, signalOffset: 0, modeWidth: 6, strategyWidth: 18, missionLines: [{ text: 'task', tone: 'text', target: { kind: 'plan-row', taskId: 't1', agentId: 'w1' } }], signalLines: [{ text: 'message', tone: 'text', target: { kind: 'signal', type: 'message', id: 'w1' } }] };
describe('SGR mouse packets and shared hit regions', () => {
  it('parses batched presses, releases, modifiers and vertical wheels with or without ESC', () => {
    expect(parseMouse('[<28;10;5M\x1b[<2;20;7m\x1b[<64;3;4M\x1b[<65;3;4M')).toEqual([
      { kind: 'press', button: 'left', x: 9, y: 4, shift: true, alt: true, ctrl: true },
      { kind: 'release', button: 'right', x: 19, y: 6, shift: false, alt: false, ctrl: false },
      { kind: 'wheel', button: 'none', x: 2, y: 3, shift: false, alt: false, ctrl: false, delta: -3 },
      { kind: 'wheel', button: 'none', x: 2, y: 3, shift: false, alt: false, ctrl: false, delta: 3 },
    ]);
    expect(parseMouse('[<1;1;1M')[0]?.button).toBe('middle');
    expect(mouseWheel('[<64;1;1M[<64;1;1M')).toBe(-6);
    expect(mouseWheel('[<66;1;1M')).toBe(0);
    expect(mouseWheel('draft')).toBeNull();
    expect(isMouseInput('[<0;2;2M[<0;2;2m')).toBe(true);
    for (const input of ['[<0;0;1M', '[<0;1;0M', '[<999;1;1M', '[<0;1;']) expect(parseMouse(input)).toEqual([]);
  });
  it('requires the same target within 400ms for a double click', () => {
    const click = createDoubleClick();
    expect(click('w1', 100)).toBe(false); expect(click('w1', 500)).toBe(true);
    expect(click('w1', 600)).toBe(false); expect(click('w2', 650)).toBe(false); expect(click('w2', 1051)).toBe(false);
  });
  it.each([[118,39],[78,23],[58,19],[28,9],[38,5]])('uses visible regions and excludes the gutter at %i×%i', (columns, rows) => {
    const layout = deckLayout(columns, rows), regions = deckRegions(layout, model);
    for (let y = 0; y < rows; y++) expect(hitTest(regions, columns, y)).toBeUndefined();
    expect(hitTest(regions, -1, 0)).toBeUndefined();
    expect(hitTest(regions, 0, rows)).toBeUndefined();
    expect(regions.every(region => region.x >= 0 && region.y >= 0 && region.x + region.w <= columns && region.y + region.h <= rows)).toBe(true);
    const agent = regions.find(region => region.target.kind === 'agent');
    if (agent) expect(hitTest(regions, agent.x, agent.y)?.target.kind).toBe('agent');
    for (const tab of regions.filter(region => region.target.kind === 'tab')) expect(hitTest(regions, tab.x, tab.y)?.target).toEqual(tab.target);
    expect(deckRegions(layout, { ...model, focus: 'colony', narrow: 0 }).some(region => region.target.kind === 'agent')).toBe(!layout.compact);
  });
  it('routes wheel by pointer, opens a member on double click and never handles releases as clicks', () => {
    const layout = deckLayout(118,39), regions = deckRegions(layout,model), handler = createDeckMouse();
    const actions = { focus: vi.fn(), select: vi.fn(), tab: vi.fn(), menu: vi.fn(), scroll: vi.fn(), signal: vi.fn(), hint: vi.fn(), mode: vi.fn(), strategy: vi.fn() };
    const agent = regions.find(region => region.target.kind === 'agent' && region.target.id === 'w1')!;
    const packet = `[<0;${agent.x + 1};${agent.y + 1}M`;
    handler(parseMouse(packet),regions,actions); handler(parseMouse(packet),regions,actions);
    expect(actions.select).toHaveBeenLastCalledWith('w1'); expect(actions.tab).toHaveBeenCalledWith(1);
    handler(parseMouse(`[<64;${agent.x + 1};${agent.y + 1}M`),regions,actions); expect(actions.scroll).toHaveBeenCalledWith('colony',-3);
    handler(parseMouse(`[<2;${agent.x + 1};${agent.y + 1}M`),regions,actions); expect(actions.menu).toHaveBeenCalledWith('w1');
    actions.select.mockClear(); handler(parseMouse(`[<0;${agent.x + 1};${agent.y + 1}m`),regions,actions); expect(actions.select).not.toHaveBeenCalled();
  });
});
