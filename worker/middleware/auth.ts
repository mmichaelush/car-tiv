/**
 * Access control for `/api/admin/*`.
 *
 * Two ways in, checked in that order:
 *
 *   1. **A signed-in account holding a staff role.** The normal path, now that
 *      accounts exist.
 *   2. **A shared secret** held as a Cloudflare secret and sent in an
 *      `Authorization: Bearer …` header. Deliberately modest, and the reason
 *      the admin worked before sign-in did; it is also the way in when
 *      `FEATURE_ACCOUNTS` is off, as it is in production today.
 *
 * The shape that made adding the first path cheap, and is worth keeping:
 *
 *   * the check happens in exactly one place — `requireStaff`;
 *   * it returns an `AdminIdentity`, which is what the rest of the code uses,
 *     so neither path is visible above this file;
 *   * the token comparison is constant-time, and a missing secret denies rather
 *     than allows.
 *
 * The URL is not a secret and is never treated as one: `/admin` returns the
 * page shell to anyone, and every piece of data on it requires the header.
 */

import { ROLES, type Role } from '@shared/constants.js';
import type { RequestContext } from '../context.js';
import { timingSafeEqual } from '../lib/crypto.js';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';

/** Who is making an admin request. */
export interface AdminIdentity {
  /** `null` while the shared-secret scheme is in use. */
  readonly userId: string | null;
  readonly displayName: string;
  readonly roles: readonly Role[];
}

/** The identity granted by the shared secret: full access. */
const SHARED_SECRET_IDENTITY: AdminIdentity = {
  userId: null,
  displayName: 'מנהל',
  roles: [...ROLES],
};

/**
 * Require a staff caller.
 *
 * @throws UnauthorizedError when no usable credential was presented.
 * @throws ForbiddenError when the caller lacks every required role.
 */
export function requireStaff(
  context: RequestContext,
  allowed: readonly Role[] = ['admin', 'editor', 'moderator'],
): AdminIdentity {
  const identity = authenticate(context);
  if (identity == null) throw new UnauthorizedError('נדרשת התחברות לאזור הניהול');

  if (!identity.roles.some((role) => allowed.includes(role))) {
    throw new ForbiddenError('אין לכם הרשאה לפעולה הזו');
  }

  return identity;
}

/**
 * Resolve the caller, or `null` when there is no valid credential.
 *
 * Two credentials are accepted, in this order:
 *
 *  1. A signed-in account holding a staff role. This is the normal path now
 *     that accounts exist, and it is what gives the audit log a real user id.
 *  2. The shared `ADMIN_TOKEN`. Kept because it is the only way in before the
 *     first account has been granted a role — a bootstrap credential, and the
 *     one to remove once staff accounts are set up.
 */
function authenticate(context: RequestContext): AdminIdentity | null {
  const account = context.account;
  if (account != null) {
    const staffRoles = account.roles.filter((role) => role !== 'user');
    if (staffRoles.length > 0) {
      return {
        userId: account.user.id,
        displayName: account.user.displayName,
        roles: staffRoles,
      };
    }
  }

  const expected = context.env.ADMIN_TOKEN;

  // No secret configured means the admin API is closed, not open.
  if (expected == null || expected.length === 0) return null;

  const header = context.request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (presented.length === 0) return null;

  return timingSafeEqual(presented, expected) ? SHARED_SECRET_IDENTITY : null;
}

/** `true` when the caller holds the role. */
export function hasRole(identity: AdminIdentity, role: Role): boolean {
  return identity.roles.includes(role);
}
