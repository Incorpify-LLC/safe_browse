# Deployment Runbook & Cloudflare Infrastructure Guide

This guide details the deployment procedure, Cloudflare setup, credit card enablement rules, and zero-cost guarantees for **Safe Browse**.

---

## 1. Cloudflare R2 Pricing & Free Tier Guarantee

### Why Credit Card Activation is Required for R2
Cloudflare requires a payment method on file to activate R2 object storage. This is a Cloudflare platform anti-abuse mechanism to prevent automated botnets from creating bulk storage buckets. 

### The $0 Cost Breakdown for Families
As long as usage remains within Cloudflare's monthly Free Tier, **your bill is $0.00/month**. Safe Browse is designed specifically to stay well below these limits:

| Metric | Cloudflare R2 Monthly Free Tier | Safe Browse Family Usage (<10 devices) | Free Quota Consumed |
| :--- | :--- | :--- | :--- |
| **Standard Storage** | **10 GB / month** | ~20 MB (compressed category lists) | **~0.2%** |
| **Class A Ops (Writes)** | **1,000,000 / month** | ~60 ops / month (daily list updates) | **~0.006%** |
| **Class B Ops (Reads)** | **10,000,000 / month** | ~100–500 ops / month (device sync checks) | **~0.005%** |
| **Data Egress** | **$0.00 (Free Forever)** | Unlimited egress | **0% ($0.00)** |
| **Unauthorized Requests** | **$0.00 (Free)** | Failed / unauthenticated requests | **0% ($0.00)** |

### Safety Rules & Cost Controls
1. **Standard Storage Only**: Safe Browse uses Standard R2 storage objects only. It does **NOT** use Infrequent Access storage or R2 Data Catalog features (which do not have free tiers).
2. **Egress Guarantee**: Cloudflare R2 never charges data transfer (egress) fees for downloading objects via Workers API, S3 API, or custom domains.
3. **Billing Monitoring**: You can verify that your bill remains $0.00 at any time via **Cloudflare Dashboard → Billing → Invoices**.

---

## 2. Cloudflare Setup & Deployment Steps

1. **Enable R2 & D1**:
   - Enable R2 in the Cloudflare Dashboard (requires one-time card verification).
   - Create D1 database (`safe-browse`) and R2 bucket (`safe-browse-lists`).
   - Replace database ID placeholders in `apps/worker/wrangler.jsonc`.

2. **Apply Database Migrations**:
   ```bash
   npx wrangler d1 migrations apply safe-browse --remote --config apps/worker/wrangler.jsonc
   ```

3. **Configure Domains & Authentication**:
   - Configure parent dashboard domain (`app.<domain>`) behind Cloudflare Access (Free for up to 50 users).
   - Configure device API domain (`device-api.<domain>`) without Cloudflare Access (bearer token auth is enforced directly by the Worker).

4. **Worker Secrets**:
   - Set secrets securely using Wrangler:
     ```bash
     npx wrangler secret put ACCESS_TEAM_DOMAIN
     npx wrangler secret put ACCESS_AUD
     npx wrangler secret put MANIFEST_PUBLIC_KEY_JWK
     ```
   - Never commit secret keys or tokens to git.

5. **Deploy Backend Worker & Dashboard**:
   ```bash
   npm run build
   npx wrangler deploy --config apps/worker/wrangler.jsonc
   ```

---

## 3. Parent Console Password Setup & Reset

### First-Time Setup
When Safe Browse is deployed for the first time:
1. Visit the deployed dashboard URL (`https://safe-browse-api.as2agents.workers.dev/` or custom domain).
2. The console detects no master password is set (`requireSetup: true`) and presents the **Create Master Password / PIN** screen.
3. Type your preferred password or PIN (e.g. a 6-digit PIN or custom passphrase) to lock the console.

### Resetting a Forgotten Password
If a parent forgets their password or a deployer wants to reset console access:
Run this command from your terminal to clear the password in D1:

```bash
npx wrangler d1 execute safe-browse --remote --command "UPDATE parents SET password_hash = NULL, session_token = NULL;" --config apps/worker/wrangler.jsonc
```

Upon refreshing the dashboard URL, the console will return to **First-Time Setup** mode, prompting for a new Master Password.

---

## 4. Windows Agent & Extension Packaging

1. Build the self-contained x64 Windows service (`SafeBrowse.Service.exe`), Native Host CLI (`SafeBrowse.NativeHost.exe`), Enrollment CLI (`SafeBrowse.Enroll.exe`), and Tray UI (`SafeBrowse.Tray.exe`).
2. Build the WiX MSI installer project (`apps/windows/installer/Package.wxs`).
3. Store publication IDs must replace development IDs in native-messaging manifests and browser installation policies.

---

## 4. Blocklist Licensing & Transparency

- **Application Code**: Licensed under Apache-2.0.
- **Blocklist Data**: HaGeZi-derived blocklist artifacts are separately identified GPL-3.0 data.
- **Manifest Provenance**: Every generated manifest includes upstream URLs, revisions, license identifiers, transformation versions, SHA256 hashes, and domain counts.
