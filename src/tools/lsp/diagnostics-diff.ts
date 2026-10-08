export interface FileDiagnostic {
  line: number;
  column: number;
  code: number;
  message: string;
}

export function newDiagnostics(before: FileDiagnostic[], after: FileDiagnostic[]): FileDiagnostic[] {
  const counts = new Map<string, number>(),
    key = (d: FileDiagnostic) => JSON.stringify([d.code, d.message]);
  for (const d of before) counts.set(key(d), (counts.get(key(d)) ?? 0) + 1);
  return after.filter((d) => {
    const n = counts.get(key(d)) ?? 0;
    if (!n) return true;
    counts.set(key(d), n - 1);
    return false;
  });
}
