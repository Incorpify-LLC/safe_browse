# Parent console security — three-key ladder

Safe Browse is built for a **single household** on **your** Cloudflare account.
There is **no email login** and no SaaS account signup. Access uses three independent keys.

## The three keys

| Key | What it is | Who holds it | Used for |
| :--- | :--- | :--- | :--- |
| **A — PIN** | Master PIN / password you choose at first setup | Parent | Daily unlock of the console |
| **B — Authenticator (TOTP)** | App on your phone (Google Authenticator, Authy, 1Password, Bitwarden, …) | Parent | **Primary** “forgot PIN” recovery |
| **C — Cloudflare operator** | API token / dashboard access that runs `deploy.sh` | You as deployer | **Nuclear** reset if you lost the phone |

```
Daily use ──────────────►  Key A (PIN)
Forgot PIN ─────────────►  Key B (TOTP code → set new PIN)
Lost phone + forgot PIN ►  Key C (deploy.sh --reset-parent-auth → setup again)
```

## First-time setup (once)

1. Open the dashboard URL after deploy.
2. Create a master PIN (or longer password).
3. Optionally write down the **paper recovery key** (secondary backup).
4. **Required:** scan the QR code and confirm a 6-digit code from your authenticator app.
5. Setup is then locked. Public `/setup` will not overwrite your account.

You cannot skip the authenticator. Without it, there is no email-less recovery for a forgotten PIN.

## Forgot PIN (no email)

1. On the login screen choose **Forgot PIN? Use authenticator app**.
2. Enter the current 6-digit code and a new PIN.
3. You are signed in again.

Failed attempts are rate-limited (D1-backed). Too many wrong codes locks that path for ~15 minutes.

## Paper recovery key (secondary)

Shown once at setup. Use **Use paper recovery key instead** if you still have the key but prefer not to use TOTP.
Still rate-limited. Prefer TOTP as the normal path.

## Lost authenticator phone

There is **no public internet path** to wipe TOTP (that would let anyone take over the console).

From a machine that has your **Cloudflare API token**:

```bash
export CLOUDFLARE_API_TOKEN="..."
bash tools/deploy.sh --reset-parent-auth
```

Type `RESET` when prompted. This clears:

- PIN hash  
- TOTP secret  
- paper recovery key  
- active sessions  

It does **not** delete children, devices, policies, or history.

Then open the dashboard and complete first-time setup again (new PIN + new authenticator).

To wipe auth and redeploy the Worker in one go:

```bash
bash tools/deploy.sh --reset-parent-auth-and-deploy
```

## What is intentionally hard

| Attacker | Outcome |
| :--- | :--- |
| Internet random / child with only the URL | Cannot open setup again; cannot reset without TOTP or CF token |
| Guessing PIN online | Rate limited + slow password hash (PBKDF2) |
| Guessing TOTP codes online | Rate limited + 30s code window |
| Someone with your unlocked phone | Can reset PIN (intended) |
| Someone with your Cloudflare token | Can factory-reset parent auth (same as owning the host) |

## Residual honesty

- VPN / local admin on the **child PC** can still bypass DNS filtering — that is the Windows agent threat model, not the console.
- Store Cloudflare tokens like house keys; do not commit them to git.
- Short PINs are convenient; PBKDF2 + rate limits reduce online risk. Prefer a longer passphrase when you can.

## Operator SQL (manual)

Equivalent to `--reset-parent-auth`:

```bash
npx wrangler d1 execute safe-browse --remote \
  --command "UPDATE parents SET password_hash = NULL, recovery_key_hash = NULL, totp_secret = NULL, session_token = NULL;" \
  --config apps/worker/wrangler.jsonc
```
