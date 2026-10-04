import { stripVTControlCharacters } from 'node:util';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︐-︙︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3fffd}]/u;
const EMOJI = /\p{Emoji_Presentation}|\p{Regional_Indicator}|\u20e3|\ufe0f/u;
const INVISIBLE = /[\p{Mark}\p{Control}\p{Format}]/gu;

/** UTF-16 offsets are retained for editing; widths always count terminal cells. */
export function graphemes(text: string): { text: string; start: number; end: number }[] {
  return Array.from(segmenter.segment(text), (s) => ({ text: s.segment, start: s.index, end: s.index + s.segment.length }));
}

export function previousBoundary(text: string, offset: number): number {
  return graphemes(text).reverse().find((s) => s.start < offset)?.start ?? 0;
}

export function nextBoundary(text: string, offset: number): number {
  return graphemes(text).find((s) => s.end > offset)?.end ?? text.length;
}

function cellWidth(text: string): number {
  const visible = text.replace(INVISIBLE, '');
  if (!visible) return 0;
  if (EMOJI.test(text) && !text.includes('\ufe0e')) return 2;
  return WIDE.test(visible) ? 2 : 1;
}

export function displayWidth(s: string): number {
  return graphemes(stripVTControlCharacters(s)).reduce((w, ch) => w + cellWidth(ch.text), 0);
}

export function truncateDisplay(text: string, width: number, suffix = '…'): string {
  text = stripVTControlCharacters(text).replace(/[\r\n\t]/g, ' ');
  width = Math.max(0, width);
  if (displayWidth(text) <= width) return text;
  const budget = Math.max(0, width - displayWidth(suffix));
  let result = '';
  let used = 0;
  for (const ch of graphemes(text)) {
    const size = cellWidth(ch.text);
    if (used + size > budget) break;
    result += ch.text;
    used += size;
  }
  return result + (displayWidth(suffix) <= width ? suffix : '');
}

export function wrapDisplay(text: string, width: number): string[] {
  width = Math.max(1, width);
  const lines: string[] = [];
  for (const line of stripVTControlCharacters(text).replace(/\t/g, '    ').split('\n')) {
    let row = '';
    let used = 0;
    for (const ch of graphemes(line)) {
      const size = cellWidth(ch.text);
      if (used + size > width && row) { lines.push(row); row = ''; used = 0; }
      row += size > width ? '?' : ch.text;
      used += Math.min(size, width);
    }
    lines.push(row);
  }
  return lines;
}

/** 按显示宽度右侧补空格 */
export function padDisplay(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}
