import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoastError } from '../../src/core/errors.js';
import { applyEvent, emptyAgentView, replayView, type AgentView } from '../../src/ui/store/reducer.js';
import { createUiStore } from '../../src/ui/store/store.js';
import type { UiEvent } from '../../src/agent/ui-events.js';

const run = (events: UiEvent[], v: AgentView = emptyAgentView()) => events.reduce((s, e) => applyEvent(s, e, 1000), v);
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };

describe('UI reducer', () => {
  it('replays committed content once, hides internal attachments, and keeps billed usage after a rewind', () => {
    const view = replayView([
      { type: 'turn/start', turn: 1, at: '2026-10-04T00:00:00Z' },
      { type: 'user/message', turn: 1, at: '', source: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
      { type: 'attachment/injected', turn: 1, step: 1, at: '', source: 'hook', blocks: [{ type: 'text', text: 'internal' }] },
      { type: 'assistant/chunk', turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'duplicate' } },
      { type: 'assistant/message', turn: 1, step: 1, at: '', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
      { type: 'usage', turn: 1, step: 1, usage },
      { type: 'turn/end', turn: 1, at: '2026-10-04T00:00:01Z', reason: 'completed' },
      { type: 'turn/start', turn: 2, at: '' },
      { type: 'user/message', turn: 2, at: '', source: 'user', message: { role: 'user', content: [{ type: 'text', text: 'rolled back' }] } },
      { type: 'usage', turn: 2, step: 1, usage },
      { type: 'rewind', at: '', toTurn: 2 },
    ]);
    expect(view.items.map((item) => 'text' in item ? item.text : '').join(' ')).toBe('hello answer ');
    expect(view.totalUsage.input).toBe(20);
    expect(view.running).toBe(false);
  });
  it('流式文本：完成的 markdown 块立即定稿，活动区只剩尾巴', () => {
    const v = run([{ type: 'turn-start', turn: 1 }, { type: 'text-delta', text: '第一段。\n\n第二段' }]);
    expect(v.items).toEqual([{ id: 1, kind: 'markdown', text: '第一段。' }]);
    expect(v.pending).toBe('第二段');
    expect(v.running).toBe(true);
  });

  it('思考先于正文：正文开始时思考定稿为条目', () => {
    const v = run([{ type: 'reasoning-delta', text: '想一想' }, { type: 'text-delta', text: '答' }]);
    expect(v.items[0]).toMatchObject({ kind: 'reasoning', text: '想一想' });
    expect(v.reasoning).toBe('');
  });

  it('工具开始时定稿文本；结束后进入条目并带 metadata；todo_write 更新清单', () => {
    const v = run([
      { type: 'text-delta', text: '我来读文件' },
      { type: 'tool-call-start', callId: 'c1', name: 'read', args: { path: 'a' } },
      { type: 'tool-progress', callId: 'c1', text: 'x' },
      { type: 'tool-call-end', callId: 'c1', name: 'read', isError: false, preview: 'ok', durationMs: 5, metadata: { path: 'a' } },
      { type: 'tool-call-start', callId: 'c2', name: 'todo_write', args: {} },
      { type: 'tool-call-end', callId: 'c2', name: 'todo_write', isError: false, preview: '', durationMs: 1, metadata: { todos: [{ content: 'x', status: 'pending' }] } },
    ]);
    expect(v.items.map((i) => i.kind)).toEqual(['markdown', 'tool', 'tool']);
    expect(v.items[1]).toMatchObject({ kind: 'tool', tool: { name: 'read', args: { path: 'a' }, status: 'done', metadata: { path: 'a' } } });
    expect(v.tools).toEqual([]);
    expect(v.todos).toEqual([{ content: 'x', status: 'pending' }]);
  });

  it('中断：剩余工具标记为 interrupted，追加"已中断"与回合小结', () => {
    const v = run([
      { type: 'turn-start', turn: 1 },
      { type: 'usage', usage },
      { type: 'tool-call-start', callId: 'c1', name: 'bash', args: {} },
      { type: 'turn-end', reason: 'aborted', usage },
    ]);
    expect(v.items.map((i) => i.kind)).toEqual(['tool', 'notice', 'turn-summary']);
    expect(v.items[0]).toMatchObject({ tool: { status: 'interrupted' } });
    expect(v.running).toBe(false);
    expect(v.totalUsage.input).toBe(10);
  });

  it('错误提示；ABORTED 错误不重复提示', () => {
    expect(run([{ type: 'error', error: new RoastError('AUTH', 'bad') }]).items[0]).toMatchObject({ kind: 'notice', tone: 'error' });
    expect(run([{ type: 'error', error: new RoastError('ABORTED', 'x') }]).items).toEqual([]);
  });
});

describe('UI store', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('事件按帧合批；用户消息立即生效；按 agent 分片', () => {
    const store = createUiStore({ frameMs: 33, now: () => 0 });
    let renders = 0;
    store.subscribe(() => renders++);
    store.pushEvent('main', { type: 'text-delta', text: 'a' });
    store.pushEvent('main', { type: 'text-delta', text: 'b' });
    expect(renders).toBe(0);
    vi.advanceTimersByTime(33);
    expect(renders).toBe(1);
    expect(store.getState().agents['main']!.pending).toBe('ab');
    store.addUser('w1', 'hi');
    expect(store.getState().agents['w1']!.items[0]).toMatchObject({ kind: 'user', text: 'hi' });
  });
  it('groups completed read tools only before they are committed to Static', () => {
    const store = createUiStore();
    for (let i = 0; i < 3; i++) {
      store.pushEvent('main', { type: 'tool-call-start', callId: `r${i}`, name: 'read', args: { path: `${i}.ts` } });
      store.pushEvent('main', { type: 'tool-call-end', callId: `r${i}`, name: 'read', isError: false, preview: '', durationMs: 1 });
    }
    store.flush();
    const first = store.getState().agents['main']!.items[0];
    expect(first).toMatchObject({ kind: 'tool-group', tools: [{ name: 'read' }, { name: 'read' }, { name: 'read' }] });
    store.pushEvent('main', { type: 'tool-call-start', callId: 'r4', name: 'read', args: {} });
    store.pushEvent('main', { type: 'tool-call-end', callId: 'r4', name: 'read', isError: true, preview: 'error', durationMs: 1 });
    store.flush();
    expect(store.getState().agents['main']!.items[0]).toBe(first);
    expect(store.getState().agents['main']!.items[1]).toMatchObject({ kind: 'tool', tool: { status: 'error' } });
  });
});
