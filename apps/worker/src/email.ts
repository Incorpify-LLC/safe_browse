function parseFrom(value: string): string | { email: string; name: string } {
  const match = /^(.*?)\s*<([^>]+)>$/.exec(value);
  if (!match) return value;
  return { email: match[2] ?? value, name: (match[1] ?? "").trim() };
}

/**
 * The `EMAIL` send binding is not declared in wrangler.jsonc, so it is undefined
 * in production. Both callers run inside `waitUntil(...).catch(...)`, which means
 * an unguarded `env.EMAIL.send()` throws into a swallowed promise and the parent
 * is never told anything went wrong. Log explicitly instead of failing silently.
 *
 * Returns true when the message was handed to a transport.
 */
function emailConfigured(env: Env, purpose: string): boolean {
  if (env.EMAIL) return true;
  console.error(JSON.stringify({
    message: "email_not_configured",
    purpose,
    detail: "EMAIL binding is absent from wrangler.jsonc; parent notification was dropped.",
  }));
  return false;
}

export async function sendAccessRequestEmail(env: Env, to: string, childName: string, domain: string): Promise<void> {
  if (!emailConfigured(env, "access_request")) return;
  const safeChild = escapeHtml(childName);
  const safeDomain = escapeHtml(domain);
  await env.EMAIL!.send({
    to,
    from: parseFrom(env.EMAIL_FROM),
    subject: `${childName} requested access to ${domain}`,
    text: `${childName} requested access to ${domain}. Open the Safe Browse dashboard to approve or deny it.`,
    html: `<p><strong>${safeChild}</strong> requested access to <strong>${safeDomain}</strong>.</p><p>Open the Safe Browse dashboard to approve or deny it.</p>`,
  });
}

export async function sendOfflineEmail(env: Env, to: string, deviceName: string): Promise<void> {
  if (!emailConfigured(env, "device_offline")) return;
  await env.EMAIL!.send({
    to,
    from: parseFrom(env.EMAIL_FROM),
    subject: `Safe Browse cannot reach ${deviceName}`,
    text: `${deviceName} has not checked in for at least 15 minutes. Filtering should remain active with its cached policy.`,
    html: `<p><strong>${escapeHtml(deviceName)}</strong> has not checked in for at least 15 minutes.</p><p>Filtering should remain active with its cached policy.</p>`,
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character] ?? character);
}
