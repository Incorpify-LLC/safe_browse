#!/usr/bin/env bash
# =============================================================================
# Upload a Windows release (MSI + helper scripts) to Cloudflare R2
# =============================================================================
# Prerequisites:
#   - wrangler logged in (npx wrangler whoami) OR CLOUDFLARE_API_TOKEN
#   - R2 bucket exists and has public r2.dev access enabled (first run creates both)
#
# Usage:
#   bash tools/upload-windows-release.sh
#   bash tools/upload-windows-release.sh --version 0.1.0 --dir apps/windows/releases/0.1.0
#   bash tools/upload-windows-release.sh --bucket safe-browse-releases
#
# Public download base (after enable):
#   https://pub-<id>.r2.dev/releases/<version>/SafeBrowseSetup.msi
#   https://pub-<id>.r2.dev/releases/latest/SafeBrowseSetup.msi
#   https://pub-<id>.r2.dev/releases/latest.json
# =============================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; RESET='\033[0m'
log() { echo -e "${CYAN}[upload-release]${RESET} $*"; }
ok()  { echo -e "${GREEN}[✔]${RESET} $*"; }
die() { echo -e "${RED}[✘] $*${RESET}" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

BUCKET="${SAFE_BROWSE_RELEASES_BUCKET:-safe-browse-releases}"
VERSION="${SAFE_BROWSE_RELEASE_VERSION:-0.1.0}"
DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket) BUCKET="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) die "Unknown argument: $1" ;;
  esac
done

if [[ -z "${DIR}" ]]; then
  DIR="${REPO_ROOT}/apps/windows/releases/${VERSION}"
fi
[[ -d "${DIR}" ]] || die "Release directory not found: ${DIR}"
MSI="${DIR}/SafeBrowseSetup.msi"
[[ -f "${MSI}" ]] || die "Missing MSI: ${MSI}"

# Reject Git LFS pointer files
if head -c 50 "${MSI}" | grep -q 'git-lfs'; then
  die "MSI looks like a Git LFS pointer. Run: git lfs pull"
fi

command -v npx >/dev/null || die "npx/node required"
command -v sha256sum >/dev/null || die "sha256sum required"
command -v jq >/dev/null || die "jq required"

cd "${REPO_ROOT}"
W=(npx --yes wrangler@latest)

log "Checking R2 bucket '${BUCKET}'..."
if ! "${W[@]}" r2 bucket list 2>/dev/null | grep -q "${BUCKET}"; then
  log "Creating bucket..."
  "${W[@]}" r2 bucket create "${BUCKET}"
fi

log "Ensuring public r2.dev access..."
# Non-interactive enable (may already be enabled)
printf 'y\n' | "${W[@]}" r2 bucket dev-url enable "${BUCKET}" >/dev/null 2>&1 || true
PUB_LINE=$("${W[@]}" r2 bucket dev-url get "${BUCKET}" 2>/dev/null | tr -d '\r' || true)
PUB_BASE=$(echo "${PUB_LINE}" | grep -oE 'https://pub-[a-f0-9]+\.r2\.dev' | head -1 || true)
[[ -n "${PUB_BASE}" ]] || die "Could not resolve public r2.dev URL. Enable with: npx wrangler r2 bucket dev-url enable ${BUCKET}"
ok "Public base: ${PUB_BASE}"

SIZE=$(stat -c%s "${MSI}")
SHA=$(sha256sum "${MSI}" | awk '{print $1}')
log "MSI size=${SIZE} sha256=${SHA}"

put_obj() {
  local key="$1" file="$2" ct="$3"
  local extra=()
  shift 3 || true
  while [[ $# -gt 0 ]]; do extra+=("$1"); shift; done
  log "  put ${key}"
  "${W[@]}" r2 object put "${BUCKET}/${key}" --file="${file}" --content-type="${ct}" --remote "${extra[@]}"
}

put_obj "releases/${VERSION}/SafeBrowseSetup.msi" "${MSI}" "application/octet-stream" \
  --content-disposition "attachment; filename=\"SafeBrowseSetup-${VERSION}.msi\""
put_obj "releases/latest/SafeBrowseSetup.msi" "${MSI}" "application/octet-stream" \
  --content-disposition "attachment; filename=\"SafeBrowseSetup.msi\""

for f in Install-SafeBrowse.ps1 Uninstall-SafeBrowse.ps1 configure-protection.ps1 README.md; do
  if [[ -f "${DIR}/${f}" ]]; then
    ct=text/plain
    [[ "${f}" == *.md ]] && ct=text/markdown
    put_obj "releases/${VERSION}/${f}" "${DIR}/${f}" "${ct}"
  fi
done

PUBLISHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
MANIFEST=$(jq -n \
  --arg name "Safe Browse" \
  --arg version "${VERSION}" \
  --arg platform "win-x64" \
  --arg publishedAt "${PUBLISHED_AT}" \
  --arg file "SafeBrowseSetup.msi" \
  --argjson sizeBytes "${SIZE}" \
  --arg sha256 "${SHA}" \
  --arg url "${PUB_BASE}/releases/${VERSION}/SafeBrowseSetup.msi" \
  --arg latestUrl "${PUB_BASE}/releases/latest/SafeBrowseSetup.msi" \
  --arg install "${PUB_BASE}/releases/${VERSION}/Install-SafeBrowse.ps1" \
  --arg uninstall "${PUB_BASE}/releases/${VERSION}/Uninstall-SafeBrowse.ps1" \
  --arg configure "${PUB_BASE}/releases/${VERSION}/configure-protection.ps1" \
  --arg readme "${PUB_BASE}/releases/${VERSION}/README.md" \
  --arg windowsSetup "https://github.com/Incorpify-LLC/safe_browse/blob/main/docs/windows_remote_access_setup.md" \
  --arg deployment "https://github.com/Incorpify-LLC/safe_browse/blob/main/docs/deployment.md" \
  '{
    name: $name,
    version: $version,
    platform: $platform,
    publishedAt: $publishedAt,
    msi: { file: $file, sizeBytes: $sizeBytes, sha256: $sha256, url: $url, latestUrl: $latestUrl },
    scripts: { install: $install, uninstall: $uninstall, configureProtection: $configure },
    readme: $readme,
    docs: { windowsSetup: $windowsSetup, deployment: $deployment }
  }')

TMP=$(mktemp)
echo "${MANIFEST}" > "${TMP}"
put_obj "releases/${VERSION}/manifest.json" "${TMP}" "application/json"
put_obj "releases/latest.json" "${TMP}" "application/json"
rm -f "${TMP}"

# Write local copy for README generation
mkdir -p "${REPO_ROOT}/apps/windows/releases"
echo "${MANIFEST}" | jq . > "${REPO_ROOT}/apps/windows/releases/latest.json"
echo "${PUB_BASE}" > "${REPO_ROOT}/apps/windows/releases/R2_PUBLIC_BASE_URL.txt"

ok "Uploaded version ${VERSION}"
echo ""
echo "  MSI (latest):  ${PUB_BASE}/releases/latest/SafeBrowseSetup.msi"
echo "  MSI (${VERSION}): ${PUB_BASE}/releases/${VERSION}/SafeBrowseSetup.msi"
echo "  Manifest:      ${PUB_BASE}/releases/latest.json"
echo "  SHA-256:       ${SHA}"
echo ""
echo "  Update the root README download links if the public base URL changed."
echo "  Local manifest written to apps/windows/releases/latest.json"
