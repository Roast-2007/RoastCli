import { describe, expect, it } from 'vitest';
import { canonicalPath, isPathInside, isUncPath } from '../../src/core/paths.js';

describe('UNC paths are never touched (M8 review follow-up)', () => {
  it('canonicalPath / isPathInside on \\\\host\\share return immediately without filesystem access', () => {
    const unc = '\\\\attacker.example@SSL\\DavWWWRoot\\x\\a.txt';
    const started = Date.now();
    expect(isUncPath(unc)).toBe(true);
    expect(isUncPath('//host/share/x')).toBe(true);
    expect(isUncPath('C:\\x')).toBe(false);
    canonicalPath(unc);
    expect(isPathInside('C:\\work', unc)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
