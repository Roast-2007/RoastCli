import { createOutputRows, itemOutputRows } from './output-rows.js';
import type { DisplayItem } from './store/reducer.js';
/** 保留原 spans 行接口，输出与 Chat 一致。 */
export function itemRows(item: DisplayItem, width: number, ascii = false, spacing = 1) {
  return itemOutputRows(item, width, ascii, spacing).map((row) => row.spans);
}
export function createTranscript() {
  const output = createOutputRows();
  return (...args: Parameters<typeof output>) => output(...args).map((row) => row.spans);
}
