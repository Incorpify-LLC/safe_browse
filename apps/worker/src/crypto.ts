export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomToken(bytes = 32): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export function sixDigitCode(): string {
  // Rejection sampling to avoid modulo bias
  const max = 1_000_000;
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  while (true) {
    const values = crypto.getRandomValues(new Uint32Array(1));
    const n = values[0] ?? 0;
    if (n < limit) return String(n % max).padStart(6, "0");
  }
}

/** PBKDF2-HMAC-SHA256 params: balanced for Workers CPU vs offline cracking of short PINs. */
const PBKDF2_ITERS = 120_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_KEY_BITS = 256;
const PBKDF2_PREFIX = "pbkdf2$sha256$";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function pbkdf2Derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  // BufferSource typing: pass a fresh ArrayBuffer-backed view
  const saltBuf = new Uint8Array(salt);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBuf, iterations },
    keyMaterial,
    PBKDF2_KEY_BITS,
  );
  return new Uint8Array(bits);
}

/**
 * Hash a parent PIN/password for storage.
 * Format: pbkdf2$sha256$<iters>$<salt_b64url>$<hash_b64url>
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const derived = await pbkdf2Derive(password, salt, PBKDF2_ITERS);
  return `${PBKDF2_PREFIX}${PBKDF2_ITERS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(derived)}`;
}

/**
 * Verify password against stored hash. Supports:
 * - new PBKDF2 format
 * - legacy sha256("sb_salt_" + password) fixed-prefix hashes
 *
 * Returns { ok, needsRehash } so callers can upgrade legacy rows on login.
 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<{ ok: boolean; needsRehash: boolean }> {
  if (!stored) return { ok: false, needsRehash: false };

  if (stored.startsWith(PBKDF2_PREFIX)) {
    const parts = stored.split("$");
    // pbkdf2, sha256, iters, salt, hash
    if (parts.length !== 5) return { ok: false, needsRehash: false };
    const iterations = Number(parts[2]);
    const salt = base64UrlToBytes(parts[3] ?? "");
    const expected = parts[4] ?? "";
    if (!Number.isFinite(iterations) || iterations < 10_000) return { ok: false, needsRehash: false };
    const derived = await pbkdf2Derive(password, salt, iterations);
    const actual = bytesToBase64Url(derived);
    const ok = timingSafeEqual(actual, expected);
    const needsRehash = ok && iterations < PBKDF2_ITERS;
    return { ok, needsRehash };
  }

  // Legacy fixed-prefix SHA-256 (pre auth-ladder)
  const legacy = await sha256(`sb_salt_${password}`);
  const ok = timingSafeEqual(legacy, stored);
  return { ok, needsRehash: ok };
}
