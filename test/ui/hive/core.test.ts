import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../src/swarm/types.js';
import { emptyAgentView, pushItems } from '../../../src/ui/store/reducer.js';
import { deckLayout } from '../../../src/ui/hive/layout.js';
import { agentInstruction, nextFocus } from '../../../src/ui/hive/focus.js';
import { parsePlan, planRows } from '../../../src/ui/hive/plan.js';
import { missionPhase, missionChildren } from '../../../src/ui/hive/phase.js';
import { paneMaxOffset } from '../../../src/ui/hive/Pane.js';
import { emptyUsage } from '../../../src/core/types.js';
import { missionUsage } from '../../../src/ui/hive/usage.js';
const agent = (id = 'w1', parentId: string | null = 'main', state: AgentInfo['state'] = 'running'): AgentInfo => ({ id, parentId, state, taskId: 't1', depth: parentId ? 1 : 0, role: 'worker', brief: '实现', model: 'p:m', startedAt: 1, children: [] });
const mission = () => pushItems(emptyAgentView(), { kind: 'mission', missionId: 'm1', goal: '目标', strategy: 'auto', n: 3, turn: 1 });
describe('Hive projection boundaries', () => {
  it('allocates four sizes and tiny screens without losing the input', () => {
    for (const [columns, rows] of [[40, 12], [80, 24], [120, 40], [200, 60], [20, 5]]) {
      for (const interaction of [false, true]) {
        const l = deckLayout(columns!, rows!, interaction);
        expect(l.header + l.body + l.input + l.status).toBe(l.height);
        expect(l.colony + l.mission + l.signals).toBe(columns);
        expect(l.input).toBeGreaterThan(0);
      }
    }
    expect(deckLayout(80, 7)).toMatchObject({ compact: true, header: 0 });
  });
  it('parses only valid plans and derives state from associated agents', () => {
    for (const value of ['oops', '{}', '{"tasks":[{"id":"t1"}]}']) expect(parsePlan(value)).toBeNull();
    const task = { id: 't1', title: '实现', role: 'worker', acceptance: '通过', dependsOn: [] };
    expect(parsePlan(JSON.stringify({ tasks: [task, task] }))).toBeNull();
    expect(planRows(JSON.stringify({ tasks: [task] }), [])).toMatchObject([{ state: 'pending' }]);
    expect(planRows(JSON.stringify({ tasks: [task] }), [agent()])).toMatchObject([{ state: 'running', agents: [{ id: 'w1' }] }]);
    expect(planRows('broken', [agent()])).toMatchObject([{ title: '实现' }]);
  });
  it('keeps old agents out of a new mission and derives every phase', () => {
    expect(missionPhase(emptyAgentView(), [])).toBe('空闲');
    let view = { ...mission(), running: true };
    expect(missionChildren(view, [agent()])).toEqual([]);
    expect(missionPhase(view, [agent()])).toBe('计划中');
    view = pushItems(view, { kind: 'tool', tool: { callId: 's', name: 'spawn_agent', args: {}, status: 'done', preview: '', durationMs: 0, metadata: { agentId: 'w1' } } });
    expect(missionPhase(view, [agent(), agent('w2', 'w1')])).toBe('执行中');
    expect(missionChildren(view, [agent(), agent('w2', 'w1')])).toHaveLength(2);
    expect(missionPhase(view, [agent('w1', 'main', 'done')])).toBe('整合中');
    for (const [reason, label] of [['completed', '完成'], ['aborted', '中断'], ['error', '出错'], ['max-steps', '步数上限']]) expect(missionPhase(pushItems(view, { kind: 'turn-summary', reason: reason!, durationMs: 0, usage: emptyUsage() }), [])).toBe(label);
  });
  it('cycles available focus regions and accepts only known member addresses', () => {
    expect(nextFocus('input', true)).toBe('colony'); expect(nextFocus('colony', true)).toBe('mission'); expect(nextFocus('mission', true)).toBe('signals'); expect(nextFocus('signals', true)).toBe('input'); expect(nextFocus('mission', false)).toBe('input');
    expect(agentInstruction('@w1 更正\n范围', ['w1'])).toEqual({ agent: 'w1', body: '更正\n范围' });
    expect(agentInstruction('@queen 插话', [])).toEqual({ agent: 'main', body: '插话' });
    expect(agentInstruction('@missing text', [])).toBeNull();
    expect(agentInstruction('@w1', ['w1'])).toBeNull();
  });
  it('uses display width for scroll limits and never reports a partial price', () => {
    expect(paneMaxOffset([{ text: '中文'.repeat(30), tone: 'text' }], 10, 4)).toBe(19);
    const entry = { provider: 'p', model: 'm', agent: 'main', turn: 1, usage: emptyUsage(), cost: null, kind: 'generation' as const };
    expect(missionUsage([entry], 1, [])[0]!.text).toContain('未知');
  });
});
