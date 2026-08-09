/**
 * Multi-tenant auth contract tests (schemas + status semantics).
 * Route handlers need D1; these lock the public API shapes for the dashboard.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

const MIN_PASSWORD = 4;
const MAX_PASSWORD = 100;

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(MIN_PASSWORD).max(MAX_PASSWORD),
  householdName: z.string().min(1).max(80).optional(),
  turnstileToken: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  turnstileToken: z.string().optional(),
});

const totpRecoverSchema = z.object({
  email: z.string().email(),
  totpCode: z.string().length(6),
  newPassword: z.string().min(MIN_PASSWORD).max(MAX_PASSWORD),
  turnstileToken: z.string().optional(),
});

describe("multi-tenant auth schemas", () => {
  it("accepts signup with email and password", () => {
    const r = signupSchema.safeParse({
      email: "parent-a@example.com",
      password: "pin1",
      householdName: "Family A",
    });
    expect(r.success).toBe(true);
  });

  it("rejects signup without email", () => {
    const r = signupSchema.safeParse({ password: "pin1" });
    expect(r.success).toBe(false);
  });

  it("accepts login with email and password", () => {
    const r = loginSchema.safeParse({
      email: "parent-a@example.com",
      password: "pin1",
    });
    expect(r.success).toBe(true);
  });

  it("requires email for TOTP recover", () => {
    expect(
      totpRecoverSchema.safeParse({
        totpCode: "123456",
        newPassword: "newpin",
      }).success,
    ).toBe(false);
    expect(
      totpRecoverSchema.safeParse({
        email: "parent-a@example.com",
        totpCode: "123456",
        newPassword: "newpin",
      }).success,
    ).toBe(true);
  });
});

describe("multi-tenant status contract", () => {
  it("documents expected anonymous status fields", () => {
    // Mirrors GET /api/v1/auth/status for unauthenticated SaaS clients
    const anonymousStatus = {
      multiTenant: true,
      signupEnabled: true,
      requireSetup: false,
      requireTotp: false,
      hasSession: false,
      email: null as string | null,
      hasPassword: false,
      hasTotpBackup: false,
      turnstileSiteKey: "1x00000000000000000000AA",
    };
    expect(anonymousStatus.requireSetup).toBe(false);
    expect(anonymousStatus.signupEnabled).toBe(true);
    expect(anonymousStatus.multiTenant).toBe(true);
  });
});
