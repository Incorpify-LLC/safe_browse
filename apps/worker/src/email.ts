/** Split a `Name <addr@host>` string into the binding's EmailAddress shape. */
export function parseFrom(value: string): string | { email: string; name: string } {
  const match = /^(.*?)\s*<([^>]+)>$/.exec(value);
  if (!match) return value;
  return { email: match[2] ?? value, name: (match[1] ?? "").trim() };
}

/**
 * Both callers run inside `waitUntil(...).catch(...)`, so anything thrown here
 * disappears into a swallowed promise and the parent is simply never notified.
 * A self-host deploy can legitimately omit the `send_email` binding, so check for
 * it and say so in the logs rather than throwing into the void.
 */
function emailConfigured(env: Env, purpose: string): boolean {
  if (env.EMAIL) return true;
  console.error(JSON.stringify({
    message: "email_not_configured",
    purpose,
    detail: "No send_email binding; parent notification was dropped.",
  }));
  return false;
}

export async function sendAccessRequestEmail(env: Env, to: string, childName: string, domain: string): Promise<void> {
  if (!emailConfigured(env, "access_request")) return;
  const safeChild = escapeHtml(childName);
  const safeDomain = escapeHtml(domain);
  await env.EMAIL.send({
    to,
    from: parseFrom(env.EMAIL_FROM),
    subject: `${childName} requested access to ${domain}`,
    text: `${childName} requested access to ${domain}. Open the Safe Browse dashboard to approve or deny it.`,
    html: `<p><strong>${safeChild}</strong> requested access to <strong>${safeDomain}</strong>.</p><p>Open the Safe Browse dashboard to approve or deny it.</p>`,
  });
}

export async function sendOfflineEmail(env: Env, to: string, deviceName: string): Promise<void> {
  if (!emailConfigured(env, "device_offline")) return;
  await env.EMAIL.send({
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
