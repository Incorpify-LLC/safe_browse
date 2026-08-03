import { Hono, type Context } from "hono";
import { z } from "zod";
import { ageBandSchema, categories, categorySchema, domainRuleSchema, normalizeDomain, presetCategories, scheduleSchema } from "@safe-browse/contracts";
import type { AppBindings, AppVariables } from "../types";
import { parentAuth } from "../auth";
import { isResponse, jsonDetail, parseJson } from "../http";
import { createDefaultCategories, incrementPolicy } from "../policy";
import { sha256, sixDigitCode } from "../crypto";

const app = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();
app.use("*", parentAuth);
app.use("*", async (context, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(context.req.method) || context.env.ENVIRONMENT === "development") return next();
  const origin = context.req.header("Origin");
  if (!origin || !isSameOrigin(origin, context.req.url)) return context.json({ error: "cross_site_request_rejected" }, 403);
  await next();
});

app.get("/me", async (context) => {
  const parent = context.get("parent");
  return context.json(parent);
});

app.get("/children", async (context) => {
  const parent = context.get("parent");
  const result = await context.env.DB.prepare(
    `SELECT c.id, c.name, c.age_band AS ageBand, c.timezone, c.policy_version AS policyVersion,
            c.paused, d.id AS deviceId, d.name AS deviceName, d.status,
            d.last_seen_at AS lastSeenAt, d.revoked_at AS revokedAt
     FROM children c LEFT JOIN devices d ON d.child_id = c.id AND d.revoked_at IS NULL
     WHERE c.household_id = ? ORDER BY c.name`,
  ).bind(parent.householdId).all();
  return context.json({ children: result.results });
});

const createChildSchema = z.object({
  name: z.string().trim().min(1).max(80),
  ageBand: ageBandSchema,
  timezone: z.string().min(1).max(64),
});

app.post("/children", async (context) => {
  const body = await parseJson(context, createChildSchema);
  if (isResponse(body)) return body;
  try { new Intl.DateTimeFormat("en", { timeZone: body.timezone }).format(); } catch { return context.json({ error: "invalid_timezone" }, 400); }
  const parent = context.get("parent");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await context.env.DB.prepare(
    `INSERT INTO children(id,household_id,name,age_band,timezone,safe_search,youtube_restricted,created_at)
     VALUES(?,?,?,?,?,?,?,?)`,
  ).bind(id, parent.householdId, body.name, body.ageBand, body.timezone, 1, body.ageBand === "age_16_17" ? 0 : 1, now).run();
  await createDefaultCategories(context.env.DB, id, body.ageBand);
  await audit(context.env.DB, parent.householdId, "parent", parent.id, "child.created", id, body);
  return context.json({ id }, 201);
});

app.get("/children/:id/policy", async (context) => {
  const childId = await ownedChild(context, context.req.param("id"));
  if (!childId) return context.json({ error: "not_found" }, 404);
  const [child, categoryRows, schedules, rules] = await Promise.all([
    context.env.DB.prepare(`SELECT id,name,age_band AS ageBand,timezone,policy_version AS policyVersion,
      safe_search AS safeSearch,youtube_restricted AS youtubeRestricted,paused FROM children WHERE id=?`).bind(childId).first(),
    context.env.DB.prepare("SELECT category,enabled FROM policy_categories WHERE child_id=? ORDER BY category").bind(childId).all(),
    context.env.DB.prepare(`SELECT id,category,days_json AS daysJson,start_minutes AS startMinutes,end_minutes AS endMinutes FROM schedules WHERE child_id=?`).bind(childId).all(),
    context.env.DB.prepare(`SELECT id,domain,action,expires_at AS expiresAt FROM domain_rules WHERE child_id=? ORDER BY domain`).bind(childId).all(),
  ]);
  return context.json({ child, categories: categoryRows.results, schedules: schedules.results, rules: rules.results });
});

const policyUpdateSchema = z.object({
  ageBand: ageBandSchema,
  timezone: z.string().min(1).max(64),
  enabledCategories: z.array(categorySchema),
  safeSearch: z.boolean(),
  youtubeRestricted: z.boolean(),
  paused: z.boolean(),
});

app.put("/children/:id/policy", async (context) => {
  const childId = await ownedChild(context, context.req.param("id"));
  if (!childId) return context.json({ error: "not_found" }, 404);
  const body = await parseJson(context, policyUpdateSchema);
  if (isResponse(body)) return body;
  try { new Intl.DateTimeFormat("en", { timeZone: body.timezone }).format(); } catch { return context.json({ error: "invalid_timezone" }, 400); }
  const enabled = new Set(body.enabledCategories);
  enabled.add("threats");
  await context.env.DB.batch([
    context.env.DB.prepare(`UPDATE children SET age_band=?,timezone=?,safe_search=?,youtube_restricted=?,paused=?,policy_version=policy_version+1 WHERE id=?`)
      .bind(body.ageBand, body.timezone, body.safeSearch ? 1 : 0, body.youtubeRestricted ? 1 : 0, body.paused ? 1 : 0, childId),
    ...categories.map((category) => context.env.DB.prepare(
      "INSERT INTO policy_categories(child_id,category,enabled) VALUES(?,?,?) ON CONFLICT(child_id,category) DO UPDATE SET enabled=excluded.enabled",
    ).bind(childId, category, enabled.has(category) ? 1 : 0)),
  ]);
  const parent = context.get("parent");
  await audit(context.env.DB, parent.householdId, "parent", parent.id, "policy.updated", childId, body);
  return context.json({ ok: true });
});

app.post("/children/:id/reset-preset", async (context) => {
  const childId = await ownedChild(context, context.req.param("id"));
  if (!childId) return context.json({ error: "not_found" }, 404);
  const child = await context.env.DB.prepare("SELECT age_band AS ageBand FROM children WHERE id=?").bind(childId).first<{ ageBand: keyof typeof presetCategories }>();
  if (!child) return context.json({ error: "not_found" }, 404);
  const enabled = new Set(presetCategories[child.ageBand]);
  await context.env.DB.batch(categories.map((category) => context.env.DB.prepare(
    "UPDATE policy_categories SET enabled=? WHERE child_id=? AND category=?",
  ).bind(enabled.has(category) ? 1 : 0, childId, category)));
  await incrementPolicy(context.env.DB, childId);
  return context.json({ ok: true });
});

app.post("/children/:id/enrollment-code", async (context) => {
  const childId = await ownedChild(context, context.req.param("id"));
  if (!childId) return context.json({ error: "not_found" }, 404);
  const code = sixDigitCode();
  const codeHash = await sha256(code);
  const now = new Date();
  await context.env.DB.prepare(
    "INSERT INTO enrollment_codes(id,child_id,code_hash,expires_at,created_at) VALUES(?,?,?,?,?)",
  ).bind(crypto.randomUUID(), childId, codeHash, new Date(now.getTime() + 600_000).toISOString(), now.toISOString()).run();
  return context.json({ code, expiresAt: new Date(now.getTime() + 600_000).toISOString() }, 201);
});

app.post("/children/:id/schedules", async (context) => {
  const childId = await ownedChild(context, context.req.param("id"));
  if (!childId) return context.json({ error: "not_found" }, 404);
  const body = await parseJson(context, scheduleSchema);
  if (isResponse(body)) return body;
  const id = crypto.randomUUID();
  await context.env.DB.prepare("INSERT INTO schedules(id,child_id,category,days_json,start_minutes,end_minutes) VALUES(?,?,?,?,?,?)")
    .bind(id, childId, body.category, JSON.stringify(body.days), body.startMinutes, body.endMinutes).run();
  await incrementPolicy(context.env.DB, childId);
  return context.json({ id }, 201);
});

app.delete("/children/:childId/schedules/:scheduleId", async (context) => {
  const childId = await ownedChild(context, context.req.param("childId"));
  if (!childId) return context.json({ error: "not_found" }, 404);
  await context.env.DB.prepare("DELETE FROM schedules WHERE id=? AND child_id=?").bind(context.req.param("scheduleId"), childId).run();
  await incrementPolicy(context.env.DB, childId);
  return context.body(null, 204);
});

app.post("/children/:id/rules", async (context) => {
  const childId = await ownedChild(context, context.req.param("id"));
  if (!childId) return context.json({ error: "not_found" }, 404);
  const body = await parseJson(context, domainRuleSchema);
  if (isResponse(body)) return body;
  let domain: string;
  try { domain = normalizeDomain(body.domain); } catch { return context.json({ error: "invalid_domain" }, 400); }
  const id = crypto.randomUUID();
  await context.env.DB.prepare(
    `INSERT INTO domain_rules(id,child_id,domain,action,expires_at,created_at) VALUES(?,?,?,?,?,?)
     ON CONFLICT(child_id,domain) DO UPDATE SET action=excluded.action,expires_at=excluded.expires_at`,
  ).bind(id, childId, domain, body.action, body.expiresAt, new Date().toISOString()).run();
  await incrementPolicy(context.env.DB, childId);
  return context.json({ id, domain }, 201);
});

app.delete("/children/:childId/rules/:ruleId", async (context) => {
  const childId = await ownedChild(context, context.req.param("childId"));
  if (!childId) return context.json({ error: "not_found" }, 404);
  await context.env.DB.prepare("DELETE FROM domain_rules WHERE id=? AND child_id=?").bind(context.req.param("ruleId"), childId).run();
  await incrementPolicy(context.env.DB, childId);
  return context.body(null, 204);
});

app.get("/events", async (context) => {
  const parent = context.get("parent");
  const childId = context.req.query("childId");
  const kind = context.req.query("kind");
  const domain = context.req.query("domain");
  const limit = Math.min(Math.max(Number(context.req.query("limit") ?? 100), 1), 250);
  const rows = await context.env.DB.prepare(
    `SELECT e.id,e.child_id AS childId,c.name AS childName,e.device_id AS deviceId,e.occurred_at AS occurredAt,
            e.kind,e.domain,e.category,e.browser,e.detail
     FROM events e JOIN children c ON c.id=e.child_id
     WHERE e.household_id=? AND (? IS NULL OR e.child_id=?) AND (? IS NULL OR e.kind=?)
       AND (? IS NULL OR e.domain LIKE '%' || ? || '%')
     ORDER BY e.occurred_at DESC LIMIT ?`,
  ).bind(parent.householdId, childId ?? null, childId ?? null, kind ?? null, kind ?? null, domain ?? null, domain ?? null, limit).all();
  return context.json({ events: rows.results });
});

app.get("/requests", async (context) => {
  const parent = context.get("parent");
  const rows = await context.env.DB.prepare(
    `SELECT r.id,r.child_id AS childId,c.name AS childName,r.domain,r.category,r.reason,r.status,r.duration,
            r.requested_at AS requestedAt,r.resolved_at AS resolvedAt
     FROM access_requests r JOIN children c ON c.id=r.child_id
     WHERE r.household_id=? ORDER BY (r.status='pending') DESC,r.requested_at DESC LIMIT 250`,
  ).bind(parent.householdId).all();
  return context.json({ requests: rows.results });
});

const approvalSchema = z.object({ duration: z.enum(["session", "hour", "day", "permanent", "deny"]) });
app.post("/requests/:id/resolve", async (context) => {
  const body = await parseJson(context, approvalSchema);
  if (isResponse(body)) return body;
  const parent = context.get("parent");
  const request = await context.env.DB.prepare(
    "SELECT id,child_id AS childId,domain,status FROM access_requests WHERE id=? AND household_id=?",
  ).bind(context.req.param("id"), parent.householdId).first<{ id: string; childId: string; domain: string; status: string }>();
  if (!request) return context.json({ error: "not_found" }, 404);
  if (request.status !== "pending") return context.json({ error: "already_resolved" }, 409);
  const now = new Date();
  const statements = [context.env.DB.prepare(
    "UPDATE access_requests SET status=?,duration=?,resolved_at=? WHERE id=? AND status='pending'",
  ).bind(body.duration === "deny" ? "denied" : "approved", body.duration, now.toISOString(), request.id)];
  if (body.duration !== "deny") {
    const durationMs = body.duration === "session" ? 600_000 : body.duration === "hour" ? 3_600_000 : body.duration === "day" ? endOfDayMs(now) : null;
    const expiresAt = durationMs === null ? null : new Date(now.getTime() + durationMs).toISOString();
    statements.push(context.env.DB.prepare(
      `INSERT INTO domain_rules(id,child_id,domain,action,expires_at,created_at) VALUES(?,?,?,?,?,?)
       ON CONFLICT(child_id,domain) DO UPDATE SET action='allow',expires_at=excluded.expires_at`,
    ).bind(crypto.randomUUID(), request.childId, request.domain, "allow", expiresAt, now.toISOString()));
  }
  statements.push(context.env.DB.prepare("UPDATE children SET policy_version=policy_version+1 WHERE id=?").bind(request.childId));
  await context.env.DB.batch(statements);
  await audit(context.env.DB, parent.householdId, "parent", parent.id, `request.${body.duration}`, request.id, { domain: request.domain });
  return context.json({ ok: true });
});

app.post("/devices/:id/revoke", async (context) => {
  const parent = context.get("parent");
  const result = await context.env.DB.prepare(
    `UPDATE devices SET revoked_at=? WHERE id=? AND child_id IN (SELECT id FROM children WHERE household_id=?)`,
  ).bind(new Date().toISOString(), context.req.param("id"), parent.householdId).run();
  if (!result.meta.changes) return context.json({ error: "not_found" }, 404);
  await audit(context.env.DB, parent.householdId, "parent", parent.id, "device.revoked", context.req.param("id"), {});
  return context.json({ ok: true });
});

async function ownedChild(context: Context<{ Bindings: AppBindings; Variables: AppVariables }>, childId: string): Promise<string | null> {
  const parent = context.get("parent");
  const row = await context.env.DB.prepare("SELECT id FROM children WHERE id=? AND household_id=?").bind(childId, parent.householdId).first<{ id: string }>();
  return row?.id ?? null;
}

async function audit(db: D1Database, householdId: string, actorType: string, actorId: string, action: string, targetId: string, detail: unknown) {
  await db.prepare("INSERT INTO audit_log(id,household_id,actor_type,actor_id,action,target_id,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), householdId, actorType, actorId, action, targetId, jsonDetail(detail), new Date().toISOString()).run();
}

function endOfDayMs(now: Date): number {
  const end = new Date(now);
  end.setUTCHours(23, 59, 59, 999);
  return Math.max(end.getTime() - now.getTime(), 60_000);
}

function isSameOrigin(origin: string, requestUrl: string): boolean {
  try { return new URL(origin).origin === new URL(requestUrl).origin; } catch { return false; }
}

export default app;
