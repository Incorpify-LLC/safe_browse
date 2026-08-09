# Parent console security — multi-tenant SaaS + self-host

Safe Browse supports **many households on one Incorpify-hosted Worker** (SaaS default).
Each parent signs up with **email + PIN**, then links a **TOTP authenticator**.

Self-host (single family on your own CF account) still works via legacy `/setup` without email.

---

## SaaS model (default)

| Key | What it is | Used for |
| :--- | :--- | :--- |
| **Email** | Unique parent login id | Sign up / log in / TOTP recover scope |
| **PIN** | Master password (min 4 chars) | Daily unlock |
| **Authenticator (TOTP)** | App on your phone | **Required** after signup; primary forgot-PIN path |
| **Paper recovery key** | Shown once at signup | Secondary forgot-PIN |
| **Incorpify operator** | Cloudflare account / deploy tooling | Support reset of a locked account (not a public API) |

```
Sign up (email + PIN) ──► Link TOTP ──► Use dashboard
Daily use ──────────────► Email + PIN
Forgot PIN ─────────────► Email + TOTP code → new PIN
Paper key still works ──► Recovery key → new PIN (+ new paper key)
```

### API (multi-tenant)

| Endpoint | Purpose |
| :--- | :--- |
| `POST /api/v1/auth/signup` | Create **new household** + parent (`email`, `password`, optional `householdName`, Turnstile) |
| `POST /api/v1/auth/login` | `email` + `password` (+ Turnstile) |
| `GET /api/v1/auth/status` | `multiTenant: true`, `signupEnabled: true`, `requireSetup: false`; session fields if Bearer present |
| `POST /api/v1/auth/totp/recover` | `email` + `totpCode` + `newPassword` |
| `POST /api/v1/auth/recover` | Paper recovery key (unique per parent) |
| `POST /api/v1/auth/setup` | **Legacy**: with `email` → same as signup; without email → single-tenant `parent@family.local` only if no accounts exist |

Two different emails ⇒ two isolated households (children/devices never cross).

---

## First-time (SaaS)

1. Open `https://safebrowse.incorpify.in` (or your deploy URL).
2. **Sign up** with email + PIN.
3. Save the **paper recovery key** (optional but recommended).
4. **Link authenticator** (required before console APIs).
5. Add children, enroll devices.

You cannot skip the authenticator for password-based parents.

---

## Forgot PIN

1. Choose **Forgot PIN? Use authenticator**.
2. Enter **email**, current 6-digit code, and new PIN.
3. Signed in again.

Failed attempts are rate-limited (D1). Wrong TOTP does not reveal whether the email exists (uniform error).

---

## Paper recovery key (secondary)

Shown once at signup/setup. Still rate-limited. Prefer TOTP for normal recovery.

---

## Self-host (single family)

If you run `deploy.sh` on your own Cloudflare account:

1. Open the Worker URL.
2. Call legacy **setup** with PIN only (creates `parent@family.local`), **or** signup with your email.
3. Link TOTP as above.

Operator nuclear wipe of **all** parent auth on that D1:

```bash
export CLOUDFLARE_API_TOKEN="..."
bash tools/deploy.sh --reset-parent-auth
```

On **SaaS**, that tool must not be used as a routine parent recovery path (it would affect every family). Support resets should target **one parent row** (runbook TBD).

---

## What is intentionally hard

| Attacker | Outcome |
| :--- | :--- |
| Internet random | Cannot take over without email + PIN or TOTP |
| Child with only the URL | No access without parent credentials |
| Guessing PIN online | Rate limited + PBKDF2 |
| Guessing TOTP online | Rate limited + 30s window |
| Someone with unlocked parent phone | Can reset PIN (intended) |

---

## Related

- Multi-tenant product plan: [saas-multitenant-plan.md](./saas-multitenant-plan.md)
- Deploy: [deployment.md](./deployment.md)
