import { describe, expect, it } from 'vitest';
import { Blackboard } from '../../src/swarm/board.js';
import { MessageBus } from '../../src/swarm/bus.js';
import { Mailbox, renderInbox } from '../../src/swarm/mailbox.js';
import { parseAddress, type Envelope } from '../../src/swarm/types.js';

describe('Mailbox', () => {
  it('唤醒类消息唤醒等待者，info 不唤醒；drain 取出全部', async () => {
    const mb = new Mailbox();
    let woke = false;
    const p = mb.waitForWake().then(() => (woke = true));
    mb.enqueue(env('info'));
    await Promise.resolve();
    expect(woke).toBe(false);
    mb.enqueue(env('report'));
    await p;
    expect(woke).toBe(true);
    expect(mb.drain().map((e) => e.kind)).toEqual(['info', 'report']);
    expect(mb.size).toBe(0);
  });

  it('renderInbox 含类型、来源、主题、引用', () => {
    const text = renderInbox([{ ...env('question'), subject: '用哪个库？', body: '请决定', refs: ['/mission/x'] }]);
    expect(text).toContain('<inbox>');
    expect(text).toContain('[question] 来自 w1');
    expect(text).toContain('用哪个库？');
    expect(text).toContain('/mission/x');
  });
});

function env(kind: Envelope['kind']): Envelope {
  return { id: 'm1', from: 'w1', to: { rel: 'parent' }, kind, subject: 's', body: 'b', refs: [], hop: 0, at: 0 };
}

describe('MessageBus', () => {
  const inbox: Record<string, Envelope[]> = {};
  const make = (opts = {}) =>
    new MessageBus(
      {
        resolve: (from, to) => (to === 'broadcast' ? (from === 'main' ? ['w1', 'w2'] : null) : 'agent' in to ? [to.agent] : 'rel' in to && to.rel === 'parent' ? ['main'] : []),
        deliver: (id, e) => (inbox[id] = [...(inbox[id] ?? []), e]),
      },
      opts,
    );

  it('路由投递；自发自收被过滤；无收件人 → route', () => {
    const bus = make();
    expect(bus.send('w1', { to: { rel: 'parent' }, kind: 'question', subject: 'q', body: '?' })).toMatchObject({ ok: true, recipients: ['main'] });
    expect(inbox['main']).toHaveLength(1);
    expect(bus.send('w1', { to: { rel: 'children' }, kind: 'info', subject: 'x', body: 'y' })).toEqual({ ok: false, reason: 'route' });
  });

  it('只有 Queen 能广播；hop / 长度上限；去重；限流', () => {
    const bus = make({ perMinute: 2, maxHop: 2, maxBodyChars: 10 });
    expect(bus.send('w1', { to: 'broadcast', kind: 'info', subject: 's', body: 'b' })).toEqual({ ok: false, reason: 'forbidden' });
    expect(bus.send('main', { to: { agent: 'w1' }, kind: 'info', subject: 's', body: 'b', hop: 3 })).toEqual({ ok: false, reason: 'hop' });
    expect(bus.send('main', { to: { agent: 'w1' }, kind: 'info', subject: 's', body: 'x'.repeat(11) })).toEqual({ ok: false, reason: 'too-long' });
    expect(bus.send('main', { to: { agent: 'w1' }, kind: 'info', subject: 's', body: '1' }).ok).toBe(true);
    expect(bus.send('main', { to: { agent: 'w1' }, kind: 'info', subject: 's', body: '1' })).toEqual({ ok: false, reason: 'dup' });
    expect(bus.send('main', { to: { agent: 'w1' }, kind: 'info', subject: 's', body: '2' }).ok).toBe(true);
    expect(bus.send('main', { to: { agent: 'w1' }, kind: 'info', subject: 's', body: '3' })).toEqual({ ok: false, reason: 'rate' });
  });

  it('parseAddress', () => {
    expect(parseAddress('parent')).toEqual({ rel: 'parent' });
    expect(parseAddress('role:critic')).toEqual({ role: 'critic' });
    expect(parseAddress('topic:api')).toEqual({ topic: 'api' });
    expect(parseAddress('w3')).toEqual({ agent: 'w3' });
  });
});

describe('Blackboard', () => {
  it('版本递增，CAS 冲突返回当前版本；list 按前缀', () => {
    const b = new Blackboard();
    expect(b.write('/mission/api', 'v1', { author: 'w1' })).toEqual({ ok: true, version: 1 });
    expect(b.write('mission/api/', 'v2', { author: 'w2', expect: 1 })).toEqual({ ok: true, version: 2 });
    expect(b.write('/mission/api', 'v3', { author: 'w1', expect: 1 })).toEqual({ ok: false, current: 2 });
    expect(b.read('/mission/api')).toMatchObject({ value: 'v2', author: 'w2' });
    b.write('/mission/db', 'x', { author: 'w1' });
    b.write('/other', 'y', { author: 'w1' });
    expect(b.list('/mission').map((m) => m.key)).toEqual(['/mission/api', '/mission/db']);
  });

  it('watch 只通知元信息，不通知作者本人', () => {
    const notes: string[] = [];
    const b = new Blackboard((watcher, meta) => notes.push(`${watcher}:${meta.key}@${meta.version}`));
    b.watch('/mission', 'main');
    b.watch('/mission', 'w1');
    b.write('/mission/plan', 'p', { author: 'w1' });
    expect(notes).toEqual(['main:/mission/plan@1']);
  });
});
