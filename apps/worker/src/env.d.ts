/**
 * Bindings, secrets, and runtime globals that `wrangler types` cannot see.
 *
 * `worker-configuration.d.ts` is generated from `wrangler.jsonc` alone, so it only
 * knows about plain vars and declared bindings. Secrets (set with
 * `wrangler secret put`) never appear there, and neither do bindings that are
 * intentionally absent from the committed config. Declaration merging adds them
 * back here without touching the generated file, which `npm run typecheck`
 * rewrites on every run.
 *
 * Everything below is optional on purpose: each is genuinely absent in at least
 * one real environment (local dev, CI, or a self-host deploy that has not
 * configured that transport). Code must handle absence rather than assume it.
 */
interface Env {
  /** Turnstile server-side key. Set with `wrangler secret put TURNSTILE_SECRET_KEY`. */
  TURNSTILE_SECRET_KEY?: string;
  /** Telegram push alerts — optional parent notification transport. */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  /** ntfy.sh topic — optional parent notification transport. */
  NTFY_TOPIC?: string;
  /** Resend API key — optional parent notification transport. */
  RESEND_API_KEY?: string;
}

