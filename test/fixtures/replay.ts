/**
 * 日志可重放断言（"model-visible ⟺ logged" 的不变量）：
 * 对日志里每个 request/digest，折叠其之前的全部事件得到的历史 hash 必须等于 digest.viewHash。
 */
import { loadRunLog } from '../../src/session/projection.js';
import { applyHistory, hashMessages, initialHistory } from '../../src/session/history.js';
import { buildView } from '../../src/context/view.js';

export function replayMismatches(logPath: string): string[] {
  const { events } = loadRunLog(logPath);
  let state = initialHistory();
  const problems: string[] = [];
  let digests = 0;
  for (const ev of events) {
    if (ev.type === 'request/digest') {
      digests++;
      const actual = hashMessages(buildView(state));
      if (actual !== ev.viewHash) problems.push(`seq ${ev.seq} (turn ${ev.turn} step ${ev.step}): 投影 ${actual} != 发送 ${ev.viewHash}`);
    }
    state = applyHistory(state, ev);
  }
  if (digests === 0) problems.push('日志中没有 request/digest');
  return problems;
}
