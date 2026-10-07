import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { HiveJournal, foldHive, readHiveRecords } from '../../src/swarm/hive-journal.js';
import { Blackboard } from '../../src/swarm/board.js';
import type { Envelope } from '../../src/swarm/types.js';
import { tempWorkspace } from '../fixtures/workspace.js';
it('folds rewind to earlier versions, ignores corrupt records and snapshots preserve turn provenance', () => {
  const ws = tempWorkspace(),
    journal = new HiveJournal(ws.dir);
  const board = new Blackboard();
  let writes = 0,
    watches = 0;
  board.onWrite(() => writes++);
  board.watch('/', 'w1');
  const first = { key: '/plan', value: 'first', version: 1, author: 'main', at: 1 },
    second = { ...first, value: 'second', version: 2, at: 2 };
  const envelope: Envelope = {
    id: 'm1',
    from: 'main',
    to: { agent: 'w1' },
    kind: 'info',
    subject: 'hello',
    body: 'body',
    refs: [],
    hop: 0,
    at: 2,
  };
  journal.append({ v: 1, type: 'board', turn: 1, entry: first });
  journal.append({ v: 1, type: 'board', turn: 2, entry: second });
  journal.message(2, envelope, ['w1', 'w2']);
  journal.message(2, envelope, ['w1']);
  journal.append({ v: 1, type: 'partial', turn: 2, agentId: 'main', text: 'partial', at: '' });
  journal.snapshot(2);
  const fork = tempWorkspace();
  writeFileSync(
    path.join(fork.dir, 'hive.jsonl'),
    readFileSync(path.join(ws.dir, 'hive.jsonl'), 'utf8') + '\n{broken\n{"v":9,"type":"rewind","toTurn":1}\n{"v":1,"type":"unknown"}\n',
  );
  const restored = new HiveJournal(fork.dir, readHiveRecords(fork.dir));
  restored.append({ v: 1, type: 'rewind', toTurn: 2, at: '' });
  expect(restored.state()).toEqual({ board: [first], messages: [], partials: [] });
  board.restore(restored.state().board);
  expect(board.read('/plan')).toEqual(first);
  expect(writes + watches).toBe(0);
  expect(foldHive(readHiveRecords(ws.dir)).messages).toHaveLength(1);
});
it('degrades safely when the journal cannot be written', () => {
  const journal = new HiveJournal(path.join(tempWorkspace().dir, 'missing'));
  expect(() => journal.append({ v: 1, type: 'partial', turn: 1, agentId: 'main', text: 'kept', at: '' })).not.toThrow();
  expect(journal.state().partials[0]?.text).toBe('kept');
});
