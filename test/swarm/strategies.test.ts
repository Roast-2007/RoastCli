import { describe, expect, it } from 'vitest';
import { loadStrategies, missionInput, renderBrief } from '../../src/swarm/strategies.js';
import { tempWorkspace } from '../fixtures/workspace.js';

describe('Hive strategies', () => {
  it('keeps literal goal text, renders read-only mode and all five playbooks', () => {
    const ws = tempWorkspace();
    const strategies = loadStrategies(ws.dir, ws.dir);
    expect([...strategies.keys()]).toEqual(['auto', 'fanout', 'best-of-n', 'critique', 'research']);
    const goal = '$& {{n}} 中文 🔥';
    const research = missionInput(strategies, goal, 'research', 4);
    const brief = renderBrief({ missionId: 'm9', goal, strategy: research.strategy.name, n: research.n, readOnly: research.strategy.readOnly, playbook: research.strategy.playbook });
    expect(brief).toContain('id="m9" strategy="research" n="4" mode="read-only"');
    expect(brief).toContain(`<goal>\n${goal}\n</goal>`);
    expect(brief).toContain('4 complementary angles');
    expect(() => missionInput(strategies, 'x', 'missing')).toThrow('未知的蜂群策略');
    expect(() => missionInput(strategies, 'x', 'auto', 9)).toThrow('2–8');
  });
  it('prioritizes strategies over templates within a layer and protects existing names', () => {
    const ws = tempWorkspace(), home = tempWorkspace();
    home.file('templates/custom.yaml', 'prompt: old {{goal}}');
    home.file('strategies/custom.yaml', 'prompt: new {{goal}}\nn: 5\nreadOnly: true');
    ws.file('.roast/strategies/custom.yaml', 'prompt: project');
    ws.file('.roast/strategies/local.yaml', 'playbook: local {{n}}');
    ws.file('.roast/strategies/invalid.yaml', 'prompt: x\nn: 9');
    ws.file('.roast/strategies/broken.yaml', 'prompt: [');
    const untrusted = loadStrategies(ws.dir, home.dir);
    expect(untrusted.get('custom')).toMatchObject({ playbook: 'new {{goal}}', n: 5, readOnly: true, source: 'user' });
    expect(missionInput(untrusted, 'x', 'custom').n).toBe(5);
    expect(untrusted.get('local')?.source).toBe('project');
    expect(untrusted.has('invalid')).toBe(false);
    expect(untrusted.has('broken')).toBe(false);
    expect(loadStrategies(ws.dir, home.dir, { trusted: true }).get('custom')?.playbook).toBe('project');
  });
});
