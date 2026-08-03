# Safe Browse

Safe Browse is a transparent parental-control system for Windows 10 and Windows 11. It filters domains locally, keeps working when the cloud is unavailable, and gives an invited parent a remote dashboard for policies, schedules, history, and access requests.

The MVP deliberately records only top-level browser domains and blocked DNS attempts. It never collects page paths, query strings, page titles, or page content.

## Repository

- `apps/worker` — Cloudflare Worker API, D1 migrations, R2 artifact delivery, retention, and transactional alerts.
- `apps/dashboard` — responsive React parent dashboard.
- `apps/extension` — shared WebExtension for Edge, Chrome, and Firefox.
- `apps/windows` — .NET Windows service, local policy engine/DNS proxy, native messaging host, tray, and WiX installer.
- `packages/contracts` — shared TypeScript API and policy schemas.
- `tools/blocklists` — deterministic feed compiler and signed artifact manifest tooling.

## Local development

```bash
npm install
npm run check
npm run dev --workspace @safe-browse/worker
npm run dev --workspace @safe-browse/dashboard
```

Apply the local D1 schema before exercising the API:

```bash
npx wrangler d1 migrations apply safe-browse --local --config apps/worker/wrangler.jsonc
```

The Worker accepts `Cf-Access-Authenticated-User-Email` only when `ENVIRONMENT=development`. Production requires a verified Cloudflare Access JWT and configured `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` secrets.

See [docs/architecture.md](docs/architecture.md) and [docs/deployment.md](docs/deployment.md) for security boundaries and deployment prerequisites.
