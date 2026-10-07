import { useRef, useState } from 'react';
import { useScroll } from '../scroll.js';
import type { Line } from './lines.js';
import type { Target } from './hitmap.js';

export interface PlanNavigation {
  tab: number;
  narrow: number;
  selected: string;
  offset: number;
}
/** 计划详情的阅读位置与原窗格独立，退出时还原导航。 */
export function usePlanZoom(lines: Line[], count: number, nav: PlanNavigation, restore: (nav: PlanNavigation) => void) {
  const [active, setActive] = useState(false);
  const saved = useRef(nav),
    scroll = useScroll(lines.length + Math.max(0, count - 1), count);
  const enter = (target?: Extract<Target, { kind: 'plan-row' | 'todo-row' }>) => {
    saved.current = { ...nav };
    const index = target
      ? lines.findIndex(
          (line) =>
            line.target?.kind === 'plan-detail' &&
            (target.kind === 'plan-row' ? line.target.taskId === target.taskId : line.target.todoAgentId === target.agentId),
        )
      : 0;
    scroll.move(Math.max(0, index));
    setActive(true);
  };
  const close = () => {
    setActive(false);
    restore(saved.current);
  };
  return {
    active,
    enter,
    close,
    start: scroll.start,
    move: (delta: number) => scroll.move(scroll.position() + delta),
    exitToOutput: () => setActive(false),
  };
}
