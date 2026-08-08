import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings, AppVariables } from "../types";
import { parseJson, isResponse } from "../http";
import { sha256 } from "../crypto";
import { ensureParent } from "../auth";
import { verifyTurnstileToken } from "../turnstile";
import { sendParentSecurityAlert } from "../alerts";
import { generateTotpSecret, buildOtpAuthUri, verifyTotp } from "../totp";

const app = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();

const setupSchema = z.object({
  password: z.string().min(4, "Password must be at least 4 characters").max(100),
  email: z.string().email().optional(),
  turnstileToken: z.string().optional(),
});

const loginSchema = z.object({
  password: z.string().min(1, "Password is required"),
  turnstileToken: z.string().optional(),
});

const recoverSchema = z.object({
  recoveryKey: z.string().min(8, "Recovery key is required"),
  newPassword: z.string().min(4, "Password must be at least 4 characters").max(100),
  turnstileToken: z.string().optional(),
});

const totpConfirmSchema = z.object({
  secret: z.string().min(16, "TOTP secret required"),
  code: z.string().length(6, "6-digit code required"),
});

const totpRecoverSchema = z.object({
  totpCode: z.string().length(6, "6-digit authenticator code required"),
  newPassword: z.string().min(4, "Password must be at least 4 characters").max(100),
  turnstileToken: z.string().optional(),
});

// Simple in-memory / D1 tracking for failed attempts per IP
const failedAttemptsMap = new Map<string, { count: number; firstAttempt: number }>();

function generateRecoveryKey(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `SB-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

function normalizeKey(key: string): string {
  return key.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

app.get("/status", async (context) => {
  const row = await context.env.DB.prepare(
    `SELECT COUNT(*) AS count,
      SUM(CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END) AS withPassword,
      SUM(CASE WHEN totp_secret IS NOT NULL THEN 1 ELSE 0 END) AS withTotp
     FROM parents`,
  ).first<{ count: number; withPassword: number; withTotp: number }>();

  const hasPassword = (row?.withPassword ?? 0) > 0;
  const hasTotpBackup = (row?.withTotp ?? 0) > 0;
  const parentCount = row?.count ?? 0;

  return context.json({
    hasPassword,
    hasTotpBackup,
    parentCount,
    requireSetup: !hasPassword,
    turnstileSiteKey: context.env.TURNSTILE_SITE_KEY || "1x00000000000000000000AA",
  });
});

// ── TOTP Setup: generate a fresh secret + QR URI (called during onboarding) ──
app.get("/totp/setup", async (context) => {
  const authHeader = context.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return context.json({ error: "unauthorized" }, 401);
  }
  const token = authHeader.slice(7).trim();
  const tokenHash = await sha256(token);
  const parent = await context.env.DB.prepare(
    `SELECT id, email FROM parents WHERE session_token = ?`,
  ).bind(tokenHash).first<{ id: string; email: string }>();
  if (!parent) return context.json({ error: "unauthorized" }, 401);

  const secret = generateTotpSecret();
  const label = parent.email.startsWith("parent@family.local") ? "Safe Browse" : parent.email;
  const otpauthUri = buildOtpAuthUri(secret, label);
  return context.json({ secret, otpauthUri });
});

// ── TOTP Confirm: verify first code proves app is set up, then persist secret ─
app.post("/totp/confirm", async (context) => {
  const authHeader = context.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return context.json({ error: "unauthorized" }, 401);
  }
  const token = authHeader.slice(7).trim();
  const tokenHash = await sha256(token);
  const parent = await context.env.DB.prepare(
    `SELECT id, email FROM parents WHERE session_token = ?`,
  ).bind(tokenHash).first<{ id: string; email: string }>();
  if (!parent) return context.json({ error: "unauthorized" }, 401);

  const body = await parseJson(context, totpConfirmSchema);
  if (isResponse(body)) return body;

  const ok = await verifyTotp(body.secret, body.code);
  if (!ok) {
    return context.json({ error: "invalid_code", message: "Incorrect code — check your authenticator app and try again." }, 400);
  }

  await context.env.DB.prepare(
    `UPDATE parents SET totp_secret = ? WHERE id = ?`,
  ).bind(body.secret, parent.id).run();

  return context.json({ ok: true });
});

// ── TOTP Recover: use authenticator code to reset password ────────────────────
app.post("/totp/recover", async (context) => {
  const body = await parseJson(context, totpRecoverSchema);
  if (isResponse(body)) return body;

  const clientIp = context.req.header("CF-Connecting-IP") || context.req.header("X-Forwarded-For") || "127.0.0.1";
  const userAgent = context.req.header("User-Agent") || "Unknown";

  const turnstileOk = await verifyTurnstileToken(context.env.TURNSTILE_SECRET_KEY, body.turnstileToken, clientIp);
  if (!turnstileOk) {
    return context.json({ error: "turnstile_failed", message: "CAPTCHA verification failed. Please try again." }, 400);
  }

  // Find parent with a TOTP secret configured
  const parent = await context.env.DB.prepare(
    `SELECT id, email, totp_secret FROM parents WHERE totp_secret IS NOT NULL LIMIT 1`,
  ).first<{ id: string; email: string; totp_secret: string }>();

  if (!parent) {
    return context.json({ error: "totp_not_configured", message: "No authenticator app has been set up for this account." }, 404);
  }

  const valid = await verifyTotp(parent.totp_secret, body.totpCode);
  if (!valid) {
    return context.json({ error: "invalid_totp", message: "Incorrect authenticator code. Try again — codes refresh every 30 seconds." }, 401);
  }

  // Valid — reset password, issue new session
  const newPasswordHash = await sha256(`sb_salt_${body.newPassword}`);
  const sessionToken = crypto.randomUUID() + "-" + crypto.randomUUID();
  const tokenHash = await sha256(sessionToken);

  await context.env.DB.prepare(
    `UPDATE parents SET password_hash = ?, session_token = ? WHERE id = ?`,
  ).bind(newPasswordHash, tokenHash, parent.id).run();

  void sendParentSecurityAlert(context.env, parent.email, "password.recovery_used", { ipAddress: clientIp, userAgent });

  return context.json({ token: sessionToken, email: parent.email });
});

app.post("/setup", async (context) => {
  const body = await parseJson(context, setupSchema);
  if (isResponse(body)) return body;

  const clientIp = context.req.header("CF-Connecting-IP") || context.req.header("X-Forwarded-For") || "127.0.0.1";
  const userAgent = context.req.header("User-Agent") || "Unknown";

  const turnstileOk = await verifyTurnstileToken(context.env.TURNSTILE_SECRET_KEY, body.turnstileToken, clientIp);
  if (!turnstileOk) {
    return context.json({ error: "turnstile_failed", message: "CAPTCHA bot verification failed. Please try again." }, 400);
  }

  const email = (body.email || "parent@family.local").toLowerCase();
  const parent = await ensureParent(context.env.DB, email);
  const passwordHash = await sha256(`sb_salt_${body.password}`);

  const rawKey = generateRecoveryKey();
  const recoveryHash = await sha256(`sb_rec_${normalizeKey(rawKey)}`);

  const sessionToken = crypto.randomUUID() + "-" + crypto.randomUUID();
  const tokenHash = await sha256(sessionToken);

  await context.env.DB.prepare(
    `UPDATE parents SET password_hash = ?, recovery_key_hash = ?, session_token = ? WHERE id = ?`,
  ).bind(passwordHash, recoveryHash, tokenHash, parent.id).run();

  // Send security alert email
  void sendParentSecurityAlert(context.env, parent.email, "password.created", { ipAddress: clientIp, userAgent });

  return context.json({ token: sessionToken, email: parent.email, recoveryKey: rawKey });
});

app.post("/login", async (context) => {
  const body = await parseJson(context, loginSchema);
  if (isResponse(body)) return body;

  const clientIp = context.req.header("CF-Connecting-IP") || context.req.header("X-Forwarded-For") || "127.0.0.1";
  const userAgent = context.req.header("User-Agent") || "Unknown";

  const turnstileOk = await verifyTurnstileToken(context.env.TURNSTILE_SECRET_KEY, body.turnstileToken, clientIp);
  if (!turnstileOk) {
    return context.json({ error: "turnstile_failed", message: "CAPTCHA bot verification failed. Please try again." }, 400);
  }

  const passwordHash = await sha256(`sb_salt_${body.password}`);

  const parent = await context.env.DB.prepare(
    `SELECT id, household_id AS householdId, email FROM parents WHERE password_hash = ?`,
  ).bind(passwordHash).first<{ id: string; householdId: string; email: string }>();

  if (!parent) {
    // Track failed login attempts for brute-force detection
    const now = Date.now();
    const tracker = failedAttemptsMap.get(clientIp) || { count: 0, firstAttempt: now };
    if (now - tracker.firstAttempt > 900_000) {
      tracker.count = 1;
      tracker.firstAttempt = now;
    } else {
      tracker.count += 1;
    }
    failedAttemptsMap.set(clientIp, tracker);

    // If 5 failed attempts occur within 15 minutes, trigger parent alert
    if (tracker.count >= 5) {
      const anyParent = await context.env.DB.prepare(`SELECT email FROM parents WHERE email NOT LIKE '%@family.local' LIMIT 1`).first<{ email: string }>();
      if (anyParent?.email) {
        void sendParentSecurityAlert(context.env, anyParent.email, "login.brute_force_detected", { ipAddress: clientIp, userAgent });
      }
    }

    return context.json({ error: "invalid_password", message: "Incorrect parent password" }, 401);
  }

  // Clear failed attempt counter on success
  failedAttemptsMap.delete(clientIp);

  const sessionToken = crypto.randomUUID() + "-" + crypto.randomUUID();
  const tokenHash = await sha256(sessionToken);

  await context.env.DB.prepare(
    `UPDATE parents SET session_token = ? WHERE id = ?`,
  ).bind(tokenHash, parent.id).run();

  return context.json({ token: sessionToken, email: parent.email });
});

app.post("/recover", async (context) => {
  const body = await parseJson(context, recoverSchema);
  if (isResponse(body)) return body;

  const clientIp = context.req.header("CF-Connecting-IP") || context.req.header("X-Forwarded-For") || "127.0.0.1";
  const userAgent = context.req.header("User-Agent") || "Unknown";

  const turnstileOk = await verifyTurnstileToken(context.env.TURNSTILE_SECRET_KEY, body.turnstileToken, clientIp);
  if (!turnstileOk) {
    return context.json({ error: "turnstile_failed", message: "CAPTCHA bot verification failed. Please try again." }, 400);
  }

  const normalized = normalizeKey(body.recoveryKey);
  const recoveryHash = await sha256(`sb_rec_${normalized}`);

  const parent = await context.env.DB.prepare(
    `SELECT id, household_id AS householdId, email FROM parents WHERE recovery_key_hash = ?`,
  ).bind(recoveryHash).first<{ id: string; householdId: string; email: string }>();

  if (!parent) {
    return context.json({ error: "invalid_recovery_key", message: "Invalid emergency recovery key" }, 401);
  }

  const newPasswordHash = await sha256(`sb_salt_${body.newPassword}`);
  const newRawKey = generateRecoveryKey();
  const newRecoveryHash = await sha256(`sb_rec_${normalizeKey(newRawKey)}`);

  const sessionToken = crypto.randomUUID() + "-" + crypto.randomUUID();
  const tokenHash = await sha256(sessionToken);

  await context.env.DB.prepare(
    `UPDATE parents SET password_hash = ?, recovery_key_hash = ?, session_token = ? WHERE id = ?`,
  ).bind(newPasswordHash, newRecoveryHash, tokenHash, parent.id).run();

  // Send security alert email for recovery key usage
  void sendParentSecurityAlert(context.env, parent.email, "password.recovery_used", { ipAddress: clientIp, userAgent });

  return context.json({ token: sessionToken, email: parent.email, newRecoveryKey: newRawKey });
});

app.post("/logout", async (context) => {
  const authHeader = context.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) {
      const tokenHash = await sha256(token);
      await context.env.DB.prepare(`UPDATE parents SET session_token = NULL WHERE session_token = ?`).bind(tokenHash).run();
    }
  }
  return context.json({ ok: true });
});

export default app;
