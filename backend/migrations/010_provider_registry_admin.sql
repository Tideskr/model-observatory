ALTER TABLE provider_registry_versions
  ADD COLUMN document jsonb,
  ADD COLUMN git_commit_sha text,
  ADD COLUMN activated_by text;

CREATE TABLE provider_registry_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  content_sha256 char(64) NOT NULL REFERENCES provider_registry_versions(content_sha256),
  schema_version integer NOT NULL,
  document jsonb NOT NULL,
  git_commit_sha text,
  activated_by text NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_sessions (
  token_hash char(64) PRIMARY KEY,
  github_user_id bigint NOT NULL,
  github_login text NOT NULL,
  github_avatar_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL
);
CREATE INDEX admin_sessions_expiry_idx ON admin_sessions(idle_expires_at, absolute_expires_at);

CREATE TABLE provider_registry_drafts (
  id uuid PRIMARY KEY,
  base_blob_sha text NOT NULL,
  base_content_sha256 char(64) NOT NULL,
  document jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('draft','publishing','published','committed_pending_activation','superseded')),
  created_by bigint NOT NULL,
  created_by_login text NOT NULL,
  updated_by bigint NOT NULL,
  updated_by_login text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  commit_sha text
);
CREATE INDEX provider_registry_drafts_status_updated_idx ON provider_registry_drafts(status, updated_at DESC);
