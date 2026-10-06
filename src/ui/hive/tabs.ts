import { displayWidth } from '../../core/text-width.js';
export const TABS = ['计划', '输出', '改动', '消息', '黑板', '用量'] as const;
export function missionTabs(width: number, tab: number, signals = false) {
  const order = signals ? [0, 1, 2, 6, 3, 4, 5] : [0, 1, 2, 3, 4, 5];
  let x = 0;
  return order.map((value, index) => {
    const text = `${index + 1}${value === 6 ? '信号' : TABS[value]}${value === tab ? '*' : ''}${index < order.length - 1 ? ' ' : ''}`;
    const item = { tab: value, index, text, x, width: displayWidth(text) }; x += item.width;
    return item;
  }).filter(item => item.x + item.width <= width);
}
