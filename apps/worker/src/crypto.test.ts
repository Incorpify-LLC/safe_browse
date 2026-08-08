import { describe, expect, it } from "vitest";
import { hashPassword, randomToken, sha256, sixDigitCode, verifyPassword } from "./crypto";

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
