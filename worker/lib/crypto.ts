/**
 * Hashing and id generation.
 *
 * The visitor fingerprint used for rate limiting is a salted SHA-256 of the
 * client IP: enough to count requests from one source, not enough to recover
 * the address. It is never stored in a column that is shown to anyone.
 */

/** Hex-encode bytes. */
function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of a string, hex encoded. */
export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return toHex(digest);
}

/**
 * A stable, non-reversible identifier for the caller.
 *
 * @param request  Used for `CF-Connecting-IP`.
 * @param salt     A per-deployment secret when available; falls back to a
 *                 constant in development, where there is nothing to protect.
 */
export async function fingerprint(request: Request, salt = 'car-tiv'): Promise<string> {
  const ip =
    request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? 'local';
  return sha256(`${salt}:${ip}`);
}

/** A random identifier for a new row. */
export function newId(): string {
  return crypto.randomUUID();
}

/**
 * A short id for correlating the log lines of one request.
 * Cloudflare supplies `cf-ray`; we fall back to a random value locally.
 */
export function requestId(request: Request): string {
  return request.headers.get('cf-ray') ?? crypto.randomUUID().slice(0, 8);
}

/** Constant-time string comparison, for comparing secrets. */
export function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}
