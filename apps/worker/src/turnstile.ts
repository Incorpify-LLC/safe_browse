import { isDevelopment, type AppBindings } from "./types";

/**
 * Verify a Turnstile token against Cloudflare's siteverify endpoint.
 *
 * Takes the whole env rather than just the secret so that a missing secret can be
 * treated differently by environment. This guards every unauthenticated entry
 * point — signup, login, PIN recovery, and TOTP recovery — so "no secret
 * configured" must never silently mean "everyone passes" in production.
 */
export async function verifyTurnstileToken(
  env: AppBindings,
  token: string | undefined,
  remoteIp?: string,
): Promise<boolean> {
  const secretKey = env.TURNSTILE_SECRET_KEY;

  if (!secretKey || secretKey === "replace-with-turnstile-secret") {
    // Local dev and CI have no secret, and blocking there would make the console
    // unusable offline. In production a missing secret is a misconfiguration, and
    // failing open would leave public signup completely unprotected — so fail closed
    // and make the reason obvious in the logs.
    if (isDevelopment(env)) return true;
    console.error(JSON.stringify({
      message: "turnstile_secret_missing",
      detail: "Rejecting request: TURNSTILE_SECRET_KEY is not configured. Set it with `wrangler secret put TURNSTILE_SECRET_KEY`.",
    }));
    return false;
  }

  // Cloudflare's documented always-passes test secret. siteverify would return
  // success for it anyway; short-circuiting only avoids a pointless round-trip.
  if (secretKey === "1x0000000000000000000000000000000AA") return true;

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
