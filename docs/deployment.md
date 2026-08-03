# Deployment runbook

## Cloudflare

1. Create D1 databases and R2 buckets for staging and production; replace placeholder IDs in `apps/worker/wrangler.jsonc`.
2. Apply migrations with `wrangler d1 migrations apply safe-browse --remote --env production`.
3. Configure `app.<domain>` behind Cloudflare Access. Configure a separate `device-api.<domain>` custom domain without Access; application bearer authentication remains mandatory.
4. Set `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and `MANIFEST_PUBLIC_KEY_JWK` as Worker secrets. Never commit them.
5. Enable Email Sending for the product domain, configure SPF/DKIM and DMARC, and update `EMAIL_FROM`.
6. Upload compiled list artifacts under `lists/<version>/` and `lists/latest.json` in R2.
7. Deploy with `wrangler deploy --env production --config apps/worker/wrangler.jsonc`.

Disable the public `workers.dev` route before production. Cloudflare Access must forward the JWT assertion to the parent hostname.

## Windows and extensions

Build the self-contained x64 service and native host, then build the WiX project. Pilot packages may be unsigned; public packages must pass the signing target using a trusted certificate. Store publication IDs must replace development IDs in the native-messaging manifests and browser installation policies.

## Blocklist licensing

Application code is Apache-2.0. HaGeZi-derived artifacts remain separately identified GPL-3.0 data. Every generated manifest includes upstream URLs, revisions, license identifiers, transformation version, hashes, and counts. Retain and publish the transformation source with distributed artifacts.
