import { RoastError } from '../core/errors.js';
import { parseRule } from '../tools/permissions/rules.js';

export function parseMaxSteps(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(n) || n < 1 || n > 1000)
    throw new RoastError('INVALID_REQUEST', '--max-steps 应为 1–1000 的整数');
  return n;
}

export function parseBudget(value: string | undefined, headless: boolean): number | undefined {
  if (value === undefined) return undefined;
  if (!headless) throw new RoastError('INVALID_REQUEST', '--max-budget-usd 仅可用于 -p / --print');
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new RoastError('INVALID_REQUEST', '--max-budget-usd 应为正数');
  return n;
}

export function parseToolRules(values: string[] = []): string[] {
  return values.flatMap((value) => {
    let depth = 0,
      start = 0;
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (value[i] === '(') depth++;
      if (value[i] === ')') depth--;
      if (depth < 0) throw new RoastError('INVALID_REQUEST', `无效权限规则：${value}`);
      if (value[i] === ',' && depth === 0) {
        parts.push(value.slice(start, i));
        start = i + 1;
      }
    }
    if (depth !== 0) throw new RoastError('INVALID_REQUEST', `无效权限规则：${value}`);
    parts.push(value.slice(start));
    return parts.map((part) => {
      const text = part.trim(),
        rule = parseRule(text);
      if (!/^[A-Za-z_][A-Za-z0-9_*-]*$/.test(rule.tool) || (rule.pattern !== undefined && !rule.pattern))
        throw new RoastError('INVALID_REQUEST', `无效权限规则：${part}`);
      return text;
    });
  });
}
