/**
 * Reading an OpenID Connect ID token.
 *
 * The token arrives on a direct, server-to-server TLS request to Google's token
 * endpoint, in response to a code we generated. OpenID Connect Core §3.1.3.7
 * says a client MAY skip signature validation in exactly that case, because the
 * transport already establishes who sent it — so this module decodes the
 * payload and checks the claims that still matter, rather than fetching and
 * caching Google's JWKS on every cold start.
 *
 * What is *not* optional is checking the claims: an `aud` that is not us means
 * the token was minted for a different application, and an expired token means
 * a replay. Both are rejected here rather than by the caller, so there is one
 * place to look.
 */

/** The claims we rely on. Everything else Google sends is ignored. */
export interface IdTokenClaims {
  /** The provider's stable, immutable id for this person. */
  readonly sub: string;
  readonly iss: string;
  readonly aud: string;
  readonly exp: number;
  readonly email?: string;
  readonly email_verified?: boolean;
  readonly name?: string;
  readonly picture?: string;
}

/** Issuers Google signs its tokens as. Both spellings are legitimate. */
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export class IdTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdTokenError';
  }
}

/**
 * Decode and validate a Google ID token.
 *
 * @param token      The raw `id_token` from the token endpoint.
 * @param clientId   Our OAuth client id, which must be the token's audience.
 * @param nowSeconds Injectable clock, so expiry is testable.
 * @throws IdTokenError when the token is malformed, expired, or not ours.
 */
export function decodeIdToken(
  token: string,
  clientId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): IdTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new IdTokenError('id_token is not a JWT');

  const payload = parts[1];
  if (payload == null || payload.length === 0) throw new IdTokenError('id_token has no payload');

  let claims: Partial<IdTokenClaims>;
  try {
    claims = JSON.parse(decodeBase64Url(payload)) as Partial<IdTokenClaims>;
  } catch {
    throw new IdTokenError('id_token payload is not JSON');
  }

  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw new IdTokenError('id_token has no subject');
  }
  if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.includes(claims.iss)) {
    throw new IdTokenError('id_token was not issued by Google');
  }
  if (claims.aud !== clientId) {
    throw new IdTokenError('id_token was issued for a different application');
  }
  // A minute of leeway: clock skew between Cloudflare's edge and Google is
  // normal, and rejecting a token that expired one second ago helps nobody.
  if (typeof claims.exp !== 'number' || claims.exp + 60 < nowSeconds) {
    throw new IdTokenError('id_token has expired');
  }

  return claims as IdTokenClaims;
}

/**
 * Base64url -> UTF-8 string.
 *
 * `atob` produces one character per byte, so the bytes are rebuilt and decoded
 * as UTF-8 — otherwise a Hebrew display name comes back as mojibake.
 */
function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
