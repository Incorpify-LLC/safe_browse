import { z } from "zod";

export const categories = [
  "threats", "adult", "gambling", "drugs", "piracy", "bypass",
  "anime", "social", "gaming", "streaming",
] as const;
export const categorySchema = z.enum(categories);
export type Category = z.infer<typeof categorySchema>;

export const ageBands = ["under_10", "age_10_12", "age_13_15", "age_16_17"] as const;
export const ageBandSchema = z.enum(ageBands);
export type AgeBand = z.infer<typeof ageBandSchema>;

const allSafety = ["threats", "adult", "gambling", "drugs", "piracy", "bypass"] as const;
export const presetCategories: Readonly<Record<AgeBand, readonly Category[]>> = {
  under_10: [...allSafety, "anime", "social", "gaming", "streaming"],
  age_10_12: [...allSafety, "anime"],
  age_13_15: [...allSafety],
  age_16_17: [...allSafety],
};

export const scheduleSchema = z.object({
  category: categorySchema,
  days: z.array(z.number().int().min(0).max(6)).min(1),
  startMinutes: z.number().int().min(0).max(1439),
  endMinutes: z.number().int().min(1).max(1440),
}).refine((value) => value.endMinutes > value.startMinutes, "endMinutes must be after startMinutes");

export const domainRuleSchema = z.object({
  domain: z.string().min(1).max(253),
  action: z.enum(["allow", "block"]),
  expiresAt: z.string().datetime().nullable().default(null),
});

export const policySchema = z.object({
  version: z.number().int().nonnegative(),
  childId: z.string().uuid(),
  ageBand: ageBandSchema,
  timezone: z.string().min(1).max(64),
  enabledCategories: z.array(categorySchema),
  schedules: z.array(scheduleSchema),
  domainRules: z.array(domainRuleSchema),
  safeSearch: z.boolean(),
  youtubeRestricted: z.boolean(),
  paused: z.boolean(),
  listVersion: z.string().min(1),
  generatedAt: z.string().datetime(),
});
export type Policy = z.infer<typeof policySchema>;

export const eventSchema = z.object({
  id: z.string().uuid(),
  occurredAt: z.string().datetime(),
  kind: z.enum(["navigation", "blocked", "tamper", "emergency_bypass"]),
  domain: z.string().max(253).nullable().default(null),
  category: categorySchema.nullable().default(null),
  browser: z.enum(["edge", "chrome", "firefox", "other"]).nullable().default(null),
  detail: z.string().max(200).nullable().default(null),
});
export const eventBatchSchema = z.object({ events: z.array(eventSchema).min(1).max(100) });

/**
 * Device enrollment code from parent console.
 * Accepts:
 * - New format: 12 Crockford-like chars, optional hyphens (e.g. AB3K-M9NP-Q2VX)
 * - Legacy: 6 digits (older agents / codes still in flight)
 */
export const enrollmentSchema = z.object({
  code: z
    .string()
    .trim()
    .min(6)
    .max(40)
    .transform((value) => value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
    .refine(
      (normalized) => /^\d{6}$/.test(normalized) || /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/.test(normalized),
      "Invalid enrollment code format",
    ),
  deviceName: z.string().trim().min(1).max(80),
  platform: z.literal("windows"),
  agentVersion: z.string().min(1).max(32),
});

export const heartbeatSchema = z.object({
  agentVersion: z.string().min(1).max(32),
  policyVersion: z.number().int().nonnegative(),
  listVersion: z.string().max(80),
  status: z.enum(["healthy", "degraded", "tampered", "emergency_bypass"]),
  detail: z.string().max(200).nullable().default(null),
});

export const accessRequestSchema = z.object({
  domain: z.string().min(1).max(253),
  category: categorySchema.nullable().default(null),
  reason: z.string().trim().max(300).nullable().default(null),
});

export const approvalSchema = z.object({
  duration: z.enum(["session", "hour", "day", "permanent", "deny"]),
});

export function normalizeDomain(input: string): string {
  const trimmed = input.trim().toLowerCase().replace(/\.$/, "");
  if (!trimmed || trimmed.length > 253 || trimmed.includes("/") || trimmed.includes(":")) {
    throw new Error("Invalid domain");
  }
  const ascii = new URL(`http://${trimmed}`).hostname;
  if (!ascii || ascii.length > 253 || ascii.split(".").some((label) => !label || label.length > 63)) {
    throw new Error("Invalid domain");
  }
  return ascii;
}
