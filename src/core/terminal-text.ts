import { stripVTControlCharacters } from 'node:util';

/** 外部工具文本只作为内容显示，不允许改变终端状态；保留换行、制表符和 Unicode。 */
export function terminalText(text: string): string {
  return stripVTControlCharacters(text).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}
