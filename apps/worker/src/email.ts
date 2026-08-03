function parseFrom(value: string): string | { email: string; name: string } {
  const match = /^(.*?)\s*<([^>]+)>$/.exec(value);
  if (!match) return value;
  return { email: match[2] ?? value, name: (match[1] ?? "").trim() };
}

export async function sendAccessRequestEmail(env: Env, to: string, childName: string, domain: string): Promise<void> {
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
