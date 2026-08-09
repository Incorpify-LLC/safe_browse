/**
 * Durable per-bucket rate limiting stored in D1.
 * Survives isolate restarts and is shared across Workers isolates (best-effort under D1 race).
 */

export type RateLimitResult =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSec: number; remaining: 0 };

export type RateLimitPolicy = {
  /** Unique bucket key prefix, e.g. "login" */
  action: string;
  /** Max failures (or attempts) in the window before lockout */
  maxAttempts: number;
  /** Window length in milliseconds */
  windowMs: number;
};

const DEFAULTS: Record<string, RateLimitPolicy> = {
  login: { action: "login", maxAttempts: 5, windowMs: 15 * 60_000 },
  "totp-recover": { action: "totp-recover", maxAttempts: 5, windowMs: 15 * 60_000 },
  recover: { action: "recover", maxAttempts: 5, windowMs: 15 * 60_000 },
  enroll: { action: "enroll", maxAttempts: 20, windowMs: 10 * 60_000 },
  setup: { action: "setup", maxAttempts: 10, windowMs: 60 * 60_000 },
  /** Multi-tenant account creation (per IP). */
  signup: { action: "signup", maxAttempts: 10, windowMs: 60 * 60_000 },
};

export function clientIp(headers: Headers): string {
  return (
    headers.get("CF-Connecting-IP") ||
    headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "127.0.0.1"
  );
}

function bucketKey(action: string, ip: string): string {
  return `${action}:${ip}`;
}

/**
 * Check whether the client is currently locked out (does not increment).
 */
export async function checkRateLimit(
  db: D1Database,
  action: keyof typeof DEFAULTS | string,
  ip: string,
): Promise<RateLimitResult> {
  const policy = DEFAULTS[action] ?? { action, maxAttempts: 5, windowMs: 15 * 60_000 };
  const key = bucketKey(policy.action, ip);
  const now = Date.now();
  const row = await db
    .prepare(`SELECT count, window_start AS windowStart FROM rate_limits WHERE key = ?`)
    .bind(key)
    .first<{ count: number; windowStart: number }>();

  if (!row) return { allowed: true, remaining: policy.maxAttempts };

  if (now - row.windowStart > policy.windowMs) {
    return { allowed: true, remaining: policy.maxAttempts };
  }

  if (row.count >= policy.maxAttempts) {
    const retryAfterSec = Math.max(1, Math.ceil((row.windowStart + policy.windowMs - now) / 1000));
    return { allowed: false, retryAfterSec, remaining: 0 };
  }

  return { allowed: true, remaining: policy.maxAttempts - row.count };
}

/** Record a failed attempt; returns whether still allowed after increment. */
export async function recordFailure(
  db: D1Database,
  action: keyof typeof DEFAULTS | string,
  ip: string,
): Promise<RateLimitResult> {
  const policy = DEFAULTS[action] ?? { action, maxAttempts: 5, windowMs: 15 * 60_000 };
  const key = bucketKey(policy.action, ip);
  const now = Date.now();
  const row = await db
    .prepare(`SELECT count, window_start AS windowStart FROM rate_limits WHERE key = ?`)
    .bind(key)
    .first<{ count: number; windowStart: number }>();

  let count = 1;
  let windowStart = now;
  if (row && now - row.windowStart <= policy.windowMs) {
    count = row.count + 1;
    windowStart = row.windowStart;
  }

  await db
    .prepare(
      `INSERT INTO rate_limits(key, count, window_start, updated_at) VALUES(?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET count=excluded.count, window_start=excluded.window_start, updated_at=excluded.updated_at`,
    )
    .bind(key, count, windowStart, now)
    .run();

  if (count >= policy.maxAttempts) {
    const retryAfterSec = Math.max(1, Math.ceil((windowStart + policy.windowMs - now) / 1000));
    return { allowed: false, retryAfterSec, remaining: 0 };
  }
  return { allowed: true, remaining: policy.maxAttempts - count };
}

/** Clear bucket on successful auth. */
export async function clearRateLimit(
  db: D1Database,
  action: keyof typeof DEFAULTS | string,
  ip: string,
): Promise<void> {
  const policy = DEFAULTS[action] ?? { action, maxAttempts: 5, windowMs: 15 * 60_000 };
  await db.prepare(`DELETE FROM rate_limits WHERE key = ?`).bind(bucketKey(policy.action, ip)).run();
}
