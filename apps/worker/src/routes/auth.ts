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

const setupSchema = z.object({
  password: z.string().min(MIN_PASSWORD, `Password must be at least ${MIN_PASSWORD} characters`).max(MAX_PASSWORD),
  email: z.string().email().optional(),
  turnstileToken: z.string().optional(),
});

const loginSchema = z.object({
  password: z.string().min(1, "Password is required"),
  turnstileToken: z.string().optional(),
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

/** Single-household: load the parent row that has a password (usually one). */
async function findParentByPassword(
  db: D1Database,
  password: string,
): Promise<{ id: string; householdId: string; email: string; password_hash: string; totp_secret: string | null; needsRehash: boolean } | null> {
  const rows = await db
    .prepare(
      `SELECT id, household_id AS householdId, email, password_hash, totp_secret
       FROM parents WHERE password_hash IS NOT NULL LIMIT 20`,
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

// ── Status ────────────────────────────────────────────────────────────────────
app.get("/status", async (context) => {
  const row = await context.env.DB.prepare(
    `SELECT COUNT(*) AS count,
      SUM(CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END) AS withPassword,
      SUM(CASE WHEN totp_secret IS NOT NULL THEN 1 ELSE 0 END) AS withTotp
     FROM parents`,
  ).first<{ count: number; withPassword: number; withTotp: number }>();

  const hasPassword = (row?.withPassword ?? 0) > 0;
  const hasTotp = (row?.withTotp ?? 0) > 0;
  const parentCount = row?.count ?? 0;

  // If session present, report whether this parent still needs TOTP enrollment
  let sessionNeedsTotp = false;
  const authHeader = context.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const tokenHash = await sha256(authHeader.slice(7).trim());
    const me = await context.env.DB.prepare(
      `SELECT password_hash, totp_secret FROM parents WHERE session_token = ?`,
    ).bind(tokenHash).first<{ password_hash: string | null; totp_secret: string | null }>();
    if (me?.password_hash && !me.totp_secret) sessionNeedsTotp = true;
  }

  return context.json({
    hasPassword,
    hasTotpBackup: hasTotp,
    parentCount,
    requireSetup: !hasPassword,
    /**
     * True when the current session (if any) still needs authenticator setup,
     * or when household has a password but no TOTP yet (login will force setup).
     * Dashboard only blocks on this when a session token is present.
     */
    requireTotp: sessionNeedsTotp || (hasPassword && !hasTotp),
    turnstileSiteKey: context.env.TURNSTILE_SITE_KEY || "1x00000000000000000000AA",
  });
});

// ── TOTP Setup (session required; allowed before TOTP is linked) ──────────────
app.get("/totp/setup", async (context) => {
  const parent = await requireSession(context);
  if (parent instanceof Response) return parent;

  // If already linked, refuse to mint a new secret without operator wipe
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

// ── TOTP Recover: primary email-less forgot-PIN path ──────────────────────────
app.post("/totp/recover", async (context) => {
  const body = await parseJson(context, totpRecoverSchema);
  if (isResponse(body)) return body;

  const ip = clientIp(context.req.raw.headers);
  const userAgent = context.req.header("User-Agent") || "Unknown";

  const limited = await checkRateLimit(context.env.DB, "totp-recover", ip);
  if (!limited.allowed) return rateLimitedResponse(limited.retryAfterSec);

  const turnstileOk = await verifyTurnstileToken(context.env.TURNSTILE_SECRET_KEY, body.turnstileToken, ip);
  if (!turnstileOk) {
    return context.json({ error: "turnstile_failed", message: "CAPTCHA verification failed. Please try again." }, 400);
  }

  const parent = await context.env.DB.prepare(
    `SELECT id, email, totp_secret FROM parents WHERE totp_secret IS NOT NULL LIMIT 1`,
  ).first<{ id: string; email: string; totp_secret: string }>();

  if (!parent) {
    return context.json({
      error: "totp_not_configured",
      message: "No authenticator app is linked. If you lost access entirely, re-run deploy with --reset-parent-auth.",
    }, 404);
  }

  const valid = await verifyTotp(parent.totp_secret, body.totpCode);
  if (!valid) {
    const after = await recordFailure(context.env.DB, "totp-recover", ip);
    if (!after.allowed) return rateLimitedResponse(after.retryAfterSec);
    return context.json({
      error: "invalid_totp",
      message: "Incorrect authenticator code. Codes refresh every 30 seconds.",
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

// ── First-time setup (once only) ──────────────────────────────────────────────
app.post("/setup", async (context) => {
  const body = await parseJson(context, setupSchema);
  if (isResponse(body)) return body;

  const ip = clientIp(context.req.raw.headers);
  const userAgent = context.req.header("User-Agent") || "Unknown";

  const already = await context.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM parents WHERE password_hash IS NOT NULL`,
  ).first<{ count: number }>();
  if ((already?.count ?? 0) > 0) {
    return context.json({
      error: "already_configured",
      message:
        "Parent password is already set. Sign in, use authenticator recovery, or run: bash tools/deploy.sh --reset-parent-auth",
    }, 409);
  }

  const limited = await checkRateLimit(context.env.DB, "setup", ip);
  if (!limited.allowed) return rateLimitedResponse(limited.retryAfterSec);

  const turnstileOk = await verifyTurnstileToken(context.env.TURNSTILE_SECRET_KEY, body.turnstileToken, ip);
  if (!turnstileOk) {
    return context.json({ error: "turnstile_failed", message: "CAPTCHA bot verification failed. Please try again." }, 400);
  }

  const email = (body.email || "parent@family.local").toLowerCase();
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

// ── Login ─────────────────────────────────────────────────────────────────────
app.post("/login", async (context) => {
  const body = await parseJson(context, loginSchema);
  if (isResponse(body)) return body;

  const ip = clientIp(context.req.raw.headers);
  const userAgent = context.req.header("User-Agent") || "Unknown";

  const limited = await checkRateLimit(context.env.DB, "login", ip);
  if (!limited.allowed) return rateLimitedResponse(limited.retryAfterSec);

  const turnstileOk = await verifyTurnstileToken(context.env.TURNSTILE_SECRET_KEY, body.turnstileToken, ip);
  if (!turnstileOk) {
    return context.json({ error: "turnstile_failed", message: "CAPTCHA bot verification failed. Please try again." }, 400);
  }

  const parent = await findParentByPassword(context.env.DB, body.password);
  if (!parent) {
    const after = await recordFailure(context.env.DB, "login", ip);
    if (!after.allowed) {
      const anyParent = await context.env.DB.prepare(
        `SELECT email FROM parents WHERE email NOT LIKE '%@family.local' LIMIT 1`,
      ).first<{ email: string }>();
      if (anyParent?.email) {
        void sendParentSecurityAlert(context.env, anyParent.email, "login.brute_force_detected", {
          ipAddress: ip,
          userAgent,
        });
      }
      return rateLimitedResponse(after.retryAfterSec);
    }
    return context.json({ error: "invalid_password", message: "Incorrect parent password" }, 401);
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

// ── Paper recovery key (secondary) ────────────────────────────────────────────
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
