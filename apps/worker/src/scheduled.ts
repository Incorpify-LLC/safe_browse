import { sendOfflineEmail } from "./email";

export async function runScheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  const now = new Date();
  if (controller.cron === "17 2 * * *") {
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const idempotencyCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM events WHERE occurred_at < ?").bind(cutoff),
      env.DB.prepare("DELETE FROM audit_log WHERE created_at < ?").bind(cutoff),
      env.DB.prepare("DELETE FROM access_requests WHERE requested_at < ?").bind(cutoff),
      env.DB.prepare("DELETE FROM enrollment_codes WHERE expires_at < ?").bind(now.toISOString()),
      env.DB.prepare("DELETE FROM domain_rules WHERE expires_at IS NOT NULL AND expires_at < ?").bind(now.toISOString()),
      env.DB.prepare("DELETE FROM idempotency_keys WHERE created_at < ?").bind(idempotencyCutoff),
    ]);
    console.log(JSON.stringify({ message: "retention_complete", cutoff }));
    return;
  }

  const offlineCutoff = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
  const rows = await env.DB.prepare(
    `SELECT d.id,d.name,p.email FROM devices d
     JOIN children c ON c.id=d.child_id JOIN parents p ON p.household_id=c.household_id
     WHERE d.revoked_at IS NULL AND d.last_seen_at<? AND d.offline_alerted_at IS NULL`,
  ).bind(offlineCutoff).all<{ id: string; name: string; email: string }>();
  for (const row of rows.results) {
    await env.DB.prepare("UPDATE devices SET status='offline',offline_alerted_at=? WHERE id=? AND offline_alerted_at IS NULL")
      .bind(now.toISOString(), row.id).run();
    ctx.waitUntil(sendOfflineEmail(env, row.email, row.name).catch((error: unknown) => {
      console.error(JSON.stringify({ message: "offline_email_failed", deviceId: row.id, error: error instanceof Error ? error.message : String(error) }));
    }));
  }
}
