import { describe, expect, it } from 'vitest';
import { displayWidth, truncateDisplay, wrapDisplay } from '../../src/core/text-width.js';
import { createEditor, editorReducer } from '../../src/ui/input/editor.js';
import { editorViewport, inlineLayout } from '../../src/ui/layout.js';
import { deckLayout } from '../../src/ui/hive/layout.js';

describe('terminal text and layout', () => {
  it('measures graphemes, emoji, combining marks and terminal escapes', () => {
    expect(displayWidth('中A')).toBe(3);
    expect(displayWidth('e\u0301👨‍👩‍👧‍👦🇸🇬')).toBe(5);
    expect(displayWidth('\u001b[31m中文\u001b[0m')).toBe(4);
    expect(truncateDisplay('中文👩‍💻abcdef', 7)).toBe('中文👩‍💻…');
    expect(wrapDisplay('中文👩‍💻abc', 4)).toEqual(['中文', '👩‍💻ab', 'c']);
  });
  it('never places the editing caret outside the viewport, even after resizing', () => {
    const state = editorReducer(createEditor(), { type: 'set', text: '中文'.repeat(30) + '\nlast' });
    for (const width of [4, 12, 76]) for (const height of [1, 3, 8]) {
      const view = editorViewport(state, width, height);
      expect(view.lines.length).toBeLessThanOrEqual(height);
      expect(view.caret.y).toBeGreaterThanOrEqual(0);
      expect(view.caret.y).toBeLessThan(height);
      expect(view.caret.x).toBeLessThan(width);
      expect(view.lines.every((line) => displayWidth(line.text) <= width)).toBe(true);
    }
  });
  it('deletes and traverses a whole grapheme without corrupting unicode', () => {
    let state = editorReducer(createEditor(), { type: 'insert', text: 'a👩‍💻e\u0301' });
    state = editorReducer(state, { type: 'backspace' });
    expect(state.lines).toEqual(['a👩‍💻']);
    state = editorReducer(state, { type: 'left' });
    expect(state.col).toBe(1);
    state = editorReducer(state, { type: 'delete' });
    expect(state.lines).toEqual(['a']);
  });
  it('budgets every visible region below the screen height', () => {
    for (const rows of [5, 10, 16, 24, 40, 80]) {
      const layout = inlineLayout(rows - 1, { tools: 20, todos: 100, agents: 20, interaction: false, detail: false });
      expect(Object.values(layout).reduce((a, b) => a + b, 0)).toBeLessThan(rows);
      expect(layout.input).toBeGreaterThan(0);
      const modal = inlineLayout(rows - 1, { tools: 20, todos: 100, agents: 20, interaction: true, detail: true });
      expect(Object.values(modal).reduce((a, b) => a + b, 0)).toBeLessThan(rows);
      for (const columns of [20, 40, 80, 120, 200]) {
        const mission = deckLayout(columns, rows - 1);
        expect(mission.height).toBeLessThan(rows);
        expect(mission.colony + mission.mission + mission.signals).toBeLessThanOrEqual(columns);
        expect(mission.mission).toBeGreaterThan(0);
      }
    }
  });
});
