-- Auth tables come from the pinned Better Auth configuration, not hand-written DDL.
-- No raw lyrics, provider tokens, personal palette or captured audio are stored here.
CREATE TABLE current_context (
  user_id text PRIMARY KEY,
  context jsonb,
  updated_at timestamptz NOT NULL DEFAULT 'epoch',
  retry_at timestamptz,
  poll_owner uuid,
  poll_expires_at timestamptz
);
CREATE TABLE generated_analysis (
  cache_key char(64) PRIMARY KEY,
  track_id varchar(128) NOT NULL,
  model varchar(128) NOT NULL,
  prompt_version integer NOT NULL,
  lyrics_hash char(64) NOT NULL,
  profile jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX generated_analysis_track ON generated_analysis(track_id, model, prompt_version);
CREATE TABLE usage_counter (
  day date NOT NULL,
  scope text NOT NULL,
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (day, scope)
);
CREATE TABLE enrichment_reservation (
  user_id text NOT NULL,
  request_id text NOT NULL,
  track_id varchar(128) NOT NULL,
  cache_key char(64),
  day date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, request_id)
);
CREATE TABLE enrichment_lease (
  cache_key char(64) PRIMARY KEY,
  owner uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE request_counter (
  user_id text NOT NULL,
  category varchar(32) NOT NULL,
  minute bigint NOT NULL,
  used integer NOT NULL CHECK (used > 0),
  PRIMARY KEY (user_id, category, minute)
);
