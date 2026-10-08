-- Public, normalized song metadata only. Never store credentials, audio or
-- user-owned pitch palettes here. Provider misses have their own bounded TTL.
CREATE TABLE IF NOT EXISTS lastfm_tag_cache (
  cache_key char(64) PRIMARY KEY,
  tags jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS lastfm_tag_cache_expiry ON lastfm_tag_cache(expires_at);
-- API-key provider limits are shared by all songs/users, not just one cache key.
CREATE TABLE IF NOT EXISTS provider_cooldown (
  provider varchar(32) PRIMARY KEY CHECK (provider IN ('lastfm')),
  retry_at timestamptz NOT NULL
);
