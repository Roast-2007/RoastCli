import { describe, expect, it } from 'vitest';
import { useRef, useEffect } from 'react';
import { Box, Text, type DOMElement } from 'ink';
import { render } from 'ink-testing-library';
import { absoluteOrigin, caretPosition, type Point } from '../../src/ui/input/cursor.js';

describe('IME cursor placement', () => {
  it('counts CJK characters as two columns and offsets by border, padding and prompt', () => {
    expect(caretPosition({ x: 0, y: 2 }, '中文ab', 3, 0)).toEqual({ x: 9, y: 3 });
    expect(caretPosition({ x: 1, y: 0 }, '', 0, 2)).toEqual({ x: 5, y: 3 });
  });

  it('computes the absolute origin of a nested box from the Ink layout', async () => {
    let seen: Point | null = null;
    function Probe() {
      const ref = useRef<DOMElement>(null);
      useEffect(() => {
        seen = absoluteOrigin(ref.current);
      });
      return (
        <Box flexDirection="column">
          <Text>line 1</Text>
          <Text>line 2</Text>
          <Box marginLeft={3} ref={ref}>
            <Text>input</Text>
          </Box>
        </Box>
      );
    }
    const { rerender, unmount } = render(<Probe />);
    await new Promise((r) => setTimeout(r, 20));
    rerender(<Probe />);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual({ x: 3, y: 2 });
    expect(absoluteOrigin(null)).toBeNull();
    unmount();
  });
});
