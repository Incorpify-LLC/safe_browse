import { describe, expect, it } from "vitest";
import { randomToken, sha256, sixDigitCode } from "./crypto";

describe("credential helpers", () => {
  it("generates URL-safe, non-repeating credentials", () => {
    const first = randomToken(); const second = randomToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(first).not.toBe(second);
  });
  it("hashes deterministically and creates six-digit codes", async () => {
    expect(await sha256("safe-browse")).toBe(await sha256("safe-browse"));
    expect(sixDigitCode()).toMatch(/^\d{6}$/);
  });
});
