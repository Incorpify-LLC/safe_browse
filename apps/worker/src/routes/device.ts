import { Hono } from "hono";
import { accessRequestSchema, enrollmentSchema, eventBatchSchema, heartbeatSchema, normalizeDomain } from "@safe-browse/contracts";
import type { AppBindings, AppVariables } from "../types";
import { deviceAuth } from "../auth";
import { isResponse, parseJson } from "../http";
import { randomToken, sha256 } from "../crypto";
import { buildPolicy, latestListVersion } from "../policy";
import { sendAccessRequestEmail } from "../email";

const app = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();

app.post("/enroll", async (context) => {
  const body = await parseJson(context, enrollmentSchema);
  if (isResponse(body)) return body;
  const codeHash = await sha256(body.code);
  const now = new Date().toISOString();
  const enrollment = await context.env.DB.prepare(
    `SELECT e.id,e.child_id AS childId,c.household_id AS householdId
     FROM enrollment_codes e JOIN children c ON c.id=e.child_id
     WHERE e.code_hash=? AND e.consumed_at IS NULL AND e.expires_at>?`,
  ).bind(codeHash, now).first<{ id: string; childId: string; householdId: string }>();
  if (!enrollment) return context.json({ error: "invalid_or_expired_code" }, 400);

  const token = randomToken();
  const deviceId = crypto.randomUUID();
  await context.env.DB.batch([
    context.env.DB.prepare("UPDATE enrollment_codes SET consumed_at=? WHERE id=? AND consumed_at IS NULL").bind(now, enrollment.id),
    context.env.DB.prepare("UPDATE devices SET revoked_at=? WHERE child_id=? AND revoked_at IS NULL").bind(now, enrollment.childId),
    context.env.DB.prepare(
      `INSERT INTO devices(id,child_id,name,platform,credential_hash,agent_version,last_seen_at,created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
    ).bind(deviceId, enrollment.childId, body.deviceName, body.platform, await sha256(token), body.agentVersion, now, now),
    context.env.DB.prepare(
      "INSERT INTO audit_log(id,household_id,actor_type,actor_id,action,target_id,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).bind(crypto.randomUUID(), enrollment.householdId, "device", deviceId, "device.enrolled", deviceId, "{}", now),
  ]);
  const listVersion = await latestListVersion(context.env.LISTS);
  const policy = await buildPolicy(context.env.DB, enrollment.childId, listVersion);
  return context.json({ deviceId, token, policy }, 201);
});

app.use("*", deviceAuth);

app.get("/sync", async (context) => {
  const device = context.get("device");
  const listVersion = await latestListVersion(context.env.LISTS);
  const policy = await buildPolicy(context.env.DB, device.childId, listVersion);
  if (!policy) return context.json({ error: "child_not_found" }, 404);
  const knownVersion = Number(context.req.query("policyVersion") ?? -1);
  if (knownVersion === policy.version && context.req.query("listVersion") === policy.listVersion) {
    return context.body(null, 304);
  }
  return context.json({ policy });
});

app.post("/heartbeat", async (context) => {
  const body = await parseJson(context, heartbeatSchema);
  if (isResponse(body)) return body;
  const device = context.get("device");
  await context.env.DB.prepare(
    `UPDATE devices SET agent_version=?,policy_version=?,list_version=?,status=?,last_seen_at=?,offline_alerted_at=NULL WHERE id=?`,
  ).bind(body.agentVersion, body.policyVersion, body.listVersion, body.status, new Date().toISOString(), device.id).run();
  if (body.status === "tampered" || body.status === "emergency_bypass") {
    await context.env.DB.prepare(
      "INSERT INTO audit_log(id,household_id,actor_type,actor_id,action,target_id,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).bind(crypto.randomUUID(), device.householdId, "device", device.id, `device.${body.status}`, device.id, JSON.stringify({ detail: body.detail }), new Date().toISOString()).run();
  }
  return context.json({ ok: true });
});

app.post("/events", async (context) => {
  const idempotencyKey = context.req.header("Idempotency-Key");
  if (!idempotencyKey || idempotencyKey.length > 100) return context.json({ error: "missing_idempotency_key" }, 400);
  const body = await parseJson(context, eventBatchSchema);
  if (isResponse(body)) return body;
  const device = context.get("device");
  const existing = await context.env.DB.prepare("SELECT 1 AS found FROM idempotency_keys WHERE device_id=? AND key=?")
    .bind(device.id, idempotencyKey).first<{ found: number }>();
  if (existing) return context.json({ accepted: 0, duplicate: true });
  const receivedAt = new Date().toISOString();
  const statements = body.events.map((event) => {
    let domain = event.domain;
    if (domain) {
      try { domain = normalizeDomain(domain); } catch { domain = null; }
    }
    return context.env.DB.prepare(
      `INSERT OR IGNORE INTO events(id,household_id,child_id,device_id,occurred_at,kind,domain,category,browser,detail,received_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(event.id, device.householdId, device.childId, device.id, event.occurredAt, event.kind, domain, event.category, event.browser, event.detail, receivedAt);
  });
  statements.push(context.env.DB.prepare("INSERT INTO idempotency_keys(device_id,key,created_at) VALUES(?,?,?)").bind(device.id, idempotencyKey, receivedAt));
  await context.env.DB.batch(statements);
  return context.json({ accepted: body.events.length });
});

app.post("/access-requests", async (context) => {
  const body = await parseJson(context, accessRequestSchema);
  if (isResponse(body)) return body;
  let domain: string;
  try { domain = normalizeDomain(body.domain); } catch { return context.json({ error: "invalid_domain" }, 400); }
  const device = context.get("device");
  const duplicate = await context.env.DB.prepare(
    "SELECT id FROM access_requests WHERE child_id=? AND domain=? AND status='pending'",
  ).bind(device.childId, domain).first<{ id: string }>();
  if (duplicate) return context.json({ id: duplicate.id, duplicate: true });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await context.env.DB.prepare(
    `INSERT INTO access_requests(id,household_id,child_id,device_id,domain,category,reason,requested_at)
     VALUES(?,?,?,?,?,?,?,?)`,
  ).bind(id, device.householdId, device.childId, device.id, domain, body.category, body.reason, now).run();
  const recipient = await context.env.DB.prepare(
    `SELECT p.email,c.name AS childName FROM parents p JOIN children c ON c.household_id=p.household_id
     WHERE c.id=? LIMIT 1`,
  ).bind(device.childId).first<{ email: string; childName: string }>();
  if (recipient) {
    context.executionCtx.waitUntil(sendAccessRequestEmail(context.env, recipient.email, recipient.childName, domain).catch((error: unknown) => {
      console.error(JSON.stringify({ message: "access_request_email_failed", requestId: id, error: error instanceof Error ? error.message : String(error) }));
    }));
  }
  return context.json({ id }, 201);
});

app.get("/access-requests/:id", async (context) => {
  const device = context.get("device");
  const request = await context.env.DB.prepare(
    `SELECT id,domain,status,duration,requested_at AS requestedAt,resolved_at AS resolvedAt
     FROM access_requests WHERE id=? AND device_id=?`,
  ).bind(context.req.param("id"), device.id).first();
  if (!request) return context.json({ error: "not_found" }, 404);
  return context.json(request);
});

app.get("/lists/manifest", async (context) => {
  const object = await context.env.LISTS.get("lists/latest.json");
  if (!object) return context.json({ error: "list_not_ready" }, 503);
  return new Response(object.body, { headers: { "Content-Type": "application/json", "ETag": object.httpEtag, "Cache-Control": "private, max-age=300" } });
});

app.get("/lists/:version/:file", async (context) => {
  const version = context.req.param("version");
  const file = context.req.param("file");
  if (!/^[a-zA-Z0-9._-]+$/.test(version) || !/^[a-zA-Z0-9._-]+$/.test(file)) return context.json({ error: "invalid_path" }, 400);
  const object = await context.env.LISTS.get(`lists/${version}/${file}`);
  if (!object) return context.json({ error: "not_found" }, 404);
  return new Response(object.body, { headers: { "Content-Type": "application/gzip", "ETag": object.httpEtag, "Cache-Control": "private, max-age=86400, immutable" } });
});

export default app;
