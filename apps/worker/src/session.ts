import { sha256 } from "./crypto";

/**
 * Parent console session lifetime.
 *
 * Two independent bounds, which is the conventional pairing:
 *   - idle: a session unused for this long must re-authenticate, so an abandoned
 *     token on a shared or lost device stops working on its own.
 *   - absolute: a session cannot outlive this no matter how actively it is used,
 *     which bounds the damage from a token stolen from an active parent.
 *
 * `parents.session_token` is a single column, so a parent has exactly one live
 * session and logging in elsewhere invalidates the previous one. That is a real
 * constraint worth revisiting if multi-device support is ever wanted; it also
 * means a fresh login is itself a way to revoke a suspected stolen token.
 */
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Sliding the idle window on every request would mean a D1 write per authenticated
 * request. Only persist the slide when the stored value is at least this stale;
 * the idle window is measured in days, so an hour of drift is immaterial.
 */
const SESSION_TOUCH_AFTER_MS = 60 * 60 * 1000;

export type NewSession = {
  /** Opaque token handed to the client. Never stored. */
  sessionToken: string;
  /** SHA-256 of the token — this is what goes in the database. */
  tokenHash: string;
  expiresAt: string;
  lastUsedAt: string;
};

/**
 * Mint a session. Every code path that logs a parent in must go through this so
 * that no route can accidentally create a session without an expiry.
 */
export async function createSession(now: Date = new Date()): Promise<NewSession> {
  const sessionToken = crypto.randomUUID() + "-" + crypto.randomUUID();
  return {
    sessionToken,
    tokenHash: await sha256(sessionToken),
    expiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS).toISOString(),
    lastUsedAt: now.toISOString(),
  };
}

export type SessionTimestamps = {
  sessionExpiresAt: string | null;
  sessionLastUsedAt: string | null;
};

/**
 * A session is live only if it has both timestamps, has not passed its absolute
 * expiry, and has been used within the idle window.
 *
 * Sessions predating migration 0006 have NULL timestamps and are rejected — a
 * one-time forced re-login rather than grandfathering unbounded tokens.
 */
export function isSessionLive(row: SessionTimestamps, now: Date = new Date()): boolean {
  if (!row.sessionExpiresAt || !row.sessionLastUsedAt) return false;

  const expiresAt = Date.parse(row.sessionExpiresAt);
  const lastUsedAt = Date.parse(row.sessionLastUsedAt);
  if (Number.isNaN(expiresAt) || Number.isNaN(lastUsedAt)) return false;

  const nowMs = now.getTime();
  if (nowMs >= expiresAt) return false;
  if (nowMs - lastUsedAt >= SESSION_IDLE_MS) return false;
  return true;
}

/**
 * Slide the idle window, skipping the write when the stored value is recent.
 * Safe to call on every authenticated request.
 */
export async function touchSession(
  db: D1Database,
  tokenHash: string,
  row: SessionTimestamps,
  now: Date = new Date(),
): Promise<void> {
  const lastUsedAt = row.sessionLastUsedAt ? Date.parse(row.sessionLastUsedAt) : 0;
  if (now.getTime() - lastUsedAt < SESSION_TOUCH_AFTER_MS) return;
  await db
    .prepare("UPDATE parents SET session_last_used_at = ? WHERE session_token = ?")
    .bind(now.toISOString(), tokenHash)
    .run();
}

/** Clear a session by token hash. Used by logout and by expiry cleanup. */
export async function clearSession(db: D1Database, tokenHash: string): Promise<void> {
  await db
    .prepare(
      "UPDATE parents SET session_token = NULL, session_expires_at = NULL, session_last_used_at = NULL WHERE session_token = ?",
    )
    .bind(tokenHash)
    .run();
}
