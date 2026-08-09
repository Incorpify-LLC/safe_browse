import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings, AppVariables } from "../types";
import { parseJson, isResponse } from "../http";
import { hashPassword, sha256, verifyPassword } from "../crypto";
import { ensureParent } from "../auth";
import { verifyTurnstileToken } from "../turnstile";
import { sendParentSecurityAlert } from "../alerts";
import { generateTotpSecret, buildOtpAuthUri, verifyTotp } from "../totp";
import { checkRateLimit, clearRateLimit, clientIp, recordFailure } from "../rate-limit";

const app = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();

const MIN_PASSWORD = 4;
const MAX_PASSWORD = 100;

const signupSchema = z.object({
  email: z.string().email("A valid email is required"),
  password: z.string().min(MIN_PASSWORD, `Password must be at least ${MIN_PASSWORD} characters`).max(MAX_PASSWORD),
  householdName: z.string().min(1).max(80).optional(),
  turnstileToken: z.string().optional(),
});

/** @deprecated Prefer /signup. Kept for self-host single-family installs. */
const setupSchema = z.object({
  password: z.string().min(MIN_PASSWORD, `Password must be at least ${MIN_PASSWORD} characters`).max(MAX_PASSWORD),
  email: z.string().email().optional(),
  turnstileToken: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email("Email is required"),
  password: z.string().min(1, "Password is required"),
  turnstileToken: z.string().optional(),
});

/** Legacy password-only login (single-tenant / self-host). Prefer email+password. */
const legacyLoginSchema = z.object({
  password: z.string().min(1, "Password is required"),
  turnstileToken: z.string().optional(),
  email: z.string().email().optional(),
});

const recoverSchema = z.object({
  recoveryKey: z.string().min(8, "Recovery key is required"),
  newPassword: z.string().min(MIN_PASSWORD, `Password must be at least ${MIN_PASSWORD} characters`).max(MAX_PASSWORD),
  turnstileToken: z.string().optional(),
});

const totpConfirmSchema = z.object({
  secret: z.string().min(16, "TOTP secret required"),
  code: z.string().length(6, "6-digit code required"),
});

const totpRecoverSchema = z.object({
  email: z.string().email("Email is required"),
  totpCode: z.string().length(6, "6-digit authenticator code required"),
  newPassword: z.string().min(MIN_PASSWORD, `Password must be at least ${MIN_PASSWORD} characters`).max(MAX_PASSWORD),
  turnstileToken: z.string().optional(),
});

function generateRecoveryKey(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `SB-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

function normalizeKey(key: string): string {
  return key.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function rateLimitedResponse(retryAfterSec: number) {
  return new Response(
    JSON.stringify({
      error: "rate_limited",
      message: `Too many attempts. Try again in about ${Math.ceil(retryAfterSec / 60)} minute(s).`,
      retryAfterSec,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSec),
      },
    },
  );
}

async function requireSession(
  context: { req: { header(name: string): string | undefined }; env: AppBindings },
): Promise<{ id: string; email: string; totp_secret: string | null } | Response> {
  const authHeader = context.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const token = authHeader.slice(7).trim();
  const tokenHash = await sha256(token);
  const parent = await context.env.DB.prepare(
    `SELECT id, email, totp_secret FROM parents WHERE session_token = ?`,
  ).bind(tokenHash).first<{ id: string; email: string; totp_secret: string | null }>();
  if (!parent) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return parent;
}

type ParentAuthRow = {
  id: string;
  householdId: string;
  email: string;
  password_hash: string;
  totp_secret: string | null;
  needsRehash: boolean;
};

/** Multi-tenant: look up parent by email, then verify password. */
async function findParentByEmailPassword(
  db: D1Database,
  email: string,
  password: string,
): Promise<ParentAuthRow | null> {
  const row = await db
    .prepare(
      `SELECT id, household_id AS householdId, email, password_hash, totp_secret
       FROM parents WHERE email = ? COLLATE NOCASE`,
    )
    .bind(email.toLowerCase())
    .first<{ id: string; householdId: string; email: string; password_hash: string | null; totp_secret: string | null }>();

  if (!row?.password_hash) return null;
  const result = await verifyPassword(password, row.password_hash);
  if (!result.ok) return null;
  return {
    id: row.id,
    householdId: row.householdId,
    email: row.email,
    password_hash: row.password_hash,
    totp_secret: row.totp_secret,
    needsRehash: result.needsRehash,
  };
}

/**
 * Legacy single-tenant: scan parents with passwords (capped).
 * Used only when login body has no email (old dashboard / self-host).
 */
async function findParentByPasswordOnly(
  db: D1Database,
  password: string,
): Promise<ParentAuthRow | null> {
  const rows = await db
    .prepare(
      `SELECT id, household_id AS householdId, email, password_hash, totp_secret
       FROM parents WHERE password_hash IS NOT NULL LIMIT 50`,
    )
    .all<{ id: string; householdId: string; email: string; password_hash: string; totp_secret: string | null }>();

  for (const row of rows.results ?? []) {
    const result = await verifyPassword(password, row.password_hash);
    if (result.ok) {
      return { ...row, needsRehash: result.needsRehash };
    }
  }
  return null;
}

async function issueSession(db: D1Database, parentId: string): Promise<string> {
  const sessionToken = crypto.randomUUID() + "-" + crypto.randomUUID();
  const tokenHash = await sha256(sessionToken);
  await db.prepare(`UPDATE parents SET session_token = ? WHERE id = ?`).bind(tokenHash, parentId).run();
  return sessionToken;
}

/** Create household + parent with password, recovery key, and session. */
async function provisionParentAccount(
  db: D1Database,
  opts: {
    email: string;
    password: string;
    householdName?: string;
  },
): Promise<{ parentId: string; email: string; sessionToken: string; recoveryKey: string }> {
  const email = opts.email.toLowerCase();
  const existing = await db
    .prepare(`SELECT id, password_hash FROM parents WHERE email = ? COLLATE NOCASE`)
    .bind(email)
    .first<{ id: string; password_hash: string | null }>();

  if (existing?.password_hash) {
    const err = new Error("email_taken");
    throw err;
  }

  const passwordHash = await hashPassword(opts.password);
  const rawKey = generateRecoveryKey();
  const recoveryHash = await sha256(`sb_rec_${normalizeKey(rawKey)}`);
  const sessionToken = crypto.randomUUID() + "-" + crypto.randomUUID();
  const tokenHash = await sha256(sessionToken);
  const now = new Date().toISOString();

  let parentId: string;

  if (existing) {
    // Row exists without password (e.g. CF Access auto-provision) — attach credentials.
    parentId = existing.id;
    await db
      .prepare(
        `UPDATE parents SET password_hash = ?, recovery_key_hash = ?, session_token = ?, totp_secret = NULL WHERE id = ?`,
      )
      .bind(passwordHash, recoveryHash, tokenHash, parentId)
      .run();
  } else {
    const householdId = crypto.randomUUID();
    parentId = crypto.randomUUID();
    const householdName = (opts.householdName?.trim() || `${email.split("@")[0]}'s household`).slice(0, 80);
    await db.batch([
      db
        .prepare("INSERT INTO households(id,name,timezone,created_at) VALUES(?,?,?,?)")
        .bind(householdId, householdName, "UTC", now),
      db
        .prepare(
          `INSERT INTO parents(id,household_id,email,created_at,password_hash,recovery_key_hash,session_token,totp_secret)
           VALUES(?,?,?,?,?,?,?,NULL)`,
        )
        .bind(parentId, householdId, email, now, passwordHash, recoveryHash, tokenHash),
    ]);
  }

  return { parentId, email, sessionToken, recoveryKey: rawKey };
}

// ── Status (multi-tenant aware) ───────────────────────────────────────────────
app.get("/status", async (context) => {
  let session: {
    email: string;
    hasPassword: boolean;
    hasTotp: boolean;
  } | null = null;

  const authHeader = context.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const tokenHash = await sha256(authHeader.slice(7).trim());
    const me = await context.env.DB.prepare(
      `SELECT email, password_hash, totp_secret FROM parents WHERE session_token = ?`,
    )
      .bind(tokenHash)
      .first<{ email: string; password_hash: string | null; totp_secret: string | null }>();
    if (me) {
      session = {
        email: me.email,
        hasPassword: Boolean(me.password_hash),
        hasTotp: Boolean(me.totp_secret),
      };
    }
  }

  // Global counts kept for ops/debug only — not used to lock signup.
  const row = await context.env.DB.prepare(
    `SELECT COUNT(*) AS count,
      SUM(CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END) AS withPassword
     FROM parents`,
  ).first<{ count: number; withPassword: number }>();

  const sessionNeedsTotp = Boolean(session?.hasPassword && !session.hasTotp);

  return context.json({
    /** SaaS / multi-household mode: always allow new signups. */
    multiTenant: true,
    signupEnabled: true,
    /**
     * No global first-setup gate. Clients should show Sign up + Log in.
     * Legacy dashboards that only check requireSetup will open login (not setup).
     */
    requireSetup: false,
    /** Session-scoped: this parent still needs authenticator link. */
    requireTotp: sessionNeedsTotp,
    hasSession: Boolean(session),
    email: session?.email ?? null,
    hasPassword: session?.hasPassword ?? false,
    hasTotpBackup: session?.hasTotp ?? false,
    parentCount: row?.count ?? 0,
    configuredAccounts: row?.withPassword ?? 0,
    turnstileSiteKey: context.env.TURNSTILE_SITE_KEY || "1x00000000000000000000AA",
  });
});

// ── Sign up (multi-tenant: new household + parent) ─────────────────────────────
app.post("/signup", async (context) => {
  const body = await parseJson(context, signupSchema);
  if (isResponse(body)) return body;

  const ip = clientIp(context.req.raw.headers);
  const userAgent = context.req.header("User-Agent") || "Unknown";
  const email = body.email.toLowerCase();

  const limited = await checkRateLimit(context.env.DB, "signup", ip);
  if (!limited.allowed) return rateLimitedResponse(limited.retryAfterSec);

  // Also rate-limit per email to slow targeted abuse
  const emailLimited = await checkRateLimit(context.env.DB, "signup", `email:${email}`);
  if (!emailLimited.allowed) return rateLimitedResponse(emailLimited.retryAfterSec);

  const turnstileOk = await verifyTurnstileToken(context.env.TURNSTILE_SECRET_KEY, body.turnstileToken, ip);
  if (!turnstileOk) {
    return context.json({ error: "turnstile_failed", message: "CAPTCHA bot verification failed. Please try again." }, 400);
  }

  try {
    const account = await provisionParentAccount(context.env.DB, {
      email,
      password: body.password,
      ...(body.householdName ? { householdName: body.householdName } : {}),
    });
    await clearRateLimit(context.env.DB, "signup", ip);
    await clearRateLimit(context.env.DB, "signup", `email:${email}`);
    void sendParentSecurityAlert(context.env, account.email, "password.created", { ipAddress: ip, userAgent });

    return context.json({
      token: account.sessionToken,
      email: account.email,
      recoveryKey: account.recoveryKey,
      requireTotp: true,
    });
  } catch (e) {
    if (e instanceof Error && e.message === "email_taken") {
      await recordFailure(context.env.DB, "signup", ip);
      return context.json({
        error: "email_taken",
        message: "An account with this email already exists. Log in instead.",
      }, 409);
    }
    throw e;
  }
});

// ── TOTP Setup (session required; allowed before TOTP is linked) ──────────────
app.get("/totp/setup", async (context) => {
  const parent = await requireSession(context);
  if (parent instanceof Response) return parent;

  if (parent.totp_secret) {
    return context.json({
      error: "totp_already_configured",
      message: "Authenticator is already linked. Use operator reset if you lost your phone.",
    }, 409);
  }

  const secret = generateTotpSecret();
  const label = parent.email.startsWith("parent@family.local") ? "Safe Browse" : parent.email;
  const otpauthUri = buildOtpAuthUri(secret, label);
  return context.json({ secret, otpauthUri });
});

app.post("/totp/confirm", async (context) => {
  const parent = await requireSession(context);
  if (parent instanceof Response) return parent;

  if (parent.totp_secret) {
    return context.json({ error: "totp_already_configured", message: "Authenticator is already linked." }, 409);
  }

  const body = await parseJson(context, totpConfirmSchema);
  if (isResponse(body)) return body;

  const ok = await verifyTotp(body.secret, body.code);
  if (!ok) {
    return context.json({
      error: "invalid_code",
      message: "Incorrect code — check your authenticator app and try again.",
    }, 400);
  }

  await context.env.DB.prepare(`UPDATE parents SET totp_secret = ? WHERE id = ?`)
    .bind(body.secret, parent.id).run();

  return context.json({ ok: true });
});

// ── TOTP Recover: forgot PIN (email + authenticator) ──────────────────────────
app.post("/totp/recover", async (context) => {
  const body = await parseJson(context, totpRecoverSchema);
  if (isResponse(body)) return body;

  const ip = clientIp(context.req.raw.headers);
  const userAgent = context.req.header("User-Agent") || "Unknown";
  const email = body.email.toLowerCase();

  const limited = await checkRateLimit(context.env.DB, "totp-recover", ip);
  if (!limited.allowed) return rateLimitedResponse(limited.retryAfterSec);

  const turnstileOk = await verifyTurnstileToken(context.env.TURNSTILE_SECRET_KEY, body.turnstileToken, ip);
  if (!turnstileOk) {
    return context.json({ error: "turnstile_failed", message: "CAPTCHA verification failed. Please try again." }, 400);
  }

  const parent = await context.env.DB.prepare(
    `SELECT id, email, totp_secret FROM parents WHERE email = ? COLLATE NOCASE`,
  )
    .bind(email)
    .first<{ id: string; email: string; totp_secret: string | null }>();

  // Uniform error to avoid account enumeration where possible
  if (!parent?.totp_secret) {
    const after = await recordFailure(context.env.DB, "totp-recover", ip);
    if (!after.allowed) return rateLimitedResponse(after.retryAfterSec);
    return context.json({
      error: "invalid_totp",
      message: "Incorrect email or authenticator code.",
    }, 401);
  }

  const valid = await verifyTotp(parent.totp_secret, body.totpCode);
  if (!valid) {
    const after = await recordFailure(context.env.DB, "totp-recover", ip);
    if (!after.allowed) return rateLimitedResponse(after.retryAfterSec);
    return context.json({
      error: "invalid_totp",
      message: "Incorrect email or authenticator code. Codes refresh every 30 seconds.",
    }, 401);
  }

  await clearRateLimit(context.env.DB, "totp-recover", ip);

  const newPasswordHash = await hashPassword(body.newPassword);
  const sessionToken = await issueSession(context.env.DB, parent.id);
  await context.env.DB.prepare(`UPDATE parents SET password_hash = ? WHERE id = ?`)
    .bind(newPasswordHash, parent.id).run();

  void sendParentSecurityAlert(context.env, parent.email, "password.recovery_used", {
    ipAddress: ip,
    userAgent,
  });

  return context.json({ token: sessionToken, email: parent.email });
});

// ── Legacy setup (self-host single-family) → delegates to signup semantics ────
app.post("/setup", async (context) => {
  const body = await parseJson(context, setupSchema);
  if (isResponse(body)) return body;

  const ip = clientIp(context.req.raw.headers);
  const userAgent = context.req.header("User-Agent") || "Unknown";

  // If email provided, behave as multi-tenant signup
  if (body.email) {
    const limited = await checkRateLimit(context.env.DB, "signup", ip);
    if (!limited.allowed) return rateLimitedResponse(limited.retryAfterSec);

    const turnstileOk = await verifyTurnstileToken(context.env.TURNSTILE_SECRET_KEY, body.turnstileToken, ip);
    if (!turnstileOk) {
      return context.json({ error: "turnstile_failed", message: "CAPTCHA bot verification failed. Please try again." }, 400);
    }

    try {
      const account = await provisionParentAccount(context.env.DB, {
        email: body.email.toLowerCase(),
        password: body.password,
      });
      await clearRateLimit(context.env.DB, "signup", ip);
      void sendParentSecurityAlert(context.env, account.email, "password.created", { ipAddress: ip, userAgent });
      return context.json({
        token: account.sessionToken,
        email: account.email,
        recoveryKey: account.recoveryKey,
        requireTotp: true,
      });
    } catch (e) {
      if (e instanceof Error && e.message === "email_taken") {
        return context.json({
          error: "email_taken",
          message: "An account with this email already exists. Log in instead.",
        }, 409);
      }
      throw e;
    }
  }

  // No email: legacy single-tenant path (parent@family.local) only if no accounts yet
  const already = await context.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM parents WHERE password_hash IS NOT NULL`,
  ).first<{ count: number }>();
  if ((already?.count ?? 0) > 0) {
    return context.json({
      error: "already_configured",
      message: "Accounts already exist. Use Sign up with your email, or Log in.",
    }, 409);
  }

  const limited = await checkRateLimit(context.env.DB, "setup", ip);
  if (!limited.allowed) return rateLimitedResponse(limited.retryAfterSec);

  const turnstileOk = await verifyTurnstileToken(context.env.TURNSTILE_SECRET_KEY, body.turnstileToken, ip);
  if (!turnstileOk) {
    return context.json({ error: "turnstile_failed", message: "CAPTCHA bot verification failed. Please try again." }, 400);
  }

  const email = "parent@family.local";
  const parent = await ensureParent(context.env.DB, email);
  const passwordHash = await hashPassword(body.password);

  const rawKey = generateRecoveryKey();
  const recoveryHash = await sha256(`sb_rec_${normalizeKey(rawKey)}`);
  const sessionToken = crypto.randomUUID() + "-" + crypto.randomUUID();
  const tokenHash = await sha256(sessionToken);

  await context.env.DB.prepare(
    `UPDATE parents SET password_hash = ?, recovery_key_hash = ?, session_token = ?, totp_secret = NULL WHERE id = ?`,
  ).bind(passwordHash, recoveryHash, tokenHash, parent.id).run();

  await clearRateLimit(context.env.DB, "setup", ip);
  void sendParentSecurityAlert(context.env, parent.email, "password.created", { ipAddress: ip, userAgent });

  return context.json({
    token: sessionToken,
    email: parent.email,
    recoveryKey: rawKey,
    requireTotp: true,
  });
});

// ── Login (email + password preferred) ────────────────────────────────────────
app.post("/login", async (context) => {
  // Accept both multi-tenant (email+password) and legacy (password only)
  const raw = await context.req.json().catch(() => null);
  if (!raw || typeof raw !== "object") {
    return context.json({ error: "invalid_json" }, 400);
  }

  const hasEmail = typeof (raw as { email?: unknown }).email === "string" && (raw as { email: string }).email.length > 0;
  const parsed = hasEmail ? loginSchema.safeParse(raw) : legacyLoginSchema.safeParse(raw);
  if (!parsed.success) {
    return context.json({ error: "validation_error", issues: parsed.error.issues }, 400);
  }
  const body = parsed.data;

  const ip = clientIp(context.req.raw.headers);
  const userAgent = context.req.header("User-Agent") || "Unknown";

  const limited = await checkRateLimit(context.env.DB, "login", ip);
  if (!limited.allowed) return rateLimitedResponse(limited.retryAfterSec);

  const turnstileOk = await verifyTurnstileToken(context.env.TURNSTILE_SECRET_KEY, body.turnstileToken, ip);
  if (!turnstileOk) {
    return context.json({ error: "turnstile_failed", message: "CAPTCHA bot verification failed. Please try again." }, 400);
  }

  let parent: ParentAuthRow | null = null;
  if ("email" in body && body.email) {
    parent = await findParentByEmailPassword(context.env.DB, body.email, body.password);
  } else {
    parent = await findParentByPasswordOnly(context.env.DB, body.password);
  }

  if (!parent) {
    const after = await recordFailure(context.env.DB, "login", ip);
    if (!after.allowed) {
      // Alert the targeted email if known; otherwise skip global scan spam
      if ("email" in body && body.email) {
        void sendParentSecurityAlert(context.env, body.email.toLowerCase(), "login.brute_force_detected", {
          ipAddress: ip,
          userAgent,
        });
      }
      return rateLimitedResponse(after.retryAfterSec);
    }
    return context.json({
      error: "invalid_credentials",
      message: hasEmail ? "Incorrect email or password" : "Incorrect parent password",
    }, 401);
  }

  await clearRateLimit(context.env.DB, "login", ip);

  if (parent.needsRehash) {
    const upgraded = await hashPassword(body.password);
    await context.env.DB.prepare(`UPDATE parents SET password_hash = ? WHERE id = ?`)
      .bind(upgraded, parent.id).run();
  }

  const sessionToken = await issueSession(context.env.DB, parent.id);
  return context.json({
    token: sessionToken,
    email: parent.email,
    requireTotp: !parent.totp_secret,
  });
});

// ── Paper recovery key (secondary; key is globally unique) ────────────────────
app.post("/recover", async (context) => {
  const body = await parseJson(context, recoverSchema);
  if (isResponse(body)) return body;

  const ip = clientIp(context.req.raw.headers);
  const userAgent = context.req.header("User-Agent") || "Unknown";

  const limited = await checkRateLimit(context.env.DB, "recover", ip);
  if (!limited.allowed) return rateLimitedResponse(limited.retryAfterSec);

  const turnstileOk = await verifyTurnstileToken(context.env.TURNSTILE_SECRET_KEY, body.turnstileToken, ip);
  if (!turnstileOk) {
    return context.json({ error: "turnstile_failed", message: "CAPTCHA bot verification failed. Please try again." }, 400);
  }

  const normalized = normalizeKey(body.recoveryKey);
  const recoveryHash = await sha256(`sb_rec_${normalized}`);

  const parent = await context.env.DB.prepare(
    `SELECT id, household_id AS householdId, email FROM parents WHERE recovery_key_hash = ?`,
  ).bind(recoveryHash).first<{ id: string; householdId: string; email: string }>();

  if (!parent) {
    const after = await recordFailure(context.env.DB, "recover", ip);
    if (!after.allowed) return rateLimitedResponse(after.retryAfterSec);
    return context.json({ error: "invalid_recovery_key", message: "Invalid emergency recovery key" }, 401);
  }

  await clearRateLimit(context.env.DB, "recover", ip);

  const newPasswordHash = await hashPassword(body.newPassword);
  const newRawKey = generateRecoveryKey();
  const newRecoveryHash = await sha256(`sb_rec_${normalizeKey(newRawKey)}`);
  const sessionToken = crypto.randomUUID() + "-" + crypto.randomUUID();
  const tokenHash = await sha256(sessionToken);

  await context.env.DB.prepare(
    `UPDATE parents SET password_hash = ?, recovery_key_hash = ?, session_token = ? WHERE id = ?`,
  ).bind(newPasswordHash, newRecoveryHash, tokenHash, parent.id).run();

  void sendParentSecurityAlert(context.env, parent.email, "password.recovery_used", {
    ipAddress: ip,
    userAgent,
  });

  return context.json({ token: sessionToken, email: parent.email, newRecoveryKey: newRawKey });
});

app.post("/logout", async (context) => {
  const authHeader = context.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) {
      const tokenHash = await sha256(token);
      await context.env.DB.prepare(`UPDATE parents SET session_token = NULL WHERE session_token = ?`)
        .bind(tokenHash).run();
    }
  }
  return context.json({ ok: true });
});

export default app;
