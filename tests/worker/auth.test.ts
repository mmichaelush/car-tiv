/**
 * Signing in, and the personal library behind it.
 *
 * These run against a real SQLite database with the real migrations, so the
 * SQL is exercised rather than mocked. The parts worth being paranoid about —
 * and therefore the parts tested hardest — are:
 *
 *  * the session token is never stored, only its hash;
 *  * the cookie is HttpOnly, Secure and `__Host-` prefixed;
 *  * a mismatched OAuth `state` cannot complete a sign-in;
 *  * one account cannot read or change another account's rows.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountRepository } from '@worker/repositories/account-repository.js';
import { LibraryRepository } from '@worker/repositories/library-repository.js';
import { sha256 } from '@worker/lib/crypto.js';
import { createTestDatabase, type TestDatabase } from '../helpers/d1.js';
import { seedCatalog } from '../helpers/fixtures.js';
import { createTestWorker, postJson, TEST_ORIGIN, type TestWorker } from '../helpers/worker.js';

let db: TestDatabase;
let accounts: AccountRepository;
let api: TestWorker;

const profile = (overrides: Record<string, unknown> = {}) => ({
  provider: 'google' as const,
  providerUserId: 'google-sub-1',
  email: 'someone@example.com',
  displayName: 'מיכאל',
  avatarUrl: 'https://example.test/a.png',
  ...overrides,
});

/** Sign a profile in and return the cookie header a browser would send. */
async function signInAs(overrides: Record<string, unknown> = {}): Promise<{
  cookie: string;
  userId: string;
}> {
  const { token, account } = await accounts.signIn(profile(overrides), 'vitest');
  return { cookie: `__Host-session=${token}`, userId: account.user.id };
}

beforeEach(async () => {
  db = await createTestDatabase();
  seedCatalog(db);
  accounts = new AccountRepository(db);
  api = createTestWorker(db, { FEATURE_ACCOUNTS: 'true' });
});

afterEach(() => {
  db.close();
});

describe('AccountRepository', () => {
  it('creates the account on first sign-in and reuses it on the second', async () => {
    const first = await accounts.signIn(profile(), 'vitest');
    const second = await accounts.signIn(profile(), 'vitest');

    expect(second.account.user.id).toBe(first.account.user.id);
    // A second sign-in is a second session, not a second account.
    expect(second.token).not.toBe(first.token);
  });

  it('gives a new account the plain user role and nothing more', async () => {
    const { account } = await accounts.signIn(profile(), 'vitest');
    expect(account.roles).toEqual(['user']);
  });

  it('stores only the hash of the session token', async () => {
    const { token } = await accounts.signIn(profile(), 'vitest');
    const rows = db.queryRaw<{ token_hash: string }>(`SELECT token_hash FROM sessions`);

    expect(rows).toHaveLength(1);
    const stored = rows[0]?.token_hash ?? '';
    expect(stored).not.toBe(token);
    expect(stored).toBe(await sha256(token));
  });

  it('links a second provider account with the same verified email to one user', async () => {
    const first = await accounts.signIn(profile(), 'vitest');
    const second = await accounts.signIn(
      profile({ providerUserId: 'google-sub-2', email: 'someone@example.com' }),
      'vitest',
    );
    expect(second.account.user.id).toBe(first.account.user.id);
  });

  it('does not merge two accounts that share no verified email', async () => {
    const first = await accounts.signIn(profile({ email: '' }), 'vitest');
    const second = await accounts.signIn(
      profile({ providerUserId: 'google-sub-3', email: '' }),
      'vitest',
    );
    expect(second.account.user.id).not.toBe(first.account.user.id);
  });

  it('rejects a revoked session', async () => {
    const { token, account } = await accounts.signIn(profile(), 'vitest');
    await accounts.revokeSession(account.sessionId);
    expect(await accounts.findBySessionToken(token)).toBeNull();
  });

  it('rejects an expired session', async () => {
    const { token } = await accounts.signIn(profile(), 'vitest');
    db.runRaw(`UPDATE sessions SET expires_at = datetime('now', '-1 day')`);
    expect(await accounts.findBySessionToken(token)).toBeNull();
  });

  it('rejects a token that was never issued', async () => {
    expect(await accounts.findBySessionToken('not-a-real-token')).toBeNull();
  });

  it('signs out every device at once', async () => {
    const first = await accounts.signIn(profile(), 'vitest');
    const second = await accounts.signIn(profile(), 'vitest');

    await accounts.revokeAllSessions(first.account.user.id);

    expect(await accounts.findBySessionToken(first.token)).toBeNull();
    expect(await accounts.findBySessionToken(second.token)).toBeNull();
  });
});

describe('GET /api/auth/session', () => {
  it('reports nobody when there is no cookie', async () => {
    const { body } = await api.json<{ data: { user: unknown } }>('/api/auth/session');
    expect(body.data.user).toBeNull();
  });

  it('reports the signed-in visitor', async () => {
    const { cookie } = await signInAs();
    const { body } = await api.json<{ data: { user: { displayName: string } } }>(
      '/api/auth/session',
      { headers: { cookie } },
    );
    expect(body.data.user.displayName).toBe('מיכאל');
  });

  it('says sign-in is unavailable when no OAuth client is configured', async () => {
    const { body } = await api.json<{ data: { signInAvailable: boolean } }>('/api/auth/session');
    expect(body.data.signInAvailable).toBe(false);
  });

  it('ignores a forged cookie instead of failing the request', async () => {
    const { status, body } = await api.json<{ data: { user: unknown } }>('/api/auth/session', {
      headers: { cookie: '__Host-session=forged' },
    });
    expect(status).toBe(200);
    expect(body.data.user).toBeNull();
  });
});

describe('GET /api/auth/google/start', () => {
  it('is not exposed when accounts are switched off', async () => {
    const disabled = createTestWorker(db, { FEATURE_ACCOUNTS: 'false' });
    const response = await disabled.fetch('/api/auth/google/start');
    expect(response.status).toBe(404);
  });

  it('is unavailable, not broken, when the OAuth client is not configured', async () => {
    const response = await api.fetch('/api/auth/google/start');
    expect(response.status).toBe(503);
  });

  it('redirects to Google with a state cookie the browser cannot read', async () => {
    const configured = createTestWorker(db, {
      FEATURE_ACCOUNTS: 'true',
      GOOGLE_CLIENT_ID: 'client-id',
      GOOGLE_CLIENT_SECRET: 'client-secret',
    });

    const response = await configured.fetch('/api/auth/google/start?return=/library/');
    expect(response.status).toBe(302);

    const target = new URL(response.headers.get('location') ?? '');
    expect(target.origin).toBe('https://accounts.google.com');
    expect(target.searchParams.get('client_id')).toBe('client-id');
    expect(target.searchParams.get('response_type')).toBe('code');
    expect(target.searchParams.get('redirect_uri')).toBe(`${TEST_ORIGIN}/api/auth/google/callback`);

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('__Host-oauth_state=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    // The return path travels in our cookie, not through Google.
    expect(decodeURIComponent(cookie)).toContain('/library/');
  });

  it('refuses to send the visitor to another site after sign-in', async () => {
    const configured = createTestWorker(db, {
      FEATURE_ACCOUNTS: 'true',
      GOOGLE_CLIENT_ID: 'client-id',
      GOOGLE_CLIENT_SECRET: 'client-secret',
    });

    const response = await configured.fetch('/api/auth/google/start?return=//evil.example/phish');
    const cookie = decodeURIComponent(response.headers.get('set-cookie') ?? '');
    expect(cookie).not.toContain('evil.example');
  });
});

describe('GET /api/auth/google/callback', () => {
  const configured = () =>
    createTestWorker(db, {
      FEATURE_ACCOUNTS: 'true',
      GOOGLE_CLIENT_ID: 'client-id',
      GOOGLE_CLIENT_SECRET: 'client-secret',
    });

  it('refuses a state that does not match the cookie', async () => {
    const response = await configured().fetch('/api/auth/google/callback?code=x&state=attacker', {
      headers: { cookie: '__Host-oauth_state=ours|/' },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('auth=failed');
    expect(response.headers.get('set-cookie') ?? '').not.toContain('__Host-session=');
    expect(db.queryRaw(`SELECT id FROM sessions`)).toHaveLength(0);
  });

  it('refuses a callback with no state cookie at all', async () => {
    const response = await configured().fetch('/api/auth/google/callback?code=x&state=whatever');
    expect(response.headers.get('location')).toContain('auth=failed');
  });

  it('sends the visitor back when they cancel at Google', async () => {
    const response = await configured().fetch(
      '/api/auth/google/callback?error=access_denied&state=ours',
      { headers: { cookie: '__Host-oauth_state=ours|/library/' } },
    );
    const target = new URL(response.headers.get('location') ?? '', TEST_ORIGIN);
    expect(target.pathname).toBe('/library/');
    expect(target.searchParams.get('auth')).toBe('failed');
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the session and clears the cookie', async () => {
    const { cookie } = await signInAs();

    const response = await api.fetch('/api/auth/logout', { method: 'POST', headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie') ?? '').toContain('Max-Age=0');

    const after = await api.json<{ data: { user: unknown } }>('/api/auth/session', {
      headers: { cookie },
    });
    expect(after.body.data.user).toBeNull();
  });
});

describe('/api/me/* — access control', () => {
  it('refuses every personal endpoint without a session', async () => {
    const { status } = await api.json('/api/me/library');
    expect(status).toBe(401);

    const write = await api.fetch('/api/me/favorites', postJson({ videoId: 'corolla0001' }));
    expect(write.status).toBe(401);
  });

  it('cannot reach another account playlist by guessing its id', async () => {
    const owner = await signInAs();
    const stranger = await signInAs({ providerUserId: 'google-sub-9', email: 'other@example.com' });

    const created = await api.json<{ data: { id: string } }>(
      '/api/me/playlists',
      postJson({ name: 'שלי' }, { cookie: owner.cookie }),
    );
    const playlistId = created.body.data.id;

    const attempt = await api.fetch(
      `/api/me/playlists/${playlistId}/items`,
      postJson({ videoId: 'corolla0001' }, { cookie: stranger.cookie }),
    );
    expect(attempt.status).toBe(404);
  });
});

describe('/api/me/* — the library', () => {
  it('saves and removes a favourite', async () => {
    const { cookie } = await signInAs();

    const added = await api.fetch(
      '/api/me/favorites',
      postJson({ videoId: 'corolla0001' }, { cookie }),
    );
    expect(added.status).toBe(201);

    const listed = await api.json<{ data: { favorites: { videoId: string }[] } }>(
      '/api/me/library',
      { headers: { cookie } },
    );
    expect(listed.body.data.favorites.map((item) => item.videoId)).toEqual(['corolla0001']);

    await api.fetch('/api/me/favorites/corolla0001', { method: 'DELETE', headers: { cookie } });
    const after = await api.json<{ data: { favorites: unknown[] } }>('/api/me/library', {
      headers: { cookie },
    });
    expect(after.body.data.favorites).toHaveLength(0);
  });

  it('returns the video itself alongside the id, so a list renders in one request', async () => {
    const { cookie } = await signInAs();
    await api.fetch('/api/me/favorites', postJson({ videoId: 'corolla0001' }, { cookie }));

    const { body } = await api.json<{
      data: { favorites: { snapshot: { title: string } | null }[] };
    }>('/api/me/library', { headers: { cookie } });

    expect(body.data.favorites[0]?.snapshot?.title).toBeTruthy();
  });

  it('keeps watch later as a system playlist, hidden from the playlist list', async () => {
    const { cookie } = await signInAs();
    await api.fetch('/api/me/watch-later', postJson({ videoId: 'corolla0001' }, { cookie }));

    const { body } = await api.json<{
      data: { watchLater: { videoId: string }[]; playlists: unknown[] };
    }>('/api/me/library', { headers: { cookie } });

    expect(body.data.watchLater.map((item) => item.videoId)).toEqual(['corolla0001']);
    expect(body.data.playlists).toHaveLength(0);
  });

  it('records progress and does not overwrite it with a zero', async () => {
    const { cookie } = await signInAs();

    await api.fetch(
      '/api/me/history',
      postJson({ videoId: 'corolla0001', progressSeconds: 120 }, { cookie }),
    );
    await api.fetch(
      '/api/me/history',
      postJson({ videoId: 'corolla0001', progressSeconds: 0 }, { cookie }),
    );

    const { body } = await api.json<{ data: { history: { progressSeconds: number }[] } }>(
      '/api/me/library',
      { headers: { cookie } },
    );
    expect(body.data.history[0]?.progressSeconds).toBe(120);
  });

  it('clears the whole history', async () => {
    const { cookie } = await signInAs();
    await api.fetch('/api/me/history', postJson({ videoId: 'corolla0001' }, { cookie }));

    await api.fetch('/api/me/history', { method: 'DELETE', headers: { cookie } });

    const { body } = await api.json<{ data: { history: unknown[] } }>('/api/me/library', {
      headers: { cookie },
    });
    expect(body.data.history).toHaveLength(0);
  });

  it('creates, fills, reorders and deletes a playlist', async () => {
    const { cookie } = await signInAs();

    const created = await api.json<{ data: { id: string } }>(
      '/api/me/playlists',
      postJson({ name: 'לשבת' }, { cookie }),
    );
    const id = created.body.data.id;

    await api.fetch(
      `/api/me/playlists/${id}/items`,
      postJson({ videoId: 'corolla0001' }, { cookie }),
    );
    await api.fetch(
      `/api/me/playlists/${id}/items`,
      postJson({ videoId: 'yaris000001' }, { cookie }),
    );

    // Sending the full list is a reorder, not an append.
    await api.fetch(
      `/api/me/playlists/${id}/items`,
      postJson({ videoIds: ['yaris000001', 'corolla0001'] }, { cookie }),
    );

    const listed = await api.json<{
      data: { playlists: { id: string; items: { videoId: string }[] }[] };
    }>('/api/me/library', { headers: { cookie } });

    expect(listed.body.data.playlists[0]?.items.map((item) => item.videoId)).toEqual([
      'yaris000001',
      'corolla0001',
    ]);

    await api.fetch(`/api/me/playlists/${id}`, { method: 'DELETE', headers: { cookie } });
    const after = await api.json<{ data: { playlists: unknown[] } }>('/api/me/library', {
      headers: { cookie },
    });
    expect(after.body.data.playlists).toHaveLength(0);
  });

  it('rejects an empty playlist name', async () => {
    const { cookie } = await signInAs();
    const response = await api.fetch('/api/me/playlists', postJson({ name: '  ' }, { cookie }));
    expect(response.status).toBe(400);
  });

  it('follows and unfollows a channel', async () => {
    const { cookie } = await signInAs();

    const slug = db.queryRaw<{ slug: string }>(`SELECT slug FROM channels LIMIT 1`)[0]?.slug ?? '';
    await api.fetch('/api/me/follows', postJson({ slug }, { cookie }));

    const listed = await api.json<{ data: { follows: string[] } }>('/api/me/library', {
      headers: { cookie },
    });
    expect(listed.body.data.follows).toEqual([slug]);

    await api.fetch(`/api/me/follows/${slug}`, { method: 'DELETE', headers: { cookie } });
    const after = await api.json<{ data: { follows: string[] } }>('/api/me/library', {
      headers: { cookie },
    });
    expect(after.body.data.follows).toHaveLength(0);
  });

  it('refuses to follow a channel that does not exist', async () => {
    const { cookie } = await signInAs();
    const response = await api.fetch('/api/me/follows', postJson({ slug: 'nope' }, { cookie }));
    expect(response.status).toBe(404);
  });
});

describe('POST /api/me/merge', () => {
  const guestLibrary = {
    deviceId: 'device-1',
    favorites: ['corolla0001'],
    watchLater: ['yaris000001'],
    history: [{ videoId: 'corolla0001', progressSeconds: 90, isCompleted: false }],
  };

  it('imports the device library into the account', async () => {
    const { cookie } = await signInAs();

    const response = await api.json<{ data: { merged: boolean } }>(
      '/api/me/merge',
      postJson(guestLibrary, { cookie }),
    );
    expect(response.body.data.merged).toBe(true);

    const { body } = await api.json<{
      data: { favorites: unknown[]; watchLater: unknown[]; history: unknown[] };
    }>('/api/me/library', { headers: { cookie } });

    expect(body.data.favorites).toHaveLength(1);
    expect(body.data.watchLater).toHaveLength(1);
    expect(body.data.history).toHaveLength(1);
  });

  it('runs once per device, so deleted entries do not come back', async () => {
    const { cookie } = await signInAs();
    await api.fetch('/api/me/merge', postJson(guestLibrary, { cookie }));

    await api.fetch('/api/me/favorites/corolla0001', { method: 'DELETE', headers: { cookie } });

    const second = await api.json<{ data: { merged: boolean; reason?: string } }>(
      '/api/me/merge',
      postJson(guestLibrary, { cookie }),
    );
    expect(second.body.data.merged).toBe(false);
    expect(second.body.data.reason).toBe('already-merged');

    const { body } = await api.json<{ data: { favorites: unknown[] } }>('/api/me/library', {
      headers: { cookie },
    });
    expect(body.data.favorites).toHaveLength(0);
  });

  it('skips a video that is no longer in the catalog instead of failing', async () => {
    const { cookie } = await signInAs();

    const response = await api.json<{ data: { merged: boolean } }>(
      '/api/me/merge',
      postJson(
        {
          deviceId: 'device-2',
          favorites: ['corolla0001', 'deletedvid1'],
          watchLater: [],
          history: [],
        },
        { cookie },
      ),
    );

    expect(response.body.data.merged).toBe(true);
    const { body } = await api.json<{ data: { favorites: { videoId: string }[] } }>(
      '/api/me/library',
      { headers: { cookie } },
    );
    expect(body.data.favorites.map((item) => item.videoId)).toEqual(['corolla0001']);
  });

  it('needs a device id', async () => {
    const { cookie } = await signInAs();
    const response = await api.fetch('/api/me/merge', postJson({ favorites: [] }, { cookie }));
    expect(response.status).toBe(400);
  });
});

describe('LibraryRepository', () => {
  it('numbers playlist positions sparsely, so a reorder rewrites one row', async () => {
    const { account } = await accounts.signIn(profile(), 'vitest');
    const library = new LibraryRepository(db);

    const id = await library.createPlaylist(account.user.id, 'רשימה');
    await library.addToPlaylist(account.user.id, id, 'corolla0001');
    await library.addToPlaylist(account.user.id, id, 'yaris000001');

    const positions = db
      .queryRaw<{ position: number }>(`SELECT position FROM playlist_items ORDER BY position`)
      .map((row) => row.position);
    expect(positions).toEqual([10, 20]);
  });

  it('refuses to rename a system playlist', async () => {
    const { account } = await accounts.signIn(profile(), 'vitest');
    const library = new LibraryRepository(db);

    const watchLater = await library.watchLaterId(account.user.id);
    await expect(
      library.renamePlaylist(account.user.id, watchLater, 'משהו אחר', ''),
    ).rejects.toThrow();
  });

  it('creates the watch-later list only once', async () => {
    const { account } = await accounts.signIn(profile(), 'vitest');
    const library = new LibraryRepository(db);

    const first = await library.watchLaterId(account.user.id);
    const second = await library.watchLaterId(account.user.id);
    expect(second).toBe(first);
  });
});

describe('/api/me/searches', () => {
  it('saves a filter set and returns it with the library', async () => {
    const { cookie } = await signInAs();

    await api.fetch(
      '/api/me/searches',
      postJson({ name: 'שמן לקורולה', query: 'q=שמן&category=maintenance' }, { cookie }),
    );

    const { body } = await api.json<{
      data: { savedSearches: { name: string; query: string }[] };
    }>('/api/me/library', { headers: { cookie } });

    expect(body.data.savedSearches).toHaveLength(1);
    expect(body.data.savedSearches[0]?.name).toBe('שמן לקורולה');
    expect(body.data.savedSearches[0]?.query).toContain('category=maintenance');
  });

  it('strips a parameter the catalog does not accept', async () => {
    const { cookie } = await signInAs();

    await api.fetch(
      '/api/me/searches',
      postJson({ name: 'נסיון', query: 'q=שמן&evil=1&sort=not-a-sort' }, { cookie }),
    );

    const { body } = await api.json<{ data: { savedSearches: { query: string }[] } }>(
      '/api/me/library',
      { headers: { cookie } },
    );

    const stored = body.data.savedSearches[0]?.query ?? '';
    expect(stored).not.toContain('evil');
    // An unknown sort falls back to the default, which is omitted entirely.
    expect(stored).not.toContain('not-a-sort');
  });

  it('replaces a search of the same name instead of adding a second', async () => {
    const { cookie } = await signInAs();

    await api.fetch('/api/me/searches', postJson({ name: 'שלי', query: 'q=א' }, { cookie }));
    await api.fetch('/api/me/searches', postJson({ name: 'שלי', query: 'q=ב' }, { cookie }));

    const { body } = await api.json<{ data: { savedSearches: { query: string }[] } }>(
      '/api/me/library',
      { headers: { cookie } },
    );

    expect(body.data.savedSearches).toHaveLength(1);
    expect(body.data.savedSearches[0]?.query).toContain('%D7%91');
  });

  it('rejects an empty name', async () => {
    const { cookie } = await signInAs();
    const response = await api.fetch(
      '/api/me/searches',
      postJson({ name: '  ', query: 'q=א' }, { cookie }),
    );
    expect(response.status).toBe(400);
  });

  it('deletes one', async () => {
    const { cookie } = await signInAs();

    const created = await api.json<{ data: { id: string } }>(
      '/api/me/searches',
      postJson({ name: 'שלי', query: 'q=א' }, { cookie }),
    );

    await api.fetch(`/api/me/searches/${created.body.data.id}`, {
      method: 'DELETE',
      headers: { cookie },
    });

    const { body } = await api.json<{ data: { savedSearches: unknown[] } }>('/api/me/library', {
      headers: { cookie },
    });
    expect(body.data.savedSearches).toHaveLength(0);
  });

  it("cannot delete someone else's saved search", async () => {
    const owner = await signInAs();
    const stranger = await signInAs({ providerUserId: 'sub-x', email: 'x@example.com' });

    const created = await api.json<{ data: { id: string } }>(
      '/api/me/searches',
      postJson({ name: 'שלי', query: 'q=א' }, { cookie: owner.cookie }),
    );

    await api.fetch(`/api/me/searches/${created.body.data.id}`, {
      method: 'DELETE',
      headers: { cookie: stranger.cookie },
    });

    const { body } = await api.json<{ data: { savedSearches: unknown[] } }>('/api/me/library', {
      headers: { cookie: owner.cookie },
    });
    expect(body.data.savedSearches).toHaveLength(1);
  });
});
