import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings, AppVariables } from "../types";
import { parseJson, isResponse } from "../http";
import { sha256 } from "../crypto";
import { ensureParent } from "../auth";

const app = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();

const setupSchema = z.object({
  password: z.string().min(4, "Password must be at least 4 characters").max(100),
  email: z.string().email().optional(),
});

const loginSchema = z.object({
  password: z.string().min(1, "Password is required"),
});

const recoverSchema = z.object({
  recoveryKey: z.string().min(8, "Recovery key is required"),
  newPassword: z.string().min(4, "Password must be at least 4 characters").max(100),
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

app.get("/status", async (context) => {
  const row = await context.env.DB.prepare(
    `SELECT COUNT(*) AS count, SUM(CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END) AS withPassword FROM parents`,
  ).first<{ count: number; withPassword: number }>();

  const hasPassword = (row?.withPassword ?? 0) > 0;
  const parentCount = row?.count ?? 0;

  return context.json({
    hasPassword,
    parentCount,
    requireSetup: !hasPassword,
  });
});

app.post("/setup", async (context) => {
  const body = await parseJson(context, setupSchema);
  if (isResponse(body)) return body;

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

  return context.json({ token: sessionToken, email: parent.email, recoveryKey: rawKey });
});

app.post("/login", async (context) => {
  const body = await parseJson(context, loginSchema);
  if (isResponse(body)) return body;

  const passwordHash = await sha256(`sb_salt_${body.password}`);

  const parent = await context.env.DB.prepare(
    `SELECT id, household_id AS householdId, email FROM parents WHERE password_hash = ?`,
  ).bind(passwordHash).first<{ id: string; householdId: string; email: string }>();

  if (!parent) {
    return context.json({ error: "invalid_password", message: "Incorrect parent password" }, 401);
  }

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
