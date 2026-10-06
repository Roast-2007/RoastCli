export type InterruptAction = 'interrupt' | 'clear' | 'hint' | 'exit';
/** Shared by both workspaces; the armed timestamp survives a screen switch. */
export function ctrlC(running: boolean, draft: string, armedAt: number | null, now: number): { action: InterruptAction; armedAt: number | null } {
  if (running) return { action: 'interrupt', armedAt: null };
  if (draft.length) return { action: 'clear', armedAt: now };
  if (armedAt !== null && now - armedAt <= 2000) return { action: 'exit', armedAt: null };
  return { action: 'hint', armedAt: now };
}
