import { describe, expect, it } from "vitest";
import {
  generateEnrollmentCode,
  hashPassword,
  isValidEnrollmentCode,
  normalizeEnrollmentCode,
  randomToken,
  sha256,
  sixDigitCode,
  verifyPassword,
} from "./crypto";

describe("credential helpers", () => {
  it("generates URL-safe, non-repeating credentials", () => {
    const first = randomToken();
    const second = randomToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
  });

  it("hashes deterministically and creates six-digit codes", async () => {
    expect(await sha256("safe-browse")).toBe(await sha256("safe-browse"));
    expect(sixDigitCode()).toMatch(/^\d{6}$/);
  });

  it("generates high-entropy enrollment codes and normalizes hyphens", () => {
    const code = generateEnrollmentCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const normalized = normalizeEnrollmentCode(code);
    expect(normalized).toHaveLength(12);
    expect(isValidEnrollmentCode(normalized)).toBe(true);
    expect(normalizeEnrollmentCode(code.toLowerCase().replaceAll("-", " "))).toBe(normalized);
    expect(isValidEnrollmentCode("123456")).toBe(true); // legacy
    expect(isValidEnrollmentCode("ABC")).toBe(false);
  });

  it("hashes passwords with unique salts and verifies", async () => {
    const a = await hashPassword("1234");
    const b = await hashPassword("1234");
    expect(a).toMatch(/^pbkdf2\$sha256\$120000\$/);
    expect(a).not.toBe(b);
    expect((await verifyPassword("1234", a)).ok).toBe(true);
    expect((await verifyPassword("9999", a)).ok).toBe(false);
  });

  it("verifies legacy sha256 hashes and marks rehash", async () => {
    const legacy = await sha256("sb_salt_pin42");
    const result = await verifyPassword("pin42", legacy);
    expect(result.ok).toBe(true);
    expect(result.needsRehash).toBe(true);
    expect((await verifyPassword("wrong", legacy)).ok).toBe(false);
  });
});
