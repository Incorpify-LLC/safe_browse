# How to Create a Cloudflare API Token for Safe Browse

This guide walks you through creating a Cloudflare API token that gives the
Safe Browse deploy script the permissions it needs. The entire process takes
about 3 minutes and only needs to be done once.

> **No Cloudflare account yet?**  
> Sign up free at <https://dash.cloudflare.com/sign-up>. No credit card is
> required for Workers, D1, or Turnstile. A credit card **is** required to
> activate R2 object storage (Cloudflare's abuse-prevention requirement), but
> charges will be **$0.00** as long as you stay within the free tier.  
> See [deployment.md](./deployment.md) for the full cost breakdown.

---

## Step-by-Step: Create an API Token

### 1. Open the API Tokens page

1. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com).
2. Click your **profile avatar** in the top-right corner.
3. Select **Profile** from the dropdown.
4. Click **API Tokens** in the left sidebar.

Direct link: <https://dash.cloudflare.com/profile/api-tokens>

---

### 2. Create a Custom Token

1. Click the blue **Create Token** button.
2. Scroll past the templates and click **"Create Custom Token"** (at the bottom of the page).

---

### 3. Name the Token

In the **Token name** field, enter:
```
Safe Browse Deploy
```

---

### 4. Set Permissions

Click **+ Add more** to add each permission row below.
You need **exactly these 7 permission groups**:

| Category | Permission | Access Level |
|---|---|---|
| Account | **Cloudflare Workers R2 Storage** | Edit |
| Account | **D1** | Edit |
| Account | **Workers Scripts** | Edit |
| Account | **Account Settings** | Read |
| Account | **Turnstile** | Edit |
| User | **Memberships** | Read |
| User | **User Details** | Read |

> **Tip:** Use the search boxes in each row to quickly find the permission name.

---

### 5. Set Account Resources

Under **Account Resources**:
- Set the first dropdown to **Include**
- Set the second dropdown to **All accounts**  
  *(or select your specific account if you only have one)*

---

### 6. Set Zone Resources

Under **Zone Resources**:
- Set to **All zones**  
  *(or leave as-is — Safe Browse doesn't need zone-level access)*

---

### 7. (Optional) Set an Expiry Date

For extra security, you can set a token TTL (e.g., 30 days). After it expires,
just repeat this process to create a new token.

---

### 8. Create the Token

1. Click **Continue to Summary** (blue button at the bottom).
2. Review the permissions summary.
3. Click **Create Token**.
4. **Copy the token immediately** — Cloudflare only shows it once!

The token looks like:
```
cfat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## Run the Deploy Script

Once you have your token, run:

```bash
# Clone the repo (if you haven't already)
git clone https://github.com/Incorpify-LLC/safe_browse.git
cd safe_browse

# Deploy! The script will ask for your token interactively.
bash tools/deploy.sh
```

Or pass the token directly (useful for CI/automated setups):

```bash
CLOUDFLARE_API_TOKEN="cfat_your_token_here" bash tools/deploy.sh
```

The script will:
- ✅ Verify your token
- ✅ Create the D1 database (or reuse existing)
- ✅ Create the R2 bucket (or reuse existing)
- ✅ Create the Turnstile CAPTCHA widget (or reuse existing)
- ✅ Build the dashboard UI
- ✅ Apply database migrations
- ✅ Deploy the Cloudflare Worker
- ✅ Print your live dashboard URL

**All steps are idempotent** — safe to re-run if anything goes wrong.

---

## Prerequisites

| Tool | Minimum Version | How to install |
|------|----------------|----------------|
| `node` | 18+ | [nodejs.org](https://nodejs.org) |
| `npm` | any | Bundled with Node.js |
| `curl` | any | Pre-installed on macOS/Linux. Windows: [curl.se](https://curl.se) |
| `jq` | any | `sudo apt install jq` / `brew install jq` / [stedolan.github.io/jq](https://stedolan.github.io/jq/download/) |

---

## Troubleshooting

### "Token verification failed"
- Check that you copied the full token (starts with `cfat_`)
- Ensure the token hasn't expired
- Try revoking and creating a new token

### "Could not determine account ID"
- Make sure **Account Settings: Read** permission is included
- Make sure **Account Resources** is set to "All accounts" or your specific account

### "Failed to create D1 database" / "Failed to create R2 bucket"
- Ensure **D1: Edit** and **Workers R2 Storage: Edit** permissions are included
- R2 requires a credit card on file — activate it at Cloudflare Dashboard → R2

### "Dashboard build failed"
- Run `npm install` in the repo root manually and check for errors
- Ensure Node.js >= 18 is installed

### Re-running after a partial failure
The deploy script is **fully idempotent** — just run it again. Any resources
already created (D1, R2, Turnstile) will be detected and reused automatically.
