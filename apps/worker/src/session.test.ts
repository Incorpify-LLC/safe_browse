import { describe, expect, it } from "vitest";
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, createSession, isSessionLive } from "./session";

const now = new Date("2026-08-10T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const ahead = (ms: number) => new Date(now.getTime() + ms).toISOString();

describe("isSessionLive", () => {
  it("accepts a session inside both windows", () => {
    expect(isSessionLive({
      sessionExpiresAt: ahead(SESSION_ABSOLUTE_MS),
      sessionLastUsedAt: ago(60_000),
    }, now)).toBe(true);
  });

  it("rejects sessions predating migration 0006, which have no timestamps", () => {
    expect(isSessionLive({ sessionExpiresAt: null, sessionLastUsedAt: null }, now)).toBe(false);
    // A half-populated row is equally untrustworthy.
    expect(isSessionLive({ sessionExpiresAt: ahead(1000), sessionLastUsedAt: null }, now)).toBe(false);
    expect(isSessionLive({ sessionExpiresAt: null, sessionLastUsedAt: ago(1000) }, now)).toBe(false);
  });

  it("rejects a session past its absolute expiry even when actively used", () => {
    expect(isSessionLive({
      sessionExpiresAt: ago(1),
      sessionLastUsedAt: ago(1),
    }, now)).toBe(false);
  });

  it("rejects a session idle beyond the idle window even when not yet at absolute expiry", () => {
    expect(isSessionLive({
      sessionExpiresAt: ahead(SESSION_ABSOLUTE_MS - SESSION_IDLE_MS),
      sessionLastUsedAt: ago(SESSION_IDLE_MS + 1),
    }, now)).toBe(false);
  });

  it("treats the window boundaries as expired rather than live", () => {
    expect(isSessionLive({ sessionExpiresAt: ahead(0), sessionLastUsedAt: ago(0) }, now)).toBe(false);
    expect(isSessionLive({
      sessionExpiresAt: ahead(SESSION_ABSOLUTE_MS),
      sessionLastUsedAt: ago(SESSION_IDLE_MS),
    }, now)).toBe(false);
  });

  it("rejects unparseable timestamps instead of treating NaN comparisons as valid", () => {
    expect(isSessionLive({
      sessionExpiresAt: "not-a-date",
      sessionLastUsedAt: ago(60_000),
    }, now)).toBe(false);
    expect(isSessionLive({
      sessionExpiresAt: ahead(SESSION_ABSOLUTE_MS),
      sessionLastUsedAt: "not-a-date",
    }, now)).toBe(false);
  });
});

describe("createSession", () => {
  it("mints a session that is immediately live and bounded by the absolute window", async () => {
    const session = await createSession(now);
    expect(isSessionLive({
      sessionExpiresAt: session.expiresAt,
      sessionLastUsedAt: session.lastUsedAt,
    }, now)).toBe(true);
    expect(Date.parse(session.expiresAt) - now.getTime()).toBe(SESSION_ABSOLUTE_MS);
  });

  it("stores only a hash, never the token itself", async () => {
    const session = await createSession(now);
    expect(session.tokenHash).not.toContain(session.sessionToken);
    // crypto.sha256 returns base64url, so a 32-byte digest is 43 unpadded chars.
    expect(session.tokenHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("does not repeat tokens", async () => {
    const [a, b] = await Promise.all([createSession(now), createSession(now)]);
    expect(a.sessionToken).not.toBe(b.sessionToken);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });
});
