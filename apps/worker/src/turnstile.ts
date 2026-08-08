export async function verifyTurnstileToken(secretKey: string | undefined, token: string | undefined, remoteIp?: string): Promise<boolean> {
  // If no Turnstile secret is configured (or dummy testing key), bypass or test
  if (!secretKey || secretKey === "replace-with-turnstile-secret" || secretKey === "1x0000000000000000000000000000000AA") {
    return true;
  }

  if (!token) return false;

  try {
    const formData = new FormData();
    formData.append("secret", secretKey);
    formData.append("response", token);
    if (remoteIp) formData.append("remoteip", remoteIp);

    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: formData,
    });

    const outcome = await res.json() as { success: boolean; "error-codes"?: string[] };
    return outcome.success === true;
  } catch {
    return false;
  }
}
