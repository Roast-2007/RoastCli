import { describe, expect, it, vi } from 'vitest';
import { deckFixture, tick } from './fixture.js';
import { deckLayout } from '../../../src/ui/hive/layout.js';
import { viewport } from '../../../src/ui/viewport.js';
import { paneMetrics } from '../../../src/ui/hive/Pane.js';
import { missionTabs } from '../../../src/ui/hive/tabs.js';
import { render } from 'ink-testing-library';
import { SelectPanel } from '../../../src/ui/components/SelectPanel.js';
const press = (x: number, y: number, button = 0) => `\x1b[<${button};${x + 1};${y + 1}M`;
describe('real Ink Hive mouse control', () => {
  it('keeps a scrolled menu row still between the two presses of a double click', async () => {
    const select=vi.fn(), screen=render(<SelectPanel title="long menu" entries={Array.from({length:30},(_,i)=>({id:String(i),label:`item-${i}`}))} height={10} onClose={()=>{}} onSelect={select} />);
    try {
      await tick(); screen.stdin.write('\x1b[F'); await tick();
      expect(screen.lastFrame()).toContain('item-29');
      screen.stdin.write(press(2,3)); await tick(); screen.stdin.write(press(2,3)); await tick();
      expect(select).toHaveBeenCalledWith({id:'25',label:'item-25'});
    } finally { screen.unmount(); }
  });
  it('selects and opens members, opens the same menu by right click and Space, and confirms cancellation separately', async () => {
    const f = await deckFixture();
    try {
      const root = f.store.getState().meta.swarm[0]!;
      f.store.setMeta({ swarm: [root, { ...root, id: 'w1', taskId: 't1', role: 'worker', depth: 1, parentId: 'main', state: 'done', brief: 'long task '.repeat(20) }] });
      f.store.addNotice('w1','worker output'); await tick();
      const v = viewport(f.tty.columns, f.tty.rows), l = deckLayout(v.columns,v.rows), metrics = paneMetrics(l.colony,l.body), y = l.header + metrics.titleRow + 2;
      await f.send(press(2,y)); expect(f.store.getState().focus).toBe('w1');
      await f.send(press(2,y)); expect(f.tty.frame()).toContain('worker output');
      await f.send(press(2,y,2)); expect(f.tty.frame()).toContain('w1 · worker'); expect(f.tty.frame()).toContain('暂停或继续');
      await f.send('\x1b'); await f.send(press(2,y)); await f.send(' '); expect(f.tty.frame()).toContain('w1 · worker');
      const cancel = vi.spyOn(f.controller,'cancelAgent');
      for (let i=0;i<4;i++) await f.send('\x1b[B');
      await f.send('\r'); expect(f.tty.frame()).toContain('确认取消'); expect(cancel).not.toHaveBeenCalled();
      await f.send('\x1b[B'); await f.send('\r'); expect(cancel).toHaveBeenCalledWith('w1');
    } finally { await f.close(); }
  });
  it('clicks tabs, plan rows, the strategy and mode chips and ignores clicks after mouse off', async () => {
    const f = await deckFixture();
    try {
      const root = f.store.getState().meta.swarm[0]!;
      f.store.setMeta({ swarm: [root, { ...root, id: 'w1', taskId: 't1', role: 'worker', depth: 1, parentId: 'main', state: 'done', brief: 'implement' }] });
      f.session.swarm.board.write('/mission/plan',JSON.stringify({tasks:[{id:'t1',title:'test plan',role:'worker',acceptance:'pass',dependsOn:[]}]}),{author:'main'}); await tick();
      const v = viewport(f.tty.columns,f.tty.rows), l = deckLayout(v.columns,v.rows), m = paneMetrics(l.mission,l.body);
      await f.send(press(l.colony + m.inset,l.header + m.titleRow + 1)); expect(f.store.getState().focus).toBe('w1'); expect(f.tty.frame()).toContain('test plan');
      const tab = missionTabs(m.width,0).find(tab => tab.tab === 3)!;
      await f.send(press(l.colony + m.inset + tab.x,l.header + m.titleRow)); expect(f.tty.frame()).toContain('4消息*');
      const mode = vi.spyOn(f.controller,'cycleMode'); await f.send(press(1,l.height-1)); expect(mode).toHaveBeenCalledOnce();
      await f.send(press(v.columns-5,l.header+l.body)); expect(f.store.getState().meta.overlay).toBe('strategy');
      await f.send('\x1b'); f.controller.runCommand('/mouse off'); await tick(); expect(f.tty.chunks.join('')).toContain('\x1b[?1006l');
      await f.send(press(1,l.height-1)); expect(mode).toHaveBeenCalledOnce();
      expect(f.store.getState().meta.toast?.text).toContain('/mouse on');
      f.controller.runCommand('/mouse on'); await tick(); await f.send(press(1,l.height-1)); expect(mode).toHaveBeenCalledTimes(2);
    } finally { await f.close(); }
  });
  it('scrolls the pointer panel without changing selection or the input draft', async () => {
    const f = await deckFixture();
    try {
      const root = f.store.getState().meta.swarm[0]!;
      f.store.setMeta({ swarm: [root,...Array.from({length:60},(_,i)=>({...root,id:`w${i+1}`,role:'worker' as const,depth:1,parentId:'main',state:'done' as const,brief:'task'}))] });
      f.store.pushEvent('main',{type:'text-delta',text:Array.from({length:100},(_,i)=>`output-${i}`).join('\n')}); f.store.flush(); await tick();
      await f.send('pending draft'); await f.send('\x1b[17~'); await f.send('\t'); await f.send('2');
      await f.send('\x1b[<65;3;5M'); expect(f.tty.frame()).toContain('w4 [worker]'); expect(f.store.getState().focus).toBe('main');
      const v=viewport(f.tty.columns,f.tty.rows), l=deckLayout(v.columns,v.rows);
      await f.send(press(l.colony+3,5,64)); expect(f.tty.frame()).toContain('已上翻 3 行');
      expect(f.draft.state?.lines.join('')).toBe('pending draft'); expect(f.store.getState().focus).toBe('main');
    } finally { await f.close(); }
  });
  it('selects an overlay item by click and confirms it by double click', async () => {
    const f=await deckFixture();
    try {
      f.controller.runCommand('/strategy'); await tick();
      await f.send(press(3,5)); expect(f.store.getState().meta.overlay).toBe('strategy');
      await f.send(press(3,5)); expect(f.store.getState().meta.overlay).toBeNull();
      expect(f.store.getState().meta.strategy).toBe('fanout');
    } finally { await f.close(); }
  });
  it('opens message senders and locates board keys from the signals pane', async () => {
    const f=await deckFixture();
    try {
      const root=f.store.getState().meta.swarm[0]!;
      f.store.setMeta({swarm:[root,{...root,id:'w1',role:'worker',parentId:'main',depth:1,state:'done'}],messages:[{id:'msg',from:'w1',to:{agent:'main'},kind:'info',subject:'result',body:'message body',refs:[],hop:0,at:1}]});
      f.session.swarm.board.write('/result','board value',{author:'w1'}); await tick();
      const v=viewport(f.tty.columns,f.tty.rows),l=deckLayout(v.columns,v.rows),m=paneMetrics(l.signals,l.body),x=v.columns-l.signals+m.inset,y=l.header+m.titleRow+1;
      await f.send(press(x,y)); expect(f.store.getState().focus).toBe('w1'); await vi.waitFor(()=>expect(f.tty.frame()).toContain('message body'));
      await f.send(press(x,y+1)); await vi.waitFor(()=>expect(f.tty.frame()).toContain('board value'));
    } finally { await f.close(); }
  });
  it('only confirms actual visible approval options and preserves forced-approval choices', async () => {
    const f=await deckFixture();
    try {
      const response=f.session.broker.request({kind:'permission',agentId:'main',tool:'bash',title:'dangerous operation',reason:'高危操作',forced:true},new AbortController().signal);
      await tick(); expect(f.tty.frame()).not.toContain('本项目始终允许');
      const respond=vi.spyOn(f.controller,'respond');
      await f.send(press(3,2)); expect(respond).not.toHaveBeenCalled();
      const y=f.tty.frame().split('\n').findIndex(line=>line.includes('4 拒绝 (Esc)'));
      expect(y).toBeGreaterThan(0); await f.send(press(3,y));
      expect(await response).toEqual({kind:'permission',decision:'deny'}); expect(respond).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });
});
