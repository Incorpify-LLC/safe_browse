# Deployment Runbook & Cloudflare Infrastructure Guide

## ⚡ Quick Start — One-Click Deploy

> **For parents and first-time deployers.** No prior Cloudflare experience needed.

### 1. Create a Cloudflare API Token
Follow the step-by-step guide in [docs/cloudflare-api-token.md](./cloudflare-api-token.md) to create a token with the required permissions. Takes ~3 minutes.

### 2. Run the Deploy Script
```bash
# Clone the repository
git clone https://github.com/Incorpify-LLC/safe_browse.git
cd safe_browse

# Run the one-click deploy (will prompt for your token)
bash tools/deploy.sh
```

The script **fully automates** everything:
- ✅ Creates the D1 database
- ✅ Creates the R2 storage bucket
- ✅ Creates the Turnstile CAPTCHA widget
- ✅ Builds the dashboard UI
- ✅ Applies database schema migrations
- ✅ Deploys the Cloudflare Worker

At the end, it prints your live dashboard URL. Open it, set your Parent Password, and you're done.

**Prerequisites:** `node >= 18`, `npm`, `curl`, `jq`

---


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

## 3. Parent Console Auth (email-less)

See the full **three-key ladder** in [parent-auth.md](./parent-auth.md).

### First-Time Setup
1. Open the dashboard URL.
2. Create a master PIN / password (**once only**).
3. Optionally save the paper recovery key.
4. **Required:** link a TOTP authenticator app and confirm a code.
5. Console APIs refuse access until TOTP is linked.

### Forgot PIN
Use the authenticator app on the login screen (primary). Paper recovery key is secondary.

### Lost authenticator phone (operator)
```bash
export CLOUDFLARE_API_TOKEN="..."
bash tools/deploy.sh --reset-parent-auth
```
Then complete first-time setup again. This requires your Cloudflare token — it is not a public reset.

---

## 4. Cloudflare Turnstile CAPTCHA (Production Keys)

### Why does the widget say *"For testing only. If seen, report to site owner"*?
By default, the application is pre-configured with Cloudflare's official **Testing Sitekey** (`1x00000000000000000000AA`). Cloudflare intentionally renders this banner on test sitekeys to indicate that dummy verification is active and passes automatically.

### How to Enable Production Turnstile (Free Forever):
1. In Cloudflare Dashboard, go to **Turnstile** (in the left sidebar) → **Add Site**.
2. **Site Name**: `Safe Browse Console`
3. **Domain**: `safe-browse-api.as2agents.workers.dev` (or your custom domain / `*`).
4. **Widget Type**: 
   - **Managed** (displays friendly interactive checkmark)
   - **Invisible** (runs completely invisible in background with zero UI box)
5. Copy the generated **Site Key** (`0x4AAAAAA...`) and **Secret Key** (`0x4AAAAAA...`).
6. Set the production keys in Cloudflare Workers:
   ```bash
   npx wrangler secret put TURNSTILE_SITE_KEY
   npx wrangler secret put TURNSTILE_SECRET_KEY
   ```

Once real production keys are saved, the testing banner disappears immediately!

---

## 5. Windows Agent & Extension Packaging

1. Build the self-contained x64 Windows service (`SafeBrowse.Service.exe`), Native Host CLI (`SafeBrowse.NativeHost.exe`), Enrollment CLI (`SafeBrowse.Enroll.exe`), and Tray UI (`SafeBrowse.Tray.exe`).
2. Build the WiX MSI installer project (`apps/windows/installer/Package.wxs`).
3. Store publication IDs must replace development IDs in native-messaging manifests and browser installation policies.

---

## 4. Blocklist Licensing & Transparency

- **Application Code**: Licensed under Apache-2.0.
- **Blocklist Data**: HaGeZi-derived blocklist artifacts are separately identified GPL-3.0 data.
- **Manifest Provenance**: Every generated manifest includes upstream URLs, revisions, license identifiers, transformation versions, SHA256 hashes, and domain counts.
