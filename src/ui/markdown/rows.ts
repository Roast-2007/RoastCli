import { marked, type Token, type Tokens } from 'marked';
import { highlight, supportsLanguage } from 'cli-highlight';
import { displayWidth, graphemes, padDisplay, truncateDisplay } from '../../core/text-width.js';
import { terminalText } from '../../core/terminal-text.js';
import type { Theme } from '../theme.js';

export interface Span { text: string; color?: Exclude<keyof Theme, 'name' | 'gradient'>; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; strike?: boolean }
export type Row = Span[];
const span = (text: string, style: Omit<Span, 'text'> = {}): Span => ({ text, ...style });
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Translate the highlighter's palette to theme tokens before wrapping into rows. */
function codeSpans(text: string, lang: string): Row {
  let colored = text;
  try { if (lang && supportsLanguage(lang)) colored = highlight(text, { language: lang, ignoreIllegals: true }); } catch { /* Render unsupported or incomplete code as text. */ }
  const spans: Row = [], codes = /\x1b\[([\d;]*)m/g;
  const palette: Record<number, Span['color']> = { 31: 'danger', 32: 'success', 33: 'accent2', 34: 'info', 35: 'accent', 36: 'info', 90: 'muted', 91: 'danger', 92: 'success', 93: 'accent2', 94: 'info', 95: 'accent', 96: 'info' };
  let start = 0, style: Omit<Span, 'text'> = {};
  for (const match of colored.matchAll(codes)) {
    if (match.index > start) spans.push(span(colored.slice(start, match.index), style));
    for (const code of match[1]!.split(';').map(Number)) {
      if (code === 0) style = {};
      else if (code === 39) style = { ...style, color: undefined };
      else if (code === 1 || code === 22) style = { ...style, bold: code === 1 };
      else if (code === 3 || code === 23) style = { ...style, italic: code === 3 };
      else if (palette[code]) style = { ...style, color: palette[code] };
    }
    start = match.index + match[0].length;
  }
  if (start < colored.length) spans.push(span(colored.slice(start), style));
  return spans.length ? spans : [span(text)];
}

function inline(tokens: Token[] = [], style: Omit<Span, 'text'> = {}): Row {
  return tokens.flatMap((t): Span[] => {
    const token = t as Tokens.Text;
    if (t.type === 'strong') return inline(token.tokens, { ...style, bold: true });
    if (t.type === 'em') return inline(token.tokens, { ...style, italic: true });
    if (t.type === 'del') return inline(token.tokens, { ...style, strike: true });
    if (t.type === 'codespan') return [span(token.text, { ...style, color: 'accent2' })];
    if (t.type === 'link') {
      const link = t as Tokens.Link;
      return [...inline(link.tokens, { ...style, color: 'info', underline: true }), ...(link.href && link.href !== link.text ? [span(` (${link.href})`, { ...style, dim: true })] : [])];
    }
    if (t.type === 'br') return [span('\n', style)];
    if (token.tokens) return inline(token.tokens, style);
    return [span(decode(token.text ?? t.raw ?? ''), style)];
  });
}

/** Wrap styled spans by terminal cells, preserving graphemes and inline styles. */
export function wrapSpans(spans: Row, width: number): Row[] {
  width = Math.max(1, width);
  const rows: Row[] = [];
  let row: Row = [], used = 0;
  for (const part of spans) {
    for (const ch of graphemes(part.text.replace(/\t/g, '    '))) {
      if (ch.text === '\n') { rows.push(row); row = []; used = 0; continue; }
      const size = displayWidth(ch.text);
      if (used + size > width && row.length) { rows.push(row); row = []; used = 0; }
      const text = size > width ? '?' : ch.text;
      const last = row.at(-1);
      if (last && last.color === part.color && last.bold === part.bold && last.dim === part.dim && last.italic === part.italic && last.underline === part.underline && last.strike === part.strike) last.text += text;
      else row.push({ ...part, text });
      used += Math.min(size, width);
    }
  }
  rows.push(row);
  return rows;
}

function blocks(tokens: Token[], width: number, ascii: boolean, spacing: number): Row[] {
  const rows: Row[] = [];
  const add = (parts: Row) => rows.push(...wrapSpans(parts, width));
  for (const t of tokens.filter((t) => t.type !== 'space')) {
    switch (t.type) {
      case 'heading': {
        const h = t as Tokens.Heading;
        add([span(h.depth <= 2 ? ascii ? '# ' : '▍' : '', { color: 'accent', bold: true }), ...inline(h.tokens, { bold: true, ...(h.depth <= 2 ? { color: 'accent' as const } : {}) })]); break;
      }
      case 'paragraph': case 'text': add(inline((t as Tokens.Paragraph).tokens ?? [t])); break;
      case 'code': {
        const code = t as Tokens.Code;
        const lang = code.lang?.split(/\s/)[0] ?? '';
        add([span(`${ascii ? '+-' : '╭─'} ${lang || 'code'}`, { dim: true })]);
        const prefix = width > 2 ? ascii ? '| ' : '│ ' : '';
        for (const body of wrapSpans(codeSpans(code.text, lang), Math.max(1, width - displayWidth(prefix)))) rows.push([span(prefix, { dim: true }), ...body]);
        add([span(ascii ? '+-' : '╰─', { dim: true })]); break;
      }
      case 'list': {
        const list = t as Tokens.List, start = typeof list.start === 'number' ? list.start : 1;
        list.items.forEach((item, index) => {
          const bullet = `${list.ordered ? `${start + index}.` : ascii ? '-' : '•'} `;
          const mark = item.task ? ascii ? item.checked ? '[x] ' : '[ ] ' : item.checked ? '☑ ' : '☐ ' : '';
          const prefix = truncateDisplay(bullet, Math.max(0, width - 1), '');
          const child = blocks(item.tokens.filter((t) => t.type !== 'checkbox'), Math.max(1, width - displayWidth(prefix) - displayWidth(mark)), ascii, 0);
          child.forEach((line, i) => rows.push(...wrapSpans([span(i === 0 ? prefix + mark : ' '.repeat(displayWidth(prefix + mark)), { color: 'accent' }), ...line], width)));
        }); break;
      }
      case 'blockquote': {
        const prefix = width > 2 ? ascii ? '> ' : '│ ' : '';
        for (const row of blocks((t as Tokens.Blockquote).tokens, Math.max(1, width - displayWidth(prefix)), ascii, 0)) rows.push([span(prefix, { dim: true }), ...row]); break;
      }
      case 'table': {
        const table = t as Tokens.Table;
        const data = [table.header, ...table.rows].map((r) => r.map((c) => inline(c.tokens).map((s) => s.text).join('')));
        const separator = ascii ? ' | ' : ' │ ';
        if (width < table.header.length * 4) { data.forEach((r) => add([span(r.join(' / '))])); break; }
        const budget = Math.max(1, Math.floor((width - (table.header.length - 1) * 3) / table.header.length));
        const widths = table.header.map((_, col) => Math.min(budget, Math.max(1, ...data.map((r) => displayWidth(r[col] ?? '')))));
        data.forEach((r, index) => {
          add([span(r.map((c, col) => padDisplay(truncateDisplay(c, widths[col]!), widths[col]!)).join(separator), { bold: index === 0 })]);
          if (index === 0) add([span(widths.map((w) => (ascii ? '-' : '─').repeat(w)).join(ascii ? '-+-' : '─┼─'), { dim: true })]);
        }); break;
      }
      case 'hr': add([span((ascii ? '-' : '─').repeat(Math.min(40, width)), { dim: true })]); break;
      default: add([span(decode(t.raw).trimEnd())]);
    }
    if (spacing) rows.push(...Array.from({ length: spacing }, () => []));
  }
  return rows;
}

export function markdownRows(text: string, width: number, ascii = false, spacing = 1): Row[] {
  return blocks(marked.lexer(terminalText(text)), Math.max(1, width), ascii, spacing);
}
