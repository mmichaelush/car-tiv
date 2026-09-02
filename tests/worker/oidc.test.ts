/**
 * Reading a Google ID token.
 *
 * This is the step where an external claim becomes an identity in our
 * database, so every rejection path gets a test. The token arrives over a
 * direct TLS call to Google's token endpoint in exchange for a code we minted,
 * which is what makes signature verification optional (OIDC Core §3.1.3.7) —
 * the claim checks below are what is left, and they are not optional.
 */

import { describe, expect, it } from 'vitest';
import { decodeIdToken, IdTokenError } from '@worker/lib/oidc.js';

const CLIENT_ID = 'our-client-id.apps.googleusercontent.com';
const NOW = 1_800_000_000;

/** Build a JWT with the given payload. The signature is never inspected. */
function token(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => {
    const json = JSON.stringify(value);
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  return `${encode({ alg: 'RS256' })}.${encode(payload)}.signature-not-checked`;
}

const validPayload = {
  sub: '1234567890',
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  exp: NOW + 3600,
  email: 'someone@example.com',
  email_verified: true,
  name: 'מיכאל כהן',
  picture: 'https://example.test/photo.jpg',
};

describe('decodeIdToken', () => {
  it('reads the claims we rely on', () => {
    const claims = decodeIdToken(token(validPayload), CLIENT_ID, NOW);

    expect(claims.sub).toBe('1234567890');
    expect(claims.email).toBe('someone@example.com');
    expect(claims.email_verified).toBe(true);
  });

  it('decodes a Hebrew name as UTF-8, not as one byte per character', () => {
    const claims = decodeIdToken(token(validPayload), CLIENT_ID, NOW);
    expect(claims.name).toBe('מיכאל כהן');
  });

  it('rejects a token minted for a different application', () => {
    expect(() =>
      decodeIdToken(token({ ...validPayload, aud: 'someone-elses-client' }), CLIENT_ID, NOW),
    ).toThrow(IdTokenError);
  });

  it('rejects a token from an issuer that is not Google', () => {
    expect(() =>
      decodeIdToken(token({ ...validPayload, iss: 'https://evil.example' }), CLIENT_ID, NOW),
    ).toThrow(IdTokenError);
  });

  it('accepts both spellings Google uses for its issuer', () => {
    const claims = decodeIdToken(
      token({ ...validPayload, iss: 'accounts.google.com' }),
      CLIENT_ID,
      NOW,
    );
    expect(claims.iss).toBe('accounts.google.com');
  });

  it('rejects an expired token', () => {
    expect(() =>
      decodeIdToken(token({ ...validPayload, exp: NOW - 3600 }), CLIENT_ID, NOW),
    ).toThrow(IdTokenError);
  });

  it('allows a minute of clock skew, because edge and Google clocks differ', () => {
    const claims = decodeIdToken(token({ ...validPayload, exp: NOW - 30 }), CLIENT_ID, NOW);
    expect(claims.sub).toBe('1234567890');
  });

  it('rejects a token with no subject', () => {
    const { sub: _unused, ...withoutSub } = validPayload;
    expect(() => decodeIdToken(token(withoutSub), CLIENT_ID, NOW)).toThrow(IdTokenError);
  });

  it('rejects something that is not a JWT at all', () => {
    expect(() => decodeIdToken('not.a', CLIENT_ID, NOW)).toThrow(IdTokenError);
    expect(() => decodeIdToken('', CLIENT_ID, NOW)).toThrow(IdTokenError);
  });

  it('rejects a payload that is not JSON', () => {
    expect(() => decodeIdToken('aGVhZGVy.bm90LWpzb24.sig', CLIENT_ID, NOW)).toThrow(IdTokenError);
  });
});
