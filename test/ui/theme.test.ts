import { describe, expect, it } from 'vitest';
import { pickTheme, THEMES } from '../../src/ui/theme.js';

describe('pickTheme', () => {
  it('prefers NO_COLOR, then ROAST_THEME, then config, then aurora', () => {
    expect(pickTheme({ NO_COLOR: '1', ROAST_THEME: 'ember' }, 'daylight').name).toBe('mono');
    expect(pickTheme({ ROAST_THEME: 'ember' }, 'daylight').name).toBe('ember');
    expect(pickTheme({}, 'daylight').name).toBe('daylight');
    expect(pickTheme({}).name).toBe('aurora');
    expect(pickTheme({ ROAST_THEME: 'nope' }).name).toBe('aurora');
  });

  it('every colored theme defines all semantic tokens and a gradient', () => {
    for (const t of Object.values(THEMES).filter((x) => x.name !== 'mono')) {
      for (const k of ['accent', 'success', 'warn', 'danger', 'info', 'user', 'tool', 'border'] as const)
        expect(t[k], `${t.name}.${k}`).toMatch(/^#[0-9a-f]{6}$/);
      expect(t.gradient.length).toBeGreaterThanOrEqual(2);
    }
  });
});
