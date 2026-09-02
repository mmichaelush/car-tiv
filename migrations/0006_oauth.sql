-- ============================================================================
-- 0006 — Sign-in with an external identity provider
--
-- Accounts exist in 0002; this migration adds the link between a `users` row
-- and the provider that vouched for it.
--
-- The account is a separate table rather than two columns on `users` for two
-- reasons: one person may later link a second provider to the same account,
-- and an email address is not a stable identity — people change theirs, and
-- two providers can report the same address for different humans. The provider
-- subject (`provider_user_id`) is the stable key; the email is descriptive.
--
-- No password column exists anywhere in this schema, deliberately. There is no
-- hash to leak, no reset flow to abuse and no password policy to get wrong.
-- ============================================================================

CREATE TABLE oauth_accounts (
  provider          TEXT NOT NULL CHECK (provider IN ('google')),
  -- The provider's own immutable id for this person (`sub` in an OIDC token).
  provider_user_id  TEXT NOT NULL,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- What the provider told us at the last sign-in. Descriptive only.
  email             TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, provider_user_id)
);

CREATE INDEX idx_oauth_accounts_user ON oauth_accounts (user_id);

-- ---------------------------------------------------------------------------
-- A record of which device the local (guest) library was merged from, so a
-- second sign-in on the same device does not re-import what is already there.
-- ---------------------------------------------------------------------------
CREATE TABLE library_merges (
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Random id the browser generates once and keeps in local storage.
  device_id   TEXT NOT NULL,
  merged_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  item_count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, device_id)
);
