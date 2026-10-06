export function deckLayout(columns: number, rows: number, interaction = false) {
  const height = Math.max(1, rows - 1);
  const header = rows >= 12 ? 1 : 0;
  const status = height > 1 ? 1 : 0;
  const available = height - header - status;
  const input = Math.min(available, interaction ? Math.min(14, Math.max(1, available - 1)) : Math.max(1, Math.min(7, Math.floor(rows / 6))));
  const body = Math.max(0, available - input);
  const colony = rows >= 8 && columns >= 70 ? Math.min(30, Math.floor(columns * 0.24)) : 0;
  const signals = rows >= 8 && columns >= 112 ? Math.min(40, Math.floor(columns * 0.23)) : 0;
  return { height, header, status, input, body, colony, signals, mission: Math.max(1, columns - colony - signals), compact: rows < 8, narrow: columns < 70 };
}
