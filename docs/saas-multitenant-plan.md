# Safe Browse SaaS — Multi-tenant plan (Incorpify-hosted)

**Status:** planning  
**Date:** 2026-08-09  
**Owner:** Incorpify LLC  
**Goal:** Parents use Safe Browse like a normal product (sign up → dashboard → install MSI → enroll kids). They never create a Cloudflare account, run `deploy.sh`, or touch GitHub Actions.

---

## 1. Product vision (parent journey)

```
Parent hears about Safe Browse
        │
        ▼
  app.safebrowse.incorpify…  (or *.workers.dev)
        │  Sign up (email or phone optional later)
        │  Create PIN + link authenticator
        ▼
  Parent dashboard (their household only)
        │  Add child, categories, schedules
        │  Create enroll code
        ▼
  Download MSI from R2 (already public)
        │  Install on kid PC + harden
        │  Paste enroll code
        ▼
  Device syncs policy every ~60s
  Filtering runs locally (DNS) even offline
```

**What parents never do**

- Create Cloudflare accounts  
- Paste API tokens  
- Run GitHub Actions / `deploy.sh`  
- Manage D1 / R2 / Workers  

**What Incorpify does once (ops)**

- Own one Cloudflare account  
- Deploy one multi-tenant Worker + D1 + R2 (lists + MSI)  
- Ship MSI builds to public R2  
- Monitor free-tier limits, abuse, backups  

GitHub Actions (optional later) only automates **Incorpify’s** deploys — not something parents see.

---

## 2. Current code vs SaaS target

### Already multi-tenant-shaped (data)

From `0001_initial.sql`:

| Table | Scope |
| :--- | :--- |
| `households` | Tenant root |
| `parents` | Belongs to `household_id`; `email` UNIQUE |
| `children`, `devices`, `events`, … | All hang off household / child |
| Device auth | Opaque bearer token → device → child → household |

So **isolation by `household_id` is already the right model**. Parent API routes that use `parent.householdId` are already tenant-scoped if auth is correct.

### Still single-family (auth & product)

| Behavior today | Problem for SaaS |
| :--- | :--- |
| `POST /api/v1/auth/setup` once globally (`requireSetup` = any password exists) | Second family cannot sign up |
| Login: try password against **all** parents with `LIMIT 20` | Does not scale; collisions; no email identity |
| `/auth/status` global counts | Dashboard thinks “world already set up” after first family |
| Optional CF Access JWT path | Fine for enterprise; not for public multi-tenant signup |
| Email alerts to `@family.local` placeholders | Real multi-tenant needs real identity + optional email |
| Free-tier sizing docs assume **one household** | SaaS free tier must be engineered for N households |

**Net:** schema is ~70% ready; **auth + onboarding UX must become multi-household**.

---

## 3. Target architecture

```
                    ┌──────────────────────────────────────┐
                    │     Incorpify Cloudflare account      │
                    │                                      │
   Parent browsers  │  Worker: safe-browse-api               │
   ────────────────►│   /api/v1/auth/*     (signup, login)  │
                    │   /api/v1/parent/*   (household-scoped)│
   Kid PC agents    │   /api/v1/device/*   (token-scoped)    │
   ────────────────►│                                      │
                    │  D1: all households (row isolation)  │
                    │  R2 lists: shared signed blocklists   │
                    │  R2 releases: public MSI (existing)   │
                    └──────────────────────────────────────┘
```

| Concern | SaaS choice |
| :--- | :--- |
| **Tenant key** | `households.id` (UUID) |
| **Parent identity** | Email (login id) + PIN/password + mandatory TOTP (keep current ladder) |
| **Device identity** | Existing device bearer tokens (no change) |
| **Blocklists** | **Shared** R2 artifacts (one list version for all households; policy chooses categories) |
| **MSI** | Existing public R2 `safe-browse-releases` |
| **Deploy** | Single Worker; Incorpify-only (GHA later optional) |

Optional later: custom domain `app.safebrowse…` + `device-api.safebrowse…` (device API without CF Access; parent can sit behind optional WAF/rate limits only).

---

## 4. Auth & signup (core product change)

### 4.1 New parent lifecycle

| Step | API (illustrative) | Notes |
| :--- | :--- | :--- |
| 1. Sign up | `POST /api/v1/auth/signup` | email + password + Turnstile → create **new** household + parent; issue session |
| 2. TOTP link | existing `/totp/setup` + confirm | Mandatory before console (keep) |
| 3. Login | `POST /api/v1/auth/login` | **email + password** (+ Turnstile); not password-only |
| 4. Forgot PIN | TOTP recover with **email + totp + new password** | Scope to that parent row |
| 5. Paper recovery | Optional, per parent | Already hashed; keep per-parent |
| 6. Operator wipe | Incorpify only, per household or per parent | Not global `DELETE` all PINs |

### 4.2 Remove / change single-family assumptions

| Current | SaaS |
| :--- | :--- |
| Global `requireSetup` | `requireSetup` only if **this session** has no account; marketing site has **Sign up** always |
| `findParentByPassword` scan LIMIT 20 | `SELECT … WHERE email = ?` then verify hash |
| Setup returns 409 if any password exists | Setup becomes signup **or** deprecated; first-user path = signup |
| Dev CF Access auto-provision | Keep for Incorpify staff; not for public |

### 4.3 Dashboard UX

- Landing: **Sign up** / **Log in** (not “Create master PIN for this deployment”).  
- After login: household name, children, devices (scoped).  
- Settings: change PIN, TOTP status, (later) invite second parent.  
- Enrollment codes unchanged UX; still child-scoped.

### 4.4 Second parent (phase 2)

- `parents` already supports multiple rows per household.  
- Invite by email + accept link, or share enroll-style admin code.  
- Roles later: `owner` / `guardian` (schema add `role` column).

---

## 5. Isolation & security

### 5.1 Row-level isolation (must)

Every parent route already must filter by `parent.householdId`. Audit checklist:

- [ ] Children CRUD only for `household_id = parent.householdId`  
- [ ] Enrollment codes only for children in household  
- [ ] Events / access requests / audit queries always include household  
- [ ] No “list all households” parent API  
- [ ] Device routes never return other households’ data (token → one device)

Add automated tests: two households, assert cross-tenant 404/403.

### 5.2 Rate limits & abuse

| Endpoint | Guidance |
| :--- | :--- |
| Signup | Per IP + per email; Turnstile required in production |
| Login | Per email + IP (existing D1 rate_limits) |
| Enroll | Stronger codes (see phase 1): longer than 6 digits **or** high entropy alphanumeric |
| Device sync | Existing token; optional per-device rate |

### 5.3 Secrets (production)

- `ENVIRONMENT=production`  
- Turnstile **secret** only via `wrangler secret put`  
- Optional: encrypt TOTP secrets at rest with Worker secret  
- Session tokens: add expiry + rotation (P2 today → P1 for SaaS)

### 5.4 Privacy (same product promise)

- Still only top-level domains + block events  
- Events retained 30 days per household (existing retention job)  
- No cross-household analytics without aggregation redesign  

---

## 6. Shared resources vs per-tenant

| Resource | Shared or per-tenant? | Why |
| :--- | :--- | :--- |
| Category blocklists in R2 | **Shared** | One compile pipeline; huge savings; policy selects categories |
| MSI / installers | **Shared** public R2 | Already done |
| Policy / rules / schedules | **Per child / household** | Core product |
| Device tokens | **Per device** | Existing |
| Parent PIN / TOTP | **Per parent** | Existing rows |
| Custom allow/block domains | **Per child** | Existing |

Do **not** create per-family R2 buckets for MVP SaaS.

---

## 7. Incorpify operations model

### 7.1 What you host

| Item | Name / note |
| :--- | :--- |
| Cloudflare account | Incorpify production |
| Worker | `safe-browse-api` (or `safe-browse-api-production`) |
| D1 | `safe-browse` (all households) |
| R2 | `safe-browse-lists` + `safe-browse-releases` (MSI) |
| Domain (later) | `app.…` parent UI; `device-api.…` agents |

### 7.2 Deploy path (Incorpify only)

1. **Today:** `bash tools/deploy.sh` from a trusted machine with CF token.  
2. **Soon:** GitHub Actions on `Incorpify-LLC/safe_browse` with secrets — only your org.  
3. Parents never deploy.

### 7.3 Free tier & cost (honest limits)

Cloudflare free tier can support a **small pilot** of families if:

- Event retention stays aggressive  
- List artifacts stay shared  
- Device poll interval stays ~60s (or backoff when idle)  
- No huge binary hosting beyond MSI (already on R2 free egress)

**Risk:** one D1 database for all tenants → size & write limits. Mitigations:

- Cap events per household/day  
- Cap devices per household (e.g. 5–10 for free pilot)  
- Archive/delete old events (already scheduled delete)  
- Later: paid plan or D1 scaling / multiple shards  

Document pilot caps in dashboard (“Free pilot: up to N devices”).

### 7.4 Support & break-glass

| Situation | Action |
| :--- | :--- |
| Parent lost phone + PIN | Support verifies identity → operator resets **that parent** TOTP/PIN (not whole DB) |
| Abusive signup | Turnstile + rate limit + optional email verification |
| Compromised device | Parent revokes device in UI (ensure API exists / works) |

---

## 8. Windows agent changes (minimal)

| Area | Change |
| :--- | :--- |
| Enroll | Point `ApiBaseUrl` at **Incorpify device API** (default in MSI `appsettings.json`) |
| MSI | Same R2 download; no per-family build |
| Policy | Already household-scoped via enroll response |
| Self-host mode | Optional advanced: custom API URL in install script (`-ApiBaseUrl`) for power users |

Default out-of-box: **SaaS**. Self-host remains advanced docs-only.

---

## 9. Phased delivery plan

### Phase 0 — Prep (1–2 days)

- Freeze product decision: **SaaS is default**; self-host optional.  
- Production deploy of **current** Worker (even single-family) to Incorpify CF for ops practice.  
- Turnstile secrets + `ENVIRONMENT=production`.  

### Phase 1 — Multi-tenant auth (MUST for SaaS) — ~1 week

1. **Signup API** creates household + parent (email unique).  
2. **Login** by email + password (+ Turnstile).  
3. **Status** endpoint becomes session-aware / anonymous-safe (no global “already set up”).  
4. Dashboard: Sign up / Log in screens; remove single-deploy setup monopoly.  
5. TOTP recover scoped by email.  
6. Migration if needed: indexes, `parents.role`, session expiry columns.  
7. Tests: two households cannot see each other’s children.  
8. Stronger enrollment codes (e.g. 10+ char alphanumeric).  

**Done when:** two real parents can sign up on the same Worker, each manage only their kids, each enroll a device.

### Phase 2 — Pilot hardening — ~1 week

- Session TTL + refresh  
- Device revoke UI verified  
- Per-household device caps  
- Email verification (optional but valuable)  
- Abuse monitoring / basic admin “list households” for Incorpify (operator only, CF Access or secret)  
- Full blocklist publish to shared R2 + enroll smoke  

**Done when:** closed pilot (e.g. 5–20 families) for 2 weeks without cross-tenant bugs.

### Phase 3 — Product polish

- Second parent invite  
- Billing / paid tiers (if desired)  
- Custom domain + branding  
- GitHub Actions deploy for Incorpify  
- Mobile agents (later)  

### Phase 4 — Self-host lane (optional)

Keep `deploy.sh` for technical families; document “advanced / single-tenant” as separate mode (feature flag or separate Worker name). Do not block SaaS on this.

---

## 10. Explicit non-goals (MVP SaaS)

- Per-family Cloudflare accounts  
- Parents running GitHub Actions  
- Per-tenant R2 list buckets  
- Multi-region active-active  
- Full SOC2 / enterprise SSO (can map to CF Access later for B2B)

---

## 11. Decision checklist (for you)

| Decision | Recommendation |
| :--- | :--- |
| Default product mode | **SaaS on Incorpify CF** |
| Parent identifier | **Email + PIN + TOTP** |
| CF Access for parents | **Off** for public SaaS (optional later for B2B) |
| Self-host | Supported but not primary path |
| Billing at pilot | Free pilot with hard caps; billing later |
| Device API URL in MSI | Hardcode production Incorpify URL; override for self-host |
| GitHub Actions | After Phase 1, for Incorpify deploy only |

---

## 12. Success metrics (pilot)

| Metric | Target |
| :--- | :--- |
| Signup → enroll → block adult domain | &lt; 20 minutes for a technical parent |
| Cross-tenant data leak tests | 0 failures |
| Support ops resets | Documented runbook; &lt; 15 min |
| Free-tier bill | $0 for pilot N families |
| Parent never opens CF dashboard | 100% |

---

## 13. Implementation task breakdown

| # | Task | Status |
| :---: | :--- | :--- |
| **1** | **Multi-tenant auth API** — `POST /signup`, email+password `login`, session-aware `/status`, TOTP recover by email; legacy `/setup` kept | **Done** (local integration smoke `VERIFY_OK`) |
| **2** | **Dashboard** — Sign up / Log in UI; stop using global `requireSetup` monopoly | **Done** |
| **3** | **Isolation tests** + stronger enroll codes | **Done** (12-char codes; isolation.integration.test.ts green) |
| **4** | **Production deploy** on Incorpify CF + custom domain `safebrowse.incorpify.in` | **Done** (live) |
| **5** | **MSI default `ApiBaseUrl`** → production + dogfood two households | Pending |

Hostname decision: **`https://safebrowse.incorpify.in`** (same CF zone as incorpify.in).

---

## Related docs

- [architecture.md](./architecture.md) — current system  
- [parent-auth.md](./parent-auth.md) — PIN / TOTP ladder (extend, don’t throw away)  
- [deployment.md](./deployment.md) — single-deploy today  
- [windows_remote_access_setup.md](./windows_remote_access_setup.md) — kid PC install  
- Root README — public MSI R2 links  
