CREATE TABLE donations (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('api')),
  status text NOT NULL CHECK (status IN ('quarantined', 'active', 'revoked', 'expired', 'rejected')),
  target_origin text NOT NULL,
  target_base_url text NOT NULL,
  target_hostname text NOT NULL,
  constraints jsonb NOT NULL,
  credential_handle uuid NOT NULL,
  credential_fingerprint_tail varchar(12) NOT NULL,
  revocation_token_hash char(64) NOT NULL UNIQUE,
  disclosure_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX donations_status_expiry_idx ON donations(status, expires_at);

CREATE TABLE registry_proposals (
  id uuid PRIMARY KEY,
  probe_id text NOT NULL,
  field_name text NOT NULL CHECK (field_name IN ('label', 'scoring_note', 'prompt_template', 'expected_answer')),
  current_value text NOT NULL,
  proposed_value text NOT NULL,
  reason text NOT NULL,
  evidence_urls text[] NOT NULL,
  content_sha256 char(64) NOT NULL,
  status text NOT NULL CHECK (status IN ('gitops_pending')),
  issue_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX registry_proposals_probe_idx ON registry_proposals(probe_id, created_at DESC);
