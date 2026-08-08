/**
 * RFC 6238 TOTP (Time-based One-Time Password) implementation
 * Uses only the Web Crypto API — no npm dependencies needed.
 * Compatible with Google Authenticator, Authy, 1Password, Bitwarden, etc.
 */

// ── Base32 ────────────────────────────────────────────────────────────────────
const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_CHARS[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_CHARS[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Uint8Array {
  const str = input.toUpperCase().replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of str) {
    const idx = BASE32_CHARS.indexOf(char);
    if (idx === -1) continue; // skip invalid chars / spaces
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}

// ── TOTP core (RFC 6238 / RFC 4226) ──────────────────────────────────────────
export function generateTotpSecret(): string {
  // 20 bytes = 160 bits — standard TOTP secret size
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return base32Encode(bytes);
}

async function hmacSha1(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return new Uint8Array(sig);
}

function counterToBytes(counter: number): Uint8Array {
  // 8-byte big-endian representation of the counter
  const buf = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    buf[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  return buf;
}

/** Compute a 6-digit TOTP code for a given base32 secret and unix timestamp */
export async function computeTotp(secret: string, timestampMs: number = Date.now()): Promise<string> {
  const keyBytes = base32Decode(secret);
  const counter = Math.floor(timestampMs / 1000 / 30);
  const mac = await hmacSha1(keyBytes, counterToBytes(counter));
  const offset = mac[19]! & 0x0f;
  const code =
    (((mac[offset]! & 0x7f) << 24) |
     ((mac[offset + 1]! & 0xff) << 16) |
     ((mac[offset + 2]! & 0xff) << 8) |
      (mac[offset + 3]! & 0xff)) %
    1_000_000;
  return String(code).padStart(6, "0");
}

/**
 * Verify a TOTP code — accepts the current window ±1 (90 seconds tolerance
 * to account for clock drift and slow typing)
 */
export async function verifyTotp(secret: string, code: string, timestampMs: number = Date.now()): Promise<boolean> {
  const clean = code.trim().replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const windows = [-1, 0, 1];
  for (const w of windows) {
    const expected = await computeTotp(secret, timestampMs + w * 30_000);
    if (expected === clean) return true;
  }
  return false;
}

/**
 * Build an otpauth:// URI for QR code generation.
 * Compatible with all standard authenticator apps.
 */
export function buildOtpAuthUri(secret: string, label: string, issuer: string = "Safe Browse"): string {
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?${params}`;
}
