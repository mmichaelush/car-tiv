/**
 * Accounts, sessions and the link to an identity provider.
 *
 * The session token never appears in this database. The browser holds the raw
 * token in a cookie; what is stored here is its SHA-256, so a dump of the
 * `sessions` table cannot be replayed as a login. Looking a session up is
 * therefore "hash what the cookie sent, find that hash" — which is also why
 * there is no way to list a visitor's tokens back to them.
 */

import type { D1Database } from '@cloudflare/workers-types';
import { ROLES, type Role } from '@shared/constants.js';
import type { User } from '@shared/types/user.js';
import { newId, sha256 } from '../lib/crypto.js';
import { BaseRepository } from './base.js';

/** How long a session lasts without being used. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 60; // 60 days

/** A signed-in visitor, as the rest of the Worker sees them. */
export interface Account {
  readonly user: User;
  readonly roles: readonly Role[];
  readonly sessionId: string;
}

interface UserRow {
  id: string;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
  status: string;
  createdAt: string;
}

interface SessionRow extends UserRow {
  sessionId: string;
  roles: string | null;
}

/** What the provider told us about the person signing in. */
export interface ProviderProfile {
  readonly provider: 'google';
  readonly providerUserId: string;
  readonly email: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
}

export class AccountRepository extends BaseRepository {
  constructor(db: D1Database) {
    super(db);
  }

  /**
   * Find the account behind a raw session token.
   *
   * Returns `null` for a token that is unknown, expired or revoked — the
   * caller cannot tell which, and does not need to.
   */
  async findBySessionToken(token: string): Promise<Account | null> {
    const row = await this.first<SessionRow>(
      `SELECT s.id AS sessionId,
              u.id, u.email, u.display_name AS displayName, u.avatar_url AS avatarUrl,
              u.status, u.created_at AS createdAt,
              (SELECT GROUP_CONCAT(role_id) FROM user_roles WHERE user_id = u.id) AS roles
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?
         AND s.revoked_at IS NULL
         AND s.expires_at > CURRENT_TIMESTAMP
         AND u.status = 'active'`,
      [await sha256(token)],
    );

    if (row == null) return null;

    const roles = parseRoles(row.roles);
    return { sessionId: row.sessionId, user: toUser(row, roles), roles };
  }

  /**
   * Sign a provider profile in, creating the account on first use.
   *
   * Matching is by provider subject first and email second: the subject is the
   * stable identity, but a person who already has an account created some other
   * way should not get a duplicate just because this is their first Google
   * sign-in.
   *
   * @returns The raw session token to put in the cookie. It is not stored.
   */
  async signIn(
    profile: ProviderProfile,
    userAgent: string,
  ): Promise<{ token: string; account: Account }> {
    const existing = await this.first<{ userId: string }>(
      `SELECT user_id AS userId FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?`,
      [profile.provider, profile.providerUserId],
    );

    const userId = existing?.userId ?? (await this.#linkOrCreateUser(profile));

    await this.run(
      `INSERT INTO oauth_accounts (provider, provider_user_id, user_id, email, last_login_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (provider, provider_user_id)
       DO UPDATE SET email = excluded.email, last_login_at = CURRENT_TIMESTAMP`,
      [profile.provider, profile.providerUserId, userId, profile.email],
    );

    // Keep the display name and picture fresh, but never blank an existing one
    // with an empty value the provider happened not to send this time.
    await this.run(
      `UPDATE users
       SET display_name = CASE WHEN ? = '' THEN display_name ELSE ? END,
           avatar_url   = COALESCE(?, avatar_url),
           last_login_at = CURRENT_TIMESTAMP,
           updated_at    = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [profile.displayName, profile.displayName, profile.avatarUrl, userId],
    );

    const token = createSessionToken();
    const sessionId = newId();

    await this.run(
      `INSERT INTO sessions (id, user_id, token_hash, user_agent, expires_at)
       VALUES (?, ?, ?, ?, datetime('now', ?))`,
      [
        sessionId,
        userId,
        await sha256(token),
        userAgent.slice(0, 250),
        `+${String(SESSION_TTL_SECONDS)} seconds`,
      ],
    );

    const account = await this.findBySessionToken(token);
    if (account == null) {
      // Only reachable if the row we just wrote cannot be read back.
      throw new Error('session was created but could not be read back');
    }
    return { token, account };
  }

  /** Revoke one session. Idempotent. */
  async revokeSession(sessionId: string): Promise<void> {
    await this.run(
      `UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP
       WHERE id = ? AND revoked_at IS NULL`,
      [sessionId],
    );
  }

  /** Revoke every session a user has — "sign out everywhere". */
  async revokeAllSessions(userId: string): Promise<void> {
    await this.run(
      `UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND revoked_at IS NULL`,
      [userId],
    );
  }

  /**
   * Delete expired and revoked sessions.
   * Called opportunistically after a sign-in, so the table cannot grow without
   * bound; there is no scheduled job to depend on.
   */
  async pruneSessions(): Promise<void> {
    await this.run(
      `DELETE FROM sessions
       WHERE expires_at < datetime('now', '-1 day')
          OR (revoked_at IS NOT NULL AND revoked_at < datetime('now', '-1 day'))`,
    );
  }

  /** Whether this device's guest library was already merged into the account. */
  async hasMergedDevice(userId: string, deviceId: string): Promise<boolean> {
    const row = await this.first<{ one: number }>(
      `SELECT 1 AS one FROM library_merges WHERE user_id = ? AND device_id = ?`,
      [userId, deviceId],
    );
    return row != null;
  }

  async recordMerge(userId: string, deviceId: string, itemCount: number): Promise<void> {
    await this.run(
      `INSERT INTO library_merges (user_id, device_id, item_count)
       VALUES (?, ?, ?)
       ON CONFLICT (user_id, device_id)
       DO UPDATE SET merged_at = CURRENT_TIMESTAMP, item_count = item_count + excluded.item_count`,
      [userId, deviceId, itemCount],
    );
  }

  /**
   * Attach the provider to an account with the same verified email, or create
   * one. Returns the user id either way.
   */
  async #linkOrCreateUser(profile: ProviderProfile): Promise<string> {
    if (profile.email.length > 0) {
      const byEmail = await this.first<{ id: string }>(
        `SELECT id FROM users WHERE email = ? AND status != 'deleted'`,
        [profile.email],
      );
      if (byEmail != null) return byEmail.id;
    }

    const userId = newId();
    await this.run(
      `INSERT INTO users (id, email, display_name, avatar_url, last_login_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        userId,
        profile.email.length === 0 ? null : profile.email,
        profile.displayName,
        profile.avatarUrl,
      ],
    );
    await this.run(`INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, 'user')`, [
      userId,
    ]);

    return userId;
  }
}

/**
 * A 256-bit random token, base64url encoded.
 *
 * `crypto.randomUUID()` would be shorter to write but carries only 122 bits of
 * entropy and a recognisable shape; a session token is the one credential in
 * the system, so it gets the full amount.
 */
function createSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toUser(row: UserRow, roles: readonly Role[]): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    roles,
    createdAt: row.createdAt,
  };
}

/** `GROUP_CONCAT` gives `"user,editor"`; anything unrecognised is dropped. */
function parseRoles(value: string | null): Role[] {
  if (value == null || value.length === 0) return [];
  return value
    .split(',')
    .map((role) => role.trim())
    .filter((role): role is Role => (ROLES as readonly string[]).includes(role));
}
