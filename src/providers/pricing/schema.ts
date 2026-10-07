import { z } from 'zod';

export const PricingSchema = z.object({
  input: z.number().finite().nonnegative(),
  output: z.number().finite().nonnegative(),
  cacheRead: z.number().finite().nonnegative().optional(),
  cacheWrite: z.number().finite().nonnegative().optional(),
});
export const PricingCatalogSchema = z.object({
  version: z.literal(1),
  updatedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((s) => {
      const date = new Date(s);
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === s;
    }, '日期无效'),
  currency: z.literal('USD'),
  unit: z.literal('1M tokens'),
  entries: z.array(
    z.object({
      provider: z.string().min(1),
      hosts: z.array(z.string().min(1)).optional(),
      models: z.array(z.string().min(1)).min(1),
      pricing: PricingSchema,
      /** Required in the bundled catalog (enforced by its test); optional in a hand-written ~/.roast/pricing.json. */
      source: z.string().url().optional(),
      note: z.string().optional(),
    }),
  ),
});
export type PricingCatalog = z.infer<typeof PricingCatalogSchema>;

export function parsePricingCatalog(raw: unknown): { catalog?: PricingCatalog; error?: string } {
  const result = PricingCatalogSchema.safeParse(raw);
  return result.success
    ? { catalog: result.data }
    : { error: result.error.issues.map((i) => `${i.path.join('.') || '价目'}: ${i.message}`).join('; ') };
}
