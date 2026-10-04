/**
 * 输入法（IME）光标：把终端真实光标放到输入框的插入点，中文输入法的候选框才会跟随。
 * Ink 的 useCursor 需要相对 Ink 动态输出原点的坐标；<Static> 绝对定位不占布局，
 * 所以把元素到根节点路径上的 yoga 偏移累加即可得到原点坐标。
 */
import type { DOMElement } from 'ink';
import { displayWidth } from '../../core/text-width.js';

export interface Point {
  x: number;
  y: number;
}

/** 元素左上角相对 Ink 输出原点的位置（基于上一次布局结果） */
export function absoluteOrigin(node: DOMElement | null): Point | null {
  if (!node?.yogaNode) return null;
  let x = 0;
  let y = 0;
  for (let n: DOMElement | undefined = node; n; n = n.parentNode) {
    x += n.yogaNode?.getComputedLeft() ?? 0;
    y += n.yogaNode?.getComputedTop() ?? 0;
  }
  return { x, y };
}

/**
 * 插入点坐标：输入框原点 + 边框 / 内边距 / 提示符宽度 + 光标前文字的显示宽度（CJK 记 2 列）。
 * prefixCols = 左边框(1) + paddingX(1) + "› "(2)。
 */
export function caretPosition(origin: Point, line: string, col: number, row: number, prefixCols = 4): Point {
  return { x: origin.x + prefixCols + displayWidth(line.slice(0, col)), y: origin.y + 1 + row };
}
