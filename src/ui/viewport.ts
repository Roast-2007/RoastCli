import { useWindowSize } from 'ink';
import { useTerminal } from './terminal.js';

export function viewport(rawColumns: number, rawRows: number, configured = 2, env: NodeJS.ProcessEnv = process.env) {
  const override = env['ROAST_GUTTER'];
  const value = override !== undefined && /^[0-4]$/.test(override) ? Number(override) : configured;
  const gutter = rawColumns < 30 ? 0 : Math.max(0, Math.min(4, Math.trunc(value)));
  return { columns: Math.max(1, rawColumns - gutter), rows: Math.max(1, rawRows - 1), gutter, rawColumns, rawRows };
}

/** Every UI layout receives usable dimensions, including the spare bottom row. */
export function useViewport(configured?: number) {
  const { columns, rows } = useWindowSize();
  const terminal = useTerminal();
  return viewport(columns, rows, configured ?? terminal.gutter);
}
