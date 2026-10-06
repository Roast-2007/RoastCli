import { displayWidth, truncateDisplay } from '../../core/text-width.js';
export const TABS = ['计划', '输出', '改动', '消息', '黑板', '用量'] as const;
export function missionTabs(width: number, tab: number, signals = false, ascii = false) {
  const order = signals ? [0, 1, 2, 6, 3, 4, 5] : [0, 1, 2, 3, 4, 5];
  let x = 0;
  const items = order.map((value, index) => {
    const text = ` ${index + 1} ${value === 6 ? '信号' : TABS[value]} `;
    const item = { tab: value, index, text, x, width: displayWidth(text) }; x += item.width + 1;
    return item;
  });
  const shown = items.filter(item => item.x + item.width <= width);
  if (!shown.some(item => item.tab === tab)) {
    const active = items.find(item => item.tab === tab);
    if (active && active.width <= width) return [{ ...active, x: 0 }];
  }
  return shown.map(item => ({ ...item, separator: ascii ? '|' : '│' }));
}
export function tabMemberSuffix(width: number, tab: number, member?: string) {
  return (tab === 1 || tab === 2) && member ? truncateDisplay(` · ${member}`, Math.max(0, Math.min(Math.floor(width / 2), width - 10))) : '';
}
