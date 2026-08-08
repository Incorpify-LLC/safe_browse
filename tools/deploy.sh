#!/usr/bin/env bash
# =============================================================================
# Safe Browse — One-Click Cloudflare Deploy
# =============================================================================
# Usage:
#   export CLOUDFLARE_API_TOKEN="cfat_..."
#   bash tools/deploy.sh
#
# Or pass the token inline:
#   CLOUDFLARE_API_TOKEN="cfat_..." bash tools/deploy.sh
#
# Requirements: node >= 18, npm, curl, jq
# =============================================================================
set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

log()  { echo -e "${CYAN}[safe-browse]${RESET} $*"; }
ok()   { echo -e "${GREEN}[✔]${RESET} $*"; }
warn() { echo -e "${YELLOW}[!]${RESET} $*"; }
die()  { echo -e "${RED}[✘] $*${RESET}" >&2; exit 1; }

# ── Banner ───────────────────────────────────────────────────────────────────
echo -e "${BOLD}"
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║        Safe Browse — One-Click Deploy        ║"
echo "  ║      Cloudflare Workers · D1 · R2 · Free     ║"
echo "  ╚══════════════════════════════════════════════╝"
echo -e "${RESET}"

# ── Resolve script directory so it works from any CWD ────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORKER_DIR="${REPO_ROOT}/apps/worker"
DASHBOARD_DIR="${REPO_ROOT}/apps/dashboard"
WRANGLER_CONFIG="${WORKER_DIR}/wrangler.jsonc"

# ── Step 0: Check prerequisites ───────────────────────────────────────────────
log "Checking prerequisites..."
command -v node  >/dev/null 2>&1 || die "node is not installed. Install from https://nodejs.org"
command -v npm   >/dev/null 2>&1 || die "npm is not installed."
command -v curl  >/dev/null 2>&1 || die "curl is not installed."
command -v jq    >/dev/null 2>&1 || die "jq is not installed. Run: sudo apt install jq  (or: brew install jq)"

NODE_VERSION=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
[[ "${NODE_VERSION}" -ge 18 ]] || die "Node.js >= 18 required (found ${NODE_VERSION}). Upgrade at https://nodejs.org"
ok "Prerequisites satisfied (node v$(node --version))"

# ── Step 1: Resolve API token ─────────────────────────────────────────────────
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo ""
  echo -e "${BOLD}Cloudflare API Token Required${RESET}"
  echo "  Create one at: https://dash.cloudflare.com/profile/api-tokens"
  echo "  See docs/cloudflare-api-token.md for step-by-step instructions."
  echo ""
  read -r -p "  Paste your Cloudflare API Token: " CLOUDFLARE_API_TOKEN
  [[ -n "${CLOUDFLARE_API_TOKEN}" ]] || die "No token provided. Aborting."
fi
export CLOUDFLARE_API_TOKEN

# ── Step 2: Verify token & get Account ID ─────────────────────────────────────
log "Verifying Cloudflare API token..."
CF_API="https://api.cloudflare.com/client/v4"
AUTH_HDR="Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"

verify=$(curl -sf "${CF_API}/user/tokens/verify" -H "${AUTH_HDR}") \
  || die "Token verification failed. Check your API token and try again."
[[ "$(echo "${verify}" | jq -r '.success')" == "true" ]] \
  || die "Invalid token: $(echo "${verify}" | jq -r '.errors[0].message // "unknown error"')"
ok "Token is valid (status: $(echo "${verify}" | jq -r '.result.status'))"

log "Fetching your Cloudflare Account ID..."
accounts=$(curl -sf "${CF_API}/accounts?per_page=1" -H "${AUTH_HDR}")
CLOUDFLARE_ACCOUNT_ID=$(echo "${accounts}" | jq -r '.result[0].id // empty')
ACCOUNT_NAME=$(echo "${accounts}" | jq -r '.result[0].name // "unknown"')
[[ -n "${CLOUDFLARE_ACCOUNT_ID}" ]] || die "Could not determine account ID. Ensure the token has Account:Read permission."
export CLOUDFLARE_ACCOUNT_ID
ok "Account: ${ACCOUNT_NAME} (${CLOUDFLARE_ACCOUNT_ID})"

# ── Step 3: Install npm dependencies ──────────────────────────────────────────
log "Installing npm dependencies..."
npm install --prefix "${REPO_ROOT}" --silent
ok "Dependencies installed"

# ── Wrangler helper ───────────────────────────────────────────────────────────
wrangler_run() {
  CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN}" \
  CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID}" \
  npx --yes wrangler@latest "$@" --config "${WRANGLER_CONFIG}"
}

# ── Step 4: Create / verify D1 database ───────────────────────────────────────
log "Setting up D1 database (safe-browse)..."
DB_LIST_JSON=$(wrangler_run d1 list --json 2>/dev/null || echo "[]")
DB_ID=$(echo "${DB_LIST_JSON}" | jq -r '.[] | select(.name == "safe-browse") | .uuid // empty' 2>/dev/null || true)

if [[ -z "${DB_ID}" ]]; then
  log "Creating D1 database 'safe-browse'..."
  create_raw=$(wrangler_run d1 create safe-browse --json 2>&1)
  # wrangler outputs JSON on stdout, grab it
  DB_ID=$(echo "${create_raw}" | jq -r '.uuid // .result.uuid // empty' 2>/dev/null || true)
  [[ -n "${DB_ID}" ]] || die "Failed to create D1 database. Output: ${create_raw}"
  ok "Created D1 database: ${DB_ID}"
else
  ok "D1 database already exists: ${DB_ID}"
fi

# Patch wrangler.jsonc with real DB ID
node -e "
  const fs = require('fs');
  const src = fs.readFileSync('${WRANGLER_CONFIG}', 'utf8');
  const updated = src.replace(
    /\"database_id\":\s*\"[^\"]+\"/,
    '\"database_id\": \"${DB_ID}\"'
  );
  fs.writeFileSync('${WRANGLER_CONFIG}', updated);
"
ok "wrangler.jsonc updated with database_id: ${DB_ID}"

# ── Step 5: Create / verify R2 bucket ─────────────────────────────────────────
log "Setting up R2 bucket (safe-browse-lists)..."
BUCKET_LIST_JSON=$(wrangler_run r2 bucket list --json 2>/dev/null || echo "[]")
BUCKET_EXISTS=$(echo "${BUCKET_LIST_JSON}" | jq -r '.[] | select(.name == "safe-browse-lists") | .name // empty' 2>/dev/null || true)

if [[ -z "${BUCKET_EXISTS}" ]]; then
  log "Creating R2 bucket 'safe-browse-lists'..."
  wrangler_run r2 bucket create safe-browse-lists >/dev/null
  ok "R2 bucket created"
else
  ok "R2 bucket already exists"
fi

# ── Step 6: Create / verify Turnstile widget ──────────────────────────────────
log "Setting up Cloudflare Turnstile CAPTCHA widget..."

# Discover the workers.dev subdomain for this account
WORKERS_SUBDOMAIN=$(curl -sf "${CF_API}/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/subdomain" \
  -H "${AUTH_HDR}" | jq -r '.result.subdomain // empty')
if [[ -n "${WORKERS_SUBDOMAIN}" ]]; then
  WORKER_HOSTNAME="safe-browse-api.${WORKERS_SUBDOMAIN}.workers.dev"
else
  WORKER_HOSTNAME="safe-browse-api.workers.dev"
fi

WIDGETS_RESP=$(curl -sf "${CF_API}/accounts/${CLOUDFLARE_ACCOUNT_ID}/challenges/widgets" -H "${AUTH_HDR}")
EXISTING_SITEKEY=$(echo "${WIDGETS_RESP}" | jq -r '.result[] | select(.name == "safe-browse-console") | .sitekey // empty' 2>/dev/null || true)

if [[ -n "${EXISTING_SITEKEY}" ]]; then
  TURNSTILE_SITE_KEY="${EXISTING_SITEKEY}"
  TURNSTILE_SECRET_KEY=$(curl -sf "${CF_API}/accounts/${CLOUDFLARE_ACCOUNT_ID}/challenges/widgets/${EXISTING_SITEKEY}" \
    -H "${AUTH_HDR}" | jq -r '.result.secret // empty')
  ok "Turnstile widget already exists (sitekey: ${TURNSTILE_SITE_KEY})"
else
  log "Creating Turnstile widget for domain: ${WORKER_HOSTNAME}..."
  ts_resp=$(curl -sf -X POST "${CF_API}/accounts/${CLOUDFLARE_ACCOUNT_ID}/challenges/widgets" \
    -H "${AUTH_HDR}" -H "Content-Type: application/json" \
    -d "{\"name\":\"safe-browse-console\",\"domains\":[\"${WORKER_HOSTNAME}\"],\"mode\":\"managed\",\"bot_fight_mode\":false,\"region\":\"world\"}")
  TURNSTILE_SITE_KEY=$(echo "${ts_resp}" | jq -r '.result.sitekey // empty')
  TURNSTILE_SECRET_KEY=$(echo "${ts_resp}" | jq -r '.result.secret // empty')
  [[ -n "${TURNSTILE_SITE_KEY}" ]] \
    || die "Failed to create Turnstile widget: $(echo "${ts_resp}" | jq -r '.errors[0].message // "unknown"')"
  ok "Turnstile widget created (sitekey: ${TURNSTILE_SITE_KEY})"
fi

# Patch wrangler.jsonc with Turnstile keys
node -e "
  const fs = require('fs');
  let src = fs.readFileSync('${WRANGLER_CONFIG}', 'utf8');
  src = src.replace(/\"TURNSTILE_SITE_KEY\":\s*\"[^\"]+\"/, '\"TURNSTILE_SITE_KEY\": \"${TURNSTILE_SITE_KEY}\"');
  src = src.replace(/\"TURNSTILE_SECRET_KEY\":\s*\"[^\"]+\"/, '\"TURNSTILE_SECRET_KEY\": \"${TURNSTILE_SECRET_KEY}\"');
  fs.writeFileSync('${WRANGLER_CONFIG}', src);
"
ok "wrangler.jsonc updated with Turnstile keys"

# ── Step 7: Build dashboard ────────────────────────────────────────────────────
log "Building dashboard UI..."
npm run build --prefix "${DASHBOARD_DIR}" \
  || die "Dashboard build failed. Check apps/dashboard for errors."
ok "Dashboard built successfully"

# ── Step 8: Apply database migrations ─────────────────────────────────────────
log "Applying database migrations..."
wrangler_run d1 migrations apply safe-browse --remote \
  || die "Database migration failed."
ok "Database migrations applied"

# ── Step 9: Deploy the worker ──────────────────────────────────────────────────
log "Deploying Safe Browse Worker to Cloudflare..."
DEPLOY_OUT=$(wrangler_run deploy 2>&1)
echo "${DEPLOY_OUT}"

DEPLOY_URL=$(echo "${DEPLOY_OUT}" | grep -Eo 'https://[^ ]+workers\.dev' | head -1 || true)

# ── Done! ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${GREEN}${BOLD}║      🎉  Safe Browse deployed successfully!              ║${RESET}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""
if [[ -n "${DEPLOY_URL}" ]]; then
  echo -e "  ${BOLD}Dashboard URL:${RESET}  ${DEPLOY_URL}"
fi
echo -e "  ${BOLD}Account:${RESET}        ${ACCOUNT_NAME}"
echo -e "  ${BOLD}D1 Database:${RESET}    safe-browse (${DB_ID})"
echo -e "  ${BOLD}R2 Bucket:${RESET}      safe-browse-lists"
echo -e "  ${BOLD}Turnstile:${RESET}      ${TURNSTILE_SITE_KEY}"
echo ""
echo -e "  ${BOLD}Next steps:${RESET}"
echo "  1. Open the dashboard URL above in your browser."
echo "  2. Create your Parent Master Password on first visit."
echo "  3. Install the Windows agent on your child's device."
echo "  4. Enroll the device using the code from the dashboard."
echo ""
echo -e "  ${CYAN}See docs/deployment.md for full documentation.${RESET}"
echo ""
