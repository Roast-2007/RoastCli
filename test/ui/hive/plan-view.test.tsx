import { describe, expect, it } from 'vitest';
import { parsePlan } from '../../../src/ui/hive/plan.js';
import { planPageLines, planDetailLines } from '../../../src/ui/hive/plan-view.js';
import { createUiStore } from '../../../src/ui/store/store.js';
import { emptyAgentView } from '../../../src/ui/store/reducer.js';
import { displayWidth } from '../../../src/core/text-width.js';
import { deckRegions, hitTest } from '../../../src/ui/hive/hitmap.js';
import { deckLayout } from '../../../src/ui/hive/layout.js';
import { paneLines, paneMetrics } from '../../../src/ui/hive/Pane.js';
import { viewport } from '../../../src/ui/viewport.js';
import { deckFixture, tick } from './fixture.js';

const press = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M`;
const title = '实现完整的中文计划标题并保留每个宽字符'.repeat(10);
const value = JSON.stringify({ tasks: [{ id: 't1', title, acceptance: '验收条件'.repeat(30), dependsOn: ['first', 'second'] }] });

describe('计划解析与预换行', () => {
  it('容忍缺字段、数字 id、数组顶层，跳过坏任务与重复 id', () => {
    expect(
      parsePlan(
        JSON.stringify([
          { id: 1, task: '任务' },
          { id: '1', title: '重复' },
          null,
          { id: '2', name: '名称', dependsOn: ['1', 2] },
          { id: '3', description: '说明' },
        ]),
      ),
    ).toEqual([
      { id: '1', title: '任务', role: '', acceptance: '', dependsOn: [] },
      { id: '2', title: '名称', role: '', acceptance: '', dependsOn: ['1'] },
      { id: '3', title: '说明', role: '', acceptance: '', dependsOn: [] },
    ]);
    for (const text of ['bad', '{}', '[{"id":"x"}]', '[{"id":null,"title":"x"}]']) expect(parsePlan(text)).toBeNull();
  });
  it('宽窗格完整换行，窄窗格最多三行；详情完整保留标题、验收与依赖', () => {
    const ui = createUiStore().getState();
    const wide = planPageLines(value, ui, 'main', 100, false);
    expect(
      wide
        .slice(1)
        .map((l) => l.text.slice(2))
        .join(''),
    ).toBe(title);
    expect(wide.every((l) => l.target?.kind === 'plan-row' && l.target.taskId === 't1')).toBe(true);
    const narrow = planPageLines(value, ui, 'main', 32, false);
    expect(narrow).toHaveLength(4);
    expect(narrow[3]!.text).toContain('… Enter 展开');
    expect(narrow.every((l) => displayWidth(l.text) <= 32)).toBe(true);
    expect(planPageLines(value, ui, 'main', 32, true)[3]!.text).toContain('... Enter 展开');
    const details = planDetailLines(value, ui, 32, false)
      .map((l) => l.text.replace(/^  /, ''))
      .join('');
    expect(details).toContain(title);
    expect(details).toContain('验收：' + '验收条件'.repeat(30));
    expect(details).toContain('依赖：first, second');
  });
  it('Queen 与选中成员待办有内容，ASCII 状态及 activeForm 正确，详情含全部成员', () => {
    const ui = createUiStore().getState();
    ui.agents = {
      main: {
        ...emptyAgentView(),
        todos: [
          { content: '排队', status: 'pending' },
          { content: '完成', status: 'completed' },
        ],
      },
      w1: { ...emptyAgentView(), todos: [{ content: '测试', activeForm: '正在测试', status: 'in_progress' }] },
      w2: { ...emptyAgentView(), todos: [{ content: '其他成员待办', status: 'pending' }] },
    };
    const text = planPageLines(undefined, ui, 'w1', 80, true)
      .map((l) => l.text)
      .join('\n');
    for (const part of ['待办 · Queen  1/2', '待办 · w1', '[ ] 排队', '[x] 完成', '[~] 正在测试']) expect(text).toContain(part);
    expect(text).not.toContain('其他成员待办');
    expect(
      planDetailLines(undefined, ui, 80, false)
        .map((l) => l.text)
        .join('\n'),
    ).toContain('其他成员待办');
  });
  it.each([50, 120])('绘制和命中图逐行使用同一份文本（%i 列）', (columns) => {
    const l = deckLayout(columns, 40),
      m = paneMetrics(l.mission, l.body);
    const lines = planPageLines(value, createUiStore().getState(), 'main', m.width, false);
    expect(paneLines(lines, l.mission, l.body, true)).toEqual(lines);
    const regions = deckRegions(l, {
      focus: 'mission',
      narrow: 1,
      tab: 0,
      agents: [],
      colonyOffset: 0,
      offset: 0,
      signalOffset: 0,
      missionLines: lines,
      signalLines: [],
      modeWidth: 0,
      strategyWidth: 0,
    });
    for (let i = 0; i < Math.min(lines.length, m.count); i++)
      expect(hitTest(regions, l.colony + m.inset, l.header + m.titleRow + 1 + i)?.target).toEqual(lines[i]!.target);
  });
});

describe('真实 Ink 计划详情', () => {
  it.each([50, 120])('Enter 展开、Esc 保留偏移与草稿；双击任务置顶、成员打开输出（%i 列）', async (columns) => {
    const f = await deckFixture(columns);
    try {
      const root = f.store.getState().meta.swarm[0]!;
      f.store.setMeta({
        swarm: [root, { ...root, id: 'w1', taskId: 't2', role: 'worker', depth: 1, parentId: 'main', state: 'done', brief: '第二任务' }],
      });
      f.store.addNotice('w1', '成员输出');
      f.session.swarm.board.write(
        '/mission/plan',
        JSON.stringify({ tasks: Array.from({ length: 30 }, (_, i) => ({ id: `t${i + 1}`, title: `任务标题${i + 1}` })) }),
        { author: 'main' },
      );
      await tick();
      await f.send('草稿');
      const v = viewport(columns, 40),
        l = deckLayout(v.columns, v.rows),
        m = paneMetrics(l.mission, l.body);
      await f.send('\x1b[17~');
      await f.send('\t');
      await f.send('g');
      const before = f.tty.frame();
      await f.send('\r');
      expect(f.tty.frame()).toContain('计划详情');
      expect(f.tty.frame()).toContain('任务标题1');
      await f.send('\x1b');
      expect(f.tty.frame()).toBe(before);
      const x = l.colony + m.inset,
        y = l.header + m.titleRow + 3;
      await f.send(press(x, y));
      await f.send(press(x, y));
      expect(f.tty.frame()).toContain('计划详情');
      expect(
        f.tty
          .frame()
          .split('\n')
          .map((line) => line.trim()),
      ).not.toContain('任务标题1');
      const memberY = l.header + 3;
      await f.send(press(5, memberY));
      await f.send(press(5, memberY));
      expect(f.store.getState().focus).toBe('w1');
      expect(f.tty.frame()).not.toContain('计划详情');
      expect(f.tty.frame()).toContain('成员输出');
      expect(f.draft.state?.lines.join('')).toBe('草稿');
    } finally {
      await f.close();
    }
  });
  it('只有待办时显示计划内容，双击待办展开；小于八行不展开', async () => {
    const f = await deckFixture();
    try {
      f.store.pushEvent('main', { type: 'tool-call-start', callId: 'todo', name: 'todo_write', args: {} });
      f.store.pushEvent('main', {
        type: 'tool-call-end',
        callId: 'todo',
        name: 'todo_write',
        isError: false,
        preview: 'ok',
        metadata: { todos: [{ content: '待办内容', status: 'pending' }] },
        durationMs: 0,
      });
      f.store.flush();
      await tick();
      expect(f.tty.frame()).toContain('待办内容');
      expect(f.tty.frame()).not.toContain('Queen 将在这里写入');
      const v = viewport(120, 40),
        l = deckLayout(v.columns, v.rows),
        m = paneMetrics(l.mission, l.body);
      await f.send(press(l.colony + m.inset, l.header + m.titleRow + 3));
      await f.send(press(l.colony + m.inset, l.header + m.titleRow + 3));
      expect(f.tty.frame()).toContain('计划详情');
      await f.send('\x1b');
      f.tty.rows = 7;
      f.tty.emit('resize');
      await tick();
      await f.send('\r');
      expect(f.tty.frame()).not.toContain('计划详情');
    } finally {
      await f.close();
    }
  });
});
