import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Context, Next } from "hono";
import type { AppBindings, AppVariables } from "./types";
import { sha256 } from "./crypto";

export async function parentAuth(context: Context<{ Bindings: AppBindings; Variables: AppVariables }>, next: Next) {
  const env = context.env;
  const authHeader = context.req.header("Authorization");
  const accessAssertion = context.req.header("Cf-Access-Jwt-Assertion");

  let parent: { id: string; householdId: string; email: string } | null = null;

  // 1. Session Token Bearer Auth (Direct Password / PIN Login)
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) {
      const tokenHash = await sha256(token);
      const row = await env.DB.prepare(
        `SELECT p.id, p.household_id AS householdId, p.email FROM parents p WHERE p.session_token = ?`,
      ).bind(tokenHash).first<{ id: string; householdId: string; email: string }>();
      if (row) parent = row;
    }
  }

  // 2. Cloudflare Access JWT Assertion Auth
  if (!parent && accessAssertion) {
    const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
    const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    try {
      const result = await jwtVerify(accessAssertion, jwks, { issuer, audience: env.ACCESS_AUD });
      if (typeof result.payload.email === "string") {
        parent = await ensureParent(env.DB, result.payload.email.toLowerCase());
      }
    } catch {
      return context.json({ error: "invalid_access_assertion" }, 401);
    }
  }

  // 3. Fallback for Local Dev (only on local dev server 127.0.0.1/localhost)
  const host = context.req.header("Host") ?? "";
  if (!parent && env.ENVIRONMENT === "development" && (host.includes("localhost") || host.includes("127.0.0.1"))) {
    const devEmail = context.req.header("Cf-Access-Authenticated-User-Email") ?? "developer@example.test";
    parent = await ensureParent(env.DB, devEmail.toLowerCase());
  }

  if (!parent) {
    return context.json({ error: "unauthorized", message: "Parent password authentication required" }, 401);
  }

  context.set("parent", parent);
  await next();
}

export async function deviceAuth(context: Context<{ Bindings: AppBindings; Variables: AppVariables }>, next: Next) {
  const authorization = context.req.header("Authorization");
  if (!authorization?.startsWith("Bearer ")) return context.json({ error: "missing_device_token" }, 401);
  const credentialHash = await sha256(authorization.slice(7));
  const device = await context.env.DB.prepare(
    `SELECT d.id, d.child_id AS childId, c.household_id AS householdId
     FROM devices d JOIN children c ON c.id = d.child_id
     WHERE d.credential_hash = ? AND d.revoked_at IS NULL`,
  ).bind(credentialHash).first<{ id: string; childId: string; householdId: string }>();
  if (!device) return context.json({ error: "invalid_device_token" }, 401);
  context.set("device", device);
  await next();
}

export async function ensureParent(db: D1Database, email: string) {
  const existing = await db.prepare(
    `SELECT p.id, p.household_id AS householdId, p.email FROM parents p WHERE p.email = ?`,
  ).bind(email).first<{ id: string; householdId: string; email: string }>();
  if (existing) return existing;

  const householdId = crypto.randomUUID();
  const parentId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO households(id,name,timezone,created_at) VALUES(?,?,?,?)")
      .bind(householdId, `${email}'s household`, "UTC", now),
    db.prepare("INSERT OR IGNORE INTO parents(id,household_id,email,created_at) VALUES(?,?,?,?)")
      .bind(parentId, householdId, email, now),
  ]);
  const created = await db.prepare(
    `SELECT id, household_id AS householdId, email FROM parents WHERE email = ?`,
  ).bind(email).first<{ id: string; householdId: string; email: string }>();
  if (!created) throw new Error("Unable to provision parent");
  return created;
}
