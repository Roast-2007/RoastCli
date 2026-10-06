export type DeckFocus = 'input' | 'colony' | 'mission' | 'signals';
export function nextFocus(current: DeckFocus, signals: boolean): DeckFocus {
  const order: DeckFocus[] = ['input', 'colony', 'mission', ...(signals ? ['signals' as const] : [])];
  return order[(order.indexOf(current) + 1) % order.length]!;
}
export function agentInstruction(text: string, ids: readonly string[]): { agent: string; body: string } | null {
  const match = /^@(\S+)\s+([\s\S]+)$/.exec(text.trim());
  if (!match || (!ids.includes(match[1]!) && match[1] !== 'queen')) return null;
  return { agent: match[1] === 'queen' ? 'main' : match[1]!, body: match[2]! };
}
