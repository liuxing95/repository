import { z } from "zod";

export const Purpose = z.enum([
  "read",
  "fetch",
  "model",
  "ocr",
  "embedding",
  "rerank",
  "notification",
  "calendar",
  "publish",
]);
export type Purpose = z.infer<typeof Purpose>;
export const SourcePolicy = z
  .object({
    sourceId: z.string().min(1),
    retracted: z.boolean(),
    routes: z.record(Purpose, z.array(z.string()).max(30)),
  })
  .strict();
export type SourcePolicy = z.infer<typeof SourcePolicy>;
export const Money = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const BudgetConfig = z
  .object({
    currency: z.literal("USD"),
    timezone: z.string().refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }),
    jobLimit: Money,
    dayLimit: Money,
    monthLimit: Money,
  })
  .strict();
export type BudgetConfig = z.infer<typeof BudgetConfig>;
export const Price = z
  .object({
    version: z.string().min(1),
    expiresAt: z.number().int().positive(),
    inputPerMillion: Money,
    outputPerMillion: Money,
    fixedCost: Money,
    maxInputTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
  })
  .strict();
export type Price = z.infer<typeof Price>;
export const Settings = z
  .object({
    schemaVersion: z.literal(1),
    budget: BudgetConfig.nullable(),
    routes: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9-]{1,64}$/),
            purpose: Purpose,
            enabled: z.boolean(),
            price: Price.nullable(),
          })
          .strict(),
      )
      .max(30),
  })
  .strict();
export type Settings = z.infer<typeof Settings>;
export const defaultSettings: Settings = {
  schemaVersion: 1,
  budget: null,
  routes: [],
};
