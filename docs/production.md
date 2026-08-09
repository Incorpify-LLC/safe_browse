# Production deployment (Incorpify SaaS)

**Live parent app:** https://safebrowse.incorpify.in  

**Workers.dev mirror:** https://safe-browse-api.saneax.workers.dev  

**Device API base:** `https://safebrowse.incorpify.in/api/v1/device/`

---

## Cloudflare resources (account `83bb50840b6aba2c18848f455b94f593`)

| Resource | Name / value |
| :--- | :--- |
| Worker | `safe-browse-api` |
| Custom domain | `safebrowse.incorpify.in` |
| D1 | `safe-browse` → `2bdbb275-85c2-4d55-8b9c-c4fc1cb8324f` |
| R2 lists | `safe-browse-lists` |
| R2 releases (MSI) | `safe-browse-releases` (public r2.dev) |
| `ENVIRONMENT` | `production` |

Migrations applied: `0001` … `0005`.

---

## Redeploy

```bash
cd /path/to/safe_browse
npm run build --workspace @safe-browse/dashboard
npx wrangler d1 migrations apply safe-browse --remote --config apps/worker/wrangler.jsonc
npx wrangler deploy --config apps/worker/wrangler.jsonc --env=""
```

---

## Notes / follow-ups

1. **Turnstile** uses the Incorpify production widget (site key in `wrangler.jsonc` vars; **secret** only via `wrangler secret put TURNSTILE_SECRET_KEY` — never commit the secret). Domains on the widget must include `safebrowse.incorpify.in` (and workers.dev if you use that host).
2. **Email alerts** (CF Email / Resend) not wired yet — optional.
3. **Local DNS** on some machines may lag for the new subdomain; public resolvers (`1.1.1.1`) resolve to Cloudflare anycast.
4. PBKDF2 iterations set to **80_000** for Workers CPU budgets (hashes rehashed on login if lower).

---

## Smoke checks

```bash
curl -sS https://safebrowse.incorpify.in/api/v1/auth/status
curl -sS -o /dev/null -w "%{http_code}\n" https://safebrowse.incorpify.in/
```

Open the site → **Sign up** with a real email → link authenticator.
