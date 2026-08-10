ALTER TABLE private_runs
  ADD COLUMN quote_id uuid NOT NULL,
  ADD COLUMN request_digest char(64) NOT NULL,
  ADD COLUMN target_base_url text NOT NULL,
  ADD COLUMN credential_handle uuid NOT NULL;

CREATE TABLE secret_envelopes (
  handle uuid PRIMARY KEY,
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  auth_tag bytea NOT NULL,
  aad text NOT NULL,
  key_version text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE run_reports (
  run_id uuid PRIMARY KEY REFERENCES private_runs(id),
  status text NOT NULL,
  report jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER run_reports_immutable BEFORE UPDATE ON run_reports
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
